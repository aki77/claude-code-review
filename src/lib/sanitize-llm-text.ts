// LLM が構造化出力の文字列値（summaryBody/commentBody）内に、実改行ではなく
// リテラルなバックスラッシュ+n の2文字（\n）をそのまま書いてしまうことがある。
// SDK の structured_output はそのまま値を使い JSON.parse による復元が入らないため、
// 無変換で下流（投稿本文）まで流れて「改行が \n という文字列として表示される」崩れになる。
// この関数で機械的に実改行へ正す。

// 変換対象は \n と \r\n のみ。\t や単独 \r は本文中の技術的説明（正規表現の説明など）を
// 誤変換するリスクがあるため対象外にする。
// suggestion / deleteLines には絶対に適用しないこと（existingCode 逐語照合や
// split("\n") 前提の行分割を壊すため）。

// 冪等（二重適用しても不変）。二重バックスラッシュ（\\n など、既にエスケープ済みの
// バックスラッシュ+n）は保護し、リテラル \n / \r\n だけを実改行に変換する。
// "\\\\"（エスケープ済みバックスラッシュ）を区切りに split/join することで、区切り自体
// （\\ の並び）には手を触れず、その前後の断片内だけで \n/\r\n を実改行に変換できる。
export function normalizeLlmNewlines(text: string): string {
  if (!text.includes("\\")) return text; // 大半のケースは即 return

  return text
    .split("\\\\")
    .map((part) => part.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n"))
    .join("\\\\");
}
