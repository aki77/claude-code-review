// パイプラインのオーケストレータ（local-review / pr-review 共通コア）。
//
// データフロー:
//   collectContext → diff 取得 → 著者意図情報 → llmSummaryAndClusters →
//   clusters 確定（validateClusters / tierReducedClusters）→ llmReviewAgents →
//   processFindings → retryUnresolvedAnchors（未解決のみ・1回だけ）→ llmMergeTexts →
//   mergeFindings → llmVerifyIssues → applyVerdicts →
//   (pr-review のみ) llmCommentBodies → postReview
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { applyVerdicts } from "./lib/apply-verdicts.ts";
import {
  type CollectContextOpts,
  collectContext,
} from "./lib/collect-context.ts";
import { buildDiffArgs } from "./lib/diff-anchor.ts";
import { execFileAsync } from "./lib/exec.ts";
import { mergeFindings } from "./lib/merge-findings.ts";
import { postReview } from "./lib/post-review.ts";
import { assertPrHeadMatches } from "./lib/pr-head.ts";
import {
  fetchPrMeta,
  formatPrAuthorInfo,
  getNameWithOwner,
} from "./lib/pr-meta.ts";
import { processFindings } from "./lib/process-findings.ts";
import { makeProgressReporter, type ProgressReporter } from "./lib/progress.ts";
import type { Context, FinalDoc } from "./lib/types.ts";
import {
  tierReducedClusters,
  validateClusters,
} from "./lib/validate-clusters.ts";
import type { QueryFn } from "./llm/client.ts";
import {
  type CostSink,
  type DebugSink,
  defaultReadFile,
  llmCommentBodies,
  llmMergeTexts,
  llmReviewAgents,
  llmSummaryAndClusters,
  llmVerifyIssues,
  retryUnresolvedAnchors,
} from "./llm/steps.ts";

type Exec = typeof execFileAsync;

export interface PipelineDeps {
  exec?: Exec;
  query?: QueryFn;
  // 既定: fs.readFileSync、例外→null。
  readFile?: (relPath: string) => string | null;
}

export interface PipelineResult {
  final: FinalDoc;
  ctx: Context;
}

export interface PrReviewResult extends PipelineResult {
  postedUrl?: string;
  headRefOid: string;
}

// diff の maxBuffer。巨大な diff でも打ち切られないよう大きめに確保する。
const DIFF_MAX_BUFFER = 256 * 1024 * 1024;

// 著者意図情報がコミットメッセージから得られない（staged / git log 空）場合の共通フォールバック文言。
const DIFF_ONLY_AUTHOR_INFO = "diff のみから意図推定してください。";

