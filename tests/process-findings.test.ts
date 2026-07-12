import { describe, expect, it } from "vitest";
import { processFindings } from "../src/lib/process-findings.js";
import type { Ctx, Finding, FindingsDoc } from "../src/lib/types.js";

const ctx: Ctx = {
  changedFiles: ["src/a.js", "src/b.js"],
  excludedFiles: ["dist/x.min.js"],
};
// src/a.js は 5 行の新規ファイル、src/b.js は 3 行の新規ファイル。
const diffText = [
  "diff --git a/src/a.js b/src/a.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.js",
  "@@ -0,0 +1,5 @@",
  "+line1",
  "+line2",
  "+line3",
  "+line4",
  "+line5",
  "diff --git a/src/b.js b/src/b.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.js",
  "@@ -0,0 +1,3 @@",
  "+alpha",
  "+beta",
  "+gamma",
].join("\n");

const run = (raw: unknown, opts: { ctx?: Ctx; prev?: FindingsDoc | null } = {}) =>
  processFindings(raw, { ctx, diffText, ...opts });

const bug = (over: Record<string, unknown> = {}) => ({
  agent: 3,
  path: "src/a.js",
  title: "バグ",
  body: "説明",
  existingCode: "line2",
  category: "bug",
  severity: "high",
  ...over,
});
const rule = (over: Record<string, unknown> = {}) => ({
  agent: 1,
  path: "src/a.js",
  title: "ルール違反",
  body: "説明",
  existingCode: "line4",
  ruleRefs: ["CLAUDE.md"],
  category: "rule-violation",
  severity: "medium",
  ...over,
});

