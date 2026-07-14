import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT7_SERVER_NAME } from "../src/lib/mcp-config.ts";
import {
  bugAgentSystem,
  bugAgentUser,
  clusterAgentSystem,
  clusterAgentUser,
  FALSE_POSITIVE_EXCLUSIONS,
  FINDINGS_SCHEMA,
  MERGE_TEXT_SCHEMA,
  MODEL_HEAVY,
  MODEL_LIGHT,
  mergeTextSystem,
  mergeTextUser,
  READ_ONLY_TOOLS,
  RETRY_ANCHOR_SCHEMA,
  retryAnchorSystem,
  retryAnchorUser,
  reviewMdAgentSystem,
  reviewMdAgentUser,
  reviewTools,
  ruleAgentSystem,
  ruleAgentUser,
  SUMMARY_CLUSTERS_SCHEMA,
  SUMMARY_ONLY_SCHEMA,
  summaryClustersSystem,
  summaryClustersUser,
  VERDICT_SCHEMA,
  verifySystem,
  verifyUser,
  WEB_TOOLS,
} from "../src/llm/prompts.ts";

describe("モデルエイリアス定数", () => {
  it("既定値: CODE_REVIEW_MODEL_LIGHT/_HEAVY が未設定なら MODEL_LIGHT は sonnet、MODEL_HEAVY は opus", () => {
    expect(MODEL_LIGHT).toBe("sonnet");
    expect(MODEL_HEAVY).toBe("opus");
  });
});

describe("reviewTools", () => {
  afterEach(() => {
    delete process.env.CODE_REVIEW_ENABLE_WEB;
    delete process.env.CODE_REVIEW_DISABLE_CONTEXT7;
  });

  it("既定（環境変数未設定）は READ_ONLY_TOOLS + context7 の mcp__ エントリ", () => {
    expect(reviewTools()).toEqual([
      ...READ_ONLY_TOOLS,
      `mcp__${CONTEXT7_SERVER_NAME}`,
    ]);
  });

  it("CODE_REVIEW_DISABLE_CONTEXT7=1 のとき context7 の mcp__ エントリを含めない", () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "1";
    expect(reviewTools()).toEqual([...READ_ONLY_TOOLS]);
  });

  it("CODE_REVIEW_ENABLE_WEB=1 のとき WEB_TOOLS を追加する", () => {
    process.env.CODE_REVIEW_ENABLE_WEB = "1";
    expect(reviewTools()).toEqual([
      ...READ_ONLY_TOOLS,
      `mcp__${CONTEXT7_SERVER_NAME}`,
      ...WEB_TOOLS,
    ]);
  });

  it("CODE_REVIEW_ENABLE_WEB=0 のとき WEB_TOOLS を追加しない", () => {
    process.env.CODE_REVIEW_ENABLE_WEB = "0";
    expect(reviewTools()).toEqual([
      ...READ_ONLY_TOOLS,
      `mcp__${CONTEXT7_SERVER_NAME}`,
    ]);
  });
});

describe("schema 定数", () => {
  it("FINDINGS_SCHEMA はトップレベル object で { findings: Finding[] } をラップする（Anthropic API の json_schema はトップレベル配列不可のため）", () => {
    expect(FINDINGS_SCHEMA.type).toBe("object");
    expect(FINDINGS_SCHEMA.required as string[]).toEqual(["findings"]);
    const findingsProp = (
      FINDINGS_SCHEMA.properties as {
        findings: { items: { properties: Record<string, unknown> } };
      }
    ).findings;
    const props = findingsProp.items.properties;
    expect(props.line).toBeUndefined();
    expect(props.startLine).toBeUndefined();
    expect(props.agent).toBeUndefined(); // agent 番号もコード側(stampAgent)が機械注入するため LLM には出させない
    expect(props.path).toBeDefined();
    expect(props.existingCode).toBeDefined();
  });

  it("MERGE_TEXT_SCHEMA / VERDICT_SCHEMA は id/groupId を持たない（コード側付与）", () => {
    const mergeProps = (
      MERGE_TEXT_SCHEMA as { properties: Record<string, unknown> }
    ).properties;
    expect(mergeProps.groupId).toBeUndefined();
    const verdictProps = (
      VERDICT_SCHEMA as { properties: Record<string, unknown> }
    ).properties;
    expect(verdictProps.id).toBeUndefined();
  });
});

describe("summaryClustersSystem/User", () => {
  it("wantClusters=false のとき clusters 不要文言を含む", () => {
    const sys = summaryClustersSystem({ wantClusters: false });
    expect(sys).toContain("クラスタ分割は不要");
    const user = summaryClustersUser({
      authorInfo: "info",
      diffText: "diff",
      wantClusters: false,
    });
    expect(user).toContain("空配列");
    expect(user).toContain("info");
    expect(user).toContain("diff");
  });

  it("wantClusters=true のとき分割指針（最大3・クラスタ規約）を含む", () => {
    const sys = summaryClustersSystem({ wantClusters: true });
    expect(sys).toContain("最大3");
    const user = summaryClustersUser({
      authorInfo: "info",
      diffText: "diff",
      wantClusters: true,
    });
    expect(user).not.toContain("空配列");
  });
});

