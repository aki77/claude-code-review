// プロジェクト設定基盤（`.claude/review.yaml`）の読み込み・解決。
//
// 優先順位は env > YAML > 既定（CLI 設定フラグは今回追加しないため実効これ）。
// env は「実行環境ごとの一時上書き」層と位置づけ、既存の CODE_REVIEW_* 系はすべて残す。
// YAML はプロジェクト単位の恒久設定を担う。
//
// 今回スキーマに入れるのは「実際に使うキーのみ」（YAGNI）: models（light/heavy）・
// thresholds・tools（context7/web）・prompts.falsePositiveExclusions。
// 将来キーを増やすときは RawConfig/ResolvedConfig にフィールドを足すだけで拡張できる。
//
// 欠落（readFile→null）は全て既定/env で動く。YAML パースエラーは throw せず警告して
// 既定へフォールバックする（設定ミスでレビューを止めない＝既存の tier 縮退思想と一致）。
import { parse as parseYaml } from "yaml";
import { isEnvTruthy } from "./env.ts";
import type { ReadFileFn } from "./types.ts";

export const CONFIG_PATH = ".claude/review.yaml";

// ---- 誤検知除外リスト（元プラグイン shared/review-core.md 由来） -------------
// 元プラグインはステップ3・6の両方に適用していたが、本再実装では検証(step6)にのみ
// 集約する: 発見段階（agent1-5）は幅広く拾い、確度の担保は検証エージェントが
// read-only ツールで実コードに当たって行う（「既存問題か」「lint 類か」を実際に確認できる）。
// この定数は DEFAULT_CONFIG（下記）の唯一の情報源。prompts.ts はここから re-export する
// （config.ts が prompts.ts の値を import すると初期化順序の循環エラーになるため、
// config.ts を単一の情報源にして依存の向きを一方向にする）。
export const FALSE_POSITIVE_EXCLUSIONS =
  "次に該当するものは誤検知として rejected にしてください:\n" +
  "- レビュー対象の変更より前から存在する問題（今回の変更が持ち込んだものではない）\n" +
  "- バグに見えるが実際は正しい挙動\n" +
  "- シニアエンジニアであれば指摘しないような細かすぎる指摘\n" +
  "- リンタが検出する類の問題（リンタを実際に走らせて検証する必要はない）\n" +
  "- プロジェクトルールで明示的に求められていない、一般的なコード品質の懸念" +
  "（テストカバレッジ不足、一般的なセキュリティ懸念など）\n" +
  "- プロジェクトルールに記載があっても、コード側で明示的に抑制されている事項" +
  "（lint の ignore コメントなど）";

// ---- プロンプト断片の型（Node24 は enum 不可 → union） -----------------------

export type PromptFragmentMode = "append" | "replace";

export type PromptFragmentSpec =
  | string // インライン・append 既定（最短記法）
  | { text: string; mode?: PromptFragmentMode }
  | { file: string; mode?: PromptFragmentMode }; // file はプロジェクト相対パス

// ---- RawConfig（YAML パース直後・全キー optional） --------------------------

export interface RawConfig {
  models?: { light?: unknown; heavy?: unknown };
  thresholds?: {
    smallMaxFiles?: unknown;
    smallMaxLines?: unknown;
    oversizedMaxLines?: unknown;
  };
  tools?: { context7?: unknown; web?: unknown };
  prompts?: { falsePositiveExclusions?: unknown };
}

// ---- ResolvedConfig（消費側が使う最終形。falsePositiveExclusions は埋め込み可能な文字列まで確定） ----

export interface ResolvedConfig {
  models: { light: string; heavy: string };
  thresholds: {
    smallMaxFiles: number;
    smallMaxLines: number;
    oversizedMaxLines: number;
  };
  tools: { context7: boolean; web: boolean };
  prompts: { falsePositiveExclusions: string };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  models: { light: "sonnet", heavy: "sonnet" },
  thresholds: {
    smallMaxFiles: 5,
    smallMaxLines: 150,
    oversizedMaxLines: 1000,
  },
  tools: { context7: true, web: false },
  prompts: { falsePositiveExclusions: FALSE_POSITIVE_EXCLUSIONS },
};

// ---- env 由来の値を解決する共通ヘルパー（prompts.ts/collect-context.ts から移設） ----

// 文字列 env 値（未設定・空白のみは fallback）。モデルエイリアス（sonnet/opus 等）に使う。
export function envModel(v: string | undefined, fallback: string): string {
  return v?.trim() || fallback;
}

// 数値 env 値（未設定・非数値は fallback）。tier しきい値に使う。
export function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- 軽量検証（zod/ajv を使わず手書き。未知キーは警告、型不一致は警告して既定へ） --------

function warn(message: string): void {
  process.stderr.write(`[config] warning: ${message}\n`);
}

