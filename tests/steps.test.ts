import { describe, expect, it } from "vitest";
import type { Context, FindingsDoc, Issue } from "../src/lib/types.ts";
import {
  llmMergeTexts,
  llmReviewAgents,
  llmSummaryAndClusters,
  llmVerifyIssues,
} from "../src/llm/steps.ts";
import { makeFakeQuery, makeThrowingQuery } from "./helpers/fake-query.ts";

function baseCtx(overrides: Partial<Context> = {}): Context {
  return {
    source: "staged",
    changedFiles: ["a.ts"],
    excludedFiles: [],
    oversizedFiles: [],
    excludeArgs: { git: [] },
    assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    metrics: {
      totalFiles: 1,
      totalAdded: 1,
      totalDeleted: 0,
      totalChangedLines: 1,
    },
    tier: "normal",
    diffArgs: ["--staged"],
    ...overrides,
  };
}

describe("llmSummaryAndClusters", () => {
  it("成功時は summary と rawClusters を返す", async () => {
    const query = makeFakeQuery({
      summary: "サマリ本文",
      clusters: [{ id: 1, theme: "T", changedFiles: ["a.ts"] }],
    });
    const result = await llmSummaryAndClusters(
      baseCtx(),
      "diff",
      "author-info",
      { query },
    );
    expect(result.summary).toBe("サマリ本文");
    expect(result.rawClusters).toEqual([
      { id: 1, theme: "T", changedFiles: ["a.ts"] },
    ]);
  });

  it("失敗時は {summary:null, rawClusters:[]} にフォールバックする", async () => {
    const query = makeThrowingQuery();
    const result = await llmSummaryAndClusters(
      baseCtx(),
      "diff",
      "author-info",
      { query },
    );
    expect(result.summary).toBeNull();
    expect(result.rawClusters).toEqual([]);
  });
});

describe("llmReviewAgents", () => {
  it("tier=tiny で agent3 非起動、assignments[1] 空で agent2 非起動、REVIEW.md 無しで agent5 スキップ", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });

    const ctx = baseCtx({
      tier: "tiny",
      assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    });
    await llmReviewAgents(
      {
        ctx,
        diffText: "diff",
        clusters: [
          {
            id: 1,
            theme: "T",
            changedFiles: ["a.ts"],
            symbols: [],
            contextHints: [],
          },
        ],
        summary: null,
      },
      { query, readFile: () => null },
    );
    // agent1（起動）+ agent4×1クラスタ（起動）= 2回。agent2/agent3/agent5 は非起動。
    expect(calls.length).toBe(2);
  });

  it("assignments[1] が非空なら agent2 が起動する", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "small",
      assignments: [
        { files: [{ path: "a.ts", rules: [] }] },
        { files: [{ path: "b.ts", rules: [] }] },
      ],
    });
    await llmReviewAgents(
      {
        ctx,
        diffText: "diff",
        clusters: [
          {
            id: 1,
            theme: "T",
            changedFiles: ["a.ts", "b.ts"],
            symbols: [],
            contextHints: [],
          },
        ],
        summary: null,
      },
      { query, readFile: () => null },
    );
    // agent1 + agent2 + agent4×1クラスタ = 3回（tier=small なので agent3 は起動）。
    expect(calls.length).toBe(4);
  });

  it("clusters 数だけ agent4 が起動する", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "normal",
      assignments: [{ files: [] }, { files: [] }],
    });
    const clusters = [
      {
        id: 1,
        theme: "T1",
        changedFiles: ["a.ts"],
        symbols: [],
        contextHints: [],
      },
      {
        id: 2,
        theme: "T2",
        changedFiles: ["b.ts"],
        symbols: [],
        contextHints: [],
      },
    ];
    await llmReviewAgents(
      { ctx, diffText: "diff", clusters, summary: null },
      { query, readFile: () => null },
    );
    // agent3 + agent4×2クラスタ = 3回（agent1/2 は assignments 空で非起動）。
    expect(calls.length).toBe(3);
  });

  it("REVIEW.md が存在すれば agent5 が起動する", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "tiny",
      assignments: [{ files: [] }, { files: [] }],
    });
    await llmReviewAgents(
      {
        ctx,
        diffText: "diff",
        clusters: [
          {
            id: 1,
            theme: "T",
            changedFiles: [],
            symbols: [],
            contextHints: [],
          },
        ],
        summary: null,
      },
      { query, readFile: (p) => (p === "REVIEW.md" ? "REVIEW 本文" : null) },
    );
    // agent4×1クラスタ + agent5 = 2回（agent1/2/3 は非起動）。
    expect(calls.length).toBe(2);
  });

  it("agent の finding に正しい agent 番号を機械注入する", async () => {
    const query = makeFakeQuery({
      findings: [
        {
          agent: 999,
          path: "a.ts",
          title: "t",
          body: "b",
          existingCode: "code",
          category: "rule-violation",
          severity: "low",
        },
      ],
    });
    const ctx = baseCtx({
      tier: "tiny",
      assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    });
    const findings = await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: () => null },
    );
    expect(findings).toHaveLength(1);
    expect((findings[0] as { agent: number }).agent).toBe(1);
  });

  it("runAgentSafe: フェイク query が throw すると空配列にフォールバックする", async () => {
    const query = makeThrowingQuery();
    const ctx = baseCtx({
      tier: "tiny",
      assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    });
    const findings = await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: () => null },
    );
    expect(findings).toEqual([]);
  });
});

