import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/lib/exec.ts";
import {
  buildPayload,
  buildSuggestionBody,
  postReview,
  SUMMARY_MARKER,
} from "../src/lib/post-review.ts";
import type { FinalDoc, Issue } from "../src/lib/types.ts";

// テストで変化しない共通フィールドを既定値にし、各ケースは差分（id/path/existingCode/
// resolved/params/sourceFindingIds 等）だけ渡せばよいようにするビルダー。
function makeIssue(
  overrides: Partial<Issue> & Pick<Issue, "id" | "path">,
): Issue {
  return {
    kind: "bug",
    category: "bug",
    severity: "medium",
    title: "T",
    body: "B",
    ruleRefs: [],
    resolved: false,
    sourceFindingIds: [],
    ...overrides,
  };
}

function makeFinalDoc(issues: Issue[]): FinalDoc {
  const confirmed = issues.filter((i) => i.resolved).length;
  return {
    issues,
    rejected: [],
    unverified: [],
    stats: {
      total: issues.length,
      confirmed,
      rejected: 0,
      unverified: issues.length - confirmed,
    },
  };
}

// g1: 単一行 singleton（existingCode 1行）。g2: 2行 singleton（existingCode 2行）。
// g3: resolved:false。
function makeBaseFinalDoc(): FinalDoc {
  return makeFinalDoc([
    makeIssue({
      id: "g1",
      path: "src/a.js",
      existingCode: "const x = 1;",
      resolved: true,
      sourceFindingIds: ["f1"],
      params: { line: 10, side: "RIGHT", subjectType: "LINE" },
    }),
    makeIssue({
      id: "g2",
      path: "src/b.js",
      existingCode: "# APM dependencies\napm_modules/",
      resolved: true,
      sourceFindingIds: ["f2"],
      params: {
        startLine: 3,
        line: 4,
        startSide: "RIGHT",
        side: "RIGHT",
        subjectType: "LINE",
      },
    }),
    makeIssue({
      id: "g3",
      path: "src/c.js",
      sourceFindingIds: ["f3"],
      reason: "不一致",
    }),
  ]);
}

