// Phase 3: 認証スモークテスト（ライブ）。
//
// 本プロジェクトの必須要件「ANTHROPIC_API_KEY なしで claude CLI の OAuth ログインを
// 継承したまま query() が動く」ことを実機で確認する。CI では既定 skip。
// ローカルでは `env -u ANTHROPIC_API_KEY RUN_LIVE=1 pnpm test tests/auth-smoke.test.ts`
// を実行する（事前に claude CLI でログイン済みであること）。
//
// 検証観点（docs/plans/03-auth-smoke-test.md 原典 完了条件）:
// (1) 例外なく result が返る（OAuth 継承成功）
// (2) JSON パース成功
// (3) usage / total_cost_usd が取得できる
import { describe, expect, it } from "vitest";
import { runStructured } from "../src/llm/client.js";

// ANTHROPIC_API_KEY unset のまま動くことが前提のため、テスト内で明示的に固定する。
delete process.env.ANTHROPIC_API_KEY;

describe.skipIf(!process.env.RUN_LIVE)("auth smoke", () => {
  it(
    "outputFormat 経路（json_schema）で構造化出力が得られる",
    async () => {
      const { data, usage, totalCostUsd } = await runStructured<{
        answer: number;
      }>({
        system: "あなたは算数の問題に答えるアシスタントです。",
        user: "1+1は？ answer に数値で JSON を返してください。",
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      });

      expect(data.answer).toBe(2);
      console.log("[outputFormat] usage:", usage);
      console.log("[outputFormat] totalCostUsd:", totalCostUsd);
    },
    30_000,
  );

  it(
    "system prompt 強制経路（schema 無し）で JSON.parse が通る",
    async () => {
      const { data, usage, totalCostUsd } = await runStructured<{
        answer: number;
      }>({
        system: "あなたは算数の問題に答えるアシスタントです。",
        user: "1+1は？ answer に数値で JSON を返してください。",
      });

      expect(data.answer).toBe(2);
      console.log("[system prompt] usage:", usage);
      console.log("[system prompt] totalCostUsd:", totalCostUsd);
    },
    30_000,
  );
});
