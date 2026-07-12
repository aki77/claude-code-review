# Phase 2d: 投稿ロジックの移植（post-review）

前提: `00-overview.md` 契約厳守。LLM 非依存。Phase 5（pr-review 投稿）で使うが、
純ロジック（toComment / buildSuggestionBody / buildPayload の検証）は Phase 2 で移植可能。
02a の diff-anchor（splitAndNormalize）に依存するため 02a 完了後に着手。

型の置き場所: REST コメント型等の新規型も 02a と同方針で `src/lib/types.ts` に集約し、
`post-review.ts` はそこから import する。

exec.ts の前提条件: 投稿本体（`gh api ... --input -`、Phase 5）は JSON を stdin 供給する
必要があるが、02a 時点の `exec.ts`（`execFileAsync`）は `input` オプションを持たない。
Phase 5 着手時に `exec.ts` へ `options.input?: string` を追加すること
（02c と同じ不足・詳細は 02a の exec.ts セクション参照）。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/post-review.mjs`

## ゴール
fail-closed の破壊ガードと黙殺防止のテストが green。

## 移植対象: `src/lib/post-review.ts`

- `toComment(issue, body)`: params を GitHub REST snake_case へ。単一行 `{path,body,line,side}`、
  複数行は `start_line`/`start_side` 追加。`subjectType` は落とす。
- `buildSuggestionBody(issue, suggestion, deleteLines)` → `{ok:true,body}` | `{ok:false,reason}`
  （**fail-closed の破壊ガード**）:
  1. 複数メンバー（sourceFindingIds.length>=2）→ ok:false。
  2. existingCode 空 → ok:false。
  3. 範囲行数 ≠ existingCode 行数 → ok:false（resolveAnchor 不変条件の投稿直前確認）。
  4. 行削除（shortfall>0）は消える行が全て deleteLines に含まれ、かつ vanishing.length===shortfall のみ許可
     （gitignore 巻き添え事故をここで弾く）。
  5. 安全なら ```suggestion ブロックを body に。
- `buildPayload(input, finalDoc, { commitId })` → REST リクエストボディ（黙殺防止）:
  検証（throw）: input 非オブジェクト / comments 非配列 / id 文字列必須 / 未知 id / 重複 id /
  **resolved:false をインライン化しようとしたら throw** / commentBody 空。
  **黙殺防止の核**: resolved:true な confirmed issue のうち comments に現れない id があれば throw。
  resolved 済み 0 件ならサマリのみ投稿を許容（課題ゼロ）。suggestion が危険なら withStrippedNote で
  文章のみ（例外にせず fail-closed）。戻り `{commit_id, event:"COMMENT", body, comments}`。
- 内部: toSuggestionLines, rangeLineCount, withStrippedNote。
- 投稿本体（`gh api POST /repos/{owner}/{repo}/pulls/<n>/reviews --input -`）は Phase 5 で
  `exec.ts` 経由（JSON.stringify(payload) を `input` オプションで stdin 供給。上記の
  exec.ts 前提条件を参照）。Phase 2d では純ロジック（payload 組み立て）まで。
- 型: 既存 Issue/FinalDoc（**02b**）を再利用。REST コメント型を追加（types.ts に集約）。

## テスト（元 256-497 行）
buildPayload 基本形、toComment 単一/複数行 snake_case、suggestion 有無、
**gitignore 回帰**（2 行範囲×1 行 suggestion×deleteLines 無し→捨てる・コード非削除）、
deleteLines 明示で許可、deleteLines 不足で捨てる、複数メンバー統合で捨てる、範囲行数不一致で捨てる、
検証エラー（非配列/未知 id/重複/resolved:false/黙殺防止/空 body）、課題ゼロ許容。

## 完了条件
- `pnpm test` で post-review のテストが全 green。

## 注意
- 投稿の副作用は Phase 5 に残し、Phase 2d は純ロジックのみ移植。
- ESM `.js` import・`noUncheckedIndexedAccess` 対応。挙動不変。
