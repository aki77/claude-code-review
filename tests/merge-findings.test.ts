import { describe, expect, it } from "vitest";
import { mergeFindings } from "../src/lib/merge-findings.ts";
import type { FindingsDoc } from "../src/lib/types.ts";

const doc: FindingsDoc = {
  findings: [
    {
      id: "f1",
      path: "a.js",
      kind: "bug",
      category: "performance",
      severity: "low",
      title: "T1",
      body: "B1",
      existingCode: "x",
      ruleRefs: [],
      params: { line: 2, side: "RIGHT", subjectType: "LINE" },
      resolved: true,
      status: "active",
    },
    {
      id: "f2",
      path: "a.js",
      kind: "rule",
      category: "security",
      severity: "critical",
      title: "T2",
      body: "B2",
      existingCode: "x",
      ruleRefs: ["CLAUDE.md"],
      params: { line: 2, side: "RIGHT", subjectType: "LINE" },
      resolved: true,
      status: "active",
    },
    {
      id: "f3",
      path: "b.js",
      kind: "rule",
      category: "rule-violation",
      severity: "medium",
      title: "T3",
      body: "B3",
      existingCode: "y",
      ruleRefs: ["REVIEW.md"],
      resolved: false,
      reason: "不一致",
      status: "active",
    },
  ],
  groups: [
    {
      id: "g1",
      path: "a.js",
      kind: "bug",
      category: "security",
      severity: "critical",
      resolved: true,
      memberIds: ["f1", "f2"],
      needsMergeText: true,
      params: { line: 2, side: "RIGHT", subjectType: "LINE" },
    },
    {
      id: "g2",
      path: "b.js",
      kind: "rule",
      category: "rule-violation",
      severity: "medium",
      resolved: false,
      memberIds: ["f3"],
      needsMergeText: false,
      reason: "不一致",
    },
  ],
  stats: {
    total: 3,
    valid: 3,
    invalid: 0,
    outOfScope: 0,
    resolved: 2,
    unresolved: 1,
    groups: 2,
    multiGroups: 1,
  },
};

describe("mergeFindings", () => {
  it("複数メンバーグループは LLM 統合文章を採用し、ruleRefs は和集合", () => {
    const { issues } = mergeFindings(doc, [
      { groupId: "g1", title: "統合", body: "統合本文" },
    ]);
    const g1 = issues.find((i) => i.id === "g1")!;
    expect(g1.title).toBe("統合");
    expect(g1.body).toBe("統合本文");
    expect(g1.kind).toBe("bug");
    expect(g1.ruleRefs).toEqual(["CLAUDE.md"]); // f1 は []、f2 は CLAUDE.md
    expect(g1.params).toEqual({ line: 2, side: "RIGHT", subjectType: "LINE" });
    expect(g1.sourceFindingIds).toEqual(["f1", "f2"]);
  });

  it("グループの category/severity をそのまま機械転写する（LLM の統合文章と独立）", () => {
    const { issues } = mergeFindings(doc, [
      { groupId: "g1", title: "統合", body: "統合本文" },
    ]);
    const g1 = issues.find((i) => i.id === "g1")!;
    expect(g1.category).toBe("security");
    expect(g1.severity).toBe("critical");
  });

  it("singleton グループは唯一メンバーの title/body を自動コピー", () => {
    const { issues } = mergeFindings(doc, [
      { groupId: "g1", title: "統合", body: "統合本文" },
    ]);
    const g2 = issues.find((i) => i.id === "g2")!;
    expect(g2.title).toBe("T3");
    expect(g2.body).toBe("B3");
    expect(g2.category).toBe("rule-violation");
    expect(g2.severity).toBe("medium");
    expect(g2.resolved).toBe(false);
    expect(g2.reason).toBe("不一致");
    expect("params" in g2).toBe(false);
  });

  it("resolved なグループには reason が載らない", () => {
    const { issues } = mergeFindings(doc, [
      { groupId: "g1", title: "統合", body: "統合本文" },
    ]);
    const g1 = issues.find((i) => i.id === "g1")!;
    expect("reason" in g1).toBe(false);
  });

  it("エラー: needsMergeText グループに文章が無い", () => {
    expect(() => mergeFindings(doc, [])).toThrow(
      /統合文章が供給されていません/,
    );
  });

  it("エラー: 未知の groupId", () => {
    expect(() =>
      mergeFindings(doc, [
        { groupId: "g1", title: "t", body: "b" },
        { groupId: "g99", title: "t", body: "b" },
      ]),
    ).toThrow(/未知の groupId/);
  });

  it("エラー: singleton へ文章供給", () => {
    expect(() =>
      mergeFindings(doc, [
        { groupId: "g1", title: "t", body: "b" },
        { groupId: "g2", title: "t", body: "b" },
      ]),
    ).toThrow(/単一メンバー/);
  });

  it("エラー: 重複 groupId", () => {
    expect(() =>
      mergeFindings(doc, [
        { groupId: "g1", title: "t", body: "b" },
        { groupId: "g1", title: "t2", body: "b2" },
      ]),
    ).toThrow(/重複/);
  });

  it("エラー: title/body 空", () => {
    expect(() =>
      mergeFindings(doc, [{ groupId: "g1", title: "  ", body: "b" }]),
    ).toThrow(/title\/body/);
  });

  it("エラー: title に title/body を含む JSON 構造が丸ごと入っている", () => {
    expect(() =>
      mergeFindings(doc, [
        { groupId: "g1", title: '{"title":"X","body":"Y"}', body: "正常" },
      ]),
    ).toThrow(/JSON 構造/);
  });

  it("エラー: stdin が配列でない", () => {
    expect(() => mergeFindings(doc, { groupId: "g1" })).toThrow(/配列/);
  });

  it("stats を集計する", () => {
    const { stats } = mergeFindings(doc, [
      { groupId: "g1", title: "t", body: "b" },
    ]);
    expect(stats).toEqual({
      groups: 2,
      issues: 2,
      merged: 1,
      resolved: 1,
      unresolved: 1,
    });
  });
});
