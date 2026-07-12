// パイプラインの LLM ステップ本体（step2/3/5/6）。
//
// 各関数は最終引数に deps?: {query?, readFile?, debug?} を取り、内部で
// runStructured(opts, {query}) へ委譲する。usage/totalCostUsd は debug 時のみ合算する。
// 設計原則（docs/plans/04-llm-steps.md）: LLM は意味判断のみ。位置解決・検証・フィルタ適用・
// 構造転写・グルーピング・並列制御はすべてコードで決定論的に行う（Promise.all で並列化）。
import { readFileSync } from "node:fs";
import type {
  Assignment,
  Cluster,
  Context,
  FindingsDoc,
  Issue,
  MergeText,
  Verdict,
} from "../lib/types.ts";
import { type QueryFn, runStructured } from "./client.ts";
import {
  bugAgentSystem,
  bugAgentUser,
  clusterAgentSystem,
  clusterAgentUser,
  FINDINGS_SCHEMA,
  MERGE_TEXT_SCHEMA,
  MODEL_HEAVY,
  MODEL_LIGHT,
  mergeTextSystem,
  mergeTextUser,
  reviewMdAgentSystem,
  reviewMdAgentUser,
  ruleAgentSystem,
  ruleAgentUser,
  SUMMARY_CLUSTERS_SCHEMA,
  SUMMARY_ONLY_SCHEMA,
  summaryClustersSystem,
  summaryClustersUser,
  VERDICT_SCHEMA,
  verifySystem,
  verifyUser,
} from "./prompts.ts";

export type DebugSink = (label: string, obj: unknown) => void;

export interface StepDeps {
  query?: QueryFn;
  readFile?: (relPath: string) => string | null;
  debug?: DebugSink;
}

// デフォルトの readFile: fs.readFileSync、例外→null。
export function defaultReadFile(relPath: string): string | null {
  try {
    return readFileSync(relPath, "utf8");
  } catch {
    return null;
  }
}

// ---- 障害時スキップの共通ヘルパー --------------------------------------------
// runStructured は内部で1回リトライ済み（client.ts）。それでも throw したら debug に記録し
// fallback を返す。Promise.all の各要素をこれでラップし、1エージェント失敗が全体を落とさない
// 「空扱い」を1箇所に集約する。
async function runAgentSafe<T>(
  label: string,
  fn: () => Promise<{ data: T; usage: unknown; totalCostUsd: number }>,
  fallback: T,
  debug?: DebugSink,
): Promise<T> {
  try {
    const result = await fn();
    debug?.(`agent:${label}`, {
      usage: result.usage,
      totalCostUsd: result.totalCostUsd,
    });
    return result.data;
  } catch (error) {
    debug?.(`agent:${label}:failed`, {
      error: error instanceof Error ? error.message : error,
    });
    return fallback;
  }
}

// finding 配列を返す runStructured 呼び出しの共通形（agent1〜5 で同型）。
// FINDINGS_SCHEMA は { findings: Finding[] } でラップされている（prompts.ts 参照）ため、
// ここで .findings を取り出して runAgentSafe の fallback（空配列）と揃える。
async function runFindingsAgent(
  system: string,
  user: string,
  model: string,
  queryFn: QueryFn | undefined,
): Promise<{ data: unknown[]; usage: unknown; totalCostUsd: number }> {
  const result = await runStructured<{ findings: unknown[] }>(
    { system, user, model, schema: FINDINGS_SCHEMA },
    { query: queryFn },
  );
  return {
    data: result.data.findings,
    usage: result.usage,
    totalCostUsd: result.totalCostUsd,
  };
}

// ---- step2: サマリ + 影響クラスタ分割 ----------------------------------------

export interface SummaryAndClustersResult {
  summary: string | null;
  rawClusters: unknown;
}

export async function llmSummaryAndClusters(
  ctx: Context,
  diffText: string,
  authorInfo: string,
  deps: StepDeps = {},
): Promise<SummaryAndClustersResult> {
  const wantClusters = ctx.tier !== "tiny";
  const queryFn = deps.query;

  const fallback: SummaryAndClustersResult = {
    summary: null,
    rawClusters: [] as unknown[],
  };
  return runAgentSafe<SummaryAndClustersResult>(
    "summary",
    async () => {
      const result = await runStructured<{
        summary: string;
        clusters?: unknown;
      }>(
        {
          system: summaryClustersSystem({ wantClusters }),
          user: summaryClustersUser({ authorInfo, diffText, wantClusters }),
          model: MODEL_LIGHT,
          schema: wantClusters ? SUMMARY_CLUSTERS_SCHEMA : SUMMARY_ONLY_SCHEMA,
        },
        { query: queryFn },
      );
      return {
        data: {
          summary: result.data.summary,
          rawClusters: wantClusters ? (result.data.clusters ?? []) : [],
        },
        usage: result.usage,
        totalCostUsd: result.totalCostUsd,
      };
    },
    fallback,
    deps.debug,
  );
}