describe("ruleAgentSystem/User", () => {
  it("rule-violation 固定・ruleRefs 必須・rules 限定を明記する", () => {
    const sys = ruleAgentSystem();
    expect(sys).toContain("rule-violation");
    expect(sys).toContain("ruleRefs");
    const user = ruleAgentUser({
      agent: 1,
      assignment: { files: [{ path: "a.ts", rules: ["CLAUDE.md"] }] },
      ruleTexts: [{ path: "CLAUDE.md", content: "ルール本文" }],
      summary: "サマリ",
      diffText: "diff",
    });
    expect(user).toContain("a.ts");
    expect(user).toContain("ルール本文");
    expect(user).toContain("サマリ");
  });

  it("ruleTexts が空（ファイル欠落）のとき「参照コンテキストなし」を明記する", () => {
    const user = ruleAgentUser({
      agent: 1,
      assignment: { files: [{ path: "a.ts", rules: [] }] },
      ruleTexts: [],
      summary: null,
      diffText: "diff",
    });
    expect(user).toContain("参照コンテキストなし");
  });

  it("Read/Grep/Glob で diff 外コードも確認してよい旨を明記する（精度優先の方針）", () => {
    expect(ruleAgentSystem()).toContain("Read/Grep/Glob");
  });
});

describe("bugAgentSystem/User", () => {
  it("read-only ツールで diff 外コードも確認してよい旨を明記する（精度優先の方針転換）", () => {
    const sys = bugAgentSystem();
    expect(sys).toContain("Read/Grep/Glob");
    const user = bugAgentUser({ summary: "サマリ", diffText: "diff-text" });
    expect(user).toContain("diff-text");
  });
});

describe("clusterAgentSystem/User", () => {
  it("read-only ツールで diff 外ファイルも確認してよい旨を明記する", () => {
    const sys = clusterAgentSystem();
    expect(sys).toContain("Read/Grep/Glob");
    const user = clusterAgentUser({
      cluster: {
        id: 1,
        theme: "T",
        changedFiles: ["a.ts"],
        symbols: ["f"],
        contextHints: ["b.ts"],
      },
      summary: "サマリ",
      diffText: "diff",
      contextFiles: [{ path: "b.ts", content: "コンテキスト本文" }],
    });
    expect(user).toContain("T");
    expect(user).toContain("コンテキスト本文");
  });

  it("contextFiles が空のとき「参照コンテキストなし」を明記する", () => {
    const user = clusterAgentUser({
      cluster: {
        id: 1,
        theme: "T",
        changedFiles: [],
        symbols: [],
        contextHints: ["missing.ts"],
      },
      summary: null,
      diffText: "diff",
      contextFiles: [{ path: "missing.ts", content: null }],
    });
    expect(user).toContain("参照コンテキストなし");
  });
});

describe("reviewMdAgentSystem/User", () => {
  it("rule-violation 固定・ruleRefs 必須・REVIEW.md 本文埋め込みを明記する", () => {
    const sys = reviewMdAgentSystem();
    expect(sys).toContain("rule-violation");
    expect(sys).toContain("ruleRefs");
    const user = reviewMdAgentUser({
      reviewMd: "REVIEW 本文",
      summary: "サマリ",
      diffText: "diff",
    });
    expect(user).toContain("REVIEW 本文");
  });

  it("Read/Grep/Glob で diff 外コードも確認してよい旨を明記する（精度優先の方針）", () => {
    expect(reviewMdAgentSystem()).toContain("Read/Grep/Glob");
  });
});

describe("mergeTextSystem/User", () => {
  it("統合方針（趣旨が異なるものは両方残す）を明記する", () => {
    const sys = mergeTextSystem();
    expect(sys).toContain("両方の趣旨");
    const user = mergeTextUser({
      members: [
        { title: "t1", body: "b1" },
        { title: "t2", body: "b2" },
      ],
    });
    expect(user).toContain("t1");
    expect(user).toContain("t2");
  });
});

