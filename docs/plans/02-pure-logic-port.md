# Phase 2: 決定論ロジックの TypeScript 移植

前提: `00-overview.md` のデータ構造契約を厳守。このフェーズは **LLM 非依存**で、既存 `.mjs` の純粋関数を `.ts` 化し、インラインテストを vitest に移植する。ここまでで LLM なしにテストが全部通る状態を作る。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/`

## ゴール

既存の決定論スクリプトを型付き TypeScript に移植し、既存インラインテストの移植版がすべて green になる。

## 移植対象（リスクが低い順）

### 1. `src/lib/diff-anchor.ts` ← `scripts/lib/diff-anchor.mjs`
- 関数: `parseDiff`, `normalizeLine`, `splitAndNormalize`, `sideLines`, `matchConsecutive`, `resolveAnchor`, `buildDiffArgs`。FS 非依存の純ロジック。
- 型: `DiffLine { text; oldLine: number|null; newLine: number|null }`, `Hunk { lines: DiffLine[] }`, `FilesByPath = Map<string, Hunk[]>`, `AnchorResult`（resolved:true 時 `params`, false 時 `reason`）。
- テスト: `diff-anchor.mjs:188-369` の全ケースを `tests/diff-anchor.test.ts` に移植（新規ファイル diff、count 省略ヘッダ、範囲アンカー、単一行、正規化、不一致、複数一致=曖昧、差分外ファイル、削除行=old側、非ASCIIパス、buildDiffArgs 3種）。

### 2. `src/lib/process-findings.ts` ← `scripts/process-findings.mjs`
- finding スキーマ検証（`validateFinding`）、ID 付与、`deriveKind`（agent 3,4→bug / 1,2,5→rule）、scope 機械チェック（changedFiles 外/excludedFiles → out-of-scope）、`applyAnchor`、union-find グルーピング（解決済み: path+side で行範囲重複、未解決: path+正規化 existingCode 完全一致）、`mergeParams`, `pickTop`, stats。
- カテゴリ双方向整合強制: agent 1/2/5 ⇔ rule-violation 限定、agent 3/4 は rule-violation 禁止。
- 型: `Finding`, `Group`, `FindingsDoc`, `Stats`。
- `--retry` 相当（前回 findings + existingCode パッチで未解決のみ再解決）も関数として移植（step4b で使用）。
- テスト: 決定論性（同一入力→同一出力, `process-findings.mjs:685`）とグルーピング代表ケースを移植。

### 3. `src/lib/validate-clusters.ts` ← `scripts/validate-clusters.mjs`
- `validateClusters(rawClusters, changedFiles)`: MAX_CLUSTERS=3、bail（単一クラスタ縮退 fallback:true）、CTX changedFiles との積集合（removedPaths 記録）、跨り解消（最初のクラスタ優先）、未カバー追加（最小クラスタへ、appendedPaths 記録）、id 1始まり振り直し。
- `tierReducedClusters`（tier tiny/small で単一クラスタ、fallback:false かつ tierReduced:true）。
- 型: `Cluster`, `ClustersDoc`。

### 4. `src/lib/merge-findings.ts` ← `scripts/merge-findings.mjs`
- `mergeFindings(findingsDoc, mergeTexts)`: 検証（未知/singleton供給/重複/空 title・body、needsMergeText 全供給チェック）、issue 組み立て（singleton は唯一メンバーコピー、複数は LLM 統合文章）、path/kind/category/severity/resolved/params/reason 機械転写、ruleRefs 和集合、existingCode は先頭メンバー、sourceFindingIds=memberIds。
- 型: `Issue`, `IssuesDoc`, `MergeText { groupId; title; body }`。

### 5. `src/lib/apply-verdicts.ts` ← `scripts/apply-verdicts.mjs`
- `applyVerdicts(issuesDoc, verdicts)`: 検証（未知/重複 id, enum 外 verdict）、confirmed→issues 丸ごと、rejected→`{id,path,title,reason}`、stdin に無い→unverified、stats。
- 型: `Verdict`, `FinalDoc`。

### 6. `src/lib/collect-context.ts` ← `scripts/collect-review-context.mjs`
- `resolvePrBaseRange`（`gh pr view --json` から baseRefOid、`<base>...HEAD` three-dot、fork/shallow 検知 fetch 指示付き throw）。
- `classifyFiles`（除外 glob: `.min.js`/`dist/**`/画像/フォント/アーカイブ/動画音声、`.gitattributes` linguist generated/vendored/documentation を `git check-attr --stdin -z` で一括判定）。
- `collectChangedLines`（`git diff --numstat` パース、バイナリ `-` は null）。
- `splitOversized`（1ファイル added+deleted が OVERSIZED_MAX_LINES 超過で除外）。
- `classifyTier`（totalFiles AND totalChangedLines 両方が閾値未満で tiny/small）。metrics は oversized 減算後で確定。
- `claudeMdForFile`（親ディレクトリ遡上 CLAUDE.md 収集、ディレクトリ単位メモ化）＋ `.claude/rules/**/*.md` の frontmatter `paths:` パース → `path.matchesGlob` でルール適用算出。
- `buildAssignments`（同一ルールセットでグループ化 → 2バケットへ重複ゼロ・ファイル数平準化。tier != normal は buckets[0] 集約で2体目抑止。骨格グループ LPT + filler 配置）。
- env しきい値上書き（`CODE_REVIEW_TINY_MAX_FILES`(2), `_TINY_MAX_LINES`(50), `_SMALL_MAX_FILES`(5), `_SMALL_MAX_LINES`(150), `_OVERSIZED_MAX_LINES`(1000)）を踏襲。
- 型: `Context { source; changedFiles; excludedFiles; oversizedFiles; excludeArgs; assignments; metrics; tier; diffArgs; range? }`。
- git/gh は `src/lib/exec.ts` の `execFile` ラッパで呼ぶ。

### 7. `src/lib/post-review.ts` ← `scripts/post-review.mjs`（pr-review 用・Phase 5 で使うが移植は Phase 2 でも可）
- `toComment`（params → REST snake_case: 単一行 `{path,body,line,side}`, 複数行 `start_line/start_side` 付与、subjectType 落とす）。
- `buildSuggestionBody`（**fail-closed** の破壊ガード: 複数メンバー統合 issue→null、params 範囲行数 ≠ existingCode 行数→null、行削除時 deleteLines 明示＋shortfall 一致のみ許可）。
- 黙殺防止（resolved:true confirmed が comments に無ければ throw、resolved:false を入れたら throw、未知/重複 id、空 commentBody）。
- 投稿は Phase 5 で `gh api POST /repos/{owner}/{repo}/pulls/<n>/reviews --input -`（payload `{commit_id,event:"COMMENT",body,comments}`）。

### 8. `src/lib/exec.ts`（新規小物）
- `execFile` の Promise ラッパ（stdout/stderr/exit を返す）。git/gh 実行に使う。既存の `artifact.mjs` は移植しない（ファイル I/O 層不要）。

## 完了条件

- `npm test` で移植した全テストが green。
- 特に diff-anchor（アンカー解決全ケース）・process-findings（決定論性・グルーピング）が通る。
- collect-context は git/gh 依存部分をこのリポジトリの実 diff で手動確認（`node -e` かデバッグスクリプト）。

## 注意

- 出力順序の安定化を維持（Map 挿入順、union-find の小 index を根、path ソート）。決定論性テストで担保。
- `noUncheckedIndexedAccess` 有効下では配列アクセスの undefined 分岐が増える。移植時に既存ロジックの意味を変えないよう注意（ガードは追加してよいが挙動は不変）。
