# claude-code-review

Claude Agent SDK を使ったコードレビュー CLI。

## 使い方

```
code-review local [--range [<range>]] [--debug]
code-review pr <number> [--comment] [--debug]
```

- `local`: ローカルの差分をレビューする（`--range` 省略時は staged を自動判別）
- `pr <number>`: 指定した PR をレビューする（`--comment` で結果を PR にインラインコメントとして投稿）

事前に Claude Code へのログインが完了している必要があります。

詳細は Phase 5 で拡充予定。
