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
pnpm lint    # biome check（lint + format チェック、非破壊）
pnpm format  # biome check --write（自動修正）
```

## 設計原則（最重要）

- **LLM は意味判断のみ、位置解決・検証・フィルタ適用・構造転写はコードで行う**
  （`src/cli.ts` 冒頭コメント由来）。新しいステップを
  追加するときもこの分担を崩さない。
- **行番号は LLM に推測させない**。LLM は diff 中の実在コード片 `existingCode` だけを
  出力し、行番号は `resolveAnchor`（`src/lib/diff-anchor.ts`）で機械的に確定する。
- 成果物はメモリ上のオブジェクトで各ステップ間を受け渡す（一時ファイル経由にしない）。
- **非レビュー系 LLM ステップ**（step2 要約/クラスタ・step5 マージ・step9 コメント整形・
  step4b アンカー再解決）**は既定 `allowedTools: []`（ツール不可のワンショット）**。
- **レビュー系ステップ（agent1〜5＋検証step6）はレビュー精度を優先し、read-only ツール
  （Read/Grep/Glob）＋ context7 MCP（既定 ON、依存ライブラリの実仕様確認用）を常時付与する**
  （`src/llm/prompts.ts` の `reviewTools()`／`src/lib/mcp-config.ts` の
  `buildReviewMcpServers()`。`CODE_REVIEW_DISABLE_CONTEXT7=1`（または `=true`、大小文字無視）
  で context7 を無効化できる）。
  WebFetch/WebSearch は `CODE_REVIEW_ENABLE_WEB=1`（または `=true`、大小文字無視）で opt-in。
  write 系ツールは一切許可しない
  （作業ツリーを変更しない）。ツール利用がある分レビュー再実行の決定論性は下がるが、これは
  意図した方針判断（ユーザーが精度優先を明言）。
- **設定解決は `src/lib/config.ts` に集約し、消費側は `ResolvedConfig` を引数で受ける**
  （トップレベル env 即時評価を新規に増やさない）。優先順位は `env > YAML(.claude/review.yaml)
  > 既定`。`loadConfig()` は `pipeline.ts` の入口（`runLocalReview`/`runPrReview`）で1回だけ
  呼び、`collectContext`/`runReviewCore`/各 LLM ステップの `StepDeps.config` へ配線する。
  各消費関数は `config?` を省略可能にし、省略時は既存の env/module const フォールバックへ
  倒す（既存の no-arg 呼び出し・env ベースのテストを壊さない）。
- **プロンプト断片の file 読込・合成（inline/file/append/replace）は `config.ts` で解決済みの
  文字列にしてから `prompts.ts` へ渡す**（`prompts.ts` は副作用なし・ファイル I/O なしの
  純関数を維持する設計原則を守る）。

## 認証方針（重要な制約）

- `ANTHROPIC_API_KEY` は使わない。`@anthropic-ai/claude-agent-sdk` は内部で `claude` CLI
  を起動し、CLI の OAuth ログイン状態を継承する。API キー前提のコードを書かないこと。
- 動作させるには事前に `claude` CLI でログイン済みである必要がある。

## アーキテクチャ

パイプラインは `collectContext → LLM要約/クラスタ → 決定論処理 → LLMレビュー →
processFindings → LLMマージ → mergeFindings → LLM検証 → applyVerdicts → 出力/投稿`
の順。

- `src/cli.ts`: 引数パース・ディスパッチのみ。実装ロジックは書かない。
- `src/lib/`: 決定論ロジック（git/gh 呼び出し、diff アンカー解決、finding 処理など）。
- `src/llm/`: LLM 呼び出しステップ本体（`client.ts`/`prompts.ts`/`steps.ts`）。実装済み。
- `src/lib/types.ts`: Finding/Group/Ctx 等のデータ契約。既存 `.mjs` 実装のフィールド名を
  変えずに移植すること（回帰防止のため）。

## Gotchas

- Node 24 系はフラグなしでネイティブ TypeScript 実行（型ストリッピング）が有効。dev 実行に
  tsx/ts-node は不要で `node src/cli.ts` が直接動く（enum/namespace 不可。ビルドの型チェック
  ＆`dist/` 出力は従来どおり `tsc` が担う）。
  相対 import は `.ts` 拡張子で書くこと（`.js` ではない）。理由: Node の型ストリッピングは
  import 指定子を書き換えないため、dev 実行時はディスク上に実在するファイル（`.ts`）を指す
  必要がある。tsconfig の `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
  により、`tsc` ビルド時は出力の import が自動的に `.js` へ書き換わる。この方針は Biome の
  `useImportExtensions`（`biome.jsonc`、`extensionMappings: {"ts":"ts"}`）で機械的に強制
  されており、`.js` に戻すと `pnpm lint` がエラーになる。
- Biome導入時、`noNonNullAssertion` はオフにしている。理由: tsconfig の
  `noUncheckedIndexedAccess` により配列/Map アクセス後の非null アサーション（`!`）が
  境界確認済みであることを示す正当な書き方として多用されているため。
- git hook は依存ツール（husky 等）を使わず `core.hooksPath` 方式。`pnpm install` 時に
  `prepare` スクリプトが `git config --local core.hooksPath .githooks` を設定し、
  `.githooks/pre-commit` が `lint-staged` 経由で staged ファイルに `biome check --write`
  を適用する。
- `@types/node` のバージョンは Node 本体のバージョンと一致しない
  （例: Node `v24.18.0` でも `@types/node` は `^24.1.0` 系）。npm 上の実在バージョンを
  確認してから追加すること。
- Node は v24 系、パッケージマネージャは pnpm（npm は使わない）。
