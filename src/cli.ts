#!/usr/bin/env node

/**
 * CLI エントリポイント。
 *
 * このファイルの責務は3つだけ:
 *   1. 引数仕様の定義とパース（自前実装、外部依存なし）
 *   2. パース結果の検証
 *   3. サブコマンドへのディスパッチ
 *
 * 実装ロジック（git/gh 呼び出し・LLM・レビュー処理）はここには書かない
 * （src/pipeline.ts / src/report.ts に委譲する）。
 */
import { isAbortError } from "./lib/abort.ts";
import { runLocalReview, runPrReview } from "./pipeline.ts";
import { printSummary } from "./report.ts";

type Command = "local" | "pr";

export type ParsedArgs = {
  command: Command;
  prNumber?: number;
  range?: string | true;
  comment: boolean;
  debug: boolean;
  quiet: boolean;
  help: boolean;
  background?: string;
  backgroundFile?: string;
};

const USAGE = `Usage:
  code-review local [--range [<range>]] [--background <text>] [--background-file <path>] [--debug] [--quiet]
  code-review pr <number> [--comment] [--background <text>] [--background-file <path>] [--debug] [--quiet]
  code-review --help

Commands:
  local              ローカルの差分をレビューする
  pr <number>        指定した PR をレビューする

Options:
  --range [<range>]             local 専用。差分範囲を指定（省略時は staged を自動判別）
  --comment                     pr 専用。レビュー結果を PR にインラインコメントとして投稿する
  --background, -b <text>       自動取得できない背景情報（要件・意図）をインラインで指定する
  --background-file, -B <path>  背景情報をファイルから読み込む（8000字上限・サニタイズ適用）
  --debug                       デバッグログを出力する
  --quiet, -q                   進捗表示を抑制する
  -h, --help                    このヘルプを表示する
`;

export class UsageError extends Error {}

function isFlag(token: string | undefined): boolean {
  return token?.startsWith("-") ?? false;
}

/**
 * argv (先頭の node/script パスを除いたもの) をパースする。
 * `parseFlags` (claude-plugins/.../scripts/lib/artifact.mjs:88) を踏襲しつつ、
 * サブコマンド（位置引数）と、値省略可能なフラグ（--range）を扱えるように拡張したもの。
 */
// 値必須フラグ（--background/-b, --background-file/-B）の次トークンを取り出し、
// 消費後のインデックス（呼び出し元の while ループが次に読む位置）を返す。
// --range と異なり値省略は不可なので、次トークンが無い/フラグなら UsageError にする。
function consumeRequiredValue(
  argv: string[],
  i: number,
  flagName: string,
): { value: string; nextIndex: number } {
  const next = argv[i + 1];
  if (isFlag(next) || next === undefined) {
    throw new UsageError(`${flagName} には値が必要です`);
  }
  return { value: next, nextIndex: i + 2 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let help = false;
  let comment = false;
  let debug = false;
  let quiet = false;
  let range: string | true | undefined;
  let command: Command | undefined;
  let prNumber: number | undefined;
  let background: string | undefined;
  let backgroundFile: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    // `npm run dev -- --help` / `pnpm dev -- --help` のように渡される
    // 引数区切りの `--` は無視する。
    if (token === "--") {
      i += 1;
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      i += 1;
      continue;
    }

    if (token === "--comment") {
      comment = true;
      i += 1;
      continue;
    }

    if (token === "--debug") {
      debug = true;
      i += 1;
      continue;
    }

    if (token === "--quiet" || token === "-q") {
      quiet = true;
      i += 1;
      continue;
    }

    if (token === "--range") {
      const next = argv[i + 1];
      if (isFlag(next) || next === undefined) {
        range = true;
        i += 1;
      } else {
        range = next;
        i += 2;
      }
      continue;
    }

    if (token === "--background" || token === "-b") {
      ({ value: background, nextIndex: i } = consumeRequiredValue(
        argv,
        i,
        token,
      ));
      continue;
    }

    if (token === "--background-file" || token === "-B") {
      ({ value: backgroundFile, nextIndex: i } = consumeRequiredValue(
        argv,
        i,
        token,
      ));
      continue;
    }

    if (isFlag(token)) {
      throw new UsageError(`unknown option: ${token}`);
    }

    // 非フラグトークン: サブコマンド、または pr のPR番号
    if (command === undefined) {
      if (token !== "local" && token !== "pr") {
        throw new UsageError(`unknown command: ${token}`);
      }
      command = token;
      i += 1;
      continue;
    }

    if (command === "pr" && prNumber === undefined) {
      const parsed = Number(token);
      if (!Number.isInteger(parsed)) {
        throw new UsageError(`invalid PR number: ${token}`);
      }
      prNumber = parsed;
      i += 1;
      continue;
    }

    throw new UsageError(`unexpected argument: ${token}`);
  }

  if (help) {
    return {
      command: command ?? "local",
      help,
      comment,
      debug,
      quiet,
      range,
      background,
      backgroundFile,
    };
  }

  if (command === undefined) {
    throw new UsageError("missing command");
  }

  if (command === "pr" && prNumber === undefined) {
    throw new UsageError("missing PR number");
  }

  return {
    command,
    prNumber,
    range,
    comment,
    debug,
    quiet,
    help,
    background,
    backgroundFile,
  };
}

