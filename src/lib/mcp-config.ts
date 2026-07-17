// レビュー系ステップ（agent1〜5＋検証step6）に渡す MCP サーバ設定のビルダ。
//
// context7（依存ライブラリの実仕様を確認できる MCP）を既定で有効化する。
// CI・オフライン・context7 未導入環境向けに CODE_REVIEW_DISABLE_CONTEXT7 で無効化できる
// 退避経路を用意する（無効時は undefined を返し、client.ts の mcpServers 条件付きスプレッドで
// 口を閉じる）。
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedConfig } from "./config.ts";
import { isEnvTruthy } from "./env.ts";

// mcpServers のキー名。prompts.ts の reviewTools() が allowedTools に
// `mcp__<server>` 形式で同じ名前を積むため、サーバー名を単一の情報源にするために export する。
export const CONTEXT7_SERVER_NAME = "context7";

// context7 の stdio 起動設定。npx 経由で @upstash/context7-mcp を都度起動する
// （事前インストール不要だが初回ダウンロード・ネット接続が必要）。
const CONTEXT7_SERVER_CONFIG: McpServerConfig = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@upstash/context7-mcp"],
};

// CODE_REVIEW_DISABLE_CONTEXT7 の判定を単一の情報源にする。
// prompts.ts の reviewTools()/toolUsageInstruction() からも参照される。
// config 省略時のみ env を直読みする（config 経由の呼び出しは resolveConfig 側で
// 既に env>YAML>既定 の優先順位を解決済みのため、ここでは config.tools.context7 を読むだけ）。
export function isContext7Enabled(): boolean {
  return !isEnvTruthy(process.env.CODE_REVIEW_DISABLE_CONTEXT7);
}

// レビュー系ステップへ渡す mcpServers を組み立てる。
// context7 が無効なら undefined を返し、MCP を渡さない
// （client.ts の runStructured は mcpServers === undefined のとき options に含めない）。
export function buildReviewMcpServers(
  config?: ResolvedConfig,
): Record<string, McpServerConfig> | undefined {
  const enabled = config ? config.tools.context7 : isContext7Enabled();
  if (!enabled) return undefined;
  return { [CONTEXT7_SERVER_NAME]: CONTEXT7_SERVER_CONFIG };
}
