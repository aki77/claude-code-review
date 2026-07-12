# CLAUDE.md

Claude Agent SDK を使ったコードレビュー CLI の TypeScript 実装（既存の
[aki77/claude-plugins code-review プラグイン](https://github.com/aki77/claude-plugins/tree/main/plugins/code-review)
の決定論的再実装）。

## 開発コマンド

```bash
pnpm install
pnpm dev -- local [--range [<range>]] [--debug]   # 開発実行
pnpm dev -- pr <number> [--comment] [--debug]
pnpm build   # tsc
pnpm test    # vitest run
pnpm test:watch
```

## 設計原則（最重要）

- **LLM は意味判断のみ、位置解決・検証・フィルタ適用・構造転写はコードで行う**
  （`src/cli.ts` 冒頭コメント、`docs/plans/00-overview.md` 由来）。新しいステップを
  追加するときもこの分担を崩さない。
- **行番号は LLM に推測させない**。LLM は diff 中の実在コード片 `existingCode` だけを
  出力し、行番号は `resolveAnchor`（`src/lib/diff-anchor.ts`）で機械的に確定する。
- 成果物はメモリ上のオブジェクトで各ステップ間を受け渡す（一時ファイル経由にしない）。

## 認証方針（重要な制約）

- `ANTHROPIC_API_KEY` は使わない。`@anthropic-ai/claude-agent-sdk` は内部で `claude` CLI
  を起動し、CLI の OAuth ログイン状態を継承する。API キー前提のコードを書かないこと。
- 動作させるには事前に `claude` CLI でログイン済みである必要がある。

## アーキテクチャ

全体設計と各フェーズの計画は `docs/plans/00-overview.md` を起点に `docs/plans/*.md` を参照。
パイプラインは `collectContext → LLM要約/クラスタ → 決定論処理 → LLMレビュー →
processFindings → LLMマージ → mergeFindings → LLM検証 → applyVerdicts → 出力/投稿`
の順（詳細は overview 内の表）。

- `src/cli.ts`: 引数パース・ディスパッチのみ。実装ロジックは書かない。
- `src/lib/`: 決定論ロジック（git/gh 呼び出し、diff アンカー解決、finding 処理など）。
- `src/llm/`: LLM 呼び出しステップ（Phase 4 で実装予定、現状 `.gitkeep` のみ）。
- `src/lib/types.ts`: Finding/Group/Ctx 等のデータ契約。既存 `.mjs` 実装のフィールド名を
  変えずに移植すること（回帰防止のため）。

## Workflow

- 実装を進める中で `docs/plans/*.md` に記載した方針の見直しが発生した場合は、
  その場でコードだけ変更して終わらせず、該当する `docs/plans/*.md` の記述も
  同じタイミングで更新すること（計画とコードの乖離を防ぐため）。

## Gotchas

- Node 24 系はフラグなしでネイティブ TypeScript 実行（型ストリッピング）が有効。dev 実行に
  tsx/ts-node は不要で `node src/cli.ts` が直接動く（enum/namespace 不可。ビルドの型チェック
  ＆`dist/` 出力は従来どおり `tsc` が担う）。
  相対 import は `.ts` 拡張子で書くこと（`.js` ではない）。理由: Node の型ストリッピングは
  import 指定子を書き換えないため、dev 実行時はディスク上に実在するファイル（`.ts`）を指す
  必要がある。tsconfig の `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
  により、`tsc` ビルド時は出力の import が自動的に `.js` へ書き換わる。
- `@types/node` のバージョンは Node 本体のバージョンと一致しない
  （例: Node `v24.18.0` でも `@types/node` は `^24.1.0` 系）。npm 上の実在バージョンを
  確認してから追加すること。
- Node は v24 系、パッケージマネージャは pnpm（npm は使わない）。