describe("post-review", () => {
  it("buildPayload: 基本形（commit_id / event / body）を組み立てる", () => {
    // resolved:true が g1,g2。両方 comments に含めないと黙殺エラーになるため両方渡す。
    const p = buildPayload(
      {
        summaryBody: "## サマリ",
        comments: [
          { id: "g1", commentBody: "問題1" },
          { id: "g2", commentBody: "問題2" },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "abc123" },
    );
    expect(p.commit_id).toBe("abc123");
    expect(p.event).toBe("COMMENT");
    expect(p.body).toBe(`${SUMMARY_MARKER}\n\n## サマリ`);
    expect(p.comments.length).toBe(2);
  });

  it("buildPayload: summaryBody 先頭に SUMMARY_MARKER が付く（未指定でもマーカー行は入る）", () => {
    const p = buildPayload({ comments: [] }, makeFinalDoc([]), {
      commitId: "abc123",
    });
    expect(p.body).toBe(`${SUMMARY_MARKER}\n\n`);
    expect(p.body.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it("toComment: 単一行は line+side のみ、start_*/subjectType を含めない", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          { id: "g2", commentBody: "y" },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    const c1 = p.comments.find((c) => c.path === "src/a.js")!;
    expect(c1).toEqual({
      path: "src/a.js",
      body: "x",
      line: 10,
      side: "RIGHT",
    });
    expect("start_line" in c1).toBe(false);
    expect("subjectType" in c1).toBe(false);
  });

  it("toComment: 複数行は start_line/start_side を snake_case に変換する", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          { id: "g2", commentBody: "y" },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js")!;
    expect(c2).toEqual({
      path: "src/b.js",
      body: "y",
      line: 4,
      side: "RIGHT",
      start_line: 3,
      start_side: "RIGHT",
    });
  });

  it("suggestion 無しは commentBody をそのまま body にする", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "文章のみ" },
          { id: "g2", commentBody: "y" },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    expect(p.comments.find((c) => c.path === "src/a.js")!.body).toBe(
      "文章のみ",
    );
  });

  it("suggestion: 行数一致（単一行 singleton）は ```suggestion ブロックで結合する", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "提案", suggestion: "const x = 2;" },
          { id: "g2", commentBody: "y" },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    expect(p.comments.find((c) => c.path === "src/a.js")!.body).toBe(
      "提案\n\n```suggestion\nconst x = 2;\n```",
    );
  });

  it("回帰（gitignore 事故）: 2行範囲×1行 suggestion×deleteLines 無し → suggestion を捨て文章のみ・コード非削除", () => {
    // existingCode = "# APM dependencies\napm_modules/"（2行）。suggestion を翻訳コメント1行にすると
    // apm_modules/ が消える。deleteLines 無しなので機械ガードが suggestion を捨てる。
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          {
            id: "g2",
            commentBody: "コメントは日本語で",
            suggestion: "# APMパッケージ依存",
          },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js")!;
    expect(c2.body.includes("```suggestion")).toBe(false);
    expect(c2.body.includes("apm_modules/ を消")).toBe(false);
    expect(c2.body).toMatch(/自動判定/);
    expect(c2.body.trim().length).toBeGreaterThan(0);
  });

  it("suggestion: deleteLines で削除を明示すれば行削除 suggestion も投稿する", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          {
            id: "g2",
            commentBody: "不要コメント削除",
            suggestion: "apm_modules/",
            deleteLines: ["# APM dependencies"],
          },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    expect(p.comments.find((c) => c.path === "src/b.js")!.body).toBe(
      "不要コメント削除\n\n```suggestion\napm_modules/\n```",
    );
  });

  it("suggestion: deleteLines に無い行が消えるなら捨てる", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          {
            id: "g2",
            commentBody: "コメント翻訳",
            suggestion: "# APMパッケージ依存",
            deleteLines: ["# APM dependencies"],
          },
        ],
      },
      makeBaseFinalDoc(),
      { commitId: "x" },
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js")!;
    expect(c2.body.includes("```suggestion")).toBe(false);
    expect(c2.body).toMatch(/自動判定/);
  });

  it("suggestion: 複数メンバーの統合 issue には付けず捨てる", () => {
    const merged = makeFinalDoc([
      makeIssue({
        id: "g1",
        path: "src/a.js",
        existingCode: "const x = 1;",
        resolved: true,
        sourceFindingIds: ["f1", "f2"],
        params: { line: 10, side: "RIGHT", subjectType: "LINE" },
      }),
    ]);
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "統合課題", suggestion: "const x = 2;" },
        ],
      },
      merged,
      { commitId: "x" },
    );
    const c1 = p.comments.find((c) => c.path === "src/a.js")!;
    expect(c1.body.includes("```suggestion")).toBe(false);
    expect(c1.body).toMatch(/統合/);
  });

  it("buildSuggestionBody: 範囲行数と existingCode 行数の不一致は捨てる", () => {
    const issue = makeIssue({
      id: "gx",
      path: "src/x.js",
      existingCode: "a\nb\nc",
      resolved: true,
      sourceFindingIds: ["f1"],
      params: {
        startLine: 1,
        line: 2,
        startSide: "RIGHT",
        side: "RIGHT",
        subjectType: "LINE",
      },
    });
    const r = buildSuggestionBody(issue, "a\nb", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/範囲行数/);
  });

  it("検証: comments が配列でなければ throw", () => {
    expect(() =>
      buildPayload({ summaryBody: "s" } as never, makeBaseFinalDoc(), {
        commitId: "x",
      }),
    ).toThrow(/comments は配列/);
  });

  it("検証: 未知 id は throw", () => {
    expect(() =>
      buildPayload(
        { summaryBody: "s", comments: [{ id: "g99", commentBody: "x" }] },
        makeBaseFinalDoc(),
        { commitId: "x" },
      ),
    ).toThrow(/存在しません/);
  });

  it("検証: 重複 id は throw", () => {
    expect(() =>
      buildPayload(
        {
          summaryBody: "s",
          comments: [
            { id: "g1", commentBody: "x" },
            { id: "g1", commentBody: "y" },
            { id: "g2", commentBody: "z" },
          ],
        },
        makeBaseFinalDoc(),
        { commitId: "x" },
      ),
    ).toThrow(/重複/);
  });

  it("検証: resolved:false の id を comments に入れると throw", () => {
    expect(() =>
      buildPayload(
        {
          summaryBody: "s",
          comments: [
            { id: "g1", commentBody: "x" },
            { id: "g2", commentBody: "y" },
            { id: "g3", commentBody: "z" },
          ],
        },
        makeBaseFinalDoc(),
        { commitId: "x" },
      ),
    ).toThrow(/インライン投稿できません/);
  });

  it("検証: resolved:true confirmed の黙殺（comments 欠落）は throw", () => {
    // g2 を渡し忘れ → 黙殺防止で throw。
    expect(() =>
      buildPayload(
        { summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }] },
        makeBaseFinalDoc(),
        {
          commitId: "x",
        },
      ),
    ).toThrow(/黙殺防止/);
  });

  it("検証: commentBody 空は throw", () => {
    expect(() =>
      buildPayload(
        {
          summaryBody: "s",
          comments: [
            { id: "g1", commentBody: "  " },
            { id: "g2", commentBody: "y" },
          ],
        },
        makeBaseFinalDoc(),
        { commitId: "x" },
      ),
    ).toThrow(/commentBody が空/);
  });

  it("許容: resolved 済み issue 0 件ならサマリのみ投稿（課題ゼロ）", () => {
    const emptyFinal = makeFinalDoc([
      makeIssue({ id: "g3", path: "c.js", sourceFindingIds: ["f3"] }),
    ]);
    const p = buildPayload(
      { summaryBody: "問題は見つかりませんでした。", comments: [] },
      emptyFinal,
      { commitId: "x" },
    );
    expect(p.comments).toEqual([]);
    expect(p.body).toBe(`${SUMMARY_MARKER}\n\n問題は見つかりませんでした。`);
  });

  it("許容: confirmed 0 件（FINAL 空）ならサマリのみ投稿", () => {
    const emptyFinal = makeFinalDoc([]);
    const p = buildPayload(
      { summaryBody: "課題なし", comments: [] },
      emptyFinal,
      { commitId: "x" },
    );
    expect(p.comments).toEqual([]);
  });
});

