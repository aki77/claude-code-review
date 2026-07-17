// パイプラインの LLM ステップ本体（step2/3/5/6）。
//
// 各関数は最終引数に deps?: {query?, readFile?, debug?} を取り、内部で
// runStructured(opts, {query}) へ委譲する。usage/totalCostUsd は debug 時のみ合算する。
// 設計原則: LLM は意味判断のみ。位置解決・検証・フィルタ適用・
// 構造転写・グルーピング・並列制御はすべてコードで決定論的に行う（Promise.all で並列化）。
import { readFileSync } from "node:fs";
import type {
  McpServerConfig,
  ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortError } from "../lib/abort.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { ProgressReporter } from "../lib/progress.ts";
import type {
  Assignment,
  Cluster,
  Context,
  FinalDoc,
  FindingsDoc,
  Issue,
  MergeText,
  PostReviewComment,
  PostReviewInput,
  ReadFileFn,
  Verdict,
} from "../lib/types.ts";
import { formatBadge } from "../report.ts";
import {
  type QueryFn,
  type RunStructuredResult,
  runStructured,
} from "./client.ts";
import {
  bugAgentSystem,
  bugAgentUser,
  buildReviewOpts,
  COMMENT_BODIES_SCHEMA,
  clusterAgentSystem,
  clusterAgentUser,
  commentBodiesSystem,
  commentBodiesUser,
  FINDINGS_SCHEMA,
  MERGE_TEXT_SCHEMA,
  MODEL_HEAVY,
  MODEL_LIGHT,
  mergeTextSystem,
  mergeTextUser,
  RETRY_ANCHOR_SCHEMA,
  retryAnchorSystem,
  retryAnchorUser,
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

// 実行全体のコスト集計器。runAgentSafe の成功パスで modelUsage を受け取り、
// 呼び出し側（pipeline.ts）がモデルごとに加算する。
export type CostSink = (modelUsage: Record<string, ModelUsage>) => void;

export interface StepDeps {
  query?: QueryFn;
  readFile?: (relPath: string) => string | null;
  debug?: DebugSink;
  costSink?: CostSink;
  progress?: ProgressReporter;
  // Ctrl+C 中断伝播用。渡すと各 runStructured 呼び出しに abortController として配線される。
  abortController?: AbortController;
  // プロジェクト設定（.claude/review.yaml + env）。省略時は各ステップが現行の
  // module const/env フォールバックを使う（pipeline.ts が loadConfig() の結果を注入する）。
  config?: ResolvedConfig;
}

// config.models 省略時の module const フォールバックを1箇所に集約する。
// 各ステップ関数が `deps.config?.models.light ?? MODEL_LIGHT` を個別に手書きしていた
// 重複（6箇所）をこのヘルパー呼び出しに置き換える。
function resolveModels(config?: ResolvedConfig): {
  light: string;
  heavy: string;
} {
  return {
    light: config?.models.light ?? MODEL_LIGHT,
    heavy: config?.models.heavy ?? MODEL_HEAVY,
  };
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
  fn: () => Promise<RunStructuredResult<T>>,
  fallback: T,
  debug?: DebugSink,
  costSink?: CostSink,
  progress?: ProgressReporter,
): Promise<T> {
  try {
    const result = await fn();
    debug?.(`agent:${label}`, {
      usage: result.usage,
      totalCostUsd: result.totalCostUsd,
    });
    costSink?.(result.modelUsage);
    return result.data;
  } catch (error) {
    // Ctrl+C 中断由来のエラーは「1エージェント失敗を空 fallback で握り潰す」対象外。
    // 握り潰すと各エージェントが空 findings を返して処理が続行してしまい、中断が効かない。
    if (isAbortError(error)) {
      throw error;
    }
    debug?.(`agent:${label}:failed`, {
      error: error instanceof Error ? error.message : error,
    });
    return fallback;
  } finally {
    progress?.tickAgent();
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
  reviewOpts: {
    allowedTools?: string[];
    mcpServers?: Record<string, McpServerConfig>;
    abortController?: AbortController;
  } = {},
): Promise<RunStructuredResult<unknown[]>> {
  const result = await runStructured<{ findings: unknown[] }>(
    { system, user, model, schema: FINDINGS_SCHEMA, ...reviewOpts },
    { query: queryFn },
  );
  return { ...result, data: result.data.findings };
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
  const wantClusters = ctx.tier === "normal";
  const queryFn = deps.query;
  const { light: modelLight } = resolveModels(deps.config);

  deps.progress?.startStep("要約", 1);
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
          model: modelLight,
          schema: wantClusters ? SUMMARY_CLUSTERS_SCHEMA : SUMMARY_ONLY_SCHEMA,
          abortController: deps.abortController,
        },
        { query: queryFn },
      );
      return {
        ...result,
        data: {
          summary: result.data.summary,
          rawClusters: wantClusters ? (result.data.clusters ?? []) : [],
        },
      };
    },
    fallback,
    deps.debug,
    deps.costSink,
    deps.progress,
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
  const costSink = deps.costSink;
  const progress = deps.progress;
  const config = deps.config;
  const { light: modelLight, heavy: modelHeavy } = resolveModels(config);
  // 全レビュー系エージェント（agent1〜5）共通の allowedTools/mcpServers（＋中断用 abortController）。
  const reviewOpts = buildReviewOpts(deps.abortController, config);

  const tasks: Promise<unknown[]>[] = [];

  // agent1/2: プロジェクトルール準拠チェック。assignments[0]/[1] それぞれ担当ファイルが
  // 空でないときだけ起動する（small は buildAssignments が buckets[1] を空にするので
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
            ruleAgentSystem(config),
            ruleAgentUser({ agent, assignment, ruleTexts, summary, diffText }),
            modelLight,
            queryFn,
            reviewOpts,
          );
        },
        [],
        debug,
        costSink,
        progress,
      ).then((findings) => stampAgent(findings, agent)),
    );
  }

  // agent3: バグ検出。tier によらず常に起動。
  tasks.push(
    runAgentSafe(
      "agent3",
      () =>
        runFindingsAgent(
          bugAgentSystem(config),
          bugAgentUser({ summary, diffText }),
          modelHeavy,
          queryFn,
          reviewOpts,
        ),
      [],
      debug,
      costSink,
      progress,
    ).then((findings) => stampAgent(findings, 3)),
  );

  // agent4: バグ検出／クロスファイル整合性チェック。各クラスタ1インスタンス並列。
  // contextHints のファイル本文は起点ヒントとして埋め込みつつ、それ以外の diff 外
  // ファイルも read-only ツール（Read/Grep/Glob）で能動的に参照できるようにする。
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
            clusterAgentSystem(config),
            clusterAgentUser({
              cluster,
              summary,
              diffText: clusterDiff,
              contextFiles,
            }),
            modelHeavy,
            queryFn,
            reviewOpts,
          );
        },
        [],
        debug,
        costSink,
        progress,
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
            reviewMdAgentSystem(config),
            reviewMdAgentUser({ reviewMd, summary, diffText }),
            modelLight,
            queryFn,
            reviewOpts,
          ),
        [],
        debug,
        costSink,
        progress,
      ).then((findings) => stampAgent(findings, 5)),
    );
  }

  progress?.startStep("レビュー", tasks.length);
  const results = await Promise.all(tasks);
  return results.flat();
}

