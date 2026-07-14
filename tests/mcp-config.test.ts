import { afterEach, describe, expect, it } from "vitest";
import { buildReviewMcpServers } from "../src/lib/mcp-config.ts";

describe("buildReviewMcpServers", () => {
  afterEach(() => {
    delete process.env.CODE_REVIEW_DISABLE_CONTEXT7;
  });

  it("既定（CODE_REVIEW_DISABLE_CONTEXT7 未設定）は context7 の stdio 設定を返す", () => {
    const servers = buildReviewMcpServers();
    expect(servers).toEqual({
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
  });

  it("CODE_REVIEW_DISABLE_CONTEXT7=1 のとき undefined を返す（口を閉じる）", () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "1";
    expect(buildReviewMcpServers()).toBeUndefined();
  });

  it("CODE_REVIEW_DISABLE_CONTEXT7=0 のときは context7 を返す", () => {
    process.env.CODE_REVIEW_DISABLE_CONTEXT7 = "0";
    expect(buildReviewMcpServers()).toBeDefined();
  });
});