// local-review / pr-review 共通コア（CTX 確定後〜FINAL 生成まで）。
// skipSummaryAgent: true なら summary/clusters の LLM 呼び出しをスキップし、authorInfo を
// そのまま summary に使う（small-PR コスト削減）。
async function runReviewCore(
  ctx: Context,
  authorInfo: string,
  skipSummaryAgent: boolean,
  deps: Required<Pick<PipelineDeps, "exec" | "readFile">> &
    Pick<PipelineDeps, "query"> & {
      debug: DebugSink;
      progress: ProgressReporter;
    },
): Promise<{ final: FinalDoc; totalCostUsd: number }> {
  const { exec, query, readFile, debug, progress } = deps;

  // 実行全体のコスト集計。モデルIDごとに ModelUsage を加算し、debug("cost-summary", ...) で
  // final の直後に出力する（SDK の result.modelUsage をそのまま集計するため、モデル混在時も
  // 正確な内訳になる）。
  // 加算対象は実測値のみ（contextWindow/maxOutputTokens はモデル固有のスペック値であり
  // 加算しない。ModelUsage にフィールドが増えても手作業の追随が要らないようループで加算する）。
  const ACCUMULATED_USAGE_FIELDS = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
  ] as const satisfies readonly (keyof ModelUsage)[];
  const costs: Record<string, ModelUsage> = {};
  const costSink: CostSink = (modelUsage) => {
    for (const [model, usage] of Object.entries(modelUsage)) {
      const acc = costs[model];
      if (acc === undefined) {
        costs[model] = { ...usage };
      } else {
        for (const field of ACCUMULATED_USAGE_FIELDS) {
          acc[field] += usage[field];
        }
      }
    }
  };

  // diff 取得（統一 diff。以降の全ステップがこの diff を使う）。
  progress.startStep("diff 取得");
  const diffResult = await exec("git", buildDiffArgs(ctx), {
    maxBuffer: DIFF_MAX_BUFFER,
  });
  const diffText = diffResult.stdout;
  progress.succeedStep();

  if (diffText.trim() === "") {
    const emptyFinal: FinalDoc = {
      issues: [],
      rejected: [],
      unverified: [],
      stats: { total: 0, confirmed: 0, rejected: 0, unverified: 0 },
    };
    debug("final", emptyFinal);
    debug("cost-summary", { totalCostUsd: 0, byModel: {} });
    return { final: emptyFinal, totalCostUsd: 0 };
  }

  // サマリ + クラスタ分割案。small-PR は summary の LLM 呼び出しを省き、著者意図情報
  // （PR タイトル/説明）をそのまま summary に流す（LLM 1回分のコスト削減）。
  // skipSummaryAgent 時は要約ステップを startStep せず、静かにスキップする。
  let summary: string | null;
  let rawClusters: unknown;
  if (skipSummaryAgent) {
    summary = authorInfo;
    rawClusters = [];
  } else {
    const result = await llmSummaryAndClusters(ctx, diffText, authorInfo, {
      query,
      debug,
      costSink,
      progress,
    });
    summary = result.summary;
    rawClusters = result.rawClusters;
    progress.succeedStep();
  }
  debug("summary", summary);

  // clusters 確定。normal のみ LLM 出力を検証、それ以外は決定論的縮退。
  const clustersDoc =
    ctx.tier === "normal" && !skipSummaryAgent
      ? validateClusters(rawClusters, ctx.changedFiles)
      : tierReducedClusters(ctx.changedFiles);
  debug("clustersDoc", clustersDoc);

  // レビューエージェント(agent1〜5)。
  const rawFindings = await llmReviewAgents(
    { ctx, diffText, clusters: clustersDoc.clusters, summary },
    { query, readFile, debug, costSink, progress },
  );

  // finding 機械処理。
  let findingsDoc = processFindings(rawFindings, { ctx, diffText });
  debug("findingsDoc", findingsDoc);
  progress.succeedStep(`${findingsDoc.findings.length} findings`);

  // step4b: 未解決アンカー再解決。LLM に existingCode を diff に逐語一致するよう
  // 1回だけ再出力させ、processFindings に prev として再投入して再解決する（ループしない）。
  if (findingsDoc.stats.unresolved > 0) {
    const patches = await retryUnresolvedAnchors(findingsDoc, diffText, {
      query,
      debug,
      costSink,
      progress,
    });
    if (patches.length > 0) {
      findingsDoc = processFindings(patches, {
        ctx,
        diffText,
        prev: findingsDoc,
      });
      debug("findingsDoc:retried", findingsDoc);
    }
    progress.succeedStep();
  }

  // 統合文章作成。
  const mergeTexts = await llmMergeTexts(findingsDoc, {
    query,
    debug,
    costSink,
    progress,
  });
  debug("mergeTexts", mergeTexts);
  if (mergeTexts.length > 0) progress.succeedStep();

  // ISSUES 生成。
  const issuesDoc = mergeFindings(findingsDoc, mergeTexts);
  debug("issuesDoc", issuesDoc);

  // 検証。
  const verdicts = await llmVerifyIssues(issuesDoc.issues, diffText, summary, {
    query,
    debug,
    costSink,
    progress,
  });
  debug("verdicts", verdicts);

  // FINAL 生成。applyVerdicts が confirmed/rejected を集計済みなので、
  // progress の note にはそれをそのまま使う（二重集計を避ける）。
  const final = applyVerdicts(issuesDoc, verdicts);
  progress.succeedStep(
    `confirmed:${final.stats.confirmed} rejected:${final.stats.rejected}`,
  );
  debug("final", final);
  const totalCostUsd = Object.values(costs).reduce(
    (sum, m) => sum + m.costUSD,
    0,
  );
  debug("cost-summary", { totalCostUsd, byModel: costs });

  return { final, totalCostUsd };
}

function makeDebugSink(enabled: boolean): DebugSink {
  return enabled
    ? (label, obj) => {
        process.stderr.write(
          `[debug] ${label}:\n${JSON.stringify(obj, null, 2)}\n`,
        );
      }
    : () => {};
}

