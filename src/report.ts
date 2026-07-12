// step8: レビュー結果のサマリをターミナルに出力する。
//
// review-core.md:197-203 準拠（投稿なし）。local-review なので冒頭の「変更概要」は
// 載せない（local-review SKILL.md:29）。
import type { Context, FinalDoc } from "./lib/types.ts";

function issueLine(issue: FinalDoc["issues"][number]): string {
  const badge = `[${issue.category ?? "-"} · ${issue.severity ?? "-"}]`;
  const location =
    issue.resolved && issue.params && "line" in issue.params
      ? `${issue.path}:${issue.params.line}`
      : issue.path;
  return `${badge} ${location}  ${issue.title}`;
}

export function formatSummary(final: FinalDoc, ctx: Context): string {
  const lines: string[] = [];

  if (final.issues.length > 0) {
    for (const issue of final.issues) {
      lines.push(issueLine(issue));
    }
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
