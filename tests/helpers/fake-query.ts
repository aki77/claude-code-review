// steps.ts / client.ts のテスト用フェイク QueryFn。
//
// runStructured は query() の async generator から `{type:"result", subtype:"success", ...}`
// の1メッセージを待つ（client.ts の result 経路）。このヘルパーはその1メッセージだけを
// yield するフェイクを作り、実際の LLM を呼ばずに runStructured を実際に通す。
import type { QueryFn } from "../../src/llm/client.js";

type QueryCall = { prompt: unknown; options: unknown };

// structured_output を1つ返すフェイク query。呼ばれるたびに calls に記録する。
export function makeFakeQuery(
  structuredOutput: unknown,
  opts: { calls?: QueryCall[] } = {},
): QueryFn {
  const fakeQuery = ((params: { prompt: unknown; options: unknown }) => {
    opts.calls?.push({ prompt: params.prompt, options: params.options });
    return (async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        num_turns: 1,
        result: JSON.stringify(structuredOutput),
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        structured_output: structuredOutput,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "fake-session",
      };
    })();
  }) as unknown as QueryFn;
  return fakeQuery;
}

// 常に throw するフェイク query（runAgentSafe のフォールバック経路検証用）。
// async generator ではなく async 関数でも QueryFn の呼び出し側（for await）は
// throw を投げた時点で例外として伝播するため、これで十分。
export function makeThrowingQuery(message = "fake failure"): QueryFn {
  const fakeQuery = (() => {
    throw new Error(message);
  }) as unknown as QueryFn;
  return fakeQuery;
}
