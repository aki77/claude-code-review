# Phase 5: pr-review 投稿・コスト比較・ドキュメント

前提: Phase 4 で local-review が完走。このフェーズで pr-review（GitHub PR 取得＋インラインコメント投稿）を追加し、目的（コスト削減）を定量確認してドキュメント化する。

参照元: `pr-review/SKILL.md`（step0/9/10）, `post-review.mjs`。

## ゴール

`node dist/cli.js pr <n>`（step8 まで、投稿なし）と `pr <n> --comment`（インラインコメント一括投稿）が動く。

## 作業内容

### step0: PR HEAD 一致確認（`pr-review/SKILL.md:12-16`）
- `gh pr view <n> --json headRefOid` と ローカル HEAD（`git rev-parse HEAD`）を比較。
- 不一致なら無条件終了（ローカルがレビュー対象コミットと一致していない）。

### step1 の PR モード（Phase 2 の collect-context 拡張）
- `resolvePrBaseRange`（`gh pr view` の baseRefOid → `<base>...HEAD`）を使い CTX を構築。
- サマリ入力に PR タイトル・説明文・コミットを含める（local と異なり著者意図が PR にある）。
- pr-review 特有: agent1/2/3/5 は step2 と並列可、agent4 のみ step2 完了待ち（`pr-review/SKILL.md:27`）。tiny 時 summary 起動しない（意図は PR タイトル/説明で代替、`:28`）。

### step9: コメント本文作成（`--comment` 時のみ, `pr-review/SKILL.md:39-49`）
- `llmCommentBodies(finalIssues)`: confirmed かつ resolved:true の issue ごとに `{ id, commentBody, suggestion?, deleteLines? }` を生成。
  - 本文先頭に `[category · severity]` バッジ、引用元リンク。
  - suggestion は小規模・自己完結・単一 finding 由来のみ。
  - resolved:false の confirmed はインライン化せずサマリ本文で言及。

### step10: 投稿（`post-review.ts` 使用）
- `toComment` で params → REST snake_case。
- `buildSuggestionBody` の **fail-closed 破壊ガード**を必ず通す（複数メンバー統合・行数不一致・deleteLines 不整合なら suggestion を捨てて文章のみ）。
- `gh api POST /repos/{owner}/{repo}/pulls/<n>/reviews --input -` で payload `{commit_id, event:"COMMENT", body: summaryBody, comments}` を一括投稿。
- 同一課題 1 コメントのみ（重複禁止）。

### `src/cli.ts`
- `pr <n>` / `pr <n> --comment` を pipeline に接続。`--comment` なしは step8 で終了。

## 検証（E2E・慎重に）

1. **投稿なし先行**: テスト用 PR で `pr <n>`（step8 まで）を実行しサマリ確認。
2. **suggestion ガード確認**: 統合 issue や行数不一致ケースで suggestion が捨てられ文章のみになることを確認（コードを壊さない）。
3. **投稿**: 問題なければ `pr <n> --comment` で `gh api` 投稿。インラインコメントが正位置（resolved:true の path:line）に付くこと、resolved:false がサマリ言及に回ることを確認。
4. HEAD 不一致時に step0 で止まることを確認。

## コスト比較（目的の達成確認）

- 同一 diff（このリポジトリの適当な変更 or テスト PR）を:
  - (a) 既存プラグイン（SKILL 経由）
  - (b) 新実装（Agent SDK）
  で流し、LLM の usage（トークン数）を比較。
- 新実装で「オーケストレーション分の LLM トークンが削減」されていることを確認し、数値を README に記録。
- Phase 3 で取得した usage 取得手段を使う。

## ドキュメント（README 拡充）

- インストール・前提（Claude Code ログイン済み、gh CLI）。
- 使い方: `code-review local [--range <range>]`, `code-review pr <n> [--comment]`, `--debug`。
- 認証の仕組み（OAuth 継承、APIキー不要）と制約。
- 既存プラグインとの差分（決定論オーケストレーション、コスト削減、データ構造互換）。
- env しきい値（`CODE_REVIEW_*`）一覧。

## 完了条件

- pr-review が step0〜10 で完走、`--comment` 投稿が正しく行われる。
- suggestion 破壊ガード・黙殺可視化が機能。
- コスト削減が数値で確認でき README に記載。
- 全純コードテストが green。
