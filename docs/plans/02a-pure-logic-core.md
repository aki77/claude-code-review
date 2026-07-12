# Phase 2a: 決定論ロジック移植（中核: exec / diff-anchor / process-findings）

前提: `00-overview.md` のデータ構造契約を厳守。LLM 非依存。既存 `.mjs` の
フィールド名・挙動を一切変えず TypeScript 化し、インラインテストを vitest へ移植する。

参照元: `/Users/aki/src/github.com/aki77/claude-plugins/plugins/code-review/scripts/`

## ゴール
アンカー解決の全ケースと process-findings の決定論性テストが green になる。
ここが Phase 2 全体の中核であり最優先。

## 移植対象

### 1. `src/lib/exec.ts`（新規小物）
- `execFile` の Promise ラッパ。`{ stdout, stderr, code }` を返す。git/gh 実行に使う。
- 02c(collect-context)/02d(post-review) が依存するため 02a で先に用意。
- 参照元 `lib/artifact.mjs` は移植しない（ファイル I/O 層は不要）。
- 型: `ExecResult { stdout: string; stderr: string; code: number }`。
  非 0 終了を throw するか結果で返すかは呼び出し側の使い分けに合わせる
  （collect-context は失敗時 tier を落とさず全 0 を返す設計 → code を見て分岐できる形にする）。

### 2. `src/lib/diff-anchor.ts` ← `scripts/lib/diff-anchor.mjs`（純ロジック・依存ゼロ）
- 正規表現: `hunkHeaderRe`（count 省略可 `@@ -a[,b] +c[,d] @@`）, `fileHeaderRe`（b/ 側新パス採用）。
- 関数: `parseDiff`, `normalizeLine`, `splitAndNormalize`, `sideLines`,
  `matchConsecutive`, `resolveAnchor`, `buildDiffArgs`。
- 型:
  - `DiffLine { text: string; oldLine: number|null; newLine: number|null }`
  - `Hunk { lines: DiffLine[] }`
  - `FilesByPath = Map<string, Hunk[]>`（挿入順保持）
  - `Side = "new" | "old"`（内部）/ REST 側は "RIGHT"|"LEFT"
  - `AnchorResult`: resolved:true 時 `{ resolved:true; side; params }`、
    false 時 `{ resolved:false; reason }`（相互排他の判別可能 union）
- 挙動の要点（不変に保つ）:
  - `matchConsecutive` は **ちょうど 1 箇所のときだけ返す**。0 件（不一致）も 2 件以上
    （曖昧）も null。
  - `resolveAnchor` は **new 側優先、なければ old 側**。単一行は `{line, side, subjectType}`、
    複数行は `startLine/line/startSide/side/subjectType`。early-false は
    path/existingCode 未指定・対象ファイル差分なし・needle 空。
  - `buildDiffArgs` は `["-c","core.quotepath=false","diff",...diffArgs,...excludeArgs]`。

### 3. `src/lib/process-findings.ts` ← `scripts/process-findings.mjs`
- 公開: `processFindings(rawInput, { ctx, diffText, prev=null })` → `{ findings, groups, stats }`。
  内部関数（validateFinding / deriveKind / scope チェック / applyAnchor / union-find /
  mergeParams / pickTop / stats）はテスト経由で検証する。
- 移植で不変に保つ要点:
  - `validateFinding`: 必須フィールド、`ruleRefs` は agent∈{1,2,5} で非空配列必須、
    `category`∈{bug,security,performance,rule-violation}、`severity`∈{critical,high,medium,low}（info 無し）。
    **双方向整合**: agent∈{1,2,5}⇔rule-violation 限定、agent∈{3,4} は rule-violation 禁止。
  - `deriveKind`: agent 3,4→"bug" / 1,2,5→"rule"。
  - scope: `!changedSet.has(path) || excludedSet.has(path)` → status:"out-of-scope"。
  - `applyAnchor`: resolveAnchor 結果で params(成功)/reason(失敗) を相互排他セット。
  - union-find `makeUnionFind`: path compression＋**小 index を根**に寄せて安定化。
    解決済みは `path\0side` キーで行範囲重複（`a[0]<=b[1] && b[0]<=a[1]`）union、
    未解決は `path\0正規化existingCode` 完全一致 union。status:"active" のみ対象。
  - `mergeParams`: 全メンバー lineRange から最小 start..最大 line 合成。
  - `pickTop`: CATEGORY_PRIORITY{security:0,bug:1,performance:2}・
    SEVERITY_PRIORITY{critical:0,high:1,medium:2,low:3}。group severity は最大深刻度、
    kind は bug が 1 件でもあれば bug、category は bug グループは最重要度・rule グループは常に
    "rule-violation"。members≥2 で needsMergeText:true。
  - `--retry`（prev 分岐）: rawInput を `[{id, existingCode}]` パッチ配列として扱い
    （配列でなければ throw）、prev.findings の **active かつ未解決のものだけ** existingCode を
    差し替えて再 applyAnchor、groupId を落として再グルーピング。invalid/out-of-scope/解決済みは触らない。
    初回は入力を `.flat()` で 1 段フラット化、id は `f1..fN`。
  - diff 取得の `git` 呼び出し（元 399 行 execFileSync）は `diffText` 引数として注入され、
    processFindings 自体は純粋。テストでは固定 diffText を渡す。
- 型: `Finding`, `Group`, `FindingsDoc`, `Stats`（00-overview 契約準拠）。

## テスト（tests/diff-anchor.test.ts, tests/process-findings.test.ts）
- diff-anchor（元 188-369 行の全ケース）: 新規ファイル diff の行採番、count 省略ヘッダ、
  範囲アンカー、単一行、正規化（インデント/マーカー吸収）、不一致→false、複数一致→曖昧 false、
  差分外ファイル→false、削除行→old/LEFT、非 ASCII パス（quotepath=false 生 UTF-8）、
  buildDiffArgs 3 種。
- process-findings（元 415 行以降・特に 685 行）: **決定論性（同一入力→JSON.stringify 一致）**、
  ID 付与、スキーマ検証各種、scope、kind 導出、アンカー解決、グルーピング（行範囲重複/推移連結/
  bug 優先/severity 最大/未解決同一アンカー）、フラット化、--retry 2 件、非配列 throw。

## 完了条件
- `pnpm test` で diff-anchor・process-findings のテストが全 green。
- 特にアンカー解決全ケースと決定論性を担保。

## 注意
- ESM `.js` 拡張子付き import（`./diff-anchor.js`）。
- `noUncheckedIndexedAccess` 下でガード追加可・挙動不変。
- 出力順序安定化（Map 挿入順・union-find 小 index 根・path ソート）を維持。
