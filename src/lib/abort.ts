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

// --- 診断用（Ctrl+C 中断切り分け）--------------------------------------------
// 以下は --debug 時のみ使う一時的な診断ログのための純関数。原因確定後、恒久ログとして
// 残す分だけ整理し、残りは撤去する前提（.claude/plans/ctrl-c-dapper-cascade.md 参照）。

// モジュール初回読み込み時刻＝診断ログ全体で共通の時間基準。env 評価ではなく、
// プロセス内で一度だけ Date.now() を呼ぶモジュール初期化。
export const DEBUG_EPOCH = Date.now();

// DEBUG_EPOCH からの経過ミリ秒。診断ログの `at` フィールドに埋め込み、
// cli.ts/client.ts/steps.ts をまたいだ単一時間軸での時系列比較を可能にする。
export function elapsedMs(): number {
  return Date.now() - DEBUG_EPOCH;
}

// catch した error の種別を診断ログ用にまとめる純関数。
// isAbortError と同じ判定材料（name/code/instanceof）に加え、constructor.name も見て
// 「isAbortError は false だが実は近い形」のケースも観測できるようにする。
export function abortErrorKind(error: unknown): {
  isAbort: boolean;
  name?: string;
  code?: string;
  ctor?: string;
} {
  if (!(error instanceof Error)) {
    return { isAbort: false };
  }
  return {
    isAbort: isAbortError(error),
    name: error.name,
    code: (error as NodeJS.ErrnoException).code,
    ctor: error.constructor?.name,
  };
}
