# claude-code-review スキル

`@aki77/claude-code-review` CLI を `pnpx` 経由で実行し、レビュー結果を要約するスキル。
**local（作業ツリーの未コミット変更、無ければ base ブランチとの差分）専用**で、
ブランチ名を渡せばそのブランチとの差分をレビューできる。`--fix` を付けると、確認済み
（confirmed）の指摘が 0 件になるまでレビューと修正を自動で往復する。挙動の詳細
（終了コードの扱い・サマリ形式・修正フェーズの停止基準など）は
[SKILL.md](./SKILL.md) を参照。

前提として、本体 CLI（`@aki77/claude-code-review`）は `pnpx`/`npx` 経由でその場実行され、
事前インストールは不要。ただし [Claude Code](https://github.com/anthropics/claude-code)
CLI にログイン済みであることが必要。

## インストール方法

以下の3つはどれも並列の選択肢で、優劣はない。使い慣れたツールを選べばよい。

### `gh skill install`

[GitHub CLI](https://cli.github.com/)（v2.90.0 以降）に組み込みのコマンド。追加の
インストール手順は不要。

```bash
gh skill install aki77/claude-code-review skills/claude-code-review
```

### `npx skills add`

npm パッケージ [`skills`](https://www.npmjs.com/package/skills)（Vercel Labs 製）を
`npx` 経由でその場実行する。グローバルインストール不要。GitHub の完全 URL
（`tree/<branch>/<path>` 形式）でサブディレクトリを指定する。

```bash
npx skills add https://github.com/aki77/claude-code-review/tree/main/skills/claude-code-review
```

### `apm install`

Microsoft 製 Agent Package Manager (APM)。`owner/repo/<path>` 形式でサブディレクトリを
直接指定する。

```bash
apm install aki77/claude-code-review/skills/claude-code-review
```

## 手動インストール（フォールバック）

上記3ツールのいずれも使わない場合は、[`skills/claude-code-review/SKILL.md`](./SKILL.md)
を自分のプロジェクトの `.claude/skills/claude-code-review/` にコピーするだけでよい。
