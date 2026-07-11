# code-review を Claude Agent SDK で TypeScript 再実装 — 全体概要

## Context（なぜ作るか）

既存の [aki77/claude-plugins の code-review プラグイン](https://github.com/aki77/claude-plugins/tree/main/plugins/code-review) は、Claude Code の SKILL（`review-core.md` の手順書）を「メインエージェント＋サブエージェント」が一字一句なぞって実行し、位置解決・グルーピング・検証適用・投稿などの決定論的処理を `.mjs` スクリプトに逃がす構造になっている。

この構造には2つの弱点がある:

1. **コスト**: オーケストレーション（ステップ順序制御・成果物受け渡し・並列起動判断）まで LLM（メインエージェント）が担うため、手順書の読解・判断に大量のトークンを消費する。しかもその判断は本質的に決定論的（step1→step2→…と順に流すだけ）で、LLM に任せる必要がない。
2. **非決定性**: 「並列 Agent 呼び出しを1メッセージにまとめる」「background 起動を避ける」等、手順書で厳しく縛っても LLM 依存のため崩れうる（`review-core.md` が denial ループ回避に多大な記述を割いている）。

**目的**: オーケストレーションを TypeScript コードで決定論的に書き、LLM 呼び出しを「意味判断が必要な箇所（サマリ/クラスタ分割・レビュー分析・課題検証・統合文章・コメント本文）」だけに限定する。これによりコスト削減とステップ処理の決定論化を両立する。

**設計原則は既存を踏襲**: 「LLM は意味判断のみ、位置解決・検証・フィルタ適用・構造転写はコード」（alibaba/open-code-review 由来、`review-core.md:7`）。

## 認証方針（最優先の制約）

- ユーザーは **Claude Code のサブスクリプション（OAuth）ログイン状態のまま、APIキーなしで**動かす必要がある。
- 現状確認済み: `ANTHROPIC_API_KEY` は unset、`claude` CLI 2.1.205 がインストール済み、`~/.claude/.credentials.json`（OAuth 認証）あり。
- **`@anthropic-ai/claude-agent-sdk` を採用する**。これは内部で `claude` CLI バイナリを起動するため、CLI がログイン済みなら OAuth 認証を継承して APIキーなしで動作する（このセッション自身が動いている仕組みと同じ）。
- **`@anthropic-ai/sdk`（Messages API）は採用しない** — こちらは `ANTHROPIC_API_KEY` 必須で、サブスク認証を継承できないため要件を満たさない。
  - トレードオフ: Agent SDK 経由の LLM 呼び出しは Messages API 直接より若干オーバーヘッドがあるが、認証要件が最優先のため許容する。
- LLM 呼び出しは `query()` で `allowedTools: []`（ツール禁止）＋ system prompt で JSON 強制し、決定論コードから diff 等のコンテキストを prompt に埋め込んで渡す（＝ LLM にコンテキスト収集させない）。

## スコープ

**両モードを実装する**（既存の local-review / pr-review 相当）:
- `local-review`: ローカル git 差分（staged / range）をレビュー → ターミナルにサマリ出力。GitHub 投稿なし。
- `pr-review`: GitHub PR を取得 → レビュー → `--comment` 指定時にインラインコメント一括投稿。

## 全体アーキテクチャ

```
[TypeScript orchestrator（決定論）]
  step1  collectContext()            → CTX     （純コード: git/gh, ファイル分類, tier, ルール割当）
  step2  llmSummaryAndClusters()     → summary/clusters （LLM: query 1回, JSON）
  step2b validateClusters()          → CLUSTERS （純コード: 移植）
  step3  llmReviewAgents()           → findings[] （LLM: query を観点ごとに並列, JSON）
  step4  processFindings()           → FINDINGS （純コード: 移植, ID/scope/anchor/grouping）
  step5  llmMergeTexts()             → mergeTexts （LLM: needsMergeText グループのみ, JSON）
  step5b mergeFindings()             → ISSUES   （純コード: 移植, 構造転写）
  step6  llmVerifyIssues()           → verdicts （LLM: issue ごとに並列, JSON）
  step7  applyVerdicts()             → FINAL    （純コード: 移植）
  step8  printSummary()              →          （純コード: ターミナル出力）
  step9  llmCommentBodies()          → comments （LLM: pr-review --comment 時のみ, JSON）
  step10 postReview()                →          （純コード: 移植 + gh api 投稿）
```

- **成果物はメモリ上のオブジェクトで受け渡す**（既存の「一時ファイル＋パス渡し＋jq」は headless の Bash 制約回避のためで、TS コードでは不要 → 大幅に単純化）。
- 並列化は `Promise.all` で TS が制御（既存の「1メッセージに複数 Agent をまとめる」制約が構造的に不要になる）。

## データ構造契約（既存を厳守・移植先で型付けするのみ）

既存スクリプトの各フィールド名を変えない。既存インラインテストを仕様書として vitest に移植し回帰を防ぐ。

- **finding**（`process-findings.mjs` 出力）: `id`(f1..), `agent`(1-5), `path`, `title`, `body`, `existingCode`, `ruleRefs`, `kind`("bug"|"rule"), `category`("bug"|"security"|"performance"|"rule-violation"), `severity`("critical"|"high"|"medium"|"low"), `status`("active"|"invalid"|"out-of-scope"), `params`|`reason`（相互排他）, `groupId`。
- **group**: `id`(g1..), `path`, `kind`, `category`, `severity`, `resolved`, `memberIds`, `needsMergeText`(members≥2), `params`|`reason`。
- **issue**（`merge-findings.mjs` 出力）: `id`, `path`, `kind`, `category`, `severity`, `title`, `body`, `ruleRefs`, `existingCode`, `resolved`, `sourceFindingIds`, `params`|`reason`。
- **verdict**（step6 入力）: `id`, `verdict`("confirmed"|"rejected"), `reason`。
- **final**（`apply-verdicts.mjs` 出力）: `issues`(confirmed), `rejected`, `unverified`, `stats`。
- **アンカー不変**: LLM は `existingCode`（diff 中の実在コード片）だけを出力、行番号は `resolveAnchor` で確定（`diff-anchor.mjs`）。LLM に行番号を推測させない（既存の核心、`README.md:10`）。

## 参照元

`/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/` の各 `.mjs`。

## フェーズ一覧

| Phase | ファイル | 内容 | LLM 依存 |
|---|---|---|---|
| 1 | `01-project-setup.md` | プロジェクト初期化（package.json/tsconfig/vitest/CLI 骨格） | なし |
| 2 | `02-pure-logic-port.md` | 決定論ロジックの TS 移植＋テスト移植 | なし |
| 3 | `03-auth-smoke-test.md` | 認証スモークテスト（OAuth 継承検証） | あり（肝） |
| 4 | `04-llm-steps.md` | LLM ステップ＋オーケストレータ、local-review E2E | あり |
| 5 | `05-pr-review-and-wrapup.md` | pr-review 投稿・コスト比較・ドキュメント | あり |

**推奨順序**: 1 → 2（LLM 不要でテスト通過）→ 3（要件の肝を早期に潰す）→ 4 → 5。