function makeFakeExec(
  handler: (
    command: string,
    args: string[],
    options?: { input?: string },
  ) => ExecResult,
): (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<ExecResult> {
  return async (command, args, options) => handler(command, args, options);
}

describe("postReview", () => {
  it("gh api の argv と stdin payload、html_url を検証する", async () => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const exec = makeFakeExec((command, args, options) => {
      calls.push({ command, args, input: options?.input });
      return {
        stdout: JSON.stringify({ html_url: "https://example.com/pr/1" }),
        stderr: "",
        code: 0,
      };
    });

    const url = await postReview({
      pr: "1",
      nameWithOwner: "owner/repo",
      postInput: {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          { id: "g2", commentBody: "y" },
        ],
      },
      final: makeBaseFinalDoc(),
      commitId: "abc123",
      exec,
    });

    expect(url).toBe("https://example.com/pr/1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("gh");
    expect(calls[0]?.args).toEqual([
      "api",
      "--method",
      "POST",
      "/repos/owner/repo/pulls/1/reviews",
      "--input",
      "-",
    ]);
    const payload = JSON.parse(calls[0]?.input ?? "{}");
    expect(payload.commit_id).toBe("abc123");
    expect(payload.event).toBe("COMMENT");
  });

  it("code!==0 は stderr を含めて throw する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "",
      stderr: "HTTP 422",
      code: 1,
    }));
    await expect(
      postReview({
        pr: "1",
        nameWithOwner: "owner/repo",
        postInput: {
          summaryBody: "s",
          comments: [
            { id: "g1", commentBody: "x" },
            { id: "g2", commentBody: "y" },
          ],
        },
        final: makeBaseFinalDoc(),
        commitId: "abc123",
        exec,
      }),
    ).rejects.toThrow(/HTTP 422/);
  });

  it("buildPayload の黙殺防止 throw が exec 呼び出し前に発生する", async () => {
    const calls: unknown[] = [];
    const exec = makeFakeExec(() => {
      calls.push(1);
      return { stdout: "{}", stderr: "", code: 0 };
    });
    await expect(
      postReview({
        pr: "1",
        nameWithOwner: "owner/repo",
        postInput: {
          summaryBody: "s",
          comments: [{ id: "g1", commentBody: "x" }],
        },
        final: makeBaseFinalDoc(),
        commitId: "abc123",
        exec,
      }),
    ).rejects.toThrow(/黙殺防止/);
    expect(calls).toHaveLength(0);
  });
});
