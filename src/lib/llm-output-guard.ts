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
// 列挙する。process-findings.ts（invalid 化）と merge-findings.ts（救済対象の判定）で
// 判定結果の扱いは異なるが、どのフィールドが異常かの判定自体は共通化する。
export function stuffedJsonFieldNames(title: string, body: string): string[] {
  const fields: string[] = [];
  if (looksLikeStuffedJson(title)) fields.push("title");
  if (looksLikeStuffedJson(body)) fields.push("body");
  return fields;
}

// value（stuffed 判定済み）をパースし、内側の title/body（非空文字列のもの）を取り出す。
// 実発生例（title に固定文言、body に本当の title/body が JSON で1段だけ詰め込まれる）は
// 1段のパースで剥がしきれるため、再帰はしない。パース不能・title/body どちらのキーも
// 無い場合は null（呼び出し側はフォールバックすること）。
function unstuffJsonField(
  value: string,
): { title?: string; body?: string } | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return null;
  }
  // 内側の空文字列は「有効な値なし」とみなして undefined に倒す。unstuffTitleBody の
  // `inner.title ?? title` は nullish 合体のため "" を素通しさせてしまい、呼び出し側が
  // 守る「title/body は非空文字列」という不変条件を unstuff 後に破ってしまうため
  // （空文字列 → 元の非空値へフォールバックさせる）。
  const innerTitle =
    typeof parsed.title === "string" && parsed.title.trim() !== ""
      ? parsed.title
      : undefined;
  const innerBody =
    typeof parsed.body === "string" && parsed.body.trim() !== ""
      ? parsed.body
      : undefined;
  if (innerTitle === undefined && innerBody === undefined) return null;
  return { title: innerTitle, body: innerBody };
}

// title/body ペアを受け取り、stuffed な側を unstuff して復元した新ペアを返す純関数。
// 呼び出し側で stuffedJsonFieldNames 等により判定済みの stuffed 状態を渡す想定のため、
// looksLikeStuffedJson の再スキャンはしない。
//
// title と body はそれぞれ独立に stuffed になり得るため、両側を独立に unstuff して
// 内側の title/body 候補を集める。片側が stuffed で欠けている key があっても、
// フォールバック先が「stuffed だった元の文字列そのもの」にならないよう、生の
// stuffed 文字列は候補から除外する（残すと生 JSON がそのまま出力されてしまう）。
export function unstuffTitleBody(
  title: string,
  body: string,
  titleStuffed: boolean,
  bodyStuffed: boolean,
): { title: string; body: string } {
  if (!titleStuffed && !bodyStuffed) return { title, body };

  const fromTitle = titleStuffed ? unstuffJsonField(title) : null;
  const fromBody = bodyStuffed ? unstuffJsonField(body) : null;

  // stuffed でない生の値だけを「そのフィールドの素の候補」として使う。stuffed な生値は
  // 剥がした内側の値でしか埋められないため候補にしない（最終フォールバックは空文字列）。
  const rawTitle = titleStuffed ? undefined : title;
  const rawBody = bodyStuffed ? undefined : body;

  // 優先順位: 同一フィールド由来の内側値 → 反対フィールド由来の内側値 → stuffed でなかった
  // 元の生値 → 空文字列。この機能の中核的な動機は「title に無意味な固定文言（非 stuffed）、
  // body に本当の { title, body } が JSON で丸ごと詰め込まれている」異常出力の救済であり、
  // その場合 body 側の内側 title で junk な生 title を差し替える必要がある。よって内側値は
  // 生値より優先する。unstuffJsonField は空文字列を undefined に倒すため、内側が空のときは
  // 正しく生値へフォールバックし、「良い生値を空で握りつぶす」ことは起きない。
  const resolvedTitle = fromTitle?.title ?? fromBody?.title ?? rawTitle ?? "";
  const resolvedBody = fromBody?.body ?? fromTitle?.body ?? rawBody ?? "";
  return { title: resolvedTitle, body: resolvedBody };
}
