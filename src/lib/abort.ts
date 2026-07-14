// Ctrl+C 中断（AbortController.abort()）由来のエラーかどうかを判定する共通ヘルパー。
// exec.ts（execFile の abort）・steps.ts（runAgentSafe の再throw判定）・cli.ts（dispatch の
// catch 分岐）の3箇所で同じ判定が必要なため、ここに集約する。
// Node の child_process は abort 時に AbortError（name/code のどちらでも識別可能）を投げる。
// SDK（@anthropic-ai/claude-agent-sdk）が query() 実行中の abort で投げる AbortError は
// 空ボディの class（name/code とも未設定、instanceof でのみ識別可能）のため instanceof で判定する。
import { AbortError } from "@anthropic-ai/claude-agent-sdk";

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof AbortError ||
    error.name === "AbortError" ||
    (error as NodeJS.ErrnoException).code === "ABORT_ERR"
  );
}
