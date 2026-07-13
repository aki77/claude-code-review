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
}

export const noopReporter: ProgressReporter = {
  startStep: () => {},
  tickAgent: () => {},
  succeedStep: () => {},
  done: () => {},
};

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
        spinner = ora({ stream: process.stderr, text: render() }).start();
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
