// pipeline.ts の統合テスト。exec/query/readFile を全モック注入し、git を呼ばずに
// E2E をユニット再現する（docs/plans/04-llm-steps.md のテスト方針）。
import { describe, expect, it } from "vitest";
import { runLocalReview } from "../src/pipeline.ts";
import type { ExecResult } from "../src/lib/exec.ts";

const DIFF_TEXT = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 function f() {
-  return 1;
+  return x.value; // x は未定義参照
 }
`;

// staged モードで collectContext / pipeline が呼ぶ git コマンドを分岐するフェイク exec。
function makeFakeExec(): (command: string, args: string[], options?: unknown) => Promise<ExecResult> {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    if (command !== "git") return { stdout: "", stderr: "", code: 0 };

    if (args[0] === "diff" && args.includes("--staged") && args.includes("--name-only")) {
      return { stdout: "a.ts\n", stderr: "", code: 0 };
    }
    if (args[0] === "check-attr") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return { stdout: "1\t1\ta.ts\n", stderr: "", code: 0 };
    }
    if (args.includes("diff") && args.includes("--staged") && !args.includes("--numstat") && !args.includes("--name-only")) {
      // buildDiffArgs 経由の統一 diff 取得（-c core.quotepath=false diff --staged ...）。
      return { stdout: DIFF_TEXT, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

// runStructured の result 経路に合わせたフェイク query。呼び出し内容（system prompt）に
// 応じて finding/verdict などステップごとに異なる応答を返す。
function makeFakeQuery() {
  return ((params: { prompt: string; options: { systemPrompt?: string } }) => {
    const system = params.options.systemPrompt ?? "";
    let structuredOutput: unknown;
    if (system.includes("サマリ") || system.includes("要約")) {
      structuredOutput = { summary: "x の未定義参照バグを修正する変更", clusters: [] };
    } else if (system.includes("検証するレビューエージェント")) {
      // verifySystem() は「プロジェクトルール違反の場合」という文言も含むため、
      // ruleAgentSystem() の判定より先に固有の見出し文言で判別する。
      structuredOutput = { verdict: "confirmed", reason: "x は実際に未定義であることを確認した" };
    } else if (system.includes("バグ検出")) {
      structuredOutput = {
        findings: [
          {
            agent: 3,
            path: "a.ts",
            title: "未定義変数 x への参照",
            body: "x が定義されていないため実行時エラーになる",
            existingCode: "return x.value; // x は未定義参照",
            category: "bug",
            severity: "critical",
          },
        ],
      };
    } else if (system.includes("ルール")) {
      structuredOutput = { findings: [] };
    } else if (system.includes("REVIEW.md")) {
      structuredOutput = { findings: [] };
    } else if (system.includes("統合")) {
      structuredOutput = { title: "統合タイトル", body: "統合本文" };
    } else {
      structuredOutput = {};
    }

    return (async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        num_turns: 1,
        result: JSON.stringify(structuredOutput),
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        structured_output: structuredOutput,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "fake-session",
      };
    })();
  }) as unknown as Parameters<typeof runLocalReview>[2] extends { query?: infer Q } ? Q : never;
}

describe("runLocalReview", () => {
  it("staged・tiny・明白なバグ1件 → final.confirmed に1件", async () => {
    const exec = makeFakeExec();
    const query = makeFakeQuery();
    const readFile = () => null; // CLAUDE.md/REVIEW.md/rules 本文なし（agent5 は非起動）。

    const { final, ctx } = await runLocalReview(
      { mode: "range", range: undefined },
      { debug: false },
      { exec: exec as never, query, readFile },
    );

    expect(ctx.source).toBe("staged");
    expect(ctx.tier).toBe("tiny");
    expect(final.stats.confirmed).toBe(1);
    expect(final.issues[0]?.title).toContain("未定義変数");
  });
});