function collectRuleTexts(
  files: { path: string; rules: string[] }[],
  readFile: ReadFileFn,
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
  const costSink = deps.costSink;
  const progress = deps.progress;
  const { light: modelLight } = resolveModels(deps.config);
  const targets = findingsDoc.groups.filter((g) => g.needsMergeText);
  if (targets.length === 0) return [];

  progress?.startStep("統合文章作成", targets.length);
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
              model: modelLight,
              schema: MERGE_TEXT_SCHEMA,
              abortController: deps.abortController,
            },
            { query: queryFn },
          );
          return result;
        },
        fallback,
        debug,
        costSink,
        progress,
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

// ---- step4b: 未解決アンカー再解決 ---------------------------------------------

// 未解決 finding の existingCode を LLM に逐語コピーし直させ、パッチ配列を返す。
// パッチ適用（processFindings への再投入）は pipeline.ts 側の責務（既存ステップの
// 層分離＝LLM 呼び出しと決定論処理を分ける方針に合わせる）。
export async function retryUnresolvedAnchors(
  findingsDoc: FindingsDoc,
  diffText: string,
  deps: StepDeps = {},
): Promise<{ id: string; existingCode: string }[]> {
  const queryFn = deps.query;
  const debug = deps.debug;
  const costSink = deps.costSink;
  const progress = deps.progress;
  const { light: modelLight } = resolveModels(deps.config);

  const unresolved = findingsDoc.findings.filter(
    (f) => f.status === "active" && !f.resolved,
  );
  if (unresolved.length === 0) return [];

  const paths = unresolved
    .map((f) => f.path)
    .filter((p): p is string => typeof p === "string");
  const scopedDiff = filterDiffByFiles(diffText, paths);

  progress?.startStep("未解決アンカー再解決", 1);
  return runAgentSafe<{ id: string; existingCode: string }[]>(
    "retryAnchor",
    async () => {
      const result = await runStructured<{
        patches: { id: string; existingCode: string }[];
      }>(
        {
          system: retryAnchorSystem(),
          user: retryAnchorUser({ unresolved, diffText: scopedDiff }),
          model: modelLight,
          schema: RETRY_ANCHOR_SCHEMA,
          abortController: deps.abortController,
        },
        { query: queryFn },
      );
      return { ...result, data: result.data.patches };
    },
    [],
    debug,
    costSink,
    progress,
  );
}

