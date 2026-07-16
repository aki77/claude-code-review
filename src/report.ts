// step8: レビュー結果のサマリをターミナルに出力する。
//
// review-core.md:197-203 準拠（投稿なし）。local-review では LLM 生成の「変更概要」は
// 載せない（local-review SKILL.md:29）が、件数サマリは final.issues から決定論的に
// 生成して先頭に出す（追加 LLM 呼び出しはゼロ）。

import { appendFileSync } from "node:fs";
import { SEVERITY_PRIORITY } from "./lib/process-findings.ts";
import type {
  Category,
  Context,
  DebugEntry,
  FinalDoc,
  Issue,
  Severity,
} from "./lib/types.ts";

// カテゴリ/重要度 → 絵文字・ラベルの対応表。rule-violation → "Rule" のような対応があり
// 単純 Capitalize では導けないためテーブル引き必須。emoji と label を同一オブジェクトに
// 集約し二重管理を排除する。
const CATEGORY_META: Record<Category, { emoji: string; label: string }> = {
  bug: { emoji: "🐛", label: "Bug" },
  security: { emoji: "🔒", label: "Security" },
  performance: { emoji: "⚡", label: "Performance" },
  "rule-violation": { emoji: "📋", label: "Rule" },
};
const SEVERITY_META: Record<Severity, { emoji: string; label: string }> = {
  critical: { emoji: "🔴", label: "Critical" },
  high: { emoji: "🟠", label: "High" },
  medium: { emoji: "🟡", label: "Medium" },
  low: { emoji: "⚪", label: "Low" },
};

export interface BadgeStyle {
  bold: boolean;
}

// カテゴリ・重要度の絵文字バッジ行を組み立てる。report.ts のサマリ出力・llm/steps.ts の
// PR コメント本文（バッジ・欠落時のサマリ言及）で共通して使う唯一の定義。
// style.bold=true で PR Markdown 向けの太字ラベルにする（デフォルトは安全側のプレーン）。
// undefined の category/severity は絵文字なし・ラベル "-" に退避する（既存の "-" 挙動を踏襲）。
export function formatBadge(
  issue: Pick<Issue, "category" | "severity">,
  style: BadgeStyle = { bold: false },
): string {
  const categoryText = badgePart(CATEGORY_META, issue.category, style.bold);
  const severityText = badgePart(SEVERITY_META, issue.severity, style.bold);
  return `${categoryText}  ${severityText}`;
}

// meta テーブル引き + bold/plain 出し分けの共通処理。category/severity 双方で同型のため
// 一本化し、キー種別が増えても呼び出し側は1行で済む。
function badgePart<T extends string>(
  meta: Record<T, { emoji: string; label: string }>,
  key: T | undefined,
  bold: boolean,
): string {
  const entry = key ? meta[key] : undefined;
  const label = wrap(entry ? entry.label : "-", bold);
  return entry ? `${entry.emoji} ${label}` : label;
}

function wrap(label: string, bold: boolean): string {
  return bold ? `**${label}**` : label;
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
  const breakdown = SEVERITY_ORDER.map(
    (s) => `${SEVERITY_META[s].emoji} ${SEVERITY_META[s].label} ${counts[s]}`,
  ).join(" / ");
  return `検出 ${issues.length} 件（${breakdown}）`;
}

