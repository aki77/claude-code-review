// schema/review.schema.json（エディタ補完用 JSON Schema）と DEFAULT_CONFIG（型の実体）の
// キー集合が一致することを検証し、スキーマ⇔型のドリフトを機械検出する。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config.ts";

const schema = JSON.parse(
  readFileSync(path.join(process.cwd(), "schema/review.schema.json"), "utf8"),
) as {
  properties: Record<string, { properties?: Record<string, unknown> }>;
};

describe("schema/review.schema.json と DEFAULT_CONFIG のキー集合", () => {
  it("トップレベルキーが一致する", () => {
    expect(new Set(Object.keys(schema.properties))).toEqual(
      new Set(Object.keys(DEFAULT_CONFIG)),
    );
  });

  it("models のキーが一致する", () => {
    expect(
      new Set(Object.keys(schema.properties.models?.properties ?? {})),
    ).toEqual(new Set(Object.keys(DEFAULT_CONFIG.models)));
  });

  it("thresholds のキーが一致する", () => {
    expect(
      new Set(Object.keys(schema.properties.thresholds?.properties ?? {})),
    ).toEqual(new Set(Object.keys(DEFAULT_CONFIG.thresholds)));
  });

  it("tools のキーが一致する", () => {
    expect(
      new Set(Object.keys(schema.properties.tools?.properties ?? {})),
    ).toEqual(new Set(Object.keys(DEFAULT_CONFIG.tools)));
  });

  it("prompts のキーが一致する", () => {
    expect(
      new Set(Object.keys(schema.properties.prompts?.properties ?? {})),
    ).toEqual(new Set(Object.keys(DEFAULT_CONFIG.prompts)));
  });
});