// ---- step3: レビューエージェント（agent1〜5） --------------------------------

export interface ReviewAgentsInput {
  ctx: Context;
  diffText: string;
  clusters: Cluster[];
  summary: string | null;
}

// finding の agent 番号をコード側で上書きする（LLM 出力の agent を信用しない）。
// validateFinding が agent 種別（RULE_AGENTS={1,2,5}）と category の整合を強制するため、
// 番号ずれが invalid を招く。
function stampAgent(findings: unknown, agent: number): unknown[] {
  if (!Array.isArray(findings)) return [];
  return findings.map((f) =>
    f && typeof f === "object"
      ? { ...(f as Record<string, unknown>), agent }
      : f,
  );
}

// クラスタの changedFiles だけに絞った diff を切り出す。
// diff --git a/<path> b/<path> のブロック単位でフィルタする素朴な実装。
// cluster.changedFiles は b/ 側（新パス）で統一されている前提（diff-anchor.ts の parseDiff も
// b/ 側を採用）だが、クラスタ分割 LLM が rename 時に旧パス（a/ 側）を書く可能性への
// 防御として m[1]（a/ 側）も照合し、どちらか一致すれば残す。
function filterDiffByFiles(diffText: string, files: string[]): string {
  const fileSet = new Set(files);
  const blocks = diffText.split(/(?=^diff --git )/m);
  return blocks
    .filter((block) => {
      const m = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      if (!m) return false;
      return fileSet.has(m[2] ?? "") || fileSet.has(m[1] ?? "");
    })
    .join("");
}

export async function llmReviewAgents(
  input: ReviewAgentsInput,
  deps: StepDeps = {},
): Promise<unknown[]> {
  const { ctx, diffText, clusters, summary } = input;
  const queryFn = deps.query;
  const readFile = deps.readFile ?? defaultReadFile;
  const debug = deps.debug;

  const tasks: Promise<unknown[]>[] = [];

  // agent1/2: プロジェクトルール準拠チェック。assignments[0]/[1] それぞれ担当ファイルが
  // 空でないときだけ起動する（tiny/small は buildAssignments が buckets[1] を空にするので
  // agent2 は追加の tier 判定なしで自動的に非起動）。
  const ruleAssignments: { agent: number; assignment: Assignment }[] = [
    { agent: 1, assignment: ctx.assignments[0] },
    { agent: 2, assignment: ctx.assignments[1] },
  ].filter(
    (a): a is { agent: number; assignment: Assignment } =>
      a.assignment !== undefined && a.assignment.files.length > 0,
  );
  for (const { agent, assignment } of ruleAssignments) {
    tasks.push(
      runAgentSafe(
        `agent${agent}`,
        () => {
          const ruleTexts = collectRuleTexts(assignment.files, readFile);
          return runFindingsAgent(
            ruleAgentSystem(),
            ruleAgentUser({ agent, assignment, ruleTexts, summary, diffText }),
            MODEL_LIGHT,
            queryFn,
          );
        },
        [],
        debug,
      ).then((findings) => stampAgent(findings, agent)),
    );
  }

  // agent3: バグ検出（diff 限定）。tier !== "tiny" のときのみ起動。
  if (ctx.tier !== "tiny") {
    tasks.push(
      runAgentSafe(
        "agent3",
        () =>
          runFindingsAgent(
            bugAgentSystem(),
            bugAgentUser({ summary, diffText }),
            MODEL_HEAVY,
            queryFn,
          ),
        [],
        debug,
      ).then((findings) => stampAgent(findings, 3)),
    );
  }

  // agent4: バグ検出／クロスファイル整合性チェック。各クラスタ1インスタンス並列。
  // contextHints の存在するファイル本文のみ埋め込む。
  for (const cluster of clusters) {
    tasks.push(
      runAgentSafe(
        `agent4:cluster${cluster.id}`,
        () => {
          const contextFiles = cluster.contextHints.map((path) => ({
            path,
            content: readFile(path),
          }));
          const clusterDiff = filterDiffByFiles(diffText, cluster.changedFiles);
          return runFindingsAgent(
            clusterAgentSystem(),
            clusterAgentUser({
              cluster,
              summary,
              diffText: clusterDiff,
              contextFiles,
            }),
            MODEL_HEAVY,
            queryFn,
          );
        },
        [],
        debug,
      ).then((findings) => stampAgent(findings, 4)),
    );
  }

  // agent5: REVIEW.md 準拠チェック。readFile("REVIEW.md") が非 null のときのみ起動。
  const reviewMd = readFile("REVIEW.md");
  if (reviewMd !== null) {
    tasks.push(
      runAgentSafe(
        "agent5",
        () =>
          runFindingsAgent(
            reviewMdAgentSystem(),
            reviewMdAgentUser({ reviewMd, summary, diffText }),
            MODEL_LIGHT,
            queryFn,
          ),
        [],
        debug,
      ).then((findings) => stampAgent(findings, 5)),
    );
  }

  const results = await Promise.all(tasks);
  return results.flat();
}

