import { describe, expect, it } from "vitest";
import {
  bugAgentSystem,
  bugAgentUser,
  clusterAgentSystem,
  clusterAgentUser,
  FINDINGS_SCHEMA,
  MERGE_TEXT_SCHEMA,
  MODEL_HEAVY,
  MODEL_LIGHT,
  mergeTextSystem,
  mergeTextUser,
  reviewMdAgentSystem,
  reviewMdAgentUser,
  ruleAgentSystem,
  ruleAgentUser,
  SUMMARY_CLUSTERS_SCHEMA,
  SUMMARY_ONLY_SCHEMA,
  summaryClustersSystem,
  summaryClustersUser,
  VERDICT_SCHEMA,
  verifySystem,
  verifyUser,
} from "../src/llm/prompts.ts";

describe("モデルエイリアス定数", () => {
  it("MODEL_LIGHT は sonnet、MODEL_HEAVY は opus", () => {
    expect(MODEL_LIGHT).toBe("sonnet");
    expect(MODEL_HEAVY).toBe("opus");
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
});

describe("bugAgentSystem/User", () => {
  it("diff 限定・追加コンテキスト参照禁止を明記する", () => {
    const sys = bugAgentSystem();
    expect(sys).toContain("追加コンテキスト");
    const user = bugAgentUser({ summary: "サマリ", diffText: "diff-text" });
    expect(user).toContain("diff-text");
  });
});

describe("clusterAgentSystem/User", () => {
  it("diff と埋め込みコンテキスト以外は参照不可を明記する", () => {
    const sys = clusterAgentSystem();
    expect(sys).toContain("diff と埋め込みコンテキスト以外は参照");
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
    });
    expect(user).toContain("a.ts");
    expect(user).toContain("line");
  });

  it("summary が null のときサマリなし文言を含む", () => {
    const user = verifyUser({
      issue: { path: "a.ts", kind: "rule", title: "t", body: "b" },
      summary: null,
    });
    expect(user).toContain("サマリなし");
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
