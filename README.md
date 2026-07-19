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
npx @aki77/claude-code-review -- local [--range [<range>]] [--crit] [--debug]
npx @aki77/claude-code-review -- pr <number> [--comment] [--crit] [--debug]
```

サブコマンドへの引数を渡すには `--` 区切りが必要。

## 開発者向け: セットアップ

```bash
pnpm install
pnpm build
```

## 使い方

```
code-review local [--range [<range>]] [--crit] [--background <text>] [--background-file <path>] [--summary-file <path>] [--no-fail-on-findings] [--debug]
code-review pr <number> [--comment] [--crit] [--background <text>] [--background-file <path>] [--summary-file <path>] [--no-fail-on-findings] [--debug]
```

- `local`: ローカルの差分をレビューする。
  - `--range` を省略した場合（引数なし実行、および `--range` のみで値を省略した場合を含む）は
    **workspace モード**になる。作業ツリーの未コミット変更全体
    （staged + unstaged + untracked）を、一時 `GIT_INDEX_FILE` 経由で単一の統一 diff として
    扱う（実 index・作業ツリーは一切変更しない）。untracked ファイルも new file 追加として
    diff に含まれる。未コミット変更が **1 件もない**（すべてコミット済み）場合は、**base
    ブランチとの差分に自動フォールバック**してレビューする。フォールバック時の base 解決は
    下記（`--range` 明示時と同じ `github-pr-base-branch` → `vscode-merge-base` →
    `@{upstream}` → `origin/HEAD` の順）を使う。この場合の出力は workspace ではなく range
    扱いになり、サマリ先頭付近に
    `未コミット変更なし → base 差分（<range>）をレビューしました。` が表示される。
  - `--range <range>` で明示的にレビュー対象範囲を指定できる（`..` を含まなければ
    `<range>...HEAD` に補完される）。`--range` 明示指定時、および workspace モードで
    未コミット変更が空だったフォールバック時に、現在のブランチの base の自動解決
    （`branch.<name>.github-pr-base-branch` → `vscode-merge-base` →
    `@{upstream}` → `origin/HEAD` の順にフォールバック）が使われる
    （`<range>` に `..` を含まない base 名だけを渡した場合の補完処理）。
- `pr <number>`: 指定した PR をレビューする。
  - ローカルの HEAD が PR の HEAD と一致していない場合は、LLM を呼ぶ前にエラー終了する
    （対象 PR のブランチをチェックアウトしてから再実行する）。
  - `--comment` を付けると、レビュー結果を PR にインラインコメントとして一括投稿する
    （`gh api` 経由）。付けない場合はサマリを標準出力するのみで、投稿・追加の LLM 呼び出しは
    発生しない。
- `--crit`: [crit](https://github.com/) 連携用に、レビュー結果を
  `[{ "file", "line", "body" }, ...]` の JSON 配列として標準出力に出力する（`local` / `pr`
  両対応）。`crit comment --json` がそのまま受け取れる形式。`line` は単一行なら数値 `42`、
  複数行なら文字列 `"50-55"`。`body` は `--comment` の PR インラインコメントと同一
  （カテゴリ/重要度バッジ ＋ LLM 生成の説明文 ＋ GitHub 形式の ` ```suggestion ` フェンス）。
  `--crit` 指定時は投稿用と同じ本文生成（`llmCommentBodies`）を走らせるため追加の LLM
  コストが発生する。行番号を確定できなかった（インライン不可の）指摘は crit 出力に含めない。
  出力を crit JSON のみに保つため、`--crit` 時はサマリ表示（`printSummary`）と `posted:` 行を
  抑制する（進捗表示は元々標準エラー）。終了コードは通常時と変わらない。`pr` で `--comment` と
  `--crit` を同時指定しても、本文生成の LLM 呼び出しは 1 回だけ（投稿と crit 出力で使い回す）。

  ```bash
  # crit へ直接パイプで流し込む
  code-review pr 123 --crit | crit comment --json --author code-review

  # ファイルに落としてから取り込む
  code-review local --range HEAD~1 --crit > review.json
  crit comment --json --file review.json --author code-review
  ```
