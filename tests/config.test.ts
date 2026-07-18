import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_MAX_CHARS } from "../src/lib/background.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigWithSource,
  resolveConfig,
  resolvePromptFragment,
} from "../src/lib/config.ts";

const ENV_KEYS = [
  "CODE_REVIEW_MODEL_LIGHT",
  "CODE_REVIEW_MODEL_HEAVY",
  "CODE_REVIEW_SMALL_MAX_FILES",
  "CODE_REVIEW_SMALL_MAX_LINES",
  "CODE_REVIEW_OVERSIZED_MAX_LINES",
  "CODE_REVIEW_DISABLE_CONTEXT7",
  "CODE_REVIEW_ENABLE_WEB",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("YAML が欠落（readFile→null）のとき既定値になる", () => {
    const config = loadConfig({ env: {}, readFile: () => null });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("トップレベルが配列のとき警告して既定値にフォールバックする（未知キー誤警告は出ない）", () => {
    const warnSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const config = loadConfig({
      env: {},
      readFile: (p) => (p === ".claude/review.yaml" ? "- a\n- b\n" : null),
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages).toContainEqual(
      expect.stringContaining(
        "トップレベルは object を期待しましたが不正な形式でした",
      ),
    );
    expect(messages.some((m) => m.includes("未知のキー"))).toBe(false);
  });

  it("YAML パースエラーのとき警告して既定値にフォールバックする", () => {
    const warnSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const config = loadConfig({
      env: {},
      readFile: (p) =>
        p === ".claude/review.yaml" ? "models: [invalid" : null,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("YAML のみ反映される（env なし）", () => {
    const config = loadConfig({
      env: {},
      readFile: (p) =>
        p === ".claude/review.yaml"
          ? "models:\n  light: haiku\n  heavy: opus\n"
          : null,
    });
    expect(config.models).toEqual({ light: "haiku", heavy: "opus" });
  });

  it(".claude/review.yaml が無く .yml のみ存在する場合、.yml が読み込まれる", () => {
    const config = loadConfig({
      env: {},
      readFile: (p) =>
        p === ".claude/review.yml"
          ? "models:\n  light: haiku\n  heavy: opus\n"
          : null,
    });
    expect(config.models).toEqual({ light: "haiku", heavy: "opus" });
  });

  it(".yaml と .yml が両方存在する場合、.yaml が優先して読み込まれる", () => {
    const files: Record<string, string> = {
      ".claude/review.yaml": "models:\n  light: haiku\n",
      ".claude/review.yml": "models:\n  light: opus\n",
    };
    const config = loadConfig({
      env: {},
      readFile: (p) => files[p] ?? null,
    });
    expect(config.models.light).toBe("haiku");
  });

  describe("loadConfigWithSource", () => {
    it(".yaml を優先し sourcePath に .yaml を返す", () => {
      const files: Record<string, string> = {
        ".claude/review.yaml": "models:\n  light: haiku\n",
        ".claude/review.yml": "models:\n  light: opus\n",
      };
      const { config, sourcePath } = loadConfigWithSource({
        env: {},
        readFile: (p) => files[p] ?? null,
      });
      expect(config.models.light).toBe("haiku");
      expect(sourcePath).toBe(".claude/review.yaml");
    });

    it(".yaml が無ければ .yml を読み sourcePath に .yml を返す", () => {
      const { config, sourcePath } = loadConfigWithSource({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yml" ? "models:\n  light: haiku\n" : null,
      });
      expect(config.models.light).toBe("haiku");
      expect(sourcePath).toBe(".claude/review.yml");
    });

    it("どちらも無ければ sourcePath は null（既定値で解決される）", () => {
      const { config, sourcePath } = loadConfigWithSource({
        env: {},
        readFile: () => null,
      });
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(sourcePath).toBeNull();
    });
  });

  it("env が YAML より優先される", () => {
    const config = loadConfig({
      env: { CODE_REVIEW_MODEL_LIGHT: "opus" },
      readFile: (p) =>
        p === ".claude/review.yaml" ? "models:\n  light: haiku\n" : null,
    });
    expect(config.models.light).toBe("opus");
  });

  it("thresholds も env > YAML > 既定の優先順位で解決される", () => {
    const config = loadConfig({
      env: { CODE_REVIEW_SMALL_MAX_FILES: "10" },
      readFile: (p) =>
        p === ".claude/review.yaml"
          ? "thresholds:\n  smallMaxFiles: 3\n  smallMaxLines: 200\n"
          : null,
    });
    expect(config.thresholds.smallMaxFiles).toBe(10); // env 優先
    expect(config.thresholds.smallMaxLines).toBe(200); // YAML
    expect(config.thresholds.oversizedMaxLines).toBe(
      DEFAULT_CONFIG.thresholds.oversizedMaxLines,
    ); // 既定
  });

  describe("context7 の反転判定", () => {
    it("既定は有効", () => {
      const config = loadConfig({ env: {}, readFile: () => null });
      expect(config.tools.context7).toBe(true);
    });

    it("YAML で tools.context7: false を指定すると無効になる", () => {
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml" ? "tools:\n  context7: false\n" : null,
      });
      expect(config.tools.context7).toBe(false);
    });

    it("CODE_REVIEW_DISABLE_CONTEXT7=1 のとき YAML の指定に関わらず無効になる", () => {
      const config = loadConfig({
        env: { CODE_REVIEW_DISABLE_CONTEXT7: "1" },
        readFile: (p) =>
          p === ".claude/review.yaml" ? "tools:\n  context7: true\n" : null,
      });
      expect(config.tools.context7).toBe(false);
    });

    it("CODE_REVIEW_DISABLE_CONTEXT7=0 のとき有効のままになる", () => {
      const config = loadConfig({
        env: { CODE_REVIEW_DISABLE_CONTEXT7: "0" },
        readFile: () => null,
      });
      expect(config.tools.context7).toBe(true);
    });
  });

  describe("falsePositiveExclusions", () => {
    it("未指定なら既定文言のまま", () => {
      const config = loadConfig({ env: {}, readFile: () => null });
      expect(config.prompts.falsePositiveExclusions).toBe(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
    });

    it("string 指定は既定文言へ append される", () => {
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? "prompts:\n  falsePositiveExclusions: |\n    - 追加ルール\n"
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toContain(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(config.prompts.falsePositiveExclusions).toContain("追加ルール");
    });

    it("mode: replace のとき既定文言を含まず置換後の文字列のみになる", () => {
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? 'prompts:\n  falsePositiveExclusions:\n    text: "完全に差し替えた文言"\n    mode: replace\n'
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toBe(
        "完全に差し替えた文言",
      );
      expect(config.prompts.falsePositiveExclusions).not.toContain(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
    });

    it("file 指定は読み込んだ内容を append する", () => {
      const files: Record<string, string> = {
        ".claude/review.yaml":
          "prompts:\n  falsePositiveExclusions:\n    file: extra-rules.md\n",
        "extra-rules.md": "- ファイル由来の追加ルール",
      };
      const config = loadConfig({
        env: {},
        readFile: (p) => files[p] ?? null,
      });
      expect(config.prompts.falsePositiveExclusions).toContain(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(config.prompts.falsePositiveExclusions).toContain(
        "ファイル由来の追加ルール",
      );
    });

    it("file が欠落しているとき警告して既定文言のままになる", () => {
      const warnSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? "prompts:\n  falsePositiveExclusions:\n    file: missing.md\n"
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toBe(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(warnSpy).toHaveBeenCalled();
    });

    it("text 単独指定は採用される", () => {
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? 'prompts:\n  falsePositiveExclusions:\n    text: "追加ルール単独"\n'
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toContain(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(config.prompts.falsePositiveExclusions).toContain(
        "追加ルール単独",
      );
    });

    it("file と mode: append の組み合わせは採用される", () => {
      const files: Record<string, string> = {
        ".claude/review.yaml":
          "prompts:\n  falsePositiveExclusions:\n    file: extra-rules.md\n    mode: append\n",
        "extra-rules.md": "- ファイル由来の追加ルール(append)",
      };
      const config = loadConfig({
        env: {},
        readFile: (p) => files[p] ?? null,
      });
      expect(config.prompts.falsePositiveExclusions).toContain(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(config.prompts.falsePositiveExclusions).toContain(
        "ファイル由来の追加ルール(append)",
      );
    });

    it("text と file を同時指定すると警告して既定文言のままになる", () => {
      const warnSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? 'prompts:\n  falsePositiveExclusions:\n    text: "text指定"\n    file: extra-rules.md\n'
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toBe(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(warnSpy).toHaveBeenCalled();
    });

    it("余分なキーを指定すると警告して既定文言のままになる", () => {
      const warnSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const config = loadConfig({
        env: {},
        readFile: (p) =>
          p === ".claude/review.yaml"
            ? 'prompts:\n  falsePositiveExclusions:\n    text: "text指定"\n    bogus: "余分なキー"\n'
            : null,
      });
      expect(config.prompts.falsePositiveExclusions).toBe(
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
      );
      expect(warnSpy).toHaveBeenCalled();
    });

    it("file 由来の内容は制御文字が除去され上限で切り詰められる（sanitizeBackground 適用）", () => {
      // 制御文字（NUL）を含み、上限を大きく超える内容。--background-file と同じ
      // サニタイズ／上限を通ってプロンプトへ流れ込むことを確認する。
      const huge = `head\u0000tail${"x".repeat(BACKGROUND_MAX_CHARS)}`;
      const files: Record<string, string> = {
        ".claude/review.yaml":
          "prompts:\n  falsePositiveExclusions:\n    file: rules.md\n    mode: replace\n",
        "rules.md": huge,
      };
      const config = loadConfig({
        env: {},
        readFile: (p) => files[p] ?? null,
      });
      const result = config.prompts.falsePositiveExclusions;
      // 制御文字は除去される。
      expect(result).not.toContain("\u0000");
      expect(result.startsWith("headtail")).toBe(true);
      // 上限（BACKGROUND_MAX_CHARS）で切り詰められる。
      expect(result.length).toBe(BACKGROUND_MAX_CHARS);
    });
  });

  it("未知キーは警告するが既定値へフォールバックして処理を継続する", () => {
    const warnSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const config = loadConfig({
      env: {},
      readFile: (p) =>
        p === ".claude/review.yaml"
          ? "unknownTopLevel: 1\nmodels:\n  light: haiku\n"
          : null,
    });
    expect(config.models.light).toBe("haiku");
    expect(warnSpy).toHaveBeenCalled();
    // トップレベルの未知キーは先頭ドットなしで警告される（`.unknownTopLevel` ではない）。
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages).toContainEqual(
      expect.stringContaining("未知のキー unknownTopLevel は無視されます"),
    );
    expect(messages.some((m) => m.includes("未知のキー ."))).toBe(false);
  });

  it("ネストされた未知キーはセクション名付きで警告される", () => {
    const warnSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loadConfig({
      env: {},
      readFile: (p) =>
        p === ".claude/review.yaml"
          ? "models:\n  light: haiku\n  bogus: 1\n"
          : null,
    });
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages).toContainEqual(
      expect.stringContaining("未知のキー models.bogus は無視されます"),
    );
  });
});

describe("resolveConfig", () => {
  it("raw が null（YAML 欠落相当）でも既定値を返す", () => {
    expect(resolveConfig(null, {}, () => null)).toEqual(DEFAULT_CONFIG);
  });
});

describe("resolvePromptFragment", () => {
  it("spec が undefined のとき base をそのまま返す", () => {
    expect(resolvePromptFragment(undefined, "base", () => null)).toBe("base");
  });

  it("string spec は base に追記する", () => {
    expect(resolvePromptFragment("extra", "base", () => null)).toBe(
      "base\nextra",
    );
  });

  it("{text, mode: replace} は text のみを返す", () => {
    expect(
      resolvePromptFragment(
        { text: "extra", mode: "replace" },
        "base",
        () => null,
      ),
    ).toBe("extra");
  });

  it("{file} でファイルが読めないときは base のままになる", () => {
    expect(
      resolvePromptFragment({ file: "missing.md" }, "base", () => null),
    ).toBe("base");
  });
});
