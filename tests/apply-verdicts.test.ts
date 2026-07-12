import { describe, expect, it } from "vitest";
import { applyVerdicts } from "../src/lib/apply-verdicts.ts";
import type { IssuesDoc } from "../src/lib/types.ts";

const doc: IssuesDoc = {
  issues: [
    {
      id: "g1",
      path: "a.js",
      title: "T1",
      body: "B1",
      kind: "bug",
      category: "security",
      severity: "critical",
      resolved: true,
      ruleRefs: [],
      sourceFindingIds: ["f1"],
    },
    {
      id: "g2",
      path: "b.js",
      title: "T2",
      body: "B2",
      kind: "rule",
      category: "rule-violation",
      severity: "medium",
      resolved: true,
      ruleRefs: [],
      sourceFindingIds: ["f2"],
    },
    {
      id: "g3",
      path: "c.js",
      title: "T3",
      body: "B3",
      kind: "bug",
      category: "performance",
      severity: "low",
      resolved: false,
      ruleRefs: [],
      sourceFindingIds: ["f3"],
    },
  ],
  stats: { groups: 3, issues: 3, merged: 0, resolved: 2, unresolved: 1 },
};

describe("applyVerdicts", () => {
  it("confirmed の issue は category/severity を丸ごと携行する", () => {
    const r = applyVerdicts(doc, [{ id: "g1", verdict: "confirmed" }]);
    expect(r.issues[0]!.category).toBe("security");
    expect(r.issues[0]!.severity).toBe("critical");
  });

  it("confirmed のみ issues に残す", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "誤検知" },
      { id: "g3", verdict: "confirmed" },
    ]);
    expect(r.issues.map((i) => i.id)).toEqual(["g1", "g3"]);
  });

  it("rejected を理由付きで記録する", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "誤検知" },
      { id: "g3", verdict: "confirmed" },
    ]);
    expect(r.rejected).toEqual([
      { id: "g2", path: "b.js", title: "T2", reason: "誤検知" },
    ]);
  });

  it("reason 省略時は空文字になる", () => {
    const r = applyVerdicts(doc, [{ id: "g2", verdict: "rejected" }]);
    expect(r.rejected).toEqual([
      { id: "g2", path: "b.js", title: "T2", reason: "" },
    ]);
  });

  it("stdin に無い issue は unverified として除外", () => {
    const r = applyVerdicts(doc, [{ id: "g1", verdict: "confirmed" }]);
    expect(r.issues.map((i) => i.id)).toEqual(["g1"]);
    expect(r.unverified).toEqual(["g2", "g3"]);
  });

  it("全 verdict 欠落（検証エージェント全滅）→ 全件 unverified", () => {
    const r = applyVerdicts(doc, []);
    expect(r.issues).toEqual([]);
    expect(r.unverified).toEqual(["g1", "g2", "g3"]);
  });

  it("stats を集計する", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "x" },
    ]);
    expect(r.stats).toEqual({
      total: 3,
      confirmed: 1,
      rejected: 1,
      unverified: 1,
    });
  });

  it("エラー: 未知 id", () => {
    expect(() =>
      applyVerdicts(doc, [{ id: "g99", verdict: "confirmed" }]),
    ).toThrow(/未知の issue id/);
  });

  it("エラー: 重複 id", () => {
    expect(() =>
      applyVerdicts(doc, [
        { id: "g1", verdict: "confirmed" },
        { id: "g1", verdict: "rejected" },
      ]),
    ).toThrow(/重複/);
  });

  it("エラー: enum 外の verdict", () => {
    expect(() => applyVerdicts(doc, [{ id: "g1", verdict: "maybe" }])).toThrow(
      /confirmed.*rejected/,
    );
  });

  it("エラー: stdin が配列でない", () => {
    expect(() => applyVerdicts(doc, { id: "g1" })).toThrow(/配列/);
  });
});