- `--background, -b <text>`: コミットメッセージや PR 説明からは自動取得できない
  要件・意図などの背景情報をインラインで渡す（`local` / `pr` 両対応）。自動取得した
  情報を置き換えるのではなく、末尾に「補足コンテキスト（手動指定）」として併記され、
  全レビュー agent・検証ステップに伝播する。サニタイズは行われない（raw のまま渡る）。
- `--background-file, -B <path>`: 同内容をファイルから読み込む。読み込んだ内容は
  制御文字を除去したうえで 8000 字に切り詰めてから渡される（`--background` と異なり
  サニタイズされる）。`--background` と両方指定した場合は、インライン指定分が先、
  ファイル内容がその後に結合される。ファイルが読み込めない場合はエラー終了する。
- `--summary-file <path>`: レビュー結果＋実行メタ情報（対象 PR/コミット・変更規模 tier・
  対象外ファイル・LLM コスト・投稿先 URL）を Markdown に整形して指定パスに**追記**する
  （GitHub Actions の `$GITHUB_STEP_SUMMARY` 向け）。複数ステップが同じファイルに書き込む
  前提のため常に append で、既存ファイルを上書きしない。`--debug` を併用すると、各段の
  中間成果物（ctx / summary / findings / verdicts / cost-summary …）を `<details>` 折りたたみ
  として末尾に追加で出力する。`--debug` 単体（`--summary-file` なし）の挙動（stderr への生ログ
  出力）は変わらない。書き込みに失敗した場合は警告を標準エラーに出すのみで、レビュー自体の
  終了コードには影響しない。
- `--no-fail-on-findings`: confirmed 指摘が 1 件以上あっても終了コードを 0 にする
  （`local` / `pr` 両対応）。本当のエラー（例外・PR HEAD 不一致など）の終了コードは
  この影響を受けず、従来どおり `2`（中断時は `130`）のまま返る。GitHub Actions で
  「指摘ありは成功扱い・エラー時のみステップ失敗」にしたい場合に使う（後述）。
- `--debug`: 各 LLM ステップの usage・コストなどをデバッグログとして標準エラーに出力する。
  解決後の設定値（`config`）とどの設定ファイルが読まれたか（`config:source`。
  `.claude/review.yaml`/`.yml` のどちらか、またはどちらも見つからず既定値のみか）、
  検証ステップ（step6）に実際に渡された system プロンプト本文（`verify:system`。
  `falsePositiveExclusions` の解決結果が埋め込まれているか確認できる）も出力する。

開発時（ビルドせず直接実行）:

```bash
pnpm dev -- local [--range [<range>]] [--crit] [--background <text>] [--background-file <path>] [--summary-file <path>] [--no-fail-on-findings] [--debug]
pnpm dev -- pr <number> [--comment] [--crit] [--background <text>] [--background-file <path>] [--summary-file <path>] [--no-fail-on-findings] [--debug]
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
  利用できる）。`--no-fail-on-findings` を付けると、指摘があっても終了コードは 0 になる
  （エラー終了時の `2`／中断時の `130` は変わらない）。`1` は「confirmed 指摘あり」専用の
  シグナルで、レビュー自体の失敗（例外）や引数エラーとは `2` で区別される。
- `pr --comment` では、行番号が一意に解決できた confirmed 指摘のみがインラインコメントに
  なり、解決できないものはサマリ本文にまとめて記載される。インラインコメントの本文冒頭には
  カテゴリ/重要度バッジが付与される（この本文は `--crit` の出力と同一）。
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

## GitHub Actions での利用

`npx` 実行かつ `--summary-file "$GITHUB_STEP_SUMMARY"` を渡すだけで、PR へのインライン
コメント投稿とジョブサマリーへの Markdown 出力を1ステップで行える。

```yaml
name: Code Review

on:
  pull_request:

permissions:
  pull-requests: write
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # pull_request イベントは既定でマージコミットを ref にするため、
          # 対象 PR の HEAD を明示的にチェックアウトする（後述の HEAD 一致ゲート対応）。
          ref: ${{ github.event.pull_request.head.sha }}

      - run: npx @aki77/claude-code-review -- pr ${{ github.event.pull_request.number }} --comment --debug --summary-file "$GITHUB_STEP_SUMMARY" --no-fail-on-findings
        # --no-fail-on-findings により confirmed 指摘があっても exit 0 になる。
        # 本当のエラー（例外・PR HEAD 不一致など）は非0のままなので、
        # continue-on-error なしでも「エラー時のみステップ失敗」になる。
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          GH_TOKEN: ${{ github.token }}
          CODE_REVIEW_DISABLE_CONTEXT7: "1"
