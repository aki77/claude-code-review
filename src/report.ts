// step8: レビュー結果のサマリをターミナルに出力する。
//
// review-core.md:197-203 準拠（投稿なし）。local-review では LLM 生成の「変更概要」は
// 載せない（local-review SKILL.md:29）が、件数サマリは final.issues から決定論的に
// 生成して先頭に出す（追加 LLM 呼び出しはゼロ）。

import { SEVERITY_PRIORITY } from "./lib/process-findings.ts";
import type { Context, FinalDoc, Issue, Severity } from "./lib/types.ts";

// `[category · severity]` バッジ形式。report.ts のサマリ出力・llm/steps.ts の PR コメント
// 本文（バッジ・欠落時のサマリ言及）で共通して使う唯一の定義。
export function formatBadge(
  issue: Pick<Issue, "category" | "severity">,
): string {
  return `[${issue.category ?? "-"} · ${issue.severity ?? "-"}]`;
}

// 表示順は SEVERITY_PRIORITY（process-findings.ts、グループ集約の優先度定義）と同じ順序を
// 二重管理せず導出する。
const SEVERITY_ORDER = Object.keys(SEVERITY_PRIORITY) as Severity[];

// LLM を使わず final.issues の severity 集計から件数サマリ行を組み立てる（決定論・純関数）。
function formatCountSummary(issues: FinalDoc["issues"]): string {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const issue of issues) {
    if (issue.severity) {
      counts[issue.severity]++;
    }
  }
  const breakdown = SEVERITY_ORDER.map((s) => `${s} ${counts[s]}`).join(" / ");
  return `検出 ${issues.length} 件（${breakdown}）`;
}

// 見出し + 本文ブロックを返す。resolved は `path:line`、deferred は `path` のみ + 注記。
function issueBlock(issue: FinalDoc["issues"][number]): string {
  const badge = formatBadge(issue);
  const location =
    issue.resolved && issue.params && "line" in issue.params
      ? `${issue.path}:${issue.params.line}`
      : `${issue.path}（行番号未確定）`;
  return `${badge} ${location}  ${issue.title}\n\n  ${issue.body}`;
}

export function formatSummary(final: FinalDoc, ctx: Context): string {
  const lines: string[] = [];

  if (final.issues.length > 0) {
    lines.push(formatCountSummary(final.issues));
    lines.push("");
    lines.push(final.issues.map((issue) => issueBlock(issue)).join("\n\n"));
  } else {
    lines.push(
      "問題は見つかりませんでした。バグ・プロジェクトルール（CLAUDE.md / .claude/rules/）準拠・REVIEW.md準拠を確認しました。",
    );
  }

  if (final.stats.rejected > 0) {
    lines.push("");
    lines.push(`rejected: ${final.stats.rejected} 件`);
    for (const r of final.rejected) {
      lines.push(`- ${r.path}  ${r.title}（${r.reason}）`);
    }
  }

  if (final.stats.unverified > 0) {
    lines.push("");
    lines.push(
      `unverified: ${final.stats.unverified} 件（${final.unverified.join(", ")}）`,
    );
  }

  if (ctx.excludedFiles.length > 0) {
    lines.push("");
    lines.push(
      `レビュー対象外: ${ctx.excludedFiles.length} ファイル（生成物/バイナリ等）`,
    );
    for (const f of ctx.excludedFiles) {
      lines.push(`- ${f}`);
    }
  }

  if (ctx.oversizedFiles.length > 0) {
    lines.push("");
    lines.push(
      `レビュー対象外（大規模変更）: ${ctx.oversizedFiles.length} ファイル`,
    );
    for (const f of ctx.oversizedFiles) {
      lines.push(`- ${f}`);
    }
  }

  if (ctx.tier !== "normal") {
    lines.push("");
    lines.push(
      `変更規模: ${ctx.tier}（${ctx.metrics.totalFiles} ファイル / ${ctx.metrics.totalChangedLines} 行）— 一部のレビューエージェントを省略しました`,
    );
  }

  return lines.join("\n");
}

export function printSummary(
  final: FinalDoc,
  ctx: Context,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write(`${formatSummary(final, ctx)}\n`);
}
