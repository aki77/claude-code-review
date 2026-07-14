// 環境変数の真偽値判定。`CODE_REVIEW_*` 系の on/off フラグ判定で共有する
// （`src/llm/prompts.ts` の reviewTools()/externalReferenceInstruction()、
// `src/lib/mcp-config.ts` の buildReviewMcpServers() から利用）。
//
// 受理する truthy 値は "1" と "true"（大小文字無視）のみ。
// それ以外（未設定・"0"・任意の文字列）は OFF 扱い。
export function isEnvTruthy(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}
