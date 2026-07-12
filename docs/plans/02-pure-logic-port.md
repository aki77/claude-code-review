# Phase 2: 決定論ロジックの TypeScript 移植（インデックス）

前提: `00-overview.md` のデータ構造契約を厳守。このフェーズは **LLM 非依存**で、
既存 `.mjs` の純粋関数を `.ts` 化し、インラインテストを vitest に移植する。
ここまでで LLM なしにテストが全部通る状態を作る。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/`

## ゴール
既存の決定論スクリプトを型付き TypeScript に移植し、既存インラインテストの移植版が
すべて green になる。規模と依存の都合で 4 サブフェーズに分割する（依存順に着手）。

## サブフェーズ

- **[02a 純ロジック中核](02a-pure-logic-core.md)** — `src/lib/exec.ts`(新規) /
  `diff-anchor.ts` / `process-findings.ts`。最優先。アンカー解決全ケース・決定論性テスト。
- **[02b 純ロジック後半](02b-pure-logic-rest.md)** — `validate-clusters.ts` /
  `merge-findings.ts` / `apply-verdicts.ts`。child_process 非依存の 3 本。
- **[02c コンテキスト収集](02c-collect-context.md)** — `collect-context.ts`。
  git/gh 依存の重量級。export 化＋依存注入テスト＋実リポジトリ手動確認。
- **[02d 投稿ロジック](02d-post-review.md)** — `post-review.ts`。Phase 5 用だが
  純ロジック（fail-closed ガード・黙殺防止）は Phase 2 で移植。

## 移植対象の依存関係

```
exec.ts ──────────────► collect-context.ts (02c)
                   └───► post-review.ts の投稿部（Phase 5）
diff-anchor.ts ───► process-findings.ts (02a)
              └───► post-review.ts (02d, splitAndNormalize)
validate-clusters / merge-findings / apply-verdicts (02b) … 独立
```

## 完了条件（Phase 2 全体）
- `pnpm test` で移植した全テストが green。
- 特に diff-anchor（アンカー解決全ケース）・process-findings（決定論性・グルーピング）が通る。
- collect-context は git/gh 依存部分をこのリポジトリの実 diff で手動確認。

## 共通の注意
- 出力順序の安定化を維持（Map 挿入順、union-find の小 index を根、path ソート）。
- `noUncheckedIndexedAccess` 有効下で配列アクセスの undefined 分岐が増える。既存ロジックの
  意味を変えないよう注意（ガード追加可・挙動不変）。
- ESM `nodenext`: 相対 import は `.js` 拡張子付き。
- `lib/artifact.mjs`（ファイル I/O 層）は移植しない。各 `.mjs` 末尾の `main()`（CLI 化）は Phase 4。
- テストは vitest（`tests/*.test.ts`）へ 1:1 忠実移植し、既存挙動を正とする回帰テストにする。
