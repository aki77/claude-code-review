import { describe, expect, it } from "vitest";
import {
  looksLikeStuffedJson,
  stuffedJsonFieldNames,
  unstuffTitleBody,
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

describe("unstuffTitleBody", () => {
  it("発生例: title が無意味な固定文言・body に完全 JSON → 内側 body を復元し title も差し替える", () => {
    const result = unstuffTitleBody(
      "統合レビュー結果",
      '{"title":"実際の指摘タイトル","body":"実際の指摘本文"}',
      false,
      true,
    );
    expect(result).toEqual({
      title: "実際の指摘タイトル",
      body: "実際の指摘本文",
    });
  });

  it("body のみ stuffed で内側に title を含まない場合は元の title を維持する", () => {
    const result = unstuffTitleBody(
      "元のタイトル",
      '{"body":"内側本文のみ"}',
      false,
      true,
    );
    expect(result).toEqual({ title: "元のタイトル", body: "内側本文のみ" });
  });

  it("title のみ stuffed な場合は内側の title/body を採用する", () => {
    const result = unstuffTitleBody(
      '{"title":"内側タイトル","body":"内側本文"}',
      "元の本文",
      true,
      false,
    );
    expect(result).toEqual({ title: "内側タイトル", body: "内側本文" });
  });

  it("非 stuffed な正常 title/body は変化しない", () => {
    const result = unstuffTitleBody("正常な見出し", "正常な本文", false, false);
    expect(result).toEqual({ title: "正常な見出し", body: "正常な本文" });
  });

  it("stuffed 側がパース不能・title/body キー無しの場合は反対側や生値へフォールバックする", () => {
    const result = unstuffTitleBody(
      "元のタイトル",
      '{"foo":"bar"}',
      false,
      true,
    );
    expect(result).toEqual({ title: "元のタイトル", body: "" });
  });
});
