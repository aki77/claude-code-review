# claude-code-review

Claude Agent SDK を使ったコードレビュー CLI。既存の
[aki77/claude-plugins code-review プラグイン](https://github.com/aki77/claude-plugins/tree/main/plugins/code-review)
の決定論的再実装。**位置解決・検証・フィルタ適用・構造転写はコードで行い、LLM には意味判断
のみを任せる**ことで、オーケストレーション分の LLM トークンを削減する。

## インストール・前提

- Node.js 24 系、pnpm。
- [Claude Code](https://github.com/anthropics/claude-code) CLI にログイン済みであること
  （後述の認証の仕組み参照）。
- `pr` コマンドを使う場合は [`gh` CLI](https://cli.github.com/) がインストール・認証済みで
  あること。

```bash
pnpm install
pnpm build
```

## 使い方

```
code-review local [--range [<range>]] [--debug]
code-review pr <number> [--comment] [--debug]
```

- `local`: ローカルの差分をレビューする。
  - `--range` を省略すると、まずステージ済み変更（`git diff --staged`）を自動判別する。
  - `--range` の値を省略（`--range` のみ）した場合や引数なし実行時でステージ済み変更が
    無い場合は、現在のブランチの base を自動解決する
    （`branch.<name>.github-pr-base-branch` → `vscode-merge-base` → `@{upstream}` →
    `origin/HEAD` の順にフォールバック）。
  - `--range <range>` で明示的にレビュー対象範囲を指定できる（`..` を含まなければ
    `<range>...HEAD` に補完される）。
- `pr <number>`: 指定した PR をレビューする。
  - ローカルの HEAD が PR の HEAD と一致していない場合は、LLM を呼ぶ前にエラー終了する
    （対象 PR のブランチをチェックアウトしてから再実行する）。
  - `--comment` を付けると、レビュー結果を PR にインラインコメントとして一括投稿する
    （`gh api` 経由）。付けない場合はサマリを標準出力するのみで、投稿・追加の LLM 呼び出しは
    発生しない。
- `--debug`: 各 LLM ステップの usage・コストなどをデバッグログとして標準エラーに出力する。

開発時（ビルドせず直接実行）:

```bash
pnpm dev -- local [--range [<range>]] [--debug]
pnpm dev -- pr <number> [--comment] [--debug]
```

## 認証の仕組み

`ANTHROPIC_API_KEY` は使わない。内部で `@anthropic-ai/claude-agent-sdk` が `claude` CLI を
起動し、CLI の OAuth ログイン状態を継承する。したがって動作させるには事前に `claude` CLI で
ログイン済みである必要がある。API キー前提の環境変数は不要。

## env しきい値一覧（`CODE_REVIEW_*`）

変更規模の分類（tier）としきい値は環境変数で上書きできる（プロンプト自体は変更不要）。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CODE_REVIEW_TINY_MAX_FILES` | 2 | tier=tiny と判定する最大ファイル数 |
| `CODE_REVIEW_TINY_MAX_LINES` | 50 | tier=tiny と判定する最大変更行数 |
| `CODE_REVIEW_SMALL_MAX_FILES` | 5 | tier=small と判定する最大ファイル数 |
| `CODE_REVIEW_SMALL_MAX_LINES` | 150 | tier=small と判定する最大変更行数 |
| `CODE_REVIEW_OVERSIZED_MAX_LINES` | 1000 | 1ファイルの変更行数がこれを超えるとレビュー対象から除外（oversizedFiles） |

tier に応じて起動する LLM エージェントの数が変わる（tiny/small ほど少ない）。詳細は
`docs/plans/00-overview.md` を参照。

## 既存プラグインとの差分

- **決定論オーケストレーション**: 行番号解決・finding のフィルタ/グルーピング・merge/verdict
  の適用・PR コメントのバッジ/パーマリンク付与など、位置解決や構造転写を要する処理はすべて
  TypeScript の純関数が担う。LLM には「意味判断」（バグかどうか、文章をどう書くか）のみを
  任せる。
- **コスト削減**: オーケストレーション相当の LLM ターンが無くなった分、同一 diff に対する
  トークン消費・LLM 呼び出し回数が既存プラグイン（SKILL 経由）より少ない。tier=tiny では
  さらにサマリ生成用の LLM 呼び出しも省略する。
- **データ構造互換**: Finding/Group/Issue などのデータ契約は既存 `.mjs` 実装のフィールド名を
  そのまま踏襲しており、挙動の回帰を避けている。

## 開発

```bash
pnpm test        # vitest run
pnpm test:watch
pnpm lint         # biome check（非破壊）
pnpm format       # biome check --write（自動修正）
```

詳細な設計・各フェーズの実装計画は `docs/plans/00-overview.md` を起点に `docs/plans/*.md`
を参照。