// トップレベル + 4セクションの known キー一覧。DEFAULT_CONFIG から導出することで
// キー集合を手書きで二重管理しない（DEFAULT_CONFIG は RawConfig と同じネスト構造を持つ
// ため、Object.keys がそのまま「そのセクションで許可されたキー」になる）。
// resolveConfig の未知キー警告ループが1つずつ辿れるよう、キー名をラベルにしたレコードにまとめる
// （個別関数4連続呼び出しにしない）。
const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": Object.keys(DEFAULT_CONFIG),
  models: Object.keys(DEFAULT_CONFIG.models),
  thresholds: Object.keys(DEFAULT_CONFIG.thresholds),
  tools: Object.keys(DEFAULT_CONFIG.tools),
  prompts: Object.keys(DEFAULT_CONFIG.prompts),
};

function warnUnknownKeys(
  obj: Record<string, unknown> | undefined,
  known: readonly string[],
  path: string,
): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      // path が空文字（トップレベル）のときは先頭ドットを付けない。
      const fullKey = path ? `${path}.${key}` : key;
      warn(`未知のキー ${fullKey} は無視されます`);
    }
  }
}

// string/number/boolean 共通の「型が合えばそのまま、合わなければ警告してfallback」を
// 1つのジェネリック関数に集約する（3つの型別関数に分けない）。
function resolveTypedField<T>(
  raw: unknown,
  fallback: T,
  path: string,
  isValid: (v: unknown) => v is T,
  typeName: string,
): T {
  if (raw === undefined) return fallback;
  if (!isValid(raw)) {
    warn(
      `${path} は ${typeName} を期待しましたが実際は ${typeof raw} でした。既定値を使用します`,
    );
    return fallback;
  }
  return raw;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

function resolveStringField(raw: unknown, fallback: string, path: string) {
  return resolveTypedField(raw, fallback, path, isString, "string");
}

function resolveNumberField(raw: unknown, fallback: number, path: string) {
  return resolveTypedField(raw, fallback, path, isFiniteNumber, "number");
}

function resolveBooleanField(raw: unknown, fallback: boolean, path: string) {
  return resolveTypedField(raw, fallback, path, isBoolean, "boolean");
}

// prompts.falsePositiveExclusions の型（PromptFragmentSpec）を軽量に検証する。
// 形が合わなければ警告して undefined（呼び出し側が既定へフォールバック）。
// 注意: ここでの text/file 排他・余分キー禁止の制約は schema/review.schema.json の
// oneOf + additionalProperties: false と同じ内容を手書きで二重管理している
// （zod/ajv 不使用の方針上やむを得ない）。PromptFragmentSpec の形を変える際は
// 両方を揃えて更新すること。
function resolvePromptFragmentSpec(
  raw: unknown,
  path: string,
): PromptFragmentSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const mode = obj.mode;
    if (mode !== undefined && mode !== "append" && mode !== "replace") {
      warn(
        `${path}.mode は "append"/"replace" を期待しましたが不正な値でした。既定値を使用します`,
      );
      return undefined;
    }
    const hasText = typeof obj.text === "string";
    const hasFile = typeof obj.file === "string";
    const knownKeys = ["text", "file", "mode"];
    const hasUnknownKey = Object.keys(obj).some((k) => !knownKeys.includes(k));
    // text/file 排他・余分キーなしを満たすときだけ採用（schema の oneOf +
    // additionalProperties: false と同じ制約をランタイムでも守る）。
    if (!hasUnknownKey && hasText !== hasFile) {
      return hasText
        ? {
            text: obj.text as string,
            mode: mode as PromptFragmentMode | undefined,
          }
        : {
            file: obj.file as string,
            mode: mode as PromptFragmentMode | undefined,
          };
    }
  }
  warn(
    `${path} は string / {text,mode} / {file,mode} のいずれかを期待しましたが不正な形式でした。既定値を使用します`,
  );
  return undefined;
}

// ---- プロンプト断片の合成（inline/file/append/replace → 最終文字列） ---------
// undefined→base、string→`${base}\n${spec}`、{…, mode} で分岐、file 欠落は警告して base のまま。
// prompts.ts の「副作用なし・I/O なし純関数」原則を守るため、I/O（readFile）はここに閉じ込める。
export function resolvePromptFragment(
  spec: PromptFragmentSpec | undefined,
  base: string,
  readFile: ReadFileFn,
): string {
  if (spec === undefined) return base;

  if (typeof spec === "string") {
    return `${base}\n${spec}`;
  }

  if ("text" in spec) {
    return spec.mode === "replace" ? spec.text : `${base}\n${spec.text}`;
  }

  // file 参照。
  const content = readFile(spec.file);
  if (content === null) {
    warn(
      `prompts.falsePositiveExclusions の file "${spec.file}" を読み込めませんでした。既定値を使用します`,
    );
    return base;
  }
  return spec.mode === "replace" ? content : `${base}\n${content}`;
}

// ---- YAML → RawConfig（欠落・パースエラーは null） ---------------------------

