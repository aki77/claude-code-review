// パイプラインのオーケストレータ（local-review E2E）。
//
// データフロー（docs/plans/04-llm-steps.md）:
//   collectContext → diff 取得 → 著者意図情報 → llmSummaryAndClusters →
//   clusters 確定（validateClusters / tierReducedClusters）→ llmReviewAgents →
//   processFindings → [step4b スキップ] → llmMergeTexts → mergeFindings →
//   llmVerifyIssues → applyVerdicts → 呼び出し側が出力
import { applyVerdicts } from "./lib/apply-verdicts.js";
import { collectContext, type CollectContextOpts } from "./lib/collect-context.js";
import { buildDiffArgs } from "./lib/diff-anchor.js";
import { execFileAsync } from "./lib/exec.js";
import { mergeFindings } from "./lib/merge-findings.js";
import { processFindings } from "./lib/process-findings.js";
import type { Context, FinalDoc } from "./lib/types.js";
import { tierReducedClusters, validateClusters } from "./lib/validate-clusters.js";
import type { QueryFn } from "./llm/client.js";
import {
  defaultReadFile,
  llmMergeTexts,
  llmReviewAgents,
  llmSummaryAndClusters,
  llmVerifyIssues,
  type DebugSink,
} from "./llm/steps.js";

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

// diff の maxBuffer。巨大な diff でも打ち切られないよう大きめに確保する。
const DIFF_MAX_BUFFER = 256 * 1024 * 1024;

// 著者意図情報がコミットメッセージから得られない（staged / git log 空）場合の共通フォールバック文言。
const DIFF_ONLY_AUTHOR_INFO = "diff のみから意図推定してください。";

export async function runLocalReview(
  opts: CollectContextOpts,
  runOpts: { debug: boolean },
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const exec = deps.exec ?? execFileAsync;
  const query = deps.query;
  const readFile = deps.readFile ?? defaultReadFile;

  const debug: DebugSink = runOpts.debug
    ? (label, obj) => {
        process.stderr.write(`[debug] ${label}:\n${JSON.stringify(obj, null, 2)}\n`);
      }
    : () => {};

  // 1. CTX 確定。
  const ctx = await collectContext(opts, { exec });
  debug("ctx", ctx);

  // 2. diff 取得（統一 diff。以降の全ステップがこの diff を使う）。
  const diffResult = await exec("git", buildDiffArgs(ctx), { maxBuffer: DIFF_MAX_BUFFER });
  const diffText = diffResult.stdout;

  if (diffText.trim() === "") {
    const emptyFinal: FinalDoc = {
      issues: [],
      rejected: [],
      unverified: [],
      stats: { total: 0, confirmed: 0, rejected: 0, unverified: 0 },
    };
    debug("final", emptyFinal);
    return { final: emptyFinal, ctx };
  }

  // 3. 著者意図情報。staged はコミットが無いため diff のみの固定文言、それ以外（range）は
  // git log。ctx.range が無い、または git log が空ならフォールバックする。
  let authorInfo: string;
  if (ctx.source === "staged") {
    authorInfo = `ステージ済み変更・コミットなし。${DIFF_ONLY_AUTHOR_INFO}`;
  } else if (ctx.range) {
    const logResult = await exec("git", ["log", "--format=%H%n%s%n%b%n---", ctx.range]);
    authorInfo = logResult.stdout.trim() || `（コミットメッセージなし）${DIFF_ONLY_AUTHOR_INFO}`;
  } else {
    authorInfo = `（コミットメッセージなし）${DIFF_ONLY_AUTHOR_INFO}`;
  }

  // 4. サマリ + クラスタ分割案。
  const { summary, rawClusters } = await llmSummaryAndClusters(ctx, diffText, authorInfo, {
    query,
    debug,
  });
  debug("summary", summary);

  // 5. clusters 確定。normal のみ LLM 出力を検証、それ以外は決定論的縮退。
  const clustersDoc =
    ctx.tier === "normal"
      ? validateClusters(rawClusters, ctx.changedFiles)
      : tierReducedClusters(ctx.changedFiles);
  debug("clustersDoc", clustersDoc);

  // 6. レビューエージェント（agent1〜5）。
  const rawFindings = await llmReviewAgents(
    { ctx, diffText, clusters: clustersDoc.clusters, summary },
    { query, readFile, debug },
  );

  // 7. finding 機械処理。
  const findingsDoc = processFindings(rawFindings, { ctx, diffText });
  debug("findingsDoc", findingsDoc);

  // 8. step4b スキップ（Phase 4 では未解決アンカー再解決を行わない）: unresolved 件数のみ
  // debug 出力する。将来的には retryUnresolvedAnchors(findingsDoc, diffText, ctx) を呼び、
  // LLM に existingCode を再出力させて processFindings(patch, {ctx, diffText, prev: findingsDoc})
  // を1回呼ぶ形になる（この関数境界はまだ実装していない）。
  if (findingsDoc.stats.unresolved > 0) {
    debug("unresolved-skip", { unresolved: findingsDoc.stats.unresolved });
  }

  // 9. 統合文章作成。
  const mergeTexts = await llmMergeTexts(findingsDoc, { query, debug });
  debug("mergeTexts", mergeTexts);

  // 10. ISSUES 生成。
  const issuesDoc = mergeFindings(findingsDoc, mergeTexts);
  debug("issuesDoc", issuesDoc);

  // 11. 検証。
  const verdicts = await llmVerifyIssues(issuesDoc.issues, diffText, summary, { query, debug });
  debug("verdicts", verdicts);

  // 12. FINAL 生成。
  const final = applyVerdicts(issuesDoc, verdicts);
  debug("final", final);

  return { final, ctx };
}
