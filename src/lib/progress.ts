// `--debug` 無しの通常実行でも進捗が分かるようにするための進捗表示ロジック。
//
// makeDebugSink（pipeline.ts）と同じ「注入される sink」パターンに揃える。
// 実装は3種:
//   - spinner: TTY のとき。ora で1行アニメーション。
//   - plain  : 非 TTY（パイプ/リダイレクト/CI）のとき。プレーンな1行追記。
//   - noop   : --quiet または --debug のとき（--debug は既存の [debug] JSON ログに一本化する）。
// 出力先は必ず stderr（stdout は printSummary 等の最終結果専用に保つ）。
import ora, { type Ora } from "ora";

export interface ProgressReporter {
  // ステップ開始。total 指定時は並列エージェントの完了数 n/total を表示する。
  startStep(label: string, total?: number): void;
  // 並列エージェント1つ完了ごとに呼ぶ（成功・失敗どちらのパスでも）。
  tickAgent(): void;
  // 現ステップ完了。note には件数などの補足情報を渡せる（例: "5 findings"）。
  succeedStep(note?: string): void;
  // パイプライン終了時の後始末（スピナー停止など）。呼び出し側の finally で必ず1回呼ぶ。
  done(): void;
  // 実行全体の合計コスト（USD）を控えめに1行表示する。0 のときは何も出さない。
  reportCost(totalCostUsd: number): void;
}

export const noopReporter: ProgressReporter = {
  startStep: () => {},
  tickAgent: () => {},
  succeedStep: () => {},
  done: () => {},
  reportCost: () => {},
};

// 薄色（dim）ラベル付きのコスト行を stderr へ1行出す。TTY のときだけ ANSI エスケープで
// 色を付け、非 TTY（パイプ/CI）ではプレーン文字列にする（色コード混入を避ける）。
function writeCostLine(totalCostUsd: number): void {
  if (totalCostUsd === 0) return;
  const text = `cost: $${totalCostUsd.toFixed(4)}`;
  const line = process.stderr.isTTY === true ? `\x1b[2m${text}\x1b[0m` : text;
  process.stderr.write(`${line}\n`);
}

function makeSpinnerReporter(): ProgressReporter {
  let spinner: Ora | undefined;
  let label = "";
  let done = 0;
  let total: number | undefined;

  function render(): string {
    return total === undefined ? `${label}…` : `${label}… (${done}/${total})`;
  }

  return {
    startStep(newLabel, newTotal) {
      label = newLabel;
      done = 0;
      total = newTotal;
      if (spinner) {
        spinner.start(render());
      } else {
        // discardStdin: false — ora 既定(true)だと stdin を raw mode にし、Ctrl+C が端末 SIGINT を
        // 生成せず 0x03 バイト化されてしまう（SIGINT ハンドラが発火せず中断が効かない）。false にして
        // Ctrl+C を通常の端末 SIGINT として届かせ、cli.ts の SIGINT ハンドラ（abortController.abort()）
        // を確実に発火させる。
        spinner = ora({
          stream: process.stderr,
          text: render(),
          discardStdin: false,
        }).start();
      }
    },
    tickAgent() {
      done += 1;
      if (spinner) spinner.text = render();
    },
    succeedStep(note) {
      const text = note ? `${label} (${note})` : label;
      spinner?.succeed(text);
    },
    done() {
      spinner?.stop();
    },
    reportCost: writeCostLine,
  };
}

function makePlainReporter(): ProgressReporter {
  let label = "";
  let done = 0;
  let total: number | undefined;

  return {
    startStep(newLabel, newTotal) {
      label = newLabel;
      done = 0;
      total = newTotal;
      process.stderr.write(`→ ${label}…\n`);
    },
    tickAgent() {
      done += 1;
    },
    succeedStep(note) {
      // アニメーションしないため tickAgent の途中経過は出さず、完了時にまとめて表示する。
      const countNote =
        total !== undefined ? `${done}/${total} agents` : undefined;
      const notes = [countNote, note].filter(
        (v): v is string => v !== undefined && v !== "",
      );
      const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
      process.stderr.write(`✓ ${label}${suffix}\n`);
    },
    done() {},
    reportCost: writeCostLine,
  };
}

export function makeProgressReporter(opts: {
  quiet: boolean;
  debug: boolean;
}): ProgressReporter {
  if (opts.quiet || opts.debug) return noopReporter;
  return process.stderr.isTTY === true
    ? makeSpinnerReporter()
    : makePlainReporter();
}
