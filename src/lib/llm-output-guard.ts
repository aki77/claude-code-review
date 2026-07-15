// LLM が本来 title/body に分けて出力すべき内容を、title（または body）フィールド自体に
// JSON 構造として丸ごと詰め込んでしまう異常出力を機械検知する。process-findings.ts
// （finding の title/body）と merge-findings.ts（統合文章の title/body）の両方から使う。

// value 全体が単一の JSON オブジェクトとしてパースでき、かつ title/body らしきキーを
// 持つかを判定する。前後に自然文が付く正当な文言（例:
// "オブジェクトリテラル { foo: 1 } の初期化漏れ"）は trim 後に "{" 始まり "}" 終わりの
// 完全な JSON にならないため誤検知しない（"{"/"}" の事前チェックは対象を絞り込むだけで
// なく、JSON でない大多数の文字列で JSON.parse の例外コストを避ける）。
// "{" 始まり "}" 終わりで JSON.parse が成功する文字列は JSON の文法上必ずオブジェクトに
// なる（配列/null/プリミティブはこの形にならない）ため、parsed の型チェックは不要。
export function looksLikeStuffedJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const keys = Object.keys(parsed);
  return keys.includes("title") || keys.includes("body");
}

// title/body ペアのうち looksLikeStuffedJson に該当するフィールド名（"title"/"body"）を
// 列挙する。process-findings.ts（invalid 化）と merge-findings.ts（throw）で判定結果の
// 扱いは異なるが、どのフィールドが異常かの判定自体は共通化する。
export function stuffedJsonFieldNames(title: string, body: string): string[] {
  const fields: string[] = [];
  if (looksLikeStuffedJson(title)) fields.push("title");
  if (looksLikeStuffedJson(body)) fields.push("body");
  return fields;
}
