# Phase 1: プロジェクト初期化

前提: `00-overview.md`（背景・認証方針・アーキテクチャ）を参照。このフェーズは LLM 非依存。

## ゴール

TypeScript + ESM + vitest のプロジェクト骨格を用意し、`node dist/cli.js --help` が動く空 CLI を作る。

## 作業内容

### `package.json`
- `type: "module"`（ESM）。
- 依存: `@anthropic-ai/claude-agent-sdk`（LLM 呼び出し用）。
- devDependencies: `typescript`, `tsx`（開発実行）, `vitest`（テスト）, `@types/node`。
- scripts:
  - `build`: `tsc`
  - `dev`: `tsx src/cli.ts`
  - `test`: `vitest run`
  - `test:watch`: `vitest`
- `bin`: `{ "code-review": "dist/cli.js" }`（将来 npm/pnpm 等の CLI として使えるように。当面はローカル実行）。

### `tsconfig.json`
- `"module": "nodenext"`, `"moduleResolution": "nodenext"`, `"target": "es2022"`。
- `"strict": true`, `"noUncheckedIndexedAccess": true`（配列アクセス安全化）。
- `"outDir": "dist"`, `"rootDir": "src"`。
- `"types": ["node"]`（TypeScript 7 のネイティブ移植版 `tsc` では `@types/*` の自動包含が
  効かず、`process` 等のグローバル型が解決できないため明示指定が必要。TS5 時代は不要だった）。

### ディレクトリ骨格
```
src/
  cli.ts            # 引数パース・ディスパッチ（この段階では骨格のみ）
  lib/              # Phase 2 で埋める純コード
  llm/              # Phase 4 で埋める LLM ステップ
  pipeline.ts       # Phase 4 で埋めるオーケストレータ
  report.ts         # Phase 4
tests/              # vitest（Phase 2 で移植）
```

### `src/cli.ts`（骨格）
- 引数: `local` | `pr <n>` サブコマンド、`--range [<range>]`, `--comment`, `--debug`。
- この段階では各サブコマンドは「未実装」メッセージを出すだけ。引数パースの形だけ確定させる。
- 引数パースは既存 `parseFlags`（`lib/artifact.mjs:88`）相当を軽量な自前実装 or minimist 等で。依存を増やさず自前が無難。

### `.gitignore`
- `node_modules/`, `dist/`, `*.log`。

### `README.md`（最小）
- 使い方の骨子（`code-review local` / `code-review pr <n> [--comment]`）と認証前提（Claude Code ログイン済みであること）だけ記載。詳細は Phase 5 で拡充。

## 完了条件

- `pnpm install` が通る。
- `pnpm dev -- --help` でサブコマンド一覧が出る。
- `pnpm test` が「テストなし」で正常終了する（Phase 2 でテスト追加）。

## 注意

- Node バージョンは v24 系（確認済み: v24.18.0）。`package.json` の `engines` に `">=24"` を明記。
- `@anthropic-ai/claude-agent-sdk` のバージョンは install 時点の最新に固定（`pnpm-lock.yaml` をコミット）。
- `@types/node` の版は Node 本体の版と一致しない（例: `^24.18.0` は存在せず `^24.1.0` が正）。依存追加時は npm 上の実在バージョンを確認すること。
