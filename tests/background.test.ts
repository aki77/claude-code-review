import { describe, expect, it } from "vitest";
import {
  BACKGROUND_MAX_CHARS,
  loadBackgroundFile,
  mergeAuthorInfo,
  sanitizeBackground,
} from "../src/lib/background.ts";

describe("sanitizeBackground", () => {
  it("タブ・改行・CR は保持する", () => {
    const text = "line1\tvalue\nline2\r\nline3";
    expect(sanitizeBackground(text)).toBe(text);
  });

  it("C0 制御文字（NUL・ESC など）を除去する", () => {
    const text = "abc\x00def\x1bghi";
    expect(sanitizeBackground(text)).toBe("abcdefghi");
  });

  it("DEL・C1 制御文字を除去する", () => {
    const text = `abc${String.fromCharCode(0x7f)}def${String.fromCharCode(0x90)}ghi`;
    expect(sanitizeBackground(text)).toBe("abcdefghi");
  });

  it(`${BACKGROUND_MAX_CHARS} 字を超える場合は切り詰める`, () => {
    const text = "a".repeat(BACKGROUND_MAX_CHARS + 100);
    const result = sanitizeBackground(text);
    expect(result.length).toBe(BACKGROUND_MAX_CHARS);
    expect(result).toBe("a".repeat(BACKGROUND_MAX_CHARS));
  });

  it(`${BACKGROUND_MAX_CHARS} 字以下はそのまま返す`, () => {
    const text = "要件メモ";
    expect(sanitizeBackground(text)).toBe(text);
  });

  it("切り詰め境界がサロゲートペアを分断する場合、孤立サロゲートを残さない", () => {
    // "a" x (MAX - 1) + 😀(サロゲートペア) + "b" x 10
    // → index MAX-1 が 😀 の高位サロゲート、index MAX が低位サロゲートになり、
    //   slice(0, MAX) はちょうど高位サロゲートだけを末尾に残す境界になる。
    const text = `${"a".repeat(BACKGROUND_MAX_CHARS - 1)}😀${"b".repeat(10)}`;
    const result = sanitizeBackground(text);
    expect(result.length).toBe(BACKGROUND_MAX_CHARS - 1);
    expect(result).toBe("a".repeat(BACKGROUND_MAX_CHARS - 1));
    expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
  });
});

describe("loadBackgroundFile", () => {
  it("readFile が返した内容をサニタイズして返す", () => {
    const readFile = (path: string) =>
      path === "./docs/req.md" ? "要件\x00メモ" : null;
    expect(loadBackgroundFile("./docs/req.md", readFile)).toBe("要件メモ");
  });

  it("readFile が null を返す（読込失敗）場合は例外を投げる", () => {
    const readFile = () => null;
    expect(() => loadBackgroundFile("./missing.md", readFile)).toThrow(
      /背景コンテキストファイルを読み込めませんでした/,
    );
  });

  it("上限を超える内容は切り詰められる", () => {
    const long = "b".repeat(BACKGROUND_MAX_CHARS + 50);
    const readFile = () => long;
    expect(loadBackgroundFile("./big.md", readFile).length).toBe(
      BACKGROUND_MAX_CHARS,
    );
  });
});

describe("mergeAuthorInfo", () => {
  it("background が未指定なら authorInfo をそのまま返す", () => {
    expect(mergeAuthorInfo("PR タイトル")).toBe("PR タイトル");
  });

  it("background が空文字/空白のみなら authorInfo をそのまま返す", () => {
    expect(mergeAuthorInfo("PR タイトル", "")).toBe("PR タイトル");
    expect(mergeAuthorInfo("PR タイトル", "   ")).toBe("PR タイトル");
  });

  it("background があれば authorInfo の後に見出し付きで併記する", () => {
    const result = mergeAuthorInfo("PR タイトル", "認証にレート制限を追加");
    expect(result).toBe(
      "PR タイトル\n\n## 補足コンテキスト（手動指定）\n認証にレート制限を追加",
    );
  });

  it("authorInfo 自体は書き換えない（併記のみ）", () => {
    const authorInfo = "# 元のタイトル\n\n元の本文";
    const result = mergeAuthorInfo(authorInfo, "追加要件");
    expect(result.startsWith(authorInfo)).toBe(true);
  });
});
