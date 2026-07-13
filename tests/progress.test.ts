import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProgressReporter, noopReporter } from "../src/lib/progress.ts";

// process.stderr.isTTY は通常環境に依存して定義の有無・値が変わる（CI では undefined）。
// vi.spyOn の getter モックはプロパティが既に定義されていないと使えないため、
// Object.defineProperty で直接差し替え、afterEach で元の記述子に戻す。
function stubStderrIsTTY(value: boolean | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(process.stderr, "isTTY", original);
    } else {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  };
}

describe("makeProgressReporter", () => {
  it("quiet:true のとき noopReporter を返す", () => {
    const reporter = makeProgressReporter({ quiet: true, debug: false });
    expect(reporter).toBe(noopReporter);
  });

  it("debug:true のとき noopReporter を返す（quiet より優先度は問わず二重化させない）", () => {
    const reporter = makeProgressReporter({ quiet: false, debug: true });
    expect(reporter).toBe(noopReporter);
  });

  describe("非 TTY（plain reporter）", () => {
    let restoreTTY: () => void;
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      restoreTTY = stubStderrIsTTY(false);
      writeSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      restoreTTY();
      writeSpy.mockRestore();
    });

    it("startStep で `→ label…` を1行書き込む", () => {
      const reporter = makeProgressReporter({ quiet: false, debug: false });
      reporter.startStep("要約", 1);
      expect(writeSpy).toHaveBeenCalledWith("→ 要約…\n");
    });

    it("succeedStep で完了数と note を含む行を書き込む", () => {
      const reporter = makeProgressReporter({ quiet: false, debug: false });
      reporter.startStep("レビュー", 3);
      reporter.tickAgent();
      reporter.tickAgent();
      reporter.tickAgent();
      reporter.succeedStep("5 findings");
      expect(writeSpy).toHaveBeenCalledWith(
        "✓ レビュー (3/3 agents, 5 findings)\n",
      );
    });

    it("total 未指定の succeedStep は agents カウントを含めない", () => {
      const reporter = makeProgressReporter({ quiet: false, debug: false });
      reporter.startStep("diff 取得");
      reporter.succeedStep();
      expect(writeSpy).toHaveBeenCalledWith("✓ diff 取得\n");
    });

    it("done は何も書き込まない（プレーン表示に停止処理は不要）", () => {
      const reporter = makeProgressReporter({ quiet: false, debug: false });
      reporter.startStep("要約", 1);
      writeSpy.mockClear();
      reporter.done();
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe("TTY（spinner reporter）", () => {
    let restoreTTY: () => void;

    beforeEach(() => {
      restoreTTY = stubStderrIsTTY(true);
    });

    afterEach(() => {
      restoreTTY();
    });

    it("TTY 判定は isTTY フラグ分岐の選択のみ検証する（ora 内部・アニメーションはテストしない）", () => {
      // isTTY===true 環境でも ora はターミナル制御シーケンス（cursorTo 等）を
      // 実際のストリームに要求するため、start() 等は呼ばずインスタンスの型のみ確認する。
      const reporter = makeProgressReporter({ quiet: false, debug: false });
      expect(reporter).not.toBe(noopReporter);
      expect(typeof reporter.startStep).toBe("function");
      expect(typeof reporter.tickAgent).toBe("function");
      expect(typeof reporter.succeedStep).toBe("function");
      expect(typeof reporter.done).toBe("function");
    });
  });
});
