# Phase 2c: コンテキスト収集の移植（collect-context）

前提: `00-overview.md` 契約厳守。LLM 非依存。移植対象で最大（元 1134 行・51KB）かつ
git/gh 副作用を多数含む。**元 `.mjs` は関数を export していない**ため、切り出して
export 化しながら移植する。02a の `exec.ts` に依存するため 02a 完了後に着手。

移植元の `execFileSync`（同期・非 0 で throw・stdout 文字列を返す）に対し、本リポジトリの
`exec.ts` は `execFileAsync`（非同期・throw せず `{stdout,stderr,code}` を返す）に統一済み。
そのため collect-context 配下の全関数を async 化し、元の `try/catch` による制御フローは
すべて `code !== 0` チェックへ書き換える（`resolvePrBaseRange` の base 不在/shallow 判定、
`resolveRange` の 4 段フォールバックなど）。外部から見た挙動（エラーメッセージ・throw
するかどうか）は不変。特に `resolveRange` は元 CLI では全段失敗時に `process.exit(1)` して
いたが、本移植ではライブラリ関数化のため `throw` に変更する（`exit` は呼び出し側 cli.ts の
責務とする）。

型の置き場所: 新規型（`Context` 等）も 02a と同方針で `src/lib/types.ts` に集約し、
`collect-context.ts` はそこから import する。

exec.ts の前提条件: `detectLinguistExcluded`（下記）が `git check-attr --stdin -z` に
NUL 区切り文字列を stdin 供給する必要があるが、02a 時点の `exec.ts`（`execFileAsync`）は
`input` オプションを持たない。本フェーズ着手時に `exec.ts` へ `options.input?: string`
（子プロセスの stdin へ書き込み）を追加すること（詳細は 02a の exec.ts セクション参照）。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/collect-review-context.mjs`

## ゴール
純ロジック部の依存注入テストが green。git/gh 依存部はこのリポジトリの実 diff で手動確認。

## 移植対象: `src/lib/collect-context.ts`

- `resolvePrBaseRange(pr, { exec }={})` → `"<baseRefOid>...HEAD"`（**three-dot**）:
  `gh pr view <pr> --json baseRefOid,baseRefName` パース、baseRefOid 欠落 throw、
  `git cat-file -e <oid>^{commit}` で base 在庫確認（fork/shallow 欠落→`git fetch origin <baseRefName>`
  指示付き throw）、`git merge-base` 可否（shallow→`git fetch --unshallow` 指示付き throw）。
  **exec を依存注入**（テストでスタブ化）。
- `classifyFiles(files, { attrExcludedSet, defaultGlobs }={})` → `{ kept, excluded }`:
  除外 glob（`*.min.js`/`dist/**`/画像/フォント/アーカイブ/動画音声）OR attrExcludedSet。
  `.gitattributes` の linguist（generated/vendored/documentation）は `git check-attr --stdin -z`
  で一括判定（`parseCheckAttrOutput`、ATTR_NEGATIVE_VALUES={unspecified,unset,false} 以外を除外）。
  stdin にはファイル一覧を NUL 区切りで供給する（`exec.ts` の `input` オプション経由、上記参照）。
- `collectChangedLines(diffArgs, excludeArgs)`: `git diff --numstat --find-renames`。
  バイナリ（added/deleted が `-`→null）は集計・perFile から除外。失敗時は tier を落とさず全 0/空 Map。
- `splitOversized(keptFiles, perFile, maxLines)`: `added+deleted > maxLines`（**strictly greater**）
  で oversized 分離。perFile に無い kept は残す（安全側）。oversizedFiles は sort 済み。
- `classifyTier(totalFiles, totalChangedLines)`: tiny は `files<=maxFiles && lines<maxLines`
  （ファイル数 `<=`・行数 `<`）、small も同型。どちらか超過で上位 tier。metrics は oversized 減算後で確定。
- `claudeMdForFile(file)`: ルート＋親ディレクトリ遡上の CLAUDE.md 収集、`claudeMdCache` で
  ディレクトリ単位メモ化、sort＋unique。`.claude/rules/**/*.md` の frontmatter `paths:`
  （`parseFrontmatterPaths`、ブロック/インライン両対応）→ `path.matchesGlob` で適用算出。
- `buildAssignments(changedFiles, allRules, resolveRules=rulesForFile, tier="normal")` →
  2 バケット `[{files},{files}]`: 同一ルールセットでグループ化 → 重複ゼロ・ファイル数平準化。
  tier≠normal は buckets[0] 集約（2 体目抑止）。骨格グループ LPT＋filler 配置。`resolveRules` 注入可。
- env しきい値上書き（`num()` で Number.isFinite チェック）:
  `CODE_REVIEW_TINY_MAX_FILES`(2)/`_TINY_MAX_LINES`(50)/`_SMALL_MAX_FILES`(5)/
  `_SMALL_MAX_LINES`(150)/`_OVERSIZED_MAX_LINES`(1000)。
- その他内部: parseArgs, resolveRange（4 段自動解決。各段は `code===0 && stdout.trim()` で
  確定、それ以外は次段へフォールスルー。全段失敗時は `process.exit` ではなく `throw`
  ＝ライブラリ関数化）, getChangedFilesFromRange, getStagedFiles,
  parseNumstat, listRuleFiles, fileMatchesPatterns, detectLinguistExcluded, buildExcludeArgs,
  collectRules, rulesForFile。
- git/gh は `src/lib/exec.ts` の `execFile` ラッパ経由。
- 型: `Context { source; changedFiles; excludedFiles; oversizedFiles; excludeArgs;
  assignments; metrics; tier; diffArgs; range? }`。

## テスト（依存注入で FS/プロセス非依存に）
元 722-1133 行から: fileMatchesPatterns（**/`*`/完全/`{a,b}`/`?`/削除）、parseFrontmatterPaths
（null/ブロック/インライン）、buildAssignments（単一均等/#780/#792/tier 縮退）、classifyTier 境界、
parseNumstat（バイナリ/空行/rename）、classifyFiles（glob/SVG 保持/linguist 注入/defaultGlobs 注入）、
parseCheckAttrOutput（値ごと/3 属性/空）、buildExcludeArgs、splitOversized（境界/合算/漏れ/sort/全 oversized）、
resolvePrBaseRange（exec スタブで正常/base 不在/shallow/oid 欠落/不正 JSON）。

## 完了条件
- `pnpm test` で collect-context の純ロジックテストが green。
- git/gh 依存部はこのリポジトリの実 diff で手動確認（`pnpm dev` かデバッグスクリプトで
  resolveRange/collectChangedLines/classifyFiles を実行し出力確認）。

## 注意
- export 化しながらの移植で、元の関数分割・依存注入ポイント（exec/attrExcludedSet/resolveRules）を維持。
- ESM `.js` import・`noUncheckedIndexedAccess` 対応。挙動不変。
