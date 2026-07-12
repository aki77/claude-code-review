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
import { runLocalReview } from "./pipeline.ts";
import { printSummary } from "./report.ts";

type Command = "local" | "pr";

type ParsedArgs = {
  command: Command;
  prNumber?: number;
  range?: string | true;
  comment: boolean;
  debug: boolean;
  help: boolean;
};

const USAGE = `Usage:
  code-review local [--range [<range>]] [--debug]
  code-review pr <number> [--comment] [--debug]
  code-review --help

Commands:
  local              ローカルの差分をレビューする
  pr <number>        指定した PR をレビューする

Options:
  --range [<range>]  local 専用。差分範囲を指定（省略時は staged を自動判別）
  --comment          pr 専用。レビュー結果を PR にインラインコメントとして投稿する
  --debug            デバッグログを出力する
  -h, --help         このヘルプを表示する
`;

class UsageError extends Error {}

function isFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("--");
}

/**
 * argv (先頭の node/script パスを除いたもの) をパースする。
 * `parseFlags` (claude-plugins/.../scripts/lib/artifact.mjs:88) を踏襲しつつ、
 * サブコマンド（位置引数）と、値省略可能なフラグ（--range）を扱えるように拡張したもの。
 */
function parseArgs(argv: string[]): ParsedArgs {
  let help = false;
  let comment = false;
  let debug = false;
  let range: string | true | undefined;
  let command: Command | undefined;
  let prNumber: number | undefined;

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
    return { command: command ?? "local", help, comment, debug, range };
  }

  if (command === undefined) {
    throw new UsageError("missing command");
  }

  if (command === "pr" && prNumber === undefined) {
    throw new UsageError("missing PR number");
  }

  return { command, prNumber, range, comment, debug, help };
}

async function dispatch(args: ParsedArgs): Promise<number> {
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
        { debug: args.debug },
      );
      printSummary(final, ctx);
      return final.stats.confirmed > 0 ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: ${message}\n`);
      return 1;
    }
  }

  if (args.command === "pr") {
    process.stderr.write("pr: 未実装です（Phase 5 で実装予定）\n");
    return 1;
  }

  return 1;
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

  process.exit(await dispatch(args));
}

main();
