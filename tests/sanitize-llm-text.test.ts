import { describe, expect, it } from "vitest";
import { normalizeLlmNewlines } from "../src/lib/sanitize-llm-text.ts";

describe("normalizeLlmNewlines", () => {
  it("リテラル \\n を実改行に変換する", () => {
    expect(normalizeLlmNewlines("line1\\nline2")).toBe("line1\nline2");
  });

  it("リテラル \\r\\n を実改行に変換する", () => {
    expect(normalizeLlmNewlines("line1\\r\\nline2")).toBe("line1\nline2");
  });

  it("二重バックスラッシュ（\\\\n）は変換せず保持する", () => {
    // 入力文字列としての \\n（バックスラッシュ2つ+n の3文字）は
    // エスケープ済みバックスラッシュ + 通常文字 n であり、改行にしてはいけない。
    expect(normalizeLlmNewlines("path\\\\nested")).toBe("path\\\\nested");
  });

  it("実改行を含む文字列は不変（冪等性）", () => {
    const text = "line1\nline2";
    expect(normalizeLlmNewlines(text)).toBe(text);
  });

  it("二重適用しても結果が変わらない", () => {
    const text = "line1\\nline2";
    const once = normalizeLlmNewlines(text);
    expect(normalizeLlmNewlines(once)).toBe(once);
  });

  it("バックスラッシュを含まない文字列はそのまま返す", () => {
    const text = "no backslash here";
    expect(normalizeLlmNewlines(text)).toBe(text);
  });

  it("単独の \\t は変換しない", () => {
    const text = "col1\\tcol2";
    expect(normalizeLlmNewlines(text)).toBe(text);
  });

  it("単独の \\r は変換しない", () => {
    const text = "line1\\rline2";
    expect(normalizeLlmNewlines(text)).toBe(text);
  });
});
