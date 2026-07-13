// 手動コンテキスト提供（`--background` / `--background-file`）の決定論ロジック。
//
// authorInfo は本プロジェクト唯一の背景情報注入点（pipeline.ts の runReviewCore に渡り、
// step2 summaryClustersUser 経由で全 agent・検証 step6 に伝播する）。手動 background は
// authorInfo を捨てず、末尾に別セクションとして併記する（open-code-review の
// mergeBackground 相当）。LLM は意味判断のみ、注入・整形はコードで行う原則に合致。
import type { ReadFileFn } from "./types.ts";

// --background-file 読込時の文字数上限。open-code-review 同様、巨大な要件ファイルが
// そのまま LLM プロンプトへ流れ込むのを防ぐ。
export const BACKGROUND_MAX_CHARS = 8000;

const BACKGROUND_SECTION_HEADING = "## 補足コンテキスト（手動指定）";

// タブ(0x09)・改行(0x0A)・CR(0x0D) を除いた C0 制御文字（0x00-0x1F）・DEL(0x7F)・
// C1 制御文字（0x80-0x9F）にマッチする。範囲は固定なのでモジュールロード時に一度だけ
// コンパイルされる。正規表現リテラルに \uXXXX で制御文字を書くと Biome の
// noControlCharactersInRegex に引っかかるため、文字列コンストラクタで組み立てる。
// biome-ignore lint/complexity/useRegexLiterals: 制御文字を含むため文字列コンストラクタが必要
const CONTROL_CHARS_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u0080-\\u009f]",
  "g",
);

// タブ・改行以外の制御文字（C0/C1）を除去し、上限で切り詰める。
// --background-file はファイル起源のためサニタイズ対象（インライン --background は
// open-code-review 同様 raw のまま扱う。cli.ts 側でこの関数を通さない）。
export function sanitizeBackground(text: string): string {
  const stripped = text.replace(CONTROL_CHARS_PATTERN, "");
  if (stripped.length <= BACKGROUND_MAX_CHARS) return stripped;
  let out = stripped.slice(0, BACKGROUND_MAX_CHARS);
  // 切り詰め境界がサロゲートペアを分断した場合、末尾に残る孤立高位サロゲートを削る
  // （不正な UTF-16 が LLM プロンプト/JSON シリアライズへ流れ込むのを防ぐ）。
  const lastCode = out.charCodeAt(out.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    out = out.slice(0, -1);
  }
  return out;
}

// --background-file の読込 + サニタイズ + 上限適用。
// readFile は src/llm/steps.ts の defaultReadFile 相当（読めなければ null を返す）の
// DI 用関数。読込失敗時はここで例外にする（サイレントに空扱いにしない）。
export function loadBackgroundFile(path: string, readFile: ReadFileFn): string {
  const content = readFile(path);
  if (content === null) {
    throw new Error(`背景コンテキストファイルを読み込めませんでした: ${path}`);
  }
  return sanitizeBackground(content);
}

// 手動 background があれば authorInfo の後に別セクションとして併記する。
// 無ければ authorInfo をそのまま返す。
export function mergeAuthorInfo(
  authorInfo: string,
  background?: string,
): string {
  if (!background || background.trim() === "") return authorInfo;
  return `${authorInfo}\n\n${BACKGROUND_SECTION_HEADING}\n${background}`;
}
