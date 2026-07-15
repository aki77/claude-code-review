// workspace-index.ts の単体テスト。
//
// 落とし穴1（実 index シード）・落とし穴2（空ツリー SHA フォールバック）を明示的に検証する。
// exec はモックしつつ、一時 index ファイルの実体は node:fs で実際に作成・検証する
// （copyFileSync/rmSync は実ファイルシステムに触れるため、scratchpad 配下の一時ディレクトリを使う）。
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecResult } from "../src/lib/exec.ts";
import {
  createWorkspaceIndex,
  EMPTY_TREE_SHA,
  mergeEnv,
} from "../src/lib/workspace-index.ts";

type Stub = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

const dirsToClean: string[] = [];
afterEach(() => {
  for (const d of dirsToClean.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// 実 index ファイルを持つ一時ディレクトリを作り、そのパスを返す。
function makeRealIndex(content: string): { dir: string; indexPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-index-test-"));
  dirsToClean.push(dir);
  const indexPath = path.join(dir, "index");
  writeFileSync(indexPath, content);
  return { dir, indexPath };
}

describe("mergeEnv", () => {
  it("process.env と override をマージする（override が優先）", () => {
    const merged = mergeEnv({ GIT_INDEX_FILE: "/tmp/foo" });
    expect(merged.GIT_INDEX_FILE).toBe("/tmp/foo");
    // PATH 等の既存 env が消えていないこと（環境依存だが最低限 process.env のキーが残ることを見る）。
    expect(Object.keys(merged).length).toBeGreaterThan(1);
  });
});

describe("createWorkspaceIndex", () => {
  it("実 index をシードした一時 index を作り、GIT_INDEX_FILE env を返す", async () => {
    const { indexPath } = makeRealIndex("fake-index-content");
    const calls: { command: string; args: string[] }[] = [];
    const exec: Stub = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: "head000\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-files") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const ws = await createWorkspaceIndex({ exec });
    dirsToClean.push(ws.env.GIT_INDEX_FILE);

    // 落とし穴1: 一時 index は実 index の内容をシードしている（空でない・元と同一）。
    expect(readFileSync(ws.env.GIT_INDEX_FILE, "utf8")).toBe(
      "fake-index-content",
    );
    expect(ws.env.GIT_INDEX_FILE).not.toBe(indexPath);
    expect(ws.baseRef).toBe("HEAD");
    expect(ws.untracked).toEqual([]);

    ws.dispose();
    // dispose 後は一時 index が消えている一方、実 index には触れていない。
    expect(() => readFileSync(ws.env.GIT_INDEX_FILE, "utf8")).toThrow();
    expect(readFileSync(indexPath, "utf8")).toBe("fake-index-content");
  });

  it("HEAD 不在（初回コミット前）は baseRef が空ツリー SHA になる", async () => {
    const { indexPath } = makeRealIndex("seed");
    const exec: Stub = async (_command, args) => {
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        // HEAD 不在。
        return { stdout: "", stderr: "fatal: HEAD 不在", code: 128 };
      }
      if (args[0] === "ls-files") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const ws = await createWorkspaceIndex({ exec });
    dirsToClean.push(ws.env.GIT_INDEX_FILE);
    expect(ws.baseRef).toBe(EMPTY_TREE_SHA);
    ws.dispose();
  });

  it("untracked ファイルがあれば git add -N を呼ぶ", async () => {
    const { indexPath } = makeRealIndex("seed");
    const calls: { args: string[] }[] = [];
    const exec: Stub = async (_command, args) => {
      calls.push({ args });
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: "head000\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-files") {
        return {
          stdout: "new-file.txt\0untracked/dir/x.txt\0",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const ws = await createWorkspaceIndex({ exec });
    dirsToClean.push(ws.env.GIT_INDEX_FILE);
    expect(ws.untracked).toEqual(["new-file.txt", "untracked/dir/x.txt"]);
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual([
      "add",
      "-N",
      "--",
      "new-file.txt",
      "untracked/dir/x.txt",
    ]);
    ws.dispose();
  });

  it("untracked が無ければ git add -N を呼ばない", async () => {
    const { indexPath } = makeRealIndex("seed");
    const calls: { args: string[] }[] = [];
    const exec: Stub = async (_command, args) => {
      calls.push({ args });
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: "head000\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-files") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const ws = await createWorkspaceIndex({ exec });
    dirsToClean.push(ws.env.GIT_INDEX_FILE);
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
    ws.dispose();
  });

  it("シード後に git が失敗したら一時 index を掃除してから reject する（修正1回帰）", async () => {
    const { dir, indexPath } = makeRealIndex("fake-index-content");
    const exec: Stub = async (_command, args) => {
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        throw new Error("aborted");
      }
      if (args[0] === "ls-files") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(createWorkspaceIndex({ exec })).rejects.toThrow("aborted");

    // シードした一時 index（<indexPath>.review-*）がディレクトリ配下に残っていないこと。
    const leftover = readdirSync(dir).filter((f) => f.includes(".review-"));
    expect(leftover).toEqual([]);
  });

  // git add -N の失敗は「throw される」場合と「非0 code で resolve される」場合の
  // 両方があり得る（execFileAsync は abort 由来のみ reject し、通常の非0終了は resolve
  // する設計のため）。どちらの失敗形でも一時 index が掃除されてから reject することを
  // 共通の表として検証する（修正1回帰）。
  it.each([
    {
      name: "git add -N が失敗したら",
      addStub: (): never => {
        throw new Error("aborted during add -N");
      },
      expectedMessage: "aborted during add -N",
    },
    {
      name: "git add -N が非0 code で resolve したら（throw ではなく）",
      addStub: (): ExecResult => ({
        stdout: "",
        stderr: "fatal: pathspec did not match",
        code: 1,
      }),
      expectedMessage: /git add -N, exit 1/,
    },
  ])("$name 一時 index を掃除してから reject する", async ({
    addStub,
    expectedMessage,
  }) => {
    const { dir, indexPath } = makeRealIndex("fake-index-content");
    const exec: Stub = async (_command, args) => {
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: "head000\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-files") {
        return { stdout: "new-file.txt\0", stderr: "", code: 0 };
      }
      if (args[0] === "add") {
        return addStub();
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(createWorkspaceIndex({ exec })).rejects.toThrow(
      expectedMessage,
    );

    const leftover = readdirSync(dir).filter((f) => f.includes(".review-"));
    expect(leftover).toEqual([]);
  });

  it("untracked ファイル名の前後空白・改行を trim せず原文のまま返す（修正2回帰）", async () => {
    const { indexPath } = makeRealIndex("seed");
    const calls: { args: string[] }[] = [];
    const exec: Stub = async (_command, args) => {
      calls.push({ args });
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return { stdout: `${indexPath}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: "head000\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-files") {
        // -z（NUL 区切り）出力: 空白・改行を含む実在ファイル名を想定。末尾に空要素が付く。
        return {
          stdout: " leading-space.txt\0trailing-nl\n\0normal.txt\0",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const ws = await createWorkspaceIndex({ exec });
    dirsToClean.push(ws.env.GIT_INDEX_FILE);

    expect(ws.untracked).toEqual([
      " leading-space.txt",
      "trailing-nl\n",
      "normal.txt",
    ]);
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual([
      "add",
      "-N",
      "--",
      " leading-space.txt",
      "trailing-nl\n",
      "normal.txt",
    ]);
    ws.dispose();
  });
});
