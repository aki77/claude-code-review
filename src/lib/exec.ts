// execFile の Promise ラッパ。非0終了で throw せず結果で返す。
// collect-context（Phase 2c）が失敗時に tier を落とさず全0を返す設計上、
// 呼び出し側が code を見て分岐できる形にする。
//
// 02a では未使用（02c/02d が依存するため先に用意）。
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function execFileAsync(
  command: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number; input?: string } = {},
): Promise<ExecResult> {
  const { input, ...execOptions } = options;
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: "utf8", ...execOptions },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof error.code === "number"
              ? error.code
              : typeof error.code === "string"
                ? 1
                : 1;
          resolve({ stdout, stderr, code });
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
    // 子プロセスが stdin を読まずに早期終了すると write 側で EPIPE が発生しうる。
    // 同期版 execFileSync({ input }) が内部で握っていた挙動を再現し、
    // プロセス全体が落ちないようにする。
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}