// ---- step6: 検証 --------------------------------------------------------------

// 検証は allowedTools:["Read","Grep","Glob"] で issue.path を実際に読ませる方式だが、
// read-only ツールは変更後の作業ツリーしか見えず「変更より前から存在する問題」を
// 判定できない。そのため issue.path に絞った diff を verifyUser に埋め込み、
// 今回の変更が持ち込んだ問題かどうかを diff で判断できるようにする。
export async function llmVerifyIssues(
  issues: Issue[],
  diffText: string,
  summary: string | null,
  deps: StepDeps = {},
): Promise<Verdict[]> {
  const queryFn = deps.query;
  const debug = deps.debug;
  const costSink = deps.costSink;
  const progress = deps.progress;
  const config = deps.config;
  const { light: modelLight, heavy: modelHeavy } = resolveModels(config);
  // レビュー系ステップ共通の allowedTools/mcpServers（agent1〜5 と同一方針。steps.ts 冒頭参照）。
  const reviewOpts = buildReviewOpts(deps.abortController, config);

  progress?.startStep("検証", issues.length);
  const results = await Promise.all(
    issues.map(async (issue) => {
      const model = issue.kind === "bug" ? modelHeavy : modelLight;
      const issueDiff = filterDiffByFiles(diffText, [issue.path]);
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
              system: verifySystem(config),
              user: verifyUser({ issue, summary, diffText: issueDiff }),
              model,
              schema: VERDICT_SCHEMA,
              // 検証は「実際に問題か」をコードに当たって判断する必要があるため、
              // read-only ツール（＋opt-in Web）を許可する（書き込み系は一切許可しない）。
              ...reviewOpts,
            },
            { query: queryFn },
          );
          return result;
        },
        null,
        debug,
        costSink,
        progress,
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

// ---- step9: PR コメント本文作成 ------------------------------------------------

export interface CommentBodiesInput {
  prHeadSha: string;
  nameWithOwner: string;
}

// category/severity バッジ（report.ts の formatBadge と共通）とパーマリンクを
// commentBody 先頭に付与する。行番号/sha を LLM に触らせず TS で機械付与する
// （設計原則「構造転写はコード」）。
// 案C: 2行構成。1行目 = 太字バッジ行、2行目 = `<sub>📍 [path:line](permalink)</sub>`。
// permalink 無し（line=undefined、理論上デッドケース）は防御的に場所行を省略しバッジ行のみ返す。
function decorateCommentBody(issue: Issue, input: CommentBodiesInput): string {
  const badge = formatBadge(issue, { bold: true });
  const line =
    issue.params && "line" in issue.params ? issue.params.line : undefined;
  const permalink =
    line !== undefined
      ? `https://github.com/${input.nameWithOwner}/blob/${input.prHeadSha}/${issue.path}#L${line}`
      : undefined;
  const location = permalink
    ? `\n<sub>📍 [${issue.path}:${line}](${permalink})</sub>`
    : "";
  return `${badge}${location}\n\n`;
}

// issue.sourceFindingIds.length !== 1 の issue は suggestion/deleteLines を剥がす
// （複数メンバー統合 issue は existingCode が範囲全体を表さない。buildSuggestionBody の
// post-review.ts:88 ガードと二重防御し「自動判定」注記ノイズを避ける）。
function stripSuggestionIfMerged(
  issue: Issue,
  comment: PostReviewComment,
): PostReviewComment {
  if (issue.sourceFindingIds.length === 1) return comment;
  const { suggestion, deleteLines, ...rest } = comment;
  return rest;
}

// deferred（resolved:false）issue をサマリ本文へ機械的に言及する文言を生成する。
// deferred が0件なら空文字を返す（「問題は見つかりませんでした。」は全体ゼロ件専用の文言
// であり、ここには含めない。inlineable>0 の最終 return からもフォールバックとして呼ばれる
// ため、ここで全体ゼロ件文言を混ぜると矛盾表示になる）。
function formatDeferredSummary(deferred: Issue[]): string {
  if (deferred.length === 0) return "";
  const lines = deferred.map(
    (issue) =>
      `- ${formatBadge(issue, { bold: true })} ${issue.path}  ${issue.title}`,
  );
  return [
    "以下の課題は行番号を確定できず、インライン投稿できませんでした。",
    ...lines,
  ].join("\n");
}

export async function llmCommentBodies(
  final: FinalDoc,
  input: CommentBodiesInput,
  deps: StepDeps = {},
): Promise<PostReviewInput> {
  const queryFn = deps.query;
  const debug = deps.debug;
  const costSink = deps.costSink;
  const progress = deps.progress;
  const { light: modelLight } = resolveModels(deps.config);

  const inlineable = final.issues.filter((i) => i.resolved);
  const deferred = final.issues.filter((i) => !i.resolved);

  if (inlineable.length === 0) {
    // inlineable/deferred とも0件 = レビュー全体で指摘ゼロのときだけ、この文言を使う
    // （formatDeferredSummary は deferred一覧生成に純化済みで全体ゼロ件文言を含まない）。
    const summaryBody =
      deferred.length === 0
        ? "問題は見つかりませんでした。"
        : formatDeferredSummary(deferred);
    return { summaryBody, comments: [] };
  }

  progress?.startStep("コメント本文作成", 1);
  const raw = await runAgentSafe<PostReviewInput>(
    "commentBodies",
    async () => {
      const result = await runStructured<PostReviewInput>(
        {
          system: commentBodiesSystem(),
          user: commentBodiesUser({ inlineable, deferred }),
          model: modelLight,
          schema: COMMENT_BODIES_SCHEMA,
          abortController: deps.abortController,
        },
        { query: queryFn },
      );
      return result;
    },
    { summaryBody: "", comments: [] },
    debug,
    costSink,
    progress,
  );

  const byId = new Map(raw.comments.map((c) => [c.id, c]));

  // 黙殺防止: LLM が欠落させた inlineable issue には title/body から最小 commentBody を
  // TS 合成する（buildPayload の post-review.ts:213 黙殺防止 throw が落ちないことを保証）。
  const comments: PostReviewComment[] = inlineable.map((issue) => {
    const c = byId.get(issue.id) ?? {
      id: issue.id,
      commentBody: issue.body || issue.title,
    };
    const decorated: PostReviewComment = {
      ...c,
      commentBody: `${decorateCommentBody(issue, input)}${c.commentBody}`,
    };
    return stripSuggestionIfMerged(issue, decorated);
  });

  return {
    summaryBody: raw.summaryBody || formatDeferredSummary(deferred),
    comments,
  };
}