describe("llmMergeTexts", () => {
  function findingsDocWithGroup(needsMergeText: boolean): FindingsDoc {
    return {
      findings: [
        {
          id: "f1",
          agent: 1,
          path: "a.ts",
          title: "t1",
          body: "b1",
          status: "active",
          resolved: true,
          groupId: "g1",
        },
        {
          id: "f2",
          agent: 1,
          path: "a.ts",
          title: "t2",
          body: "b2",
          status: "active",
          resolved: true,
          groupId: "g1",
        },
      ],
      groups: [
        {
          id: "g1",
          path: "a.ts",
          kind: "rule",
          category: "rule-violation",
          severity: "low",
          resolved: true,
          memberIds: ["f1", "f2"],
          needsMergeText,
          params: { line: 1, side: "RIGHT", subjectType: "LINE" },
        },
      ],
      stats: {
        total: 2,
        valid: 2,
        invalid: 0,
        outOfScope: 0,
        resolved: 2,
        unresolved: 0,
        groups: 1,
        multiGroups: needsMergeText ? 1 : 0,
      },
    };
  }

  it("対象0件なら空配列を返し query を呼ばない", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ title: "x", body: "y" }, { calls });
    const doc = findingsDocWithGroup(false);
    const result = await llmMergeTexts(doc, { query });
    expect(result).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("成功時は groupId をコード側で付与する", async () => {
    const query = makeFakeQuery({ title: "統合タイトル", body: "統合本文" });
    const doc = findingsDocWithGroup(true);
    const result = await llmMergeTexts(doc, { query });
    expect(result).toEqual([
      { groupId: "g1", title: "統合タイトル", body: "統合本文" },
    ]);
  });

  it("失敗グループは先頭メンバーの title/body にフォールバックする", async () => {
    const query = makeThrowingQuery();
    const doc = findingsDocWithGroup(true);
    const result = await llmMergeTexts(doc, { query });
    expect(result).toEqual([{ groupId: "g1", title: "t1", body: "b1" }]);
  });
});

describe("llmVerifyIssues", () => {
  function baseIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      id: "g1",
      path: "a.ts",
      kind: "bug",
      category: "bug",
      severity: "high",
      title: "t",
      body: "b",
      ruleRefs: [],
      resolved: true,
      sourceFindingIds: ["f1"],
      params: { line: 1, side: "RIGHT", subjectType: "LINE" },
      ...overrides,
    };
  }

  it("成功時は id をコード側で付与する", async () => {
    const query = makeFakeQuery({ verdict: "confirmed", reason: "根拠" });
    const result = await llmVerifyIssues([baseIssue()], "diff", "summary", {
      query,
    });
    expect(result).toEqual([
      { id: "g1", verdict: "confirmed", reason: "根拠" },
    ]);
  });

  it("失敗 issue はその verdict を配列に含めない", async () => {
    const query = makeThrowingQuery();
    const result = await llmVerifyIssues([baseIssue()], "diff", "summary", {
      query,
    });
    expect(result).toEqual([]);
  });
});