describe("verifySystem/User", () => {
  it("confirmed/rejected 判定方針を明記する", () => {
    const sys = verifySystem();
    expect(sys).toContain("confirmed");
    expect(sys).toContain("rejected");
    const user = verifyUser({
      issue: {
        path: "a.ts",
        kind: "bug",
        title: "t",
        body: "b",
        params: { line: 5, side: "RIGHT", subjectType: "LINE" },
      },
      summary: "サマリ",
      diffText: "diff --git a/a.ts b/a.ts\n+foo",
    });
    expect(user).toContain("a.ts");
    expect(user).toContain("line");
  });

  it("summary が null のときサマリなし文言を含む", () => {
    const user = verifyUser({
      issue: { path: "a.ts", kind: "rule", title: "t", body: "b" },
      summary: null,
      diffText: "diff --git a/a.ts b/a.ts\n+foo",
    });
    expect(user).toContain("サマリなし");
  });

  it("read-only ツールで実コードを確認する指示を含む", () => {
    const sys = verifySystem();
    expect(sys).toContain("Read");
    expect(sys).toContain("Grep");

    const user = verifyUser({
      issue: { path: "a.ts", kind: "bug", title: "t", body: "b" },
      summary: null,
      diffText: "diff --git a/a.ts b/a.ts\n+foo",
    });
    expect(user).toContain("Read ツール");
    expect(user).toContain("a.ts");
  });

  it("diffText を渡すとプロンプトに差分が含まれる", () => {
    const user = verifyUser({
      issue: { path: "a.ts", kind: "bug", title: "t", body: "b" },
      summary: null,
      diffText: "diff --git a/a.ts b/a.ts\n+added line",
    });
    expect(user).toContain("added line");
  });

  it("diffText が空のとき参照コンテキストなし文言を含む", () => {
    const user = verifyUser({
      issue: { path: "a.ts", kind: "bug", title: "t", body: "b" },
      summary: null,
      diffText: "",
    });
    expect(user).toContain("参照コンテキストなし");
  });

  it("誤検知除外リスト（既存問題・lint類・ルール外の一般論など）を含む", () => {
    const sys = verifySystem();
    expect(sys).toContain(FALSE_POSITIVE_EXCLUSIONS);
    expect(sys).toContain("既存");
    expect(sys).toContain("リンタ");
  });
});

describe("externalReferenceInstruction（context7/Web の出し分け, verifySystem 経由で検証）", () => {
  afterEach(() => {
    delete process.env.CODE_REVIEW_DISABLE_CONTEXT7;
    delete process.env.CODE_REVIEW_ENABLE_WEB;
  });

  it("既定（context7 有効・Web 無効）は context7 のみ言及する", () => {
    const sys = verifySystem();
    expect(sys).toContain("context7");
    expect(sys).not.toContain("WebFetch");
  });

  it("CODE_REVIEW_DISABLE_CONTEXT7=1 のとき context7 に言及しない", () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "1";
    expect(verifySystem()).not.toContain("context7");
  });

  it("CODE_REVIEW_ENABLE_WEB=1 のとき WebFetch/WebSearch に言及する", () => {
    process.env.CODE_REVIEW_ENABLE_WEB = "1";
    expect(verifySystem()).toContain("WebFetch/WebSearch");
  });

  it("context7・Web とも無効なとき何も言及しない", () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "1";
    const sys = verifySystem();
    expect(sys).not.toContain("context7");
    expect(sys).not.toContain("WebFetch");
  });
});

describe("RETRY_ANCHOR_SCHEMA", () => {
  it("トップレベル object で { patches: [...] } をラップし、id/existingCode が required", () => {
    expect(RETRY_ANCHOR_SCHEMA.type).toBe("object");
    expect(RETRY_ANCHOR_SCHEMA.required as string[]).toEqual(["patches"]);
    const patchesProp = (
      RETRY_ANCHOR_SCHEMA.properties as {
        patches: { items: { required: string[] } };
      }
    ).patches;
    expect(patchesProp.items.required).toEqual(["id", "existingCode"]);
  });
});

describe("retryAnchorSystem/User", () => {
  it("行番号を書かない・id をそのまま返す旨を明記する", () => {
    const sys = retryAnchorSystem();
    expect(sys).toContain("行番号は書かない");
    expect(sys).toContain("id は入力のまま変更せずそのまま返して");

    const user = retryAnchorUser({
      unresolved: [
        { id: "f1", path: "a.ts", existingCode: "old code", reason: "不一致" },
      ],
      diffText: "diff --git a/a.ts b/a.ts\n+foo",
    });
    expect(user).toContain("f1");
    expect(user).toContain("a.ts");
    expect(user).toContain("old code");
    expect(user).toContain("不一致");
    expect(user).toContain("foo");
  });
});

// SUMMARY_ONLY_SCHEMA / SUMMARY_CLUSTERS_SCHEMA の形状の違いも軽く検証する。
describe("SUMMARY_ONLY_SCHEMA / SUMMARY_CLUSTERS_SCHEMA", () => {
  it("SUMMARY_ONLY_SCHEMA は clusters を要求しない", () => {
    expect(SUMMARY_ONLY_SCHEMA.required as string[]).toEqual(["summary"]);
  });
  it("SUMMARY_CLUSTERS_SCHEMA は summary と clusters を要求する", () => {
    expect(SUMMARY_CLUSTERS_SCHEMA.required as string[]).toEqual([
      "summary",
      "clusters",
    ]);
  });
});
