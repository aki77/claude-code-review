import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/lib/exec.ts";
import { assertPrHeadMatches } from "../src/lib/pr-head.ts";

function makeFakeExec(
  handler: (command: string, args: string[]) => ExecResult,
): (command: string, args: string[]) => Promise<ExecResult> {
  return async (command: string, args: string[]) => handler(command, args);
}

describe("assertPrHeadMatches", () => {
  it("ローカル HEAD が headRefOid と一致すれば解決する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "abc123\n",
      stderr: "",
      code: 0,
    }));
    await expect(
      assertPrHeadMatches("1", "abc123", { exec }),
    ).resolves.toBeUndefined();
  });

  it("不一致は SKILL 準拠のメッセージで throw する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "def456\n",
      stderr: "",
      code: 0,
    }));
    await expect(assertPrHeadMatches("1", "abc123", { exec })).rejects.toThrow(
      /PR #1 の HEAD（abc123）と一致しません（ローカル: def456）/,
    );
  });

  it("git rev-parse が失敗（code!==0）したら throw する", async () => {
    const exec = makeFakeExec(() => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
    }));
    await expect(assertPrHeadMatches("1", "abc123", { exec })).rejects.toThrow(
      /fatal: not a git repository/,
    );
  });
});