describe("processFindings", () => {
  it("ID 付与: 入力順に f1..fN", () => {
    const { findings } = run([bug(), rule()]);
    expect(findings.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("スキーマ検証: existingCode 欠落は invalid（全体は落とさない）", () => {
    const { findings, stats } = run([bug(), { agent: 3, path: "src/a.js", title: "x", body: "y" }]);
    expect(findings[1]!.status).toBe("invalid");
    expect(findings[1]!.errors!.join()).toMatch(/existingCode/);
    expect(stats.invalid).toBe(1);
    expect(stats.valid).toBe(1);
  });

  it("スキーマ検証: agent 1 で ruleRefs 欠落は invalid", () => {
    const { findings } = run([rule({ ruleRefs: undefined })]);
    expect(findings[0]!.status).toBe("invalid");
    expect(findings[0]!.errors!.join()).toMatch(/ruleRefs/);
  });

  it("スキーマ検証: agent 3 は ruleRefs 省略可・[] 補完", () => {
    const { findings } = run([bug()]);
    expect(findings[0]!.status).toBe("active");
    expect(findings[0]!.ruleRefs).toEqual([]);
  });

  it("スキーマ検証: category が enum 外は invalid", () => {
    const { findings, stats } = run([bug({ category: "style" })]);
    expect(findings[0]!.status).toBe("invalid");
    expect(findings[0]!.errors!.join()).toMatch(/category/);
    expect(stats.invalid).toBe(1);
  });

  it("スキーマ検証: severity が enum 外は invalid", () => {
    const { findings } = run([bug({ severity: "info" })]);
    expect(findings[0]!.status).toBe("invalid");
    expect(findings[0]!.errors!.join()).toMatch(/severity/);
  });

  it("スキーマ検証: agent 1/2/5 は category=rule-violation 以外だと invalid", () => {
    const { findings } = run([rule({ category: "bug" })]);
    expect(findings[0]!.status).toBe("invalid");
    expect(findings[0]!.errors!.join()).toMatch(/rule-violation/);
  });

  it("スキーマ検証: agent 3/4 は category=rule-violation を指定できない（invalid）", () => {
    const { findings } = run([bug({ category: "rule-violation" })]);
    expect(findings[0]!.status).toBe("invalid");
    expect(findings[0]!.errors!.join()).toMatch(/rule-violation/);
  });

  it("スキーマ検証: agent 3/4 は category に security/performance も指定できる", () => {
    const { findings } = run([
      bug({ category: "security" }),
      bug({ category: "performance", existingCode: "line3" }),
    ]);
    expect(findings[0]!.status).toBe("active");
    expect(findings[0]!.category).toBe("security");
    expect(findings[1]!.category).toBe("performance");
  });

  it("スコープ: changedFiles 外は out-of-scope", () => {
    const { findings, stats } = run([bug({ path: "src/other.js" })]);
    expect(findings[0]!.status).toBe("out-of-scope");
    expect(stats.outOfScope).toBe(1);
  });

  it("スコープ: excludedFiles は out-of-scope", () => {
    // excludedFiles は changedFiles に含まれない前提だが、両方に現れても弾く。
    const c2: Ctx = { changedFiles: ["dist/x.min.js"], excludedFiles: ["dist/x.min.js"] };
    const { findings } = processFindings([bug({ path: "dist/x.min.js", existingCode: "line2" })], {
      ctx: c2,
      diffText,
    });
    expect(findings[0]!.status).toBe("out-of-scope");
  });

  it("kind 導出: agent 3,4 → bug / 1,2,5 → rule", () => {
    const { findings } = run([
      bug({ agent: 3 }),
      bug({ agent: 4, existingCode: "line3" }),
      rule({ agent: 1 }),
      rule({ agent: 2, existingCode: "line5" }),
      rule({ agent: 5, existingCode: "line1" }),
    ]);
    expect(findings.map((f) => f.kind)).toEqual(["bug", "bug", "rule", "rule", "rule"]);
  });

  it("アンカー解決: 成功で resolved:true + params", () => {
    const { findings, stats } = run([bug()]);
    expect(findings[0]!.resolved).toBe(true);
    expect(findings[0]!.params).toMatchObject({ line: 2 });
    expect(stats.resolved).toBe(1);
  });

  it("アンカー解決: 失敗で resolved:false + reason", () => {
    const { findings, stats } = run([bug({ existingCode: "nonexistent" })]);
    expect(findings[0]!.resolved).toBe(false);
    expect(findings[0]!.reason).toBeTruthy();
    expect(stats.unresolved).toBe(1);
  });

  it("グルーピング: 行範囲が重なる同一 path+side は1グループ", () => {
    // line2..line3（f1）と line3..line4（f2）は line3 で重なる → 統合。
    const { groups } = run([
      bug({ existingCode: "line2\nline3" }),
      bug({ existingCode: "line3\nline4" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.memberIds.length).toBe(2);
    expect(groups[0]!.needsMergeText).toBe(true);
    expect(groups[0]!.params).toEqual({
      startLine: 2,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  it("グルーピング: 重ならない行範囲は別グループ", () => {
    const { groups } = run([bug({ existingCode: "line1" }), bug({ existingCode: "line5" })]);
    expect(groups.length).toBe(2);
    expect(groups[0]!.needsMergeText).toBe(false);
  });

  it("グルーピング: bug+rule 混在は bug（由来種別優先）", () => {
    const { groups } = run([bug({ existingCode: "line2" }), rule({ existingCode: "line2" })]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.kind).toBe("bug");
  });

  it("グルーピング: severity はメンバー中の最大深刻度を採用", () => {
    const { groups } = run([
      bug({ existingCode: "line2", severity: "low" }),
      bug({ existingCode: "line2\nline3", severity: "critical" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.severity).toBe("critical");
  });

  it("グルーピング: bug グループの category はメンバー中の最重要度（security > bug > performance）", () => {
    const { groups } = run([
      bug({ existingCode: "line2", category: "performance" }),
      bug({ existingCode: "line2\nline3", category: "security" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.category).toBe("security");
  });

  it("グルーピング: rule グループの category は常に rule-violation", () => {
    const { groups } = run([
      rule({ existingCode: "line4" }),
      rule({ agent: 2, existingCode: "line4" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.kind).toBe("rule");
    expect(groups[0]!.category).toBe("rule-violation");
  });

  it("グルーピング: 推移的連結（A-B, B-C なら A-B-C が1グループ）", () => {
    const { groups } = run([
      bug({ existingCode: "line1\nline2" }),
      bug({ existingCode: "line2\nline3" }),
      bug({ existingCode: "line3\nline4" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.memberIds.length).toBe(3);
    expect((groups[0]!.params as { startLine: number }).startLine).toBe(1);
    expect(groups[0]!.params!.line).toBe(4);
  });

  it("グルーピング: 未解決の同一アンカー完全一致は統合", () => {
    const { groups } = run([bug({ existingCode: "ghost" }), bug({ existingCode: "ghost" })]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.resolved).toBe(false);
    expect(groups[0]!.needsMergeText).toBe(true);
  });

  it("グルーピング: 未解決でもアンカーが違えば別グループ", () => {
    const { groups } = run([bug({ existingCode: "ghost1" }), bug({ existingCode: "ghost2" })]);
    expect(groups.length).toBe(2);
  });

  it("配列の配列を自動フラット化する", () => {
    const { findings } = run([[bug()], [rule({ existingCode: "line5" })]]);
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("--retry: パッチしたアンカーで再解決する", () => {
    const first = run([bug({ existingCode: "wronganchor" })]);
    expect(first.findings[0]!.resolved).toBe(false);
    const retried = run([{ id: "f1", existingCode: "line2" }], { prev: first });
    expect(retried.findings[0]!.resolved).toBe(true);
    expect(retried.findings[0]!.params!.line).toBe(2);
    expect(retried.stats.resolved).toBe(1);
  });

  it("--retry: パッチに無い finding は維持される", () => {
    const first = run([bug({ existingCode: "line2" }), bug({ existingCode: "wrong" })]);
    const retried = run([{ id: "f2", existingCode: "line4" }], { prev: first });
    expect(retried.findings[0]!.resolved).toBe(true); // f1 は元のまま
    expect(retried.findings[0]!.params!.line).toBe(2);
    expect(retried.findings[1]!.resolved).toBe(true); // f2 が再解決
    expect(retried.findings[1]!.params!.line).toBe(4);
  });

  it("決定論性: 同一入力 → 同一出力", () => {
    const input = [bug({ existingCode: "line2" }), rule({ existingCode: "line4" })];
    const r1 = JSON.stringify(run(input));
    const r2 = JSON.stringify(run(input));
    expect(r1).toBe(r2);
  });

  it("非配列 stdin は throw する", () => {
    expect(() => run({ not: "array" })).toThrow(/配列/);
  });
});
