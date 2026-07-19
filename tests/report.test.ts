import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Context,
  CritComment,
  FinalDoc,
  Issue,
} from "../src/lib/types.ts";
import {
  formatDebugMarkdown,
  formatSummary,
  formatSummaryMarkdown,
  printCritJson,
  writeSummaryFile,
} from "../src/report.ts";

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

describe("formatSummaryMarkdown", () => {
  it("見出しと実行メタ情報（対象・変更規模・コスト）を含める", () => {
    const out = formatSummaryMarkdown(baseFinal(), baseCtx(), {
      totalCostUsd: 0.1234,
    });
    expect(out).toContain("## Code Review");
    expect(out).toContain("### 実行メタ情報");
    expect(out).toContain("source: workspace");
    expect(out).toContain("変更規模: normal（1 ファイル / +1 -0）");
    expect(out).toContain("LLM コスト: $0.1234");
  });

  it("prNumber / headRefOid / postedUrl を指定すると対象行・投稿先行に反映する", () => {
    const out = formatSummaryMarkdown(baseFinal(), baseCtx(), {
      totalCostUsd: 0,
      prNumber: 33,
      headRefOid: "abcdef1234567",
      postedUrl: "https://github.com/owner/repo/pull/33#pullrequestreview-1",
    });
    expect(out).toContain("PR #33");
    expect(out).toContain("commit `abcdef1`");
    expect(out).toContain(
      "投稿先: https://github.com/owner/repo/pull/33#pullrequestreview-1",
    );
  });

  it("issues があるとき太字バッジ・path:line・タイトル・本文を Markdown 化する", () => {
    const final = baseFinal({
      issues: [issue()],
      stats: { total: 1, confirmed: 1, rejected: 0, unverified: 0 },
    });
    const out = formatSummaryMarkdown(final, baseCtx(), { totalCostUsd: 0 });
    expect(out).toContain("### 指摘一覧");
    expect(out).toContain("**Bug**");
    expect(out).toContain("**High**");
    expect(out).toContain("`a.ts:10`");
    expect(out).toContain("問題タイトル");
    expect(out).toContain("本文");
  });

  it("issues が0件のとき問題なしメッセージを出す", () => {
    const out = formatSummaryMarkdown(baseFinal(), baseCtx(), {
      totalCostUsd: 0,
    });
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
    const out = formatSummaryMarkdown(final, baseCtx(), { totalCostUsd: 0 });
    expect(out).toContain("### rejected");
    expect(out).toContain("却下された指摘");
    expect(out).toContain("実際は問題ない");
  });
});

describe("formatDebugMarkdown", () => {
  it("空配列のときは空文字を返す", () => {
    expect(formatDebugMarkdown([])).toBe("");
  });

  it("各エントリを <details><summary>label</summary> + JSON コードブロックにする", () => {
    const out = formatDebugMarkdown([
      { label: "ctx", obj: { source: "workspace" } },
      { label: "final", obj: { issues: [] } },
    ]);
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>ctx</summary>");
    expect(out).toContain("<summary>final</summary>");
    expect(out).toContain('"source": "workspace"');
    expect(out).toContain("```json");
  });

  it("obj 内に ``` を含む文字列があってもフェンスが途中で閉じない（4連続以上で囲む）", () => {
    const out = formatDebugMarkdown([
      { label: "findingsDoc", obj: { body: "```suggestion\nx\n```" } },
    ]);
    // 内容中の最長連続バッククォートは3つなので、外側フェンスは4連続以上でなければならない。
    expect(out).toMatch(/````+json/);
    // 開始・終了フェンスの数だけ出現する（内容側の```は3連続のまま素通し）。
    const fenceMatches = out.match(/````+/g) ?? [];
    expect(fenceMatches.length).toBe(2);
  });
});

describe("printCritJson", () => {
  it("write DI で crit コメント配列を整形 JSON（末尾改行付き）で出力する", () => {
    const comments: CritComment[] = [
      { file: "src/a.ts", line: 42, body: "本文A" },
      { file: "src/a.ts", line: "50-55", body: "本文B" },
    ];
    let out = "";
    printCritJson(comments, (s) => {
      out += s;
    });
    expect(out).toBe(`${JSON.stringify(comments, null, 2)}\n`);
    // パースし直しても同じ配列になる（valid JSON）。
    expect(JSON.parse(out)).toEqual(comments);
  });

  it("空配列でも valid JSON（[]）を出力する", () => {
    let out = "";
    printCritJson([], (s) => {
      out += s;
    });
    expect(out).toBe("[]\n");
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe("writeSummaryFile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "code-review-summary-"));
    file = path.join(dir, "summary.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("formatSummaryMarkdown の内容を指定パスに書き込む", () => {
    writeSummaryFile(file, baseFinal(), baseCtx(), { totalCostUsd: 0 }, []);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("## Code Review");
  });

  it("既存ファイルがあるときは上書きせず追記する", () => {
    writeSummaryFile(file, baseFinal(), baseCtx(), { totalCostUsd: 0 }, []);
    writeSummaryFile(file, baseFinal(), baseCtx(), { totalCostUsd: 0 }, []);
    const written = readFileSync(file, "utf8");
    expect(written.match(/## Code Review/g)?.length).toBe(2);
  });

  it("debugEntries があるとき <details> 折りたたみも追記する", () => {
    writeSummaryFile(file, baseFinal(), baseCtx(), { totalCostUsd: 0 }, [
      { label: "ctx", obj: { source: "workspace" } },
    ]);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("### デバッグ情報");
    expect(written).toContain("<summary>ctx</summary>");
  });

  it("書き込みに失敗しても例外を投げず警告を stderr に出す", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const invalidPath = path.join(dir, "no-such-dir", "summary.md");
    expect(() =>
      writeSummaryFile(
        invalidPath,
        baseFinal(),
        baseCtx(),
        { totalCostUsd: 0 },
        [],
      ),
    ).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("--summary-file への書き込みに失敗しました"),
    );
    stderrSpy.mockRestore();
  });
});