// 案C: 2行構成。1行目 = プレーンバッジ行、2行目 = 📍 + path[:line] + タイトル、続けて本文。
// resolved は `path:line`、deferred は `path` のみ + 注記。
function issueBlock(issue: FinalDoc["issues"][number]): string {
  const badge = formatBadge(issue);
  const location =
    issue.resolved && issue.params && "line" in issue.params
      ? `${issue.path}:${issue.params.line}`
      : `${issue.path}（行番号未確定）`;
  return `${badge}\n📍 ${location}  ${issue.title}\n\n  ${issue.body}`;
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

// --summary-file 出力用の実行メタ情報。CLI 側（local/pr 両方）で組み立てて渡す軽量オブジェクト。
export interface SummaryMeta {
  totalCostUsd: number;
  postedUrl?: string;
  prNumber?: number;
  headRefOid?: string;
}

function formatMetaSection(ctx: Context, meta: SummaryMeta): string[] {
  const lines: string[] = ["### 実行メタ情報", ""];

  const target: string[] = [];
  if (meta.prNumber !== undefined) target.push(`PR #${meta.prNumber}`);
  if (meta.headRefOid) target.push(`commit \`${meta.headRefOid.slice(0, 7)}\``);
  target.push(`source: ${ctx.source}`);
  lines.push(`- 対象: ${target.join(" / ")}`);

  lines.push(
    `- 変更規模: ${ctx.tier}（${ctx.metrics.totalFiles} ファイル / +${ctx.metrics.totalAdded} -${ctx.metrics.totalDeleted}）`,
  );

  if (ctx.excludedFiles.length > 0 || ctx.oversizedFiles.length > 0) {
    const excludedParts: string[] = [];
    if (ctx.excludedFiles.length > 0) {
      excludedParts.push(`対象外 ${ctx.excludedFiles.length} ファイル`);
    }
    if (ctx.oversizedFiles.length > 0) {
      excludedParts.push(`大規模変更 ${ctx.oversizedFiles.length} ファイル`);
    }
    lines.push(`- 対象外ファイル: ${excludedParts.join(" / ")}`);
  }

  lines.push(`- LLM コスト: $${meta.totalCostUsd.toFixed(4)}`);

  if (meta.postedUrl) {
    lines.push(`- 投稿先: ${meta.postedUrl}`);
  }

  return lines;
}

// PR コメント同様、太字バッジの Markdown 版 issueBlock。
function issueBlockMarkdown(issue: FinalDoc["issues"][number]): string {
  const badge = formatBadge(issue, { bold: true });
  const location =
    issue.resolved && issue.params && "line" in issue.params
      ? `\`${issue.path}:${issue.params.line}\``
      : `\`${issue.path}\`（行番号未確定）`;
  return `- ${badge}  📍 ${location} ${issue.title}\n\n  ${issue.body}`;
}

// GitHub Actions のジョブサマリー（$GITHUB_STEP_SUMMARY）向け Markdown を組み立てる。
// 既存 formatSummary（プレーンテキスト、stdout 用）とは独立した見出しベースの整形。
export function formatSummaryMarkdown(
  final: FinalDoc,
  ctx: Context,
  meta: SummaryMeta,
): string {
  const lines: string[] = ["## Code Review", ""];
  lines.push(formatCountSummary(final.issues));
  lines.push("");
  lines.push(...formatMetaSection(ctx, meta));

  if (final.issues.length > 0) {
    lines.push("", "### 指摘一覧", "");
    lines.push(
      final.issues.map((issue) => issueBlockMarkdown(issue)).join("\n\n"),
    );
  } else {
    lines.push(
      "",
      "問題は見つかりませんでした。バグ・プロジェクトルール（CLAUDE.md / .claude/rules/）準拠・REVIEW.md準拠を確認しました。",
    );
  }

  if (final.stats.rejected > 0) {
    lines.push("", "### rejected", "");
    for (const r of final.rejected) {
      lines.push(`- \`${r.path}\` ${r.title}（${r.reason}）`);
    }
  }

  if (final.stats.unverified > 0) {
    lines.push(
      "",
      `### unverified: ${final.stats.unverified} 件`,
      "",
      final.unverified.join(", "),
    );
  }

  return `${lines.join("\n")}\n`;
}

// entries の obj（diff 由来の existingCode/body/summary 等を含みうる）に ``` が含まれると、
// 固定3連続のコードフェンスがその位置で早期に閉じてしまい、以降の JSON・後続 <details> ブロックが
// 生の Markdown として解釈され表示崩れの原因になる。GFM のコードフェンスは内容中の最長連続
// バッククォートより1つ長く取れば安全に閉じないため、内容に応じてフェンス長を動的に決める。
function backtickFence(content: string): string {
  const matches = content.match(/`+/g);
  const longest = matches
    ? matches.reduce((max, m) => Math.max(max, m.length), 0)
    : 0;
  return "`".repeat(Math.max(longest + 1, 3));
}

// --debug 併用時、各パイプライン段の中間成果物を <details> 折りたたみの Markdown にする。
// entries の順序はそのまま維持する（パイプライン実行順＝デバッグ順）。
export function formatDebugMarkdown(entries: DebugEntry[]): string {
  if (entries.length === 0) return "";
  const blocks = entries.map(({ label, obj }) => {
    const json = JSON.stringify(obj, null, 2);
    const fence = backtickFence(json);
    return `<details>\n<summary>${label}</summary>\n\n${fence}json\n${json}\n${fence}\n\n</details>`;
  });
  return `\n### デバッグ情報\n\n${blocks.join("\n\n")}\n`;
}

// --summary-file 指定時、レビュー結果＋実行メタ（＋--debug 併用時は中間成果物の
// <details> 折りたたみ）を Markdown で指定パスに追記する。書き込み失敗（パス不正等）は
// warning を stderr に出して握りつぶし、呼び出し側の exit code には影響させない
// （cli.ts は summaryFile 指定時にこれを呼ぶだけで、整形・書き込みロジックは持たない）。
export function writeSummaryFile(
  summaryFile: string,
  final: FinalDoc,
  ctx: Context,
  meta: SummaryMeta,
  debugEntries: DebugEntry[],
): void {
  try {
    const md =
      formatSummaryMarkdown(final, ctx, meta) +
      (debugEntries.length > 0 ? formatDebugMarkdown(debugEntries) : "");
    appendFileSync(summaryFile, md);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `warning: --summary-file への書き込みに失敗しました: ${message}\n`,
    );
  }
}
