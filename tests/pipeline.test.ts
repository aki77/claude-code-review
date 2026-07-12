// pipeline.ts の統合テスト。exec/query/readFile を全モック注入し、git を呼ばずに
// E2E をユニット再現する（docs/plans/04-llm-steps.md のテスト方針）。
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/lib/exec.ts";
import { runLocalReview, runPrReview } from "../src/pipeline.ts";

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
function makeFakeExec(): (
  command: string,
  args: string[],
  options?: unknown,
) => Promise<ExecResult> {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    if (command !== "git") return { stdout: "", stderr: "", code: 0 };

    if (
      args[0] === "diff" &&
      args.includes("--staged") &&
      args.includes("--name-only")
    ) {
      return { stdout: "a.ts\n", stderr: "", code: 0 };
    }
    if (args[0] === "check-attr") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return { stdout: "1\t1\ta.ts\n", stderr: "", code: 0 };
    }
    if (
      args.includes("diff") &&
      args.includes("--staged") &&
      !args.includes("--numstat") &&
      !args.includes("--name-only")
    ) {
      // buildDiffArgs 経由の統一 diff 取得（-c core.quotepath=false diff --staged ...）。
      return { stdout: DIFF_TEXT, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

// runStructured が渡す systemPrompt は claude_code プリセットオブジェクト
// （{ type: "preset", append }）。判定対象のレビュー本文は append 側に入っている。
type FakeSystemPrompt = { append?: string };

function extractSystemPrompt(systemPrompt?: FakeSystemPrompt): string {
  return systemPrompt?.append ?? "";
}

// runStructured の result 経路に合わせたフェイク query。呼び出し内容（system prompt）に
// 応じて finding/verdict などステップごとに異なる応答を返す。
function makeFakeQuery() {
  return ((params: {
    prompt: string;
    options: { systemPrompt?: FakeSystemPrompt };
  }) => {
    const system = extractSystemPrompt(params.options.systemPrompt);
    let structuredOutput: unknown;
    if (system.includes("サマリ") || system.includes("要約")) {
      structuredOutput = {
        summary: "x の未定義参照バグを修正する変更",
        clusters: [],
      };
    } else if (system.includes("検証するレビューエージェント")) {
      // verifySystem() は「プロジェクトルール違反の場合」という文言も含むため、
      // ruleAgentSystem() の判定より先に固有の見出し文言で判別する。
      structuredOutput = {
        verdict: "confirmed",
        reason: "x は実際に未定義であることを確認した",
      };
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
    } else if (system.includes("PR レビューコメントの文章")) {
      const idMatch = params.prompt.match(/id: (\S+)/);
      structuredOutput = {
        summaryBody: "サマリ本文",
        comments: idMatch
          ? [{ id: idMatch[1], commentBody: "コメント本文" }]
          : [],
      };
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
  }) as unknown as Parameters<typeof runLocalReview>[2] extends {
    query?: infer Q;
  }
    ? Q
    : never;
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

// runPrReview 用フェイク exec。fetchPrMeta (gh pr view title,body,commits,headRefOid,
// baseRefOid,baseRefName を1回で取得。resolvePrBaseRange はこの baseRef を受け取るため
// gh pr view を呼ばない) と、collectContext({mode:"pr"}) が呼ぶ git cat-file / git merge-base /
// getChangedFilesFromRange (git diff --name-only)、assertPrHeadMatches (git rev-parse HEAD)、
// getNameWithOwner (gh repo view) をルーティングする。
function makeFakePrExec(opts: {
  headMatches: boolean;
}): (command: string, args: string[]) => Promise<ExecResult> {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (
        args.includes("title,body,commits,headRefOid,baseRefOid,baseRefName")
      ) {
        return {
          stdout: JSON.stringify({
            title: "PRタイトル",
            body: "PR説明",
            commits: [{ messageHeadline: "feat: 追加" }],
            headRefOid: "head111",
            baseRefOid: "base000",
            baseRefName: "main",
          }),
          stderr: "",
          code: 0,
        };
      }
    }
    if (command === "gh" && args[0] === "repo" && args[1] === "view") {
      return { stdout: "owner/repo\n", stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "api") {
      return {
        stdout: JSON.stringify({ html_url: "https://example.com/pr/1" }),
        stderr: "",
        code: 0,
      };
    }
    if (command !== "git") return { stdout: "", stderr: "", code: 0 };

    if (args[0] === "cat-file") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "merge-base") {
      return { stdout: "merged000\n", stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return {
        stdout: opts.headMatches ? "head111\n" : "other999\n",
        stderr: "",
        code: 0,
      };
    }
    if (
      args[0] === "diff" &&
      args.includes("--name-only") &&
      args.includes("--find-renames")
    ) {
      return { stdout: "a.ts\n", stderr: "", code: 0 };
    }
    if (args[0] === "check-attr") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return { stdout: "1\t1\ta.ts\n", stderr: "", code: 0 };
    }
    if (
      args.includes("diff") &&
      !args.includes("--numstat") &&
      !args.includes("--name-only")
    ) {
      return { stdout: DIFF_TEXT, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("runPrReview", () => {
  it("--comment:false → final+ctx を返し gh api は呼ばれない", async () => {
    const exec = makeFakePrExec({ headMatches: true });
    const query = makeFakeQuery();
    const readFile = () => null;

    const result = await runPrReview(
      "1",
      { debug: false, comment: false },
      { exec: exec as never, query, readFile },
    );

    expect(result.headRefOid).toBe("head111");
    expect(result.postedUrl).toBeUndefined();
    expect(result.final.stats.confirmed).toBe(1);
  });

  it("tiny-PR は summary の LLM 呼び出しが発生しない", async () => {
    const systemPrompts: string[] = [];
    const innerQuery = makeFakeQuery();
    const query = ((params: {
      options: { systemPrompt?: FakeSystemPrompt };
    }) => {
      systemPrompts.push(extractSystemPrompt(params.options.systemPrompt));
      return innerQuery(params as never);
    }) as ReturnType<typeof makeFakeQuery>;
    const exec = makeFakePrExec({ headMatches: true });
    const readFile = () => null;

    const result = await runPrReview(
      "1",
      { debug: false, comment: false },
      { exec: exec as never, query, readFile },
    );

    expect(result.ctx.tier).toBe("tiny");
    expect(
      systemPrompts.some((s) => s.includes("サマリ") || s.includes("要約")),
    ).toBe(false);
  });

  it("--comment:true → gh api が1回呼ばれ postedUrl を返す", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const baseExec = makeFakePrExec({ headMatches: true });
    const exec = async (command: string, args: string[], options?: unknown) => {
      calls.push({ command, args });
      return baseExec(command, args, options as never);
    };
    const query = makeFakeQuery();
    const readFile = () => null;

    const result = await runPrReview(
      "1",
      { debug: false, comment: true },
      { exec: exec as never, query, readFile },
    );

    expect(result.postedUrl).toBe("https://example.com/pr/1");
    const apiCalls = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "api",
    );
    expect(apiCalls).toHaveLength(1);
  });

  it("HEAD 不一致時は query が呼ばれる前に throw する", async () => {
    const exec = makeFakePrExec({ headMatches: false });
    const calls: unknown[] = [];
    const innerQuery = makeFakeQuery();
    const query = ((params: unknown) => {
      calls.push(params);
      return innerQuery(params as never);
    }) as typeof innerQuery;
    const readFile = () => null;

    await expect(
      runPrReview(
        "1",
        { debug: false, comment: false },
        { exec: exec as never, query, readFile },
      ),
    ).rejects.toThrow(/一致しません/);
    expect(calls.length).toBe(0);
  });
});
