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

  it("--background / -b で背景情報をインラインで指定できる（local）", () => {
    const args = parseArgs(["local", "--background", "認証に注目"]);
    expect(args.background).toBe("認証に注目");
  });

  it("-b は --background の短縮形として同じ値をパースする", () => {
    const args = parseArgs(["local", "-b", "認証に注目"]);
    expect(args.background).toBe("認証に注目");
  });

  it("--background-file / -B で背景情報ファイルのパスを指定できる（pr）", () => {
    const args = parseArgs(["pr", "123", "--background-file", "./docs/req.md"]);
    expect(args.backgroundFile).toBe("./docs/req.md");
  });

  it("-B は --background-file の短縮形として同じ値をパースする", () => {
    const args = parseArgs(["pr", "123", "-B", "./docs/req.md"]);
    expect(args.backgroundFile).toBe("./docs/req.md");
  });

  it("--background と --background-file を併用できる", () => {
    const args = parseArgs([
      "pr",
      "123",
      "-b",
      "認証に注目",
      "-B",
      "./docs/req.md",
    ]);
    expect(args.background).toBe("認証に注目");
    expect(args.backgroundFile).toBe("./docs/req.md");
  });

  it("--background の値が欠落している場合は UsageError", () => {
    expect(() => parseArgs(["local", "--background"])).toThrow(UsageError);
    expect(() => parseArgs(["local", "--background"])).toThrow(
      /--background には値が必要です/,
    );
  });

  it("--background の直後に別フラグが来た場合も値欠落として拒否する", () => {
    expect(() => parseArgs(["local", "--background", "--debug"])).toThrow(
      UsageError,
    );
  });

  it("--background-file の値が欠落している場合は UsageError", () => {
    expect(() => parseArgs(["pr", "123", "--background-file"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["pr", "123", "--background-file"])).toThrow(
      /--background-file には値が必要です/,
    );
  });

  it("--summary-file でサマリー出力先パスを指定できる（local）", () => {
    const args = parseArgs(["local", "--summary-file", "/tmp/summary.md"]);
    expect(args.summaryFile).toBe("/tmp/summary.md");
  });

  it("--summary-file でサマリー出力先パスを指定できる（pr）", () => {
    const args = parseArgs(["pr", "123", "--summary-file", "/tmp/summary.md"]);
    expect(args.summaryFile).toBe("/tmp/summary.md");
  });

  it("--summary-file の値が欠落している場合は UsageError", () => {
    expect(() => parseArgs(["local", "--summary-file"])).toThrow(UsageError);
    expect(() => parseArgs(["local", "--summary-file"])).toThrow(
      /--summary-file には値が必要です/,
    );
  });
});