// runLocalReview/runPrReview 共通のエラー→終了コード変換。abort 由来（Ctrl+C 中断）は
// 130、それ以外は従来どおり 1 にし、local/pr 双方で同じ分岐をコピーしないようにする。
function reportError(error: unknown): number {
  if (isAbortError(error)) {
    process.stderr.write("中断されました\n");
    return 130;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

async function dispatch(
  args: ParsedArgs,
  abortController: AbortController,
): Promise<number> {
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.command === "local") {
    // --range 値省略（`--range` のみ）→ range: undefined で staged 自動判別
    // （collect-context.ts の collectContext が range 引数なしなら staged を優先する）。
    const rangeOpt = args.range === true ? undefined : args.range;
    try {
      const { final, ctx } = await runLocalReview(
        { mode: "range", range: rangeOpt },
        {
          debug: args.debug,
          quiet: args.quiet,
          background: args.background,
          backgroundFile: args.backgroundFile,
          abortController,
        },
      );
      printSummary(final, ctx);
      return final.stats.confirmed > 0 ? 1 : 0;
    } catch (error) {
      return reportError(error);
    }
  }

  if (args.command === "pr") {
    try {
      const { final, ctx, postedUrl } = await runPrReview(
        String(args.prNumber),
        {
          debug: args.debug,
          comment: args.comment,
          quiet: args.quiet,
          background: args.background,
          backgroundFile: args.backgroundFile,
          abortController,
        },
      );
      printSummary(final, ctx);
      if (postedUrl) process.stdout.write(`posted: ${postedUrl}\n`);
      return final.stats.confirmed > 0 ? 1 : 0;
    } catch (error) {
      return reportError(error);
    }
  }

  return 1;
}

// SIGINT を受けて協調的キャンセルを行う。1回目は abortController.abort() で実行中の
// query()/execFile を止め、各ステップの後始末（progress.done() 等）を通常の finally 経路に
// 任せる。2回目（1回目の abort がまだ効いていない間に再度押された場合）は強制 exit(130)。
function installSigintHandler(abortController: AbortController): void {
  let aborted = false;
  process.on("SIGINT", () => {
    if (!aborted) {
      aborted = true;
      process.stderr.write("\n中断しています…（もう一度 Ctrl+C で強制終了）\n");
      abortController.abort();
      return;
    }
    process.exit(130);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n`);
      process.stderr.write(USAGE);
      process.exit(1);
    }
    throw error;
  }

  const abortController = new AbortController();
  installSigintHandler(abortController);

  process.exit(await dispatch(args, abortController));
}

// CLI として直接実行されたときのみエントリポイントを起動する。
// （`tests/cli.test.ts` から parseArgs を import する際に main() が
// 副作用として走り process.exit してしまうのを防ぐためのガード）
if (import.meta.main) {
  main();
}
