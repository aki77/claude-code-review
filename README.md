# claude-code-review

Claude Agent SDK を使ったコードレビュー CLI。**位置解決・検証・フィルタ適用・構造転写は
コードで行い、LLM には意味判断のみを任せる**設計により、オーケストレーション分の LLM
トークンを削減する。

## インストール・前提

- Node.js 24 系。
- [Claude Code](https://github.com/anthropics/claude-code) CLI にログイン済みであること
  （後述の認証の仕組み参照）。
- `pr` コマンドを使う場合は [`gh` CLI](https://cli.github.com/) がインストール・認証済みで
  あること。
- `jq` は不要（`gh` の `--jq` オプション経由で使うのみで、別プロセスとしては起動しない）。

## 使い方（エンドユーザー向け: npx 実行）

インストール不要で `npx` から直接実行できる。

```bash
npx @aki77/claude-code-review -- local [--range [<range>]] [--debug]
npx @aki77/claude-code-review -- pr <number> [--comment] [--debug]
```

サブコマンドへの引数を渡すには `--` 区切りが必要。

## 開発者向け: セットアップ

```bash
pnpm install
pnpm build
```

## 使い方

```
code-review local [--range [<range>]] [--background <text>] [--background-file <path>] [--debug]
code-review pr <number> [--comment] [--background <text>] [--background-file <path>] [--debug]
```

- `local`: ローカルの差分をレビューする。
  - `--range` を省略した場合（引数なし実行、および `--range` のみで値を省略した場合を含む）は
    **workspace モード**になる。作業ツリーの未コミット変更全体
    （staged + unstaged + untracked）を、一時 `GIT_INDEX_FILE` 経由で単一の統一 diff として
    扱う（実 index・作業ツリーは一切変更しない）。untracked ファイルも new file 追加として
    diff に含まれる。
  - `--range <range>` で明示的にレビュー対象範囲を指定できる（`..` を含まなければ
    `<range>...HEAD` に補完される）。値を明示指定したときのみ、現在のブランチの base の
    自動解決（`branch.<name>.github-pr-base-branch` → `vscode-merge-base` →
    `@{upstream}` → `origin/HEAD` の順にフォールバック）が使われる
    （`<range>` に `..` を含まない base 名だけを渡した場合の補完処理）。
- `pr <number>`: 指定した PR をレビューする。
  - ローカルの HEAD が PR の HEAD と一致していない場合は、LLM を呼ぶ前にエラー終了する
    （対象 PR のブランチをチェックアウトしてから再実行する）。
  - `--comment` を付けると、レビュー結果を PR にインラインコメントとして一括投稿する
    （`gh api` 経由）。付けない場合はサマリを標準出力するのみで、投稿・追加の LLM 呼び出しは
    発生しない。
- `--background, -b <text>`: コミットメッセージや PR 説明からは自動取得できない
  要件・意図などの背景情報をインラインで渡す（`local` / `pr` 両対応）。自動取得した
  情報を置き換えるのではなく、末尾に「補足コンテキスト（手動指定）」として併記され、
  全レビュー agent・検証ステップに伝播する。サニタイズは行われない（raw のまま渡る）。
- `--background-file, -B <path>`: 同内容をファイルから読み込む。読み込んだ内容は
  制御文字を除去したうえで 8000 字に切り詰めてから渡される（`--background` と異なり
  サニタイズされる）。`--background` と両方指定した場合は、インライン指定分が先、
  ファイル内容がその後に結合される。ファイルが読み込めない場合はエラー終了する。
- `--debug`: 各 LLM ステップの usage・コストなどをデバッグログとして標準エラーに出力する。

開発時（ビルドせず直接実行）:

```bash
pnpm dev -- local [--range [<range>]] [--background <text>] [--background-file <path>] [--debug]
pnpm dev -- pr <number> [--comment] [--background <text>] [--background-file <path>] [--debug]
```

## レビューの観点

diff に対して、以下の観点の LLM エージェントを並列に起動する（tier や `REVIEW.md` の有無に
応じて起動しないものもある）。

- **プロジェクトルール準拠**: `CLAUDE.md` と `.claude/rules/*.md` に書かれた規約への違反を
  監査する。
- **バグ検出**: diff に含まれるバグ・セキュリティ上の問題・パフォーマンス上の問題を検出する
  （tier によらず常に起動する）。
- **クラスタ横断のファイル整合性チェック**: 関連ファイル群（クラスタ）単位で、ファイル間の
  不整合を検出する。
- **`REVIEW.md` 準拠**: リポジトリのルート直下に `REVIEW.md` を置くと、そこに書かれた
  レビュー観点への違反を監査する（本体のコードを編集せずにレビュー観点を追加できる
  カスタマイズ手段）。ファイルが無ければこの観点はスキップされる。

tier（変更規模）に応じて起動するエージェント数自体も縮退する。

全レビュー系エージェント（agent1〜5）と検証ステップは、read-only ツール
（Read/Grep/Glob）＋ context7 MCP で diff 外のファイルや依存ライブラリの実仕様を
能動的に参照できる（作業ツリーを変更するツールは一切許可しない）。詳細は
後述の「外部参照ツール（レビュー精度優先）」を参照。

## 指摘の分類（カテゴリ・重要度）

各指摘には以下が付与され、出力・PR コメントの見出しに表示される。

| category | 表示 |
| --- | --- |
| `bug` | 🐛 Bug |
| `security` | 🔒 Security |
| `performance` | ⚡ Performance |
| `rule-violation` | 📋 Rule |

| severity | 表示 |
| --- | --- |
| `critical` | 🔴 |
| `high` | 🟠 |
| `medium` | 🟡 |
| `low` | ⚪ |

数値の confidence（信頼度スコア）は存在しない。確信度の低い指摘は、後述の検証ステップで
除外される。

## レビュー対象から除外されるファイル

以下は最初から読み込まれず、レビュー対象にならない（除外されたファイルは実行結果に一覧
表示される）。

- minify・sourcemap（`*.min.js` / `*.min.css` / `*.map` など）、`dist`・`build` 配下、
  画像・フォント・アーカイブ・メディアファイル（**SVG はテキストとして扱われ除外されない**）。
- `.gitattributes` で `linguist-generated`（および vendored/documentation 指定）とされた
  ファイル。
- 1 ファイルの変更行数が `CODE_REVIEW_OVERSIZED_MAX_LINES`（既定 1000）を超えるファイル
  （`oversizedFiles` として除外）。

なお lockfile やスナップショットファイルは対象外にせず、通常どおりレビュー対象に含める
（意図的な仕様）。

## 検証と結果の絞り込み

各エージェントが出した指摘は、最後に別の LLM による検証ステップにかけられ、
**確認できた（confirmed）指摘のみ**が最終結果に残る。棄却（rejected）・未検証
（unverified）の指摘は最終結果から除外される。検証エージェントは Read/Grep/Glob
ツールで対象ファイルの実コードを確認したうえで判定し、既存問題・lint 相当の指摘・
プロジェクトルールに無い一般論などは誤検知として棄却する。

- `local` では confirmed の指摘が 1 件以上あると終了コード 1 を返す（CI での失敗判定に
  利用できる）。
- `pr --comment` では、行番号が一意に解決できた confirmed 指摘のみがインラインコメントに
  なり、解決できないものはサマリ本文にまとめて記載される。インラインコメントの本文冒頭には
  カテゴリ/重要度バッジと対象行へのパーマリンクが 2 行で付与される。
- コード修正提案（suggestion）は、複数指摘のマージによるものだったり既存コードを意図せず
  削除してしまう可能性がある場合、事故防止のため自動的に文章のみのコメントへ変換される。
- 投稿は `gh api` 経由で行われる（PR への一括投稿）。

## 外部参照ツール（レビュー精度優先）

全レビュー系エージェント（agent1〜5）と検証ステップは、diff だけでなく実コードや
依存ライブラリの実仕様にも当たれるようにしている（レビューでは決定論性よりレビュー精度を
優先する方針）。

| ツール | 既定 | 制御 env |
| --- | --- | --- |
| Read/Grep/Glob | ON（常時） | なし |
| context7 MCP | ON | `CODE_REVIEW_DISABLE_CONTEXT7=1`（または `=true`）で無効化 |
| WebFetch/WebSearch | OFF | `CODE_REVIEW_ENABLE_WEB=1`（または `=true`）で有効化 |

- **Read/Grep/Glob** は常時有効。呼び出し元・型定義・関連ファイルなど diff 外のコードを
  確認したうえで指摘の妥当性を判断する（完全ローカルでネットワーク依存なし）。
- **context7 MCP** は既定で有効。依存ライブラリの API 仕様（非推奨・引数変更など）を
  実際に確認し、誤検知を減らす。初回起動時に `npx -y @upstash/context7-mcp` を実行するため、
  初回ダウンロードとネットワーク接続が必要。CI・オフライン環境や context7 未導入環境では
  `CODE_REVIEW_DISABLE_CONTEXT7=1`（`1` または `true`、大小文字無視で受理）を設定して
  無効化することを推奨する。
- **WebFetch/WebSearch** は既定で無効（opt-in）。任意の Web ページ本文がレビュー判定に
  混ざるため、ノイズやプロンプトインジェクションのリスクを踏まえて明示的に
  `CODE_REVIEW_ENABLE_WEB=1`（`1` または `true`、大小文字無視で受理）を設定したときのみ
  有効になる。
- ツール呼び出しの有無によって同一 diff でもレビュー結果が変わりうる（決定論性は下がる）。
  本ツールは「位置解決・検証・フィルタ適用・構造転写はコードで行う」設計原則自体は維持しつつ、
  意味判断（バグかどうか等）の精度を優先している。

## 認証の仕組み

内部で `@anthropic-ai/claude-agent-sdk` が `claude` CLI を起動し、その CLI が解決した認証を
そのまま継承する。このツール自体は認証情報を明示的に渡さないため、`claude` CLI が利用できる
認証方式（OAuth ログイン / `CLAUDE_CODE_OAUTH_TOKEN` などのトークン環境変数 /
`ANTHROPIC_API_KEY` などの API キー環境変数）のいずれでも動作する。

事前に `claude` CLI でログイン済みか、対応する認証用の環境変数が設定されていれば動く。

## env 上書き一覧（`CODE_REVIEW_*`）

変更規模の分類（tier）としきい値、および使用するモデルエイリアスは環境変数で
上書きできる（プロンプト自体は変更不要）。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CODE_REVIEW_SMALL_MAX_FILES` | 5 | tier=small と判定する最大ファイル数 |
| `CODE_REVIEW_SMALL_MAX_LINES` | 150 | tier=small と判定する最大変更行数 |
| `CODE_REVIEW_OVERSIZED_MAX_LINES` | 1000 | 1ファイルの変更行数がこれを超えるとレビュー対象から除外（oversizedFiles） |
| `CODE_REVIEW_MODEL_LIGHT` | `sonnet` | 軽量ステップ（agent1/2/5・rule 検証・要約/マージ等）で使うモデルエイリアス |
| `CODE_REVIEW_MODEL_HEAVY` | `sonnet` | 重量ステップ（agent3/4・bug 検証）で使うモデルエイリアス |
| `CODE_REVIEW_DISABLE_CONTEXT7` | 未設定（有効） | `1`（または `true`、大小文字無視）で全レビュー系ステップの context7 MCP を無効化 |
| `CODE_REVIEW_ENABLE_WEB` | 未設定（無効） | `1`（または `true`、大小文字無視）で全レビュー系ステップに WebFetch/WebSearch を追加 |

tier に応じて起動する LLM エージェントの数が変わる（small ほど少ない）。

## 設計上の特徴

- **決定論オーケストレーション**: 行番号解決・finding のフィルタ/グルーピング・merge/verdict
  の適用・PR コメントのバッジ/パーマリンク付与など、位置解決や構造転写を要する処理はすべて
  TypeScript の純関数が担う。LLM には「意味判断」（バグかどうか、文章をどう書くか）のみを
  任せる。
- **コスト削減**: オーケストレーション相当の LLM ターンが無いため、同一 diff に対する
  トークン消費・LLM 呼び出し回数を抑えられる。tier=small ではさらにサマリ生成用の LLM
  呼び出しも省略する。
- **データ構造の一貫性**: Finding/Group/Issue などのデータ契約が各処理ステップを通じて
  一貫したフィールド名で受け渡され、挙動の回帰を避けている。

## 開発

```bash
pnpm test        # vitest run
pnpm test:watch
pnpm lint         # biome check（非破壊）
pnpm format       # biome check --write（自動修正）
```
