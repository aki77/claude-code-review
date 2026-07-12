# Phase 2b: 決定論ロジック移植（後半: validate-clusters / merge-findings / apply-verdicts）

前提: `00-overview.md` 契約厳守。LLM 非依存。3 本とも child_process 完全非依存の
純粋関数で、02a に比べ独立性が高い。02a 完了後に着手。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/`

## ゴール
3 本の `--test` ケース移植版がすべて green。

## 移植対象

### 1. `src/lib/validate-clusters.ts` ← `scripts/validate-clusters.mjs`
- `MAX_CLUSTERS = 3`。
- `validateClusters(rawClusters, changedFiles)` → `{ clusters, fallback, removedPaths, appendedPaths }`:
  - bail（単一クラスタ縮退・唯一の生成点）: 配列でない / MAX 超過 / theme 欠落 /
    changedFiles 非配列 → `fallback:true`。
  - 積集合修復（changedSet と積、外れは removedPaths、symbols/contextHints を [] 補完、unique 化）。
  - 空クラスタ削除 → 0 件で bail。
  - 跨り解消（covered Set、同一ファイルは**先頭クラスタ優先**、後続から除去）→ 空なら再削除 → 0 件で bail。
  - 未カバー追加（covered でない changedFiles を appendedPaths 記録し**最小クラスタ**へ push）。
  - id 1 始まり振り直し＋`{id,theme,changedFiles,symbols,contextHints}` 整列。
- `tierReducedClusters(changedFiles)` → 単一クラスタ・`fallback:false`・**`tierReduced:true`**
  （tier tiny/small 用。壊れ入力の fallback と区別）。
- 型: `Cluster`, `ClustersDoc`。

### 2. `src/lib/merge-findings.ts` ← `scripts/merge-findings.mjs`
- `mergeFindings(findingsDoc, mergeTexts)` → `{ issues, stats }`:
  - 検証（throw）: 各 mergeText の groupId 文字列必須 / 未知 groupId / **singleton へ文章供給禁止**
    （needsMergeText でないグループ）/ 重複 groupId / title・body 非空 /
    **needsMergeText 全グループに文章供給されているか**（欠落 throw）。
  - issue 組み立て: needsMergeText は LLM 統合文章、singleton は先頭メンバー title/body 自動コピー。
    ruleRefs は全メンバー**和集合**（順序安定・重複排除）、existingCode は先頭メンバー、
    path/kind/category/severity/resolved/params/reason 機械転写、sourceFindingIds=memberIds。
  - stats: `{ groups, issues, merged, resolved, unresolved }`。
- 型: `Issue`, `IssuesDoc`, `MergeText { groupId; title; body }`。

### 3. `src/lib/apply-verdicts.ts` ← `scripts/apply-verdicts.mjs`
- `VALID_VERDICTS = {confirmed, rejected}`。
- `applyVerdicts(issuesDoc, verdicts)` → `{ issues, rejected, unverified, stats }`:
  - 検証（throw）: verdicts 非配列 / id 文字列必須 / 未知 id / 重複 id / enum 外 verdict。
  - 分類: verdict 無し→unverified、confirmed→issues 丸ごと（category/severity 携行）、
    rejected→`{id,path,title,reason: v.reason ?? ""}`。
  - stats: `{ total, confirmed, rejected, unverified }`。
- 型: `Verdict`, `FinalDoc`。

## テスト
- validate-clusters（元 170-272 行）: 正常 2 クラスタ、縮退各種（null/4 クラスタ/theme 欠落/[]/全 diff 外）、
  修復（removedPaths/appendedPaths）、id 振り直し、跨り解消（先頭優先）、tierReducedClusters。
- merge-findings（元 141-229 行）: 統合文章採用＋ruleRefs 和集合、機械転写、singleton 自動コピー、
  各種エラー（文章欠落/未知/singleton 供給/重複/空/非配列）、stats。
- apply-verdicts（元 112-188 行）: confirmed 携行・保持、rejected 理由記録、unverified 検出、
  全欠落→全 unverified、stats、エラー（未知 id/重複/enum 外/非配列）。

## 完了条件
- `pnpm test` で 3 本のテストが全 green。

## 注意
- child_process を一切使わない純粋移植。ESM `.js` import・`noUncheckedIndexedAccess` 対応。