```

- **認証**: Claude 側は対話 OAuth ログインが CI では使えないため、`CLAUDE_CODE_OAUTH_TOKEN`
  を secret として渡す（詳細は後述の「認証の仕組み」）。GitHub 側は `gh` CLI が
  `GH_TOKEN`/`GITHUB_TOKEN` を自動で拾うため `GH_TOKEN: ${{ github.token }}` を渡すだけでよい。
- **permissions**: `--comment` で PR にレビューコメントを投稿するため `pull-requests: write`、
  チェックアウトのため `contents: read` が必要。
- **checkout の `ref`**: `pr` コマンドにはローカル HEAD と PR HEAD の一致を確認するゲートが
  あるため、`actions/checkout` で対象 PR の HEAD を明示的にチェックアウトする必要がある。
  `pull_request` イベントは既定でマージコミットをチェックアウトしてしまうため、上記のように
  `ref: ${{ github.event.pull_request.head.sha }}` を指定すること。
- **`CODE_REVIEW_DISABLE_CONTEXT7`**: context7 MCP は初回起動時に `npx -y
  @upstash/context7-mcp` のダウンロードとネットワーク接続が発生するため、CI では
  `CODE_REVIEW_DISABLE_CONTEXT7: "1"` を推奨する。
- **終了コード**: 既定では confirmed 指摘が 1 件以上あると exit 1 になりステップが失敗扱いに
  なる。`--no-fail-on-findings` を付けると指摘があっても exit 0 になり、本当のエラー
  （例外・PR HEAD 不一致など）だけが exit 2（中断時は 130）で残るため、区別できる。
  「exit 1 = confirmed 指摘あり」「exit 2 = レビュー自体の失敗」「130 = 中断」が明確に
  分離されているので、`$?` から失敗理由を判定できる。PR へのコメント投稿・
  `--summary-file` へのサマリー出力自体は、この exit より前に完了している。
  `continue-on-error: true` はエラーも含めて常にステップを成功扱いにしてしまうため、
  エラーを見逃したくない場合は `--no-fail-on-findings` を使うこと（上記の例を参照）。
- **`--debug` と `--summary-file` の役割の違い**: `--debug` 単体は各パイプライン段の中間成果物
  をトラブルシュート用の生ログとして標準エラーに出す（Markdown ではない）。`--summary-file` は
  レビュー結果＋実行メタを Markdown として整形し指定パスに出力する専用の口で、`--debug` と
  併用すると中間成果物も `<details>` 折りたたみとして追記される。

## 認証の仕組み

内部で `@anthropic-ai/claude-agent-sdk` が `claude` CLI を起動し、その CLI が解決した認証を
そのまま継承する。このツール自体は認証情報を明示的に渡さないため、`claude` CLI が利用できる
認証方式（OAuth ログイン / `CLAUDE_CODE_OAUTH_TOKEN` などのトークン環境変数 /
`ANTHROPIC_API_KEY` などの API キー環境変数）のいずれでも動作する。

事前に `claude` CLI でログイン済みか、対応する認証用の環境変数が設定されていれば動く。

## 設定（`.claude/review.yaml` + `CODE_REVIEW_*` env）

変更規模の分類（tier）としきい値・使用するモデルエイリアス・誤検知除外リストなどは
プロジェクトルートの `.claude/review.yaml`（省略可・全キー任意）と環境変数の両方で
上書きできる（プロンプト自体は変更不要）。

**優先順位は `env > YAML > 既定`**。env は「実行環境ごとの一時上書き」、YAML は
「プロジェクト単位の恒久設定」という位置づけ。`.claude/review.yaml` が無い場合は
全キーが既定値（env が設定されていればそちらが優先）で動く。YAML のパースに失敗した
場合も、レビュー自体は止めずに警告を出して既定値にフォールバックする。

設定ファイルは `.claude/review.yaml` と `.claude/review.yml` の両方の拡張子に対応する
（`.yaml` を優先探索し、両方存在する場合は `.yaml` が採用される）。実際にどちらが
読まれたか（あるいはどちらも見つからず既定値のみで動いているか）は `--debug` の
`config:source` 出力で確認できる。

### YAML の全キー

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/aki77/claude-code-review/main/schema/review.schema.json
models:
  light: sonnet   # agent1/2/5・rule 検証・要約/マージ等で使うモデルエイリアス
  heavy: sonnet   # agent3/4・bug 検証で使うモデルエイリアス
thresholds:
  smallMaxFiles: 5        # tier=small と判定する最大ファイル数
  smallMaxLines: 150      # tier=small と判定する最大変更行数
  oversizedMaxLines: 1000 # 1ファイルの変更行数がこれを超えるとレビュー対象から除外
tools:
  context7: true  # context7 MCP（依存ライブラリの実仕様確認用）を有効にするか
  web: false      # WebFetch/WebSearch を有効にするか
prompts:
  falsePositiveExclusions: |   # 検証ステップ(step6)の誤検知除外リストに追記する文言
    - この repo では XXX は誤検知として扱う
```

