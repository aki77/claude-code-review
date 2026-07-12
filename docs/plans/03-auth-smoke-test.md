# Phase 3: 認証スモークテスト（要件の肝）

前提: `00-overview.md` の認証方針。このフェーズは **プロジェクト全体の成否を左右する肝**。Phase 4 の LLM 実装に入る前に、`@anthropic-ai/claude-agent-sdk` の `query()` が **APIキーなし・Claude Code の OAuth 認証継承**で動くことを実機確認する。

## なぜ最優先か

- 「サブスクログインのまま APIキーなしで動く」がユーザーの必須要件。
- Agent SDK は内部で `claude` CLI を起動するため OAuth を継承できる見込みだが、**未検証の前提**。ここが崩れると設計全体（SDK 選定）をやり直す必要があるため、LLM ステップを作り込む前に潰す。

## 作業内容

### `src/llm/client.ts`（このフェーズで最小版を作る）
`runStructured<T>(opts): Promise<T>` を実装:
- 入力: `{ system: string; user: string; model?: string; schema?: JSONSchema }`。
- `query({ prompt, options })` を呼ぶ。options:
  - `allowedTools: []`（ツール一切禁止 = 純粋なテキスト生成に限定）。
  - `settingSources: []`（プロジェクト/ユーザー設定を読み込ませない → 決定論性・余計なコンテキスト排除）。
  - `permissionMode: 'default'`。
  - `systemPrompt`: 「JSON のみを出力。前置き・コードフェンス禁止」を明示。
  - `model`: 指定があれば渡す。
- `for await (const message of query(...))` で最終 `result` メッセージを取得し、JSON パース。
- パース失敗時は1回だけリトライ（「前回出力が不正 JSON。JSON のみ再出力」を追記）。
- Agent SDK が `outputFormat`/structured output を安定サポートしていれば併用。**未確定のため、まず system prompt での JSON 強制＋パースを既定線とし、outputFormat が使えるならスモークテスト内で検証して採否を決める**。

### スモークテスト `tests/auth-smoke.test.ts`（または手動スクリプト）
- 環境: `ANTHROPIC_API_KEY` を **unset のまま**実行（現状すでに unset）。
- 簡単な構造化タスク（例: `{ "answer": 2 }` を返させる "1+1は？ JSONで answer に数値" ）を `runStructured` で1回叩く。
- 検証:
  1. 例外なく `result` が返る（＝ OAuth 継承で認証が通った）。
  2. JSON パースが成功する。
  3. usage（トークン数）が取得できるなら記録（Phase 5 のコスト比較の土台）。
- **注意**: これは実 API を叩くため、CI では skip 可能なタグを付ける（`describe.skipIf(!process.env.RUN_LIVE)` 等）。ローカルでは明示フラグで実行。

## 完了条件（判断ポイント）

- **成功**: APIキー unset のまま JSON が返る → 設計確定、Phase 4 へ。
- **失敗**（APIキーを要求される等）: ここで方針を再検討する。フォールバック候補:
  1. `query()` のオプション/環境変数で CLI 認証を明示継承する方法を調査（`claude` CLI が使う認証パスの環境変数など）。
  2. それでも不可なら、`claude` CLI を直接 `execFile` で `claude -p <prompt> --output-format json` 相当で起動するラッパに切り替える（SDK を介さず CLI 直叩き。認証は確実に継承される）。
  - この分岐はユーザーに報告・相談してから進める。

## 成果物

- 動作する `src/llm/client.ts`（最小版、Phase 4 で機能追加）。
- 認証継承が確認できたことのメモ（usage 実測値含む）。

## 実施結果（確定事項）

- **結論: 成功**。`ANTHROPIC_API_KEY` unset のまま `query()` が `claude` CLI の OAuth ログイン
  状態を継承して動作することを実機確認した。設計（SDK 選定）を維持し Phase 4 へ進む。
- `outputFormat: json_schema` を**第一選択**とし、使えない・`schema` 未指定のときは
  system prompt での JSON 強制＋パース（`JSON.parse` 失敗時1回だけリトライ）に**自動
  フォールバック**する方式を採用した（`runStructured` 内で分岐）。
- **outputFormat の採否結論**: 安定して使えた。`structured_output` に検証済みオブジェクトが
  直接入り、`JSON.parse` 不要でパース失敗の心配がない。今後 schema を用意できる呼び出し側
  では outputFormat 経路を優先する。
- スモークテスト実測値（`env -u ANTHROPIC_API_KEY RUN_LIVE=1 pnpm test tests/auth-smoke.test.ts`、
  2026-07-12 実行、両ケースとも `answer === 2` で pass）:
  - outputFormat 経路: `output_tokens: 66` / `total_cost_usd: 0.0131`
  - system prompt 強制経路: `output_tokens: 10` / `total_cost_usd: 0.0110`
  - いずれも `cache_read_input_tokens` が 20000+ あり、プロンプトキャッシュが効いている
    （system prompt 側のオーバーヘッドが以降の呼び出しで軽減される見込み）。
