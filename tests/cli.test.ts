import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/cli.ts";

describe("parseArgs", () => {
  it("--range の直後に短縮フラグ -q が来ても値として消費しない", () => {
    const args = parseArgs(["local", "--range", "-q"]);
    expect(args.range).toBe(true);
    expect(args.quiet).toBe(true);
  });

  it("--range に差分範囲の値を渡せる（回帰なし）", () => {
    const args = parseArgs(["local", "--range", "main...HEAD"]);
    expect(args.range).toBe("main...HEAD");
  });

  it("--range を末尾で値省略した場合 range: true になる", () => {
    const args = parseArgs(["local", "--range"]);
    expect(args.range).toBe(true);
  });

  it("未知の短縮フラグは unknown option として拒否する", () => {
    expect(() => parseArgs(["local", "-x"])).toThrow(UsageError);
    expect(() => parseArgs(["local", "-x"])).toThrow(/unknown option: -x/);
  });
});