先頭の `# yaml-language-server: $schema=...` はエディタ（[redhat.vscode-yaml] 等）向けの
補完・typo 検出用の1行で、CLI 実行には不要。省いても動作に影響しない。

[redhat.vscode-yaml]: https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml

### 対応する環境変数

| 環境変数 | 対応する YAML キー | 既定値 | 説明 |
| --- | --- | --- | --- |
| `CODE_REVIEW_SMALL_MAX_FILES` | `thresholds.smallMaxFiles` | 5 | tier=small と判定する最大ファイル数 |
| `CODE_REVIEW_SMALL_MAX_LINES` | `thresholds.smallMaxLines` | 150 | tier=small と判定する最大変更行数 |
| `CODE_REVIEW_OVERSIZED_MAX_LINES` | `thresholds.oversizedMaxLines` | 1000 | 1ファイルの変更行数がこれを超えるとレビュー対象から除外（oversizedFiles） |
| `CODE_REVIEW_MODEL_LIGHT` | `models.light` | `sonnet` | 軽量ステップ（agent1/2/5・rule 検証・要約/マージ等）で使うモデルエイリアス |
| `CODE_REVIEW_MODEL_HEAVY` | `models.heavy` | `sonnet` | 重量ステップ（agent3/4・bug 検証）で使うモデルエイリアス |
| `CODE_REVIEW_DISABLE_CONTEXT7` | `tools.context7`（極性が逆） | 未設定（有効） | `1`（または `true`、大小文字無視）で全レビュー系ステップの context7 MCP を無効化 |
| `CODE_REVIEW_ENABLE_WEB` | `tools.web` | 未設定（無効） | `1`（または `true`、大小文字無視）で全レビュー系ステップに WebFetch/WebSearch を追加 |

`CODE_REVIEW_DISABLE_CONTEXT7` は「無効化フラグ」、YAML の `tools.context7` は
「有効化フラグ」で極性が逆な点に注意（env が設定されていれば YAML の値に関わらず
`!isEnvTruthy(env)` が優先される）。

tier に応じて起動する LLM エージェントの数が変わる（small ほど少ない）。

### 誤検知除外リストのカスタマイズ（`prompts.falsePositiveExclusions`）

検証ステップ（step6）が使う誤検知除外リストは、プロジェクトごとにカスタマイズできる。
指定方法は3通り（`mode` 省略時は既定で `append`＝リストへの追記）:

```yaml
prompts:
  # 1. インライン文字列（最短記法。既定文言へ追記される）
  falsePositiveExclusions: |
    - この repo では XXX は誤検知として扱う

  # 2. { text, mode } 形式（mode: replace で完全に差し替え）
  falsePositiveExclusions:
    text: "このプロジェクトでは以下のみを誤検知として扱う: ..."
    mode: replace

  # 3. { file, mode } 形式（プロジェクト相対の .md 等を読み込む）
  falsePositiveExclusions:
    file: .claude/false-positive-exclusions.md
    mode: append
```

## 設計上の特徴

- **決定論オーケストレーション**: 行番号解決・finding のフィルタ/グルーピング・merge/verdict
  の適用・PR コメントのバッジ付与など、位置解決や構造転写を要する処理はすべて
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