function parseRawConfig(yamlText: string | null): RawConfig | null {
  if (yamlText === null) return null;
  try {
    const parsed = parseYaml(yamlText);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(
        `${CONFIG_PATH} のトップレベルは object を期待しましたが不正な形式でした。既定値にフォールバックします`,
      );
      return null;
    }
    return parsed as RawConfig;
  } catch (error) {
    warn(
      `${CONFIG_PATH} の YAML パースに失敗しました。既定値にフォールバックします: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

// ---- raw + env → ResolvedConfig ----------------------------------------------

export function resolveConfig(
  raw: RawConfig | null,
  env: NodeJS.ProcessEnv,
  readFile: ReadFileFn,
): ResolvedConfig {
  if (raw) {
    const sections: Record<string, Record<string, unknown> | undefined> = {
      "": raw as Record<string, unknown>,
      models: raw.models as Record<string, unknown> | undefined,
      thresholds: raw.thresholds as Record<string, unknown> | undefined,
      tools: raw.tools as Record<string, unknown> | undefined,
      prompts: raw.prompts as Record<string, unknown> | undefined,
    };
    for (const [path, known] of Object.entries(KNOWN_KEYS)) {
      warnUnknownKeys(sections[path], known, path);
    }
  }

  // YAML 解決 → env 上書きをフィールドごとにその場で1行に完結させる
  // （中間変数を経由しない。tools.context7 だけ極性が逆な env のため分岐が必要）。
  const fragmentSpec = resolvePromptFragmentSpec(
    raw?.prompts?.falsePositiveExclusions,
    "prompts.falsePositiveExclusions",
  );

  return {
    models: {
      light: envModel(
        env.CODE_REVIEW_MODEL_LIGHT,
        resolveStringField(
          raw?.models?.light,
          DEFAULT_CONFIG.models.light,
          "models.light",
        ),
      ),
      heavy: envModel(
        env.CODE_REVIEW_MODEL_HEAVY,
        resolveStringField(
          raw?.models?.heavy,
          DEFAULT_CONFIG.models.heavy,
          "models.heavy",
        ),
      ),
    },
    thresholds: {
      smallMaxFiles: num(
        env.CODE_REVIEW_SMALL_MAX_FILES,
        resolveNumberField(
          raw?.thresholds?.smallMaxFiles,
          DEFAULT_CONFIG.thresholds.smallMaxFiles,
          "thresholds.smallMaxFiles",
        ),
      ),
      smallMaxLines: num(
        env.CODE_REVIEW_SMALL_MAX_LINES,
        resolveNumberField(
          raw?.thresholds?.smallMaxLines,
          DEFAULT_CONFIG.thresholds.smallMaxLines,
          "thresholds.smallMaxLines",
        ),
      ),
      oversizedMaxLines: num(
        env.CODE_REVIEW_OVERSIZED_MAX_LINES,
        resolveNumberField(
          raw?.thresholds?.oversizedMaxLines,
          DEFAULT_CONFIG.thresholds.oversizedMaxLines,
          "thresholds.oversizedMaxLines",
        ),
      ),
    },
    tools: {
      // context7 のみ特殊: env 定義済みなら `!isEnvTruthy`、未定義なら YAML/既定。
      // CODE_REVIEW_DISABLE_CONTEXT7（無効化フラグ）と tools.context7（有効化フラグ）は
      // 極性が逆のため、他フィールドと同じ `env(...) ?? yaml` 形にできない。
      context7:
        env.CODE_REVIEW_DISABLE_CONTEXT7 !== undefined
          ? !isEnvTruthy(env.CODE_REVIEW_DISABLE_CONTEXT7)
          : resolveBooleanField(
              raw?.tools?.context7,
              DEFAULT_CONFIG.tools.context7,
              "tools.context7",
            ),
      web:
        env.CODE_REVIEW_ENABLE_WEB !== undefined
          ? isEnvTruthy(env.CODE_REVIEW_ENABLE_WEB)
          : resolveBooleanField(
              raw?.tools?.web,
              DEFAULT_CONFIG.tools.web,
              "tools.web",
            ),
    },
    prompts: {
      falsePositiveExclusions: resolvePromptFragment(
        fragmentSpec,
        DEFAULT_CONFIG.prompts.falsePositiveExclusions,
        readFile,
      ),
    },
  };
}

// pipeline が1回だけ呼ぶ入口。.claude/review.yaml を readFile 経由で読み、
// resolveConfig へ渡す。readFile が例外を投げず null を返す前提（ReadFileFn の契約）。
export function loadConfig(
  opts: { env?: NodeJS.ProcessEnv; readFile?: ReadFileFn } = {},
): ResolvedConfig {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? (() => null);
  const yamlText = readFile(CONFIG_PATH);
  const raw = parseRawConfig(yamlText);
  return resolveConfig(raw, env, readFile);
}
