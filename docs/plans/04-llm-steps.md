# Phase 4: LLM ステップとオーケストレータ（local-review E2E）

前提: `00-overview.md`（アーキテクチャ・データ契約）、Phase 2（純コード）、Phase 3（`runStructured` 認証確認済み）。このフェーズで local-review をエンドツーエンドで通す。

参照元プロンプト: `review-core.md`（step2/3/5/6）, `pr-review/SKILL.md`（step9）。

## ゴール

`node dist/cli.js local`（staged 変更）で step1〜8 が最後まで通り、ターミナルに confirmed/rejected/unverified・tier を含むサマリが出る。

## 作業内容

### `src/llm/prompts.ts`
各 LLM ステップの system/user prompt テンプレートを `review-core.md` から移植:
- **step2 サマリ/クラスタ分割**（`review-core.md:60-73`）: 変更のサマリ（意図・全体像）＋影響クラスタ分割案。出力 JSON: `{ summary: string, clusters: Cluster[] }`。
- **step3 レビュー観点**（`review-core.md:81-131`）:
  - agent1/2: プロジェクトルール（CLAUDE.md / `.claude/rules/`）準拠チェック。
  - agent3: バグ検出（diff 限定）。
  - agent4: バグ検出/クロスファイル整合性（クラスタごと）。
  - agent5: REVIEW.md 準拠チェック。
  - 各出力 JSON: finding 配列（`agent`, `path`, `title`, `body`, `existingCode`, `ruleRefs?`, `category`, `severity`）。**行番号は出させない**（existingCode のみ）。
- **step5 統合文章**（`review-core.md:178-180`）: 複数メンバーグループの `{ title, body }`。
- **step6 検証**（`review-core.md:184-193`）: issue ごとに confirmed/rejected 判定。出力 JSON: `{ verdict, reason }`。

### `src/llm/steps.ts`
- `llmSummaryAndClusters(ctx, diff)` → step2。
- `llmReviewAgents({ ctx, assignments, diff, clusters, summary })` → step3:
  - 観点（agent 1〜5）ごとに `runStructured` を **`Promise.all` で並列**起動。
  - agent4 はクラスタごとに複数インスタンスを並列。
  - tier による縮退: tiny は agent3 を起動しない・単一クラスタ、small は単一クラスタ（`review-core.md:36,52-54,88`）。
  - **local-review 特有**: 全 agent が step2 の summary 完了を待つ（summary が唯一の著者意図情報。tiny でも summary は起動、clusters は `[]`）。
  - finding 配列（全 agent 分をフラット結合）を返す。
- `llmMergeTexts(groups)` → step5: `needsMergeText:true` グループのみ `Promise.all` 並列。
- `llmVerifyIssues(issues, diff)` → step6: issue ごとに `Promise.all` 並列（bug 系は上位モデル、rule 系は軽量モデル）。confirmed/rejected を返す。

### モデル使い分け（`review-core.md:206-212` 踏襲）
- レビュー agent1/2/5・rule 検証: 軽量モデル（Sonnet 相当）。
- レビュー agent3/4・bug 検証: 上位モデル（Opus 相当）。
- `runStructured` の `model` オプションで指定。

### 障害時の縮退（TS の分岐で表現）
- LLM ステップ失敗は「1回だけリトライ」（`runStructured` 内）＋なお失敗なら該当分をスキップ（空扱いで step4 の入力から外す）。
- step2 失敗 → clusters 空 → validateClusters が単一クラスタへ縮退。
- step6 検証失敗の issue → step7 で unverified。

### `src/pipeline.ts`（オーケストレータ）
step1〜8 を順に呼ぶ:
```
ctx = collectContext(mode, opts)
diff = git diff (buildDiffArgs(ctx))
{summary, rawClusters} = await llmSummaryAndClusters(ctx, diff)
clusters = validateClusters/tierReducedClusters(rawClusters, ctx)
findings = await llmReviewAgents({ctx, assignments: ctx.assignments, diff, clusters, summary})
findingsDoc = processFindings(ctx, findings, diff)
// step4b: 未解決アンカーの再解決（今回は自動リトライ or スキップ。まず簡易版で可）
mergeTexts = await llmMergeTexts(findingsDoc.groups.filter(needsMergeText))
issuesDoc = mergeFindings(findingsDoc, mergeTexts)
verdicts = await llmVerifyIssues(issuesDoc.issues, diff)
finalDoc = applyVerdicts(issuesDoc, verdicts)
printSummary(finalDoc, ctx)   // step8
```
- `--debug` で各中間オブジェクトを JSON でログ出力（トラブルシュート用）。

### `src/report.ts`（step8, `review-core.md:197-204`）
- 表示ソースは FINAL 固定。confirmed を `[category · severity]` バッジ付き一覧。resolved:true は `path:line` 添付。
- rejected/unverified の件数を明示（黙って消さない）。
- 課題ゼロなら「問題は見つかりませんでした」。
- 末尾に excludedFiles/oversizedFiles/tier 縮退を明示。

### `src/cli.ts`
- `local` サブコマンドを pipeline に接続。`--range [<range>]`（省略時 staged 自動判別）、`--debug`。

## 検証（E2E）

1. このリポジトリで staged 変更を作る（適当なファイル追加/編集を `git add`）。
2. `npm run build && node dist/cli.js local --debug` を実行。
3. 確認:
   - 全ステップが例外なく完走。
   - 中間ログで findings→groups→issues→final の変換が妥当。
   - ターミナルサマリに confirmed/rejected/unverified 件数・tier が出る。
   - 意図的に明白なバグ（例: null 参照）を仕込み、検出→confirmed されるか確認。

## 完了条件

- local-review が staged/range 両方で完走しサマリ出力。
- 純コードのテストは引き続き green（LLM 追加で壊していない）。
