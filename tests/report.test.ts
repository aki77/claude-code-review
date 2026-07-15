import { describe, expect, it } from "vitest";
import type { Context, FinalDoc, Issue } from "../src/lib/types.ts";
import { formatSummary } from "../src/report.ts";

function baseCtx(overrides: Partial<Context> = {}): Context {
  return {
    source: "workspace",
    changedFiles: ["a.ts"],
    excludedFiles: [],
    oversizedFiles: [],
    excludeArgs: { git: [] },
    assignments: [{ files: [] }, { files: [] }],
    metrics: {
      totalFiles: 1,
      totalAdded: 1,
      totalDeleted: 0,
      totalChangedLines: 1,
    },
    tier: "normal",
    diffArgs: ["HEAD"],
    ...overrides,
  };
}

function baseFinal(overrides: Partial<FinalDoc> = {}): FinalDoc {
  return {
    issues: [],
    rejected: [],
    unverified: [],
    stats: { total: 0, confirmed: 0, rejected: 0, unverified: 0 },
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "g1",
    path: "a.ts",
    kind: "bug",
    category: "bug",
    severity: "high",
    title: "問題タイトル",
    body: "本文",
    ruleRefs: [],
    resolved: true,
    sourceFindingIds: ["f1"],
    params: { line: 10, side: "RIGHT", subjectType: "LINE" },
    ...overrides,
  };
}

describe("formatSummary", () => {
  it("confirmed 0件のとき問題なしメッセージを出す", () => {
    const out = formatSummary(baseFinal(), baseCtx());
    expect(out).toContain("問題は見つかりませんでした");
  });

  it("confirmed 1件以上のとき resolved:true は path:line を含める", () => {
    const final = baseFinal({
      issues: [issue()],
      stats: { total: 1, confirmed: 1, rejected: 0, unverified: 0 },
    });
    const out = formatSummary(final, baseCtx());
    expect(out).toContain("🐛 Bug");
    expect(out).toContain("🟠 High");
    expect(out).toContain("a.ts:10");
    expect(out).toContain("問題タイトル");
  });

  it("confirmed 1件以上のとき件数サマリ行と本文ブロックを出す", () => {
    const final = baseFinal({
      issues: [issue()],
      stats: { total: 1, confirmed: 1, rejected: 0, unverified: 0 },
    });
    const out = formatSummary(final, baseCtx());
    expect(out).toContain(
      "検出 1 件（🔴 Critical 0 / 🟠 High 1 / 🟡 Medium 0 / ⚪ Low 0）",
    );
    expect(out).toContain("本文");
  });

  it("resolved:false の issue は path のみ（行番号なし）+ 未確定注記", () => {
    const final = baseFinal({
      issues: [
        issue({ resolved: false, params: undefined, reason: "アンカー未解決" }),
      ],
      stats: { total: 1, confirmed: 1, rejected: 0, unverified: 0 },
    });
    const out = formatSummary(final, baseCtx());
    expect(out).toContain("a.ts（行番号未確定）  問題タイトル");
    expect(out).not.toContain("a.ts:");
  });

  it("issues が0件のときは件数サマリ行を出さない", () => {
    const out = formatSummary(baseFinal(), baseCtx());
    expect(out).not.toContain("検出");
    expect(out).toContain("問題は見つかりませんでした");
  });

  it("rejected 件数と各 title/reason を表示する", () => {
    const final = baseFinal({
      rejected: [
        {
          id: "g2",
          path: "b.ts",
          title: "却下された指摘",
          reason: "実際は問題ない",
        },
      ],
      stats: { total: 1, confirmed: 0, rejected: 1, unverified: 0 },
    });
    const out = formatSummary(final, baseCtx());
    expect(out).toContain("rejected: 1 件");
    expect(out).toContain("却下された指摘");
    expect(out).toContain("実際は問題ない");
  });

  it("unverified 件数を表示する", () => {
    const final = baseFinal({
      unverified: ["g3"],
      stats: { total: 1, confirmed: 0, rejected: 0, unverified: 1 },
    });
    const out = formatSummary(final, baseCtx());
    expect(out).toContain("unverified: 1 件");
    expect(out).toContain("g3");
  });

  it("excludedFiles / oversizedFiles / tier 縮退の末尾表示を網羅する", () => {
    const ctx = baseCtx({
      excludedFiles: ["dist/bundle.js"],
      oversizedFiles: ["big.ts"],
      tier: "small",
      metrics: {
        totalFiles: 1,
        totalAdded: 10,
        totalDeleted: 0,
        totalChangedLines: 10,
      },
    });
    const out = formatSummary(baseFinal(), ctx);
    expect(out).toContain("レビュー対象外: 1 ファイル（生成物/バイナリ等）");
    expect(out).toContain("dist/bundle.js");
    expect(out).toContain("レビュー対象外（大規模変更）: 1 ファイル");
    expect(out).toContain("big.ts");
    expect(out).toContain(
      "変更規模: small（1 ファイル / 10 行）— 一部のレビューエージェントを省略しました",
    );
  });

  it("tier が normal のときは縮退表示を出さない", () => {
    const out = formatSummary(baseFinal(), baseCtx({ tier: "normal" }));
    expect(out).not.toContain("変更規模:");
  });
});
