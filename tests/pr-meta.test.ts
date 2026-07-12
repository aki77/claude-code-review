import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/lib/exec.ts";
import {
  fetchPrMeta,
  formatPrAuthorInfo,
  getNameWithOwner,
} from "../src/lib/pr-meta.ts";

function makeFakeExec(
  handler: (command: string, args: string[]) => ExecResult,
): (command: string, args: string[]) => Promise<ExecResult> {
  return async (command: string, args: string[]) => handler(command, args);
}

describe("fetchPrMeta", () => {
  it("gh pr view の JSON を title/body/commits/headRefOid/baseRefOid/baseRefName にパースする", async () => {
    const exec = makeFakeExec(() => ({
      stdout: JSON.stringify({
        title: "T",
        body: "B",
        commits: [{ messageHeadline: "h1" }],
        headRefOid: "abc123",
        baseRefOid: "base000",
        baseRefName: "main",
      }),
      stderr: "",
      code: 0,
    }));
    const meta = await fetchPrMeta("1", { exec });
    expect(meta).toEqual({
      title: "T",
      body: "B",
      commits: [{ messageHeadline: "h1" }],
      headRefOid: "abc123",
      baseRefOid: "base000",
      baseRefName: "main",
    });
  });

  it("title/body/commits が欠落していてもデフォルト値で埋める", async () => {
    const exec = makeFakeExec(() => ({
      stdout: JSON.stringify({ headRefOid: "abc123" }),
      stderr: "",
      code: 0,
    }));
    const meta = await fetchPrMeta("1", { exec });
    expect(meta.title).toBe("");
    expect(meta.body).toBe("");
    expect(meta.commits).toEqual([]);
  });

  it("code!==0 は throw する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "",
      stderr: "not found",
      code: 1,
    }));
    await expect(fetchPrMeta("1", { exec })).rejects.toThrow(/not found/);
  });
});

describe("formatPrAuthorInfo", () => {
  it("title/body/commits を整形する", () => {
    const text = formatPrAuthorInfo({
      title: "タイトル",
      body: "説明文",
      commits: [
        { messageHeadline: "feat: 追加" },
        { messageHeadline: "fix: 修正", messageBody: "詳細説明" },
      ],
      headRefOid: "abc",
    });
    expect(text).toContain("タイトル");
    expect(text).toContain("説明文");
    expect(text).toContain("feat: 追加");
    expect(text).toContain("fix: 修正");
    expect(text).toContain("詳細説明");
  });

  it("body が空でもコミット一覧は出力する", () => {
    const text = formatPrAuthorInfo({
      title: "タイトル",
      body: "",
      commits: [{ messageHeadline: "feat: 追加" }],
      headRefOid: "abc",
    });
    expect(text).toContain("タイトル");
    expect(text).toContain("feat: 追加");
  });

  it("commits が空なら見出しを出さない", () => {
    const text = formatPrAuthorInfo({
      title: "タイトル",
      body: "",
      commits: [],
      headRefOid: "abc",
    });
    expect(text).not.toContain("コミット一覧");
  });
});

describe("getNameWithOwner", () => {
  it("stdout を trim して返す", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "owner/repo\n",
      stderr: "",
      code: 0,
    }));
    await expect(getNameWithOwner({ exec })).resolves.toBe("owner/repo");
  });

  it("code!==0 は throw する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "",
      stderr: "no repo",
      code: 1,
    }));
    await expect(getNameWithOwner({ exec })).rejects.toThrow(/no repo/);
  });
});
