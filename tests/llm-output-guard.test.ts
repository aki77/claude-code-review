import { describe, expect, it } from "vitest";
import {
  looksLikeStuffedJson,
  stuffedJsonFieldNames,
} from "../src/lib/llm-output-guard.ts";

describe("looksLikeStuffedJson", () => {
  it("title/body 両方を含む JSON 文字列は検知する", () => {
    expect(looksLikeStuffedJson('{"title":"X","body":"Y"}')).toBe(true);
  });

  it("title のみを含む JSON 文字列でも検知する", () => {
    expect(looksLikeStuffedJson('{"title":"見出しだけ"}')).toBe(true);
  });

  it("body のみを含む JSON 文字列でも検知する", () => {
    expect(looksLikeStuffedJson('{"body":"本文だけ"}')).toBe(true);
  });

  it("前後に自然文が付く場合は誤検知しない", () => {
    expect(
      looksLikeStuffedJson("オブジェクトリテラル { foo: 1 } の初期化漏れ"),
    ).toBe(false);
  });

  it("title/body キーを含まない完全な JSON は誤検知しない", () => {
    expect(looksLikeStuffedJson('{"foo":"bar"}')).toBe(false);
  });

  it("空オブジェクトは誤検知しない", () => {
    expect(looksLikeStuffedJson("{}")).toBe(false);
  });

  it("JSON.parse できない自然文は誤検知しない", () => {
    expect(looksLikeStuffedJson("配列 [1,2,3] を返す")).toBe(false);
  });
});

describe("stuffedJsonFieldNames", () => {
  it('title のみ異常なら ["title"] を返す', () => {
    expect(stuffedJsonFieldNames('{"title":"X"}', "正常な本文")).toEqual([
      "title",
    ]);
  });

  it('body のみ異常なら ["body"] を返す', () => {
    expect(stuffedJsonFieldNames("正常な見出し", '{"body":"Y"}')).toEqual([
      "body",
    ]);
  });

  it('両方異常なら ["title","body"] を title→body の順で返す', () => {
    expect(stuffedJsonFieldNames('{"title":"X"}', '{"body":"Y"}')).toEqual([
      "title",
      "body",
    ]);
  });

  it("両方正常なら空配列を返す", () => {
    expect(stuffedJsonFieldNames("正常な見出し", "正常な本文")).toEqual([]);
  });
});