export async function runLocalReview(
  opts: CollectContextOpts,
  runOpts: { debug: boolean; quiet?: boolean },
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const exec = deps.exec ?? execFileAsync;
  const query = deps.query;
  const readFile = deps.readFile ?? defaultReadFile;
  const debug = makeDebugSink(runOpts.debug);
  const progress = makeProgressReporter({
    quiet: runOpts.quiet ?? false,
    debug: runOpts.debug,
  });

  let totalCostUsd = 0;
  try {
    progress.startStep("コンテキスト収集");
    const ctx = await collectContext(opts, { exec });
    debug("ctx", ctx);
    progress.succeedStep();

    // 著者意図情報。staged はコミットが無いため diff のみの固定文言、それ以外（range）は
    // git log。ctx.range が無い、または git log が空ならフォールバックする。
    let authorInfo: string;
    if (ctx.source === "staged") {
      authorInfo = `ステージ済み変更・コミットなし。${DIFF_ONLY_AUTHOR_INFO}`;
    } else if (ctx.range) {
      const logResult = await exec("git", [
        "log",
        "--format=%H%n%s%n%b%n---",
        ctx.range,
      ]);
      authorInfo =
        logResult.stdout.trim() ||
        `（コミットメッセージなし）${DIFF_ONLY_AUTHOR_INFO}`;
    } else {
      authorInfo = `（コミットメッセージなし）${DIFF_ONLY_AUTHOR_INFO}`;
    }

    const result = await runReviewCore(ctx, authorInfo, false, {
      exec,
      query,
      readFile,
      debug,
      progress,
    });
    totalCostUsd = result.totalCostUsd;

    return { final: result.final, ctx };
  } finally {
    progress.done();
    progress.reportCost(totalCostUsd);
  }
}

export async function runPrReview(
  pr: string,
  runOpts: { debug: boolean; comment: boolean; quiet?: boolean },
  deps: PipelineDeps = {},
): Promise<PrReviewResult> {
  const exec = deps.exec ?? execFileAsync;
  const query = deps.query;
  const readFile = deps.readFile ?? defaultReadFile;
  const debug = makeDebugSink(runOpts.debug);
  const progress = makeProgressReporter({
    quiet: runOpts.quiet ?? false,
    debug: runOpts.debug,
  });

  let totalCostUsd = 0;
  try {
    // step0: PR メタ取得（headRefOid・baseRefOid・baseRefName を含む。gh pr view の
    // 重複呼び出しを避ける。collectContext の PR モードにも baseRef として渡す）。
    progress.startStep("コンテキスト収集");
    const meta = await fetchPrMeta(pr, { exec });
    debug("prMeta", meta);

    // step0: ローカル HEAD と PR HEAD の一致ゲート。LLM コストを一切かける前に確認する。
    await assertPrHeadMatches(pr, meta.headRefOid, { exec });

    const ctx = await collectContext(
      {
        mode: "pr",
        pr,
        baseRef: { baseRefOid: meta.baseRefOid, baseRefName: meta.baseRefName },
      },
      { exec },
    );
    debug("ctx", ctx);
    progress.succeedStep();

    const authorInfo = formatPrAuthorInfo(meta);

    const result = await runReviewCore(ctx, authorInfo, ctx.tier === "small", {
      exec,
      query,
      readFile,
      debug,
      progress,
    });
    totalCostUsd = result.totalCostUsd;
    const { final } = result;

    if (!runOpts.comment) {
      return { final, ctx, headRefOid: meta.headRefOid };
    }

    const nameWithOwner = await getNameWithOwner({ exec });
    const postInput = await llmCommentBodies(
      final,
      { prHeadSha: meta.headRefOid, nameWithOwner },
      { query, debug, progress },
    );
    debug("postInput", postInput);
    if (final.issues.filter((i) => i.resolved).length > 0) {
      progress.succeedStep();
    }
    progress.startStep("投稿");
    const postedUrl = await postReview({
      pr,
      nameWithOwner,
      postInput,
      final,
      commitId: meta.headRefOid,
      exec,
    });
    progress.succeedStep();

    return { final, ctx, postedUrl, headRefOid: meta.headRefOid };
  } finally {
    progress.done();
    progress.reportCost(totalCostUsd);
  }
}
