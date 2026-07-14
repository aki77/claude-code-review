import { describe, expect, it } from "vitest";
import type {
  Context,
  FinalDoc,
  FindingsDoc,
  Issue,
} from "../src/lib/types.ts";
import { reviewTools } from "../src/llm/prompts.ts";
import {
  llmCommentBodies,
  llmMergeTexts,
  llmReviewAgents,
  llmSummaryAndClusters,
  llmVerifyIssues,
  retryUnresolvedAnchors,
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
  it("tier=small でも agent3 起動、assignments[1] 空で agent2 非起動、REVIEW.md 無しで agent5 スキップ", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });

    const ctx = baseCtx({
      tier: "small",
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
    // agent1 + agent3（tier によらず常に起動）+ agent4×1クラスタ = 3回。agent2/agent5 は非起動。
    expect(calls.length).toBe(3);
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

  it("agent3/agent4 とも read-only ツール（Read/Grep/Glob）を許可して呼び出す（精度優先の方針）", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
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
    ];
    await llmReviewAgents(
      { ctx, diffText: "diff", clusters, summary: null },
      { query, readFile: () => null },
    );
    // agent3（diff限定を撤廃・ツール許可）+ agent4（cluster、ツール許可）の2回。
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const options = call.options as { allowedTools?: string[] };
      expect(options.allowedTools).toEqual(reviewTools());
    }
  });

  it("agent1（ルール準拠チェック）にも read-only ツールを許可して呼び出す", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "small",
      assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    });
    await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: () => null },
    );
    // agent1 + agent3（clusters 空で agent4 非起動）の2回。
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const options = call.options as { allowedTools?: string[] };
      expect(options.allowedTools).toEqual(reviewTools());
    }
  });

  it("agent5（REVIEW.md 準拠チェック）にも read-only ツールを許可して呼び出す", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "small",
      assignments: [{ files: [] }, { files: [] }],
    });
    await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: (p) => (p === "REVIEW.md" ? "REVIEW 本文" : null) },
    );
    // agent3 + agent5 の2回（agent1/2/4 は非起動）。
    expect(calls).toHaveLength(2);
    const agent5Options = calls[1]?.options as { allowedTools?: string[] };
    expect(agent5Options.allowedTools).toEqual(reviewTools());
  });

  it("全レビュー系エージェントに mcpServers(context7) が渡る", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "small",
      assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
    });
    await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: () => null },
    );
    for (const call of calls) {
      const options = call.options as {
        mcpServers?: Record<string, unknown>;
      };
      expect(options.mcpServers).toEqual({
        context7: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      });
    }
  });

  it("CODE_REVIEW_DISABLE_CONTEXT7=1 のとき mcpServers を渡さない", async () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "1";
    try {
      const calls: { prompt: unknown; options: unknown }[] = [];
      const query = makeFakeQuery({ findings: [] }, { calls });
      const ctx = baseCtx({
        tier: "small",
        assignments: [{ files: [{ path: "a.ts", rules: [] }] }, { files: [] }],
      });
      await llmReviewAgents(
        { ctx, diffText: "diff", clusters: [], summary: null },
        { query, readFile: () => null },
      );
      for (const call of calls) {
        const options = call.options as {
          mcpServers?: Record<string, unknown>;
        };
        expect(options.mcpServers).toBeUndefined();
      }
    } finally {
      delete process.env.CODE_REVIEW_DISABLE_CONTEXT7;
    }
  });

  it("REVIEW.md が存在すれば agent5 が起動する", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ findings: [] }, { calls });
    const ctx = baseCtx({
      tier: "small",
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
    // agent3（tier によらず常に起動）+ agent4×1クラスタ + agent5 = 3回（agent1/2 は非起動）。
    expect(calls.length).toBe(3);
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
      tier: "small",
      assignments: [{ files: [] }, { files: [] }],
    });
    const findings = await llmReviewAgents(
      { ctx, diffText: "diff", clusters: [], summary: null },
      { query, readFile: () => null },
    );
    // agent1/2 は assignments 空で非起動、clusters 空で agent4 も非起動。
    // agent3（tier によらず常に起動）だけが findings を返す。
    expect(findings).toHaveLength(1);
    expect((findings[0] as { agent: number }).agent).toBe(3);
  });

  it("runAgentSafe: フェイク query が throw すると空配列にフォールバックする", async () => {
    const query = makeThrowingQuery();
    const ctx = baseCtx({
      tier: "small",
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

describe("retryUnresolvedAnchors", () => {
  function findingsDocWithUnresolved(unresolvedCount: number): FindingsDoc {
    const resolvedFinding = {
      id: "f1",
      agent: 1,
      path: "a.ts",
      title: "t1",
      body: "b1",
      status: "active" as const,
      resolved: true,
    };
    const unresolvedFindings = Array.from(
      { length: unresolvedCount },
      (_, i) => ({
        id: `u${i + 1}`,
        agent: 3,
        path: "a.ts",
        title: `未解決${i + 1}`,
        body: "b",
        existingCode: "old code",
        status: "active" as const,
        resolved: false,
        reason: "diff に一意一致しない",
      }),
    );
    const findings = [resolvedFinding, ...unresolvedFindings];
    return {
      findings,
      groups: [],
      stats: {
        total: findings.length,
        valid: findings.length,
        invalid: 0,
        outOfScope: 0,
        resolved: 1,
        unresolved: unresolvedCount,
        groups: 0,
        multiGroups: 0,
      },
    };
  }

  it("未解決0件なら query を呼ばず空配列を返す", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ patches: [] }, { calls });
    const doc = findingsDocWithUnresolved(0);
    const result = await retryUnresolvedAnchors(doc, "diff", { query });
    expect(result).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("未解決ありなら patches を返す", async () => {
    const query = makeFakeQuery({
      patches: [{ id: "u1", existingCode: "new code" }],
    });
    const doc = findingsDocWithUnresolved(1);
    const result = await retryUnresolvedAnchors(doc, "diff", { query });
    expect(result).toEqual([{ id: "u1", existingCode: "new code" }]);
  });

  it("LLM 失敗時は空配列にフォールバックする", async () => {
    const query = makeThrowingQuery();
    const doc = findingsDocWithUnresolved(1);
    const result = await retryUnresolvedAnchors(doc, "diff", { query });
    expect(result).toEqual([]);
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

  it("read-only ツール（Read/Grep/Glob）を許可して呼び出す", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
    const query = makeFakeQuery(
      { verdict: "confirmed", reason: "根拠" },
      { calls },
    );
    await llmVerifyIssues([baseIssue()], "diff", "summary", { query });
    expect(calls).toHaveLength(1);
    const options = calls[0]?.options as { allowedTools?: string[] };
    expect(options.allowedTools).toEqual(reviewTools());
  });

  it("mcpServers(context7) を渡す", async () => {
    const calls: { prompt: unknown; options: unknown }[] = [];
    const query = makeFakeQuery(
      { verdict: "confirmed", reason: "根拠" },
      { calls },
    );
    await llmVerifyIssues([baseIssue()], "diff", "summary", { query });
    const options = calls[0]?.options as {
      mcpServers?: Record<string, unknown>;
    };
    expect(options.mcpServers).toEqual({
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
  });

  it("CODE_REVIEW_ENABLE_WEB=1 のとき WebFetch/WebSearch も許可する", async () => {
    process.env.CODE_REVIEW_ENABLE_WEB = "1";
    try {
      const calls: { prompt: unknown; options: unknown }[] = [];
      const query = makeFakeQuery(
        { verdict: "confirmed", reason: "根拠" },
        { calls },
      );
      await llmVerifyIssues([baseIssue()], "diff", "summary", { query });
      const options = calls[0]?.options as { allowedTools?: string[] };
      expect(options.allowedTools).toEqual(reviewTools());
    } finally {
      delete process.env.CODE_REVIEW_ENABLE_WEB;
    }
  });
});

describe("llmCommentBodies", () => {
  function baseIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      id: "g1",
      path: "a.ts",
      kind: "bug",
      category: "bug",
      severity: "high",
      title: "タイトル",
      body: "本文",
      ruleRefs: [],
      existingCode: "const x = 1;",
      resolved: true,
      sourceFindingIds: ["f1"],
      params: { line: 10, side: "RIGHT", subjectType: "LINE" },
      ...overrides,
    };
  }

  function finalDoc(issues: Issue[]): FinalDoc {
    const confirmed = issues.length;
    return {
      issues,
      rejected: [],
      unverified: [],
      stats: { total: confirmed, confirmed, rejected: 0, unverified: 0 },
    };
  }

  it("inlineable が0件なら query を呼ばず deferred 言及の summaryBody を返す", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ summaryBody: "s", comments: [] }, { calls });
    const deferredIssue = baseIssue({
      id: "g2",
      resolved: false,
      params: undefined,
    });
    const result = await llmCommentBodies(
      finalDoc([deferredIssue]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(calls.length).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.summaryBody).toContain("タイトル");
  });

  it("inlineable/deferred とも0件なら「問題は見つかりませんでした。」を返す", async () => {
    const calls: unknown[] = [];
    const query = makeFakeQuery({ summaryBody: "s", comments: [] }, { calls });
    const result = await llmCommentBodies(
      finalDoc([]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(calls.length).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.summaryBody).toBe("問題は見つかりませんでした。");
  });

  it("バッジ＋パーマリンクを TS で先頭に付与する", async () => {
    const query = makeFakeQuery({
      summaryBody: "サマリ",
      comments: [{ id: "g1", commentBody: "本文コメント" }],
    });
    const result = await llmCommentBodies(
      finalDoc([baseIssue()]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    const c = result.comments[0];
    expect(c?.commentBody).toContain("🐛 **Bug**");
    expect(c?.commentBody).toContain("🟠 **High**");
    expect(c?.commentBody).toContain("<sub>📍");
    expect(c?.commentBody).toContain("a.ts:10");
    expect(c?.commentBody).toContain(
      "https://github.com/owner/repo/blob/sha1/a.ts#L10",
    );
    expect(c?.commentBody).toContain("本文コメント");
  });

  it("resolved:false は comments から除外され summaryBody に回る", async () => {
    const query = makeFakeQuery({
      summaryBody: "サマリのみ",
      comments: [{ id: "g1", commentBody: "本文コメント" }],
    });
    const deferredIssue = baseIssue({
      id: "g2",
      resolved: false,
      params: undefined,
    });
    const result = await llmCommentBodies(
      finalDoc([baseIssue(), deferredIssue]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(result.comments.map((c) => c.id)).toEqual(["g1"]);
    expect(result.summaryBody).toBe("サマリのみ");
  });

  it("単一 finding 以外（統合 issue）の suggestion/deleteLines を剥がす", async () => {
    const query = makeFakeQuery({
      summaryBody: "s",
      comments: [
        {
          id: "g1",
          commentBody: "本文",
          suggestion: "const x = 2;",
          deleteLines: ["const x = 1;"],
        },
      ],
    });
    const mergedIssue = baseIssue({ sourceFindingIds: ["f1", "f2"] });
    const result = await llmCommentBodies(
      finalDoc([mergedIssue]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    const c = result.comments[0];
    expect(c && "suggestion" in c).toBe(false);
    expect(c && "deleteLines" in c).toBe(false);
  });

  it("LLM が欠落させた inlineable id を title/body から backfill する", async () => {
    const query = makeFakeQuery({ summaryBody: "s", comments: [] });
    const result = await llmCommentBodies(
      finalDoc([baseIssue()]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.id).toBe("g1");
    expect(result.comments[0]?.commentBody).toContain("本文");
  });

  it("throwing query でも fallback → backfill 後に comments が欠落せず、deferred0件なら矛盾表示にもならない", async () => {
    const query = makeThrowingQuery();
    const result = await llmCommentBodies(
      finalDoc([baseIssue()]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.id).toBe("g1");
    // インライン投稿があるのに「問題は見つかりませんでした。」と矛盾表示しないこと
    expect(result.summaryBody).toBe("");
  });

  it("throwing query かつ deferred があれば summaryBody が deferred 一覧文言になる", async () => {
    const query = makeThrowingQuery();
    const deferredIssue = baseIssue({
      id: "g2",
      resolved: false,
      params: undefined,
    });
    const result = await llmCommentBodies(
      finalDoc([baseIssue(), deferredIssue]),
      { prHeadSha: "sha1", nameWithOwner: "owner/repo" },
      { query },
    );
    expect(result.comments).toHaveLength(1);
    expect(result.summaryBody).not.toContain("問題は見つかりませんでした");
    expect(result.summaryBody).toContain("タイトル");
  });
});