function collectRuleTexts(
  files: { path: string; rules: string[] }[],
  readFile: (relPath: string) => string | null,
): { path: string; content: string | null }[] {
  const rulePaths = new Set<string>();
  for (const f of files) {
    for (const r of f.rules) rulePaths.add(r);
  }
  return [...rulePaths].map((path) => ({ path, content: readFile(path) }));
}

// ---- step5: 統合文章作成 -----------------------------------------------------

export async function llmMergeTexts(
  findingsDoc: FindingsDoc,
  deps: StepDeps = {},
): Promise<MergeText[]> {
  const queryFn = deps.query;
  const debug = deps.debug;
  const targets = findingsDoc.groups.filter((g) => g.needsMergeText);
  if (targets.length === 0) return [];

  const findingById = new Map(findingsDoc.findings.map((f) => [f.id, f]));

  const results = await Promise.all(
    targets.map(async (group) => {
      const members = group.memberIds.map((id) => findingById.get(id)!);
      // 失敗グループの縮退: 先頭メンバー finding の title/body をフォールバックにして必ず埋める
      // （欠落 throw を回避）。
      const head = members[0]!;
      const fallback: { title: string; body: string } = {
        title: head.title ?? "",
        body: head.body ?? "",
      };
      const text = await runAgentSafe(
        `merge:${group.id}`,
        async () => {
          const result = await runStructured<{ title: string; body: string }>(
            {
              system: mergeTextSystem(),
              user: mergeTextUser({ members }),
              model: MODEL_LIGHT,
              schema: MERGE_TEXT_SCHEMA,
            },
            { query: queryFn },
          );
          return {
            data: result.data,
            usage: result.usage,
            totalCostUsd: result.totalCostUsd,
          };
        },
        fallback,
        debug,
      );
      return {
        groupId: group.id,
        title: text.title,
        body: text.body,
      } satisfies MergeText;
    }),
  );

  return results;
}

// ---- step6: 検証 --------------------------------------------------------------

export async function llmVerifyIssues(
  issues: Issue[],
  // biome-ignore lint/correctness/noUnusedFunctionParameters: 呼び出し側 API 互換のため保持（既存実装、未使用理由は未調査）
  diffText: string,
  summary: string | null,
  deps: StepDeps = {},
): Promise<Verdict[]> {
  const queryFn = deps.query;
  const debug = deps.debug;

  const results = await Promise.all(
    issues.map(async (issue) => {
      const model = issue.kind === "bug" ? MODEL_HEAVY : MODEL_LIGHT;
      // 失敗 issue の縮退: その verdict を配列に含めない → applyVerdicts が自動的に
      // unverified にする。runAgentSafe に null フォールバックを渡し、後段でフィルタする。
      const verdict = await runAgentSafe<{
        verdict: "confirmed" | "rejected";
        reason: string;
      } | null>(
        `verify:${issue.id}`,
        async () => {
          const result = await runStructured<{
            verdict: "confirmed" | "rejected";
            reason: string;
          }>(
            {
              system: verifySystem(),
              user: verifyUser({ issue, summary }),
              model,
              schema: VERDICT_SCHEMA,
            },
            { query: queryFn },
          );
          return {
            data: result.data,
            usage: result.usage,
            totalCostUsd: result.totalCostUsd,
          };
        },
        null,
        debug,
      );
      return verdict === null
        ? null
        : ({
            id: issue.id,
            verdict: verdict.verdict,
            reason: verdict.reason,
          } as Verdict);
    }),
  );

  return results.filter((v): v is Verdict => v !== null);
}
