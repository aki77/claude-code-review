// LLM 呼び出しの共通エントリポイント。全 LLM ステップ（step2/3/5/6/9）が
// これ経由で `@anthropic-ai/claude-agent-sdk` の query() を呼ぶ。
//
// 認証方針（CLAUDE.md）: ANTHROPIC_API_KEY は使わない。query() は内部で `claude` CLI
// を起動し、CLI の OAuth ログイン状態を継承する。この前提の実機検証が
// tests/auth-smoke.test.ts。
//
// 設計原則: LLM は意味判断のみ、パース・検証・リトライ制御はコード側（docs/plans/00-overview.md）。
// 構造化出力は outputFormat: json_schema を第一選択とし、使えない/schema 未指定のときは
// system prompt での JSON 強制 + パースにフォールバックする（docs/plans/03-auth-smoke-test.md）。
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import type { JSONSchema } from "../lib/types.js";

export interface RunStructuredOpts {
  system: string;
  user: string;
  model?: string;
  schema?: JSONSchema;
}

export interface RunStructuredResult<T> {
  data: T;
  usage: NonNullableUsage;
  totalCostUsd: number;
}

// query の型（型引数なしで typeof query を直接使うと呼び出しシグネチャが煩雑になるため別名化）。
type QueryFn = typeof query;

const JSON_ONLY_INSTRUCTION =
  "\n\n出力は JSON のみ。前置き・説明文・コードフェンス（```）は一切含めないこと。";

const RETRY_USER_SUFFIX =
  "\n\n前回の出力は不正な JSON でした。前置きやコードフェンスを含めず、JSON のみを再出力してください。";

/**
 * query() を実行し、終端の result メッセージ（SDKResultMessage）を待つ。
 * - subtype が error* → errors を含めた Error を throw（認証失敗の検出ポイント）。
 * - subtype === 'success' → そのメッセージを返す。
 * - result メッセージが得られないままストリームが終わった → Error。
 */
async function runQueryUntilResult(
  queryFn: QueryFn,
  prompt: string,
  options: Parameters<QueryFn>[0]["options"],
) {
  for await (const message of queryFn({ prompt, options })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") {
      throw new Error(
        `LLM query failed (${message.subtype}): ${message.errors.join(", ")}`,
      );
    }
    return message;
  }
  throw new Error("LLM query stream ended without a result message");
}

export async function runStructured<T>(
  opts: RunStructuredOpts,
  deps?: { query?: QueryFn },
): Promise<RunStructuredResult<T>> {
  const queryFn = deps?.query ?? query;
  const systemPrompt = `${opts.system}${JSON_ONLY_INSTRUCTION}`;
  const options: Parameters<QueryFn>[0]["options"] = {
    allowedTools: [],
    settingSources: [],
    permissionMode: "default",
    systemPrompt,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.schema !== undefined
      ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } }
      : {}),
  };

  const result = await runQueryUntilResult(queryFn, opts.user, options);

  if (result.structured_output !== undefined) {
    return {
      data: result.structured_output as T,
      usage: result.usage,
      totalCostUsd: result.total_cost_usd,
    };
  }

  try {
    const data = JSON.parse(result.result) as T;
    return { data, usage: result.usage, totalCostUsd: result.total_cost_usd };
  } catch {
    // パース失敗時は 1 回だけリトライ。structured_output 経路はここに来ないためリトライ対象外。
    const retryResult = await runQueryUntilResult(
      queryFn,
      `${opts.user}${RETRY_USER_SUFFIX}`,
      options,
    );
    const data = JSON.parse(retryResult.result) as T;
    return {
      data,
      usage: retryResult.usage,
      totalCostUsd: retryResult.total_cost_usd,
    };
  }
}
