// レビューエージェント（ステップ3）の finding 配列を機械処理して FINDINGS 成果物にする中核。
//
// 設計原則（alibaba/open-code-review 由来）: **LLM は意味判断のみ、位置解決・検証・
// フィルタ適用・構造転写はコード**。ステップ3のエージェントは「diff に実在する連続コード片
// （existingCode アンカー）」付きの finding を JSON で出すだけ。このスクリプトが以下を
// すべて機械的に行い、実行ごとのブレ・黙殺・転記ミスを排除する:
//   1. ID 付与（入力順 f1..fN）
//   2. スキーマ検証（違反は finding 単位で status:"invalid"。全体は落とさない。category/severity の
//      enum 検証・agent 1/2/5 の category=rule-violation 整合チェックを含む）
//   3. スコープ機械チェック（path ∉ changedFiles / ∈ excludedFiles → status:"out-of-scope"）
//   4. kind 導出（agent 3,4 → bug / 1,2,5 → rule。LLM に書かせない）
//   5. アンカー解決（diff-anchor の resolveAnchor で行番号を確定）
//   6. 機械グルーピング（旧ステップ4「重複統合」の機械化。行範囲の重なり / 同一アンカー。
//      グループの category/severity も決定論的に導出する）
//
// main()（CLI 化・git execFileSync・artifact I/O）は移植しない（Phase 4）。
// 純関数部分のみ移植し、git 取得は diffText 引数注入に置換。
import { lineRange, parseDiff, resolveAnchor, splitAndNormalize } from "./diff-anchor.js";
import type {
  Category,
  Ctx,
  Finding,
  FindingsDoc,
  FilesByPath,
  Group,
  Params,
  Severity,
} from "./types.js";

// ---- スキーマ検証 ------------------------------------------------------------
// finding 1 件のスキーマを検証し、違反理由の配列を返す（空なら valid）。
// 必須: agent∈1..5 / path / title / body / existingCode / category / severity。
// ruleRefs は agent 1,2,5 で必須、3,4 では省略可（後段で [] 補完）。
// category は agent 種別と双方向で整合していることを強制する
// （agent 1/2/5 → rule-violation 限定、agent 3/4 → rule-violation 禁止）。
export const RULE_AGENTS = new Set([1, 2, 5]);

// category: bug/security/performance はバグ検出系（agent 3,4）由来、rule-violation は
// ルール準拠・REVIEW.md準拠系（agent 1,2,5）由来。この対応は validateFinding が双方向で
// 機械的に強制する（agent 3/4 が rule-violation を自己申告しても invalid で弾かれる）。
// severity は4段（info は入れない）。
export const VALID_CATEGORIES = new Set(["bug", "security", "performance", "rule-violation"]);
export const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// category の重要度優先順位（グループ集約で最重要度を選ぶ際に使う）。
export const CATEGORY_PRIORITY: Record<string, number> = { security: 0, bug: 1, performance: 2 };
// severity の重大度優先順位（グループ集約で最大深刻度を選ぶ際に使う）。
export const SEVERITY_PRIORITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// values のうち priority テーブルで最優先（数値最小）のものを1つ返す。
// テーブルに無い値は無視する（呼び出し側が事前にスキーマ検証済みのため通常は起こらない）。
// 該当する値が1つも無ければ undefined を返す（呼び出し側が扱う）。
function pickTop<T extends string>(values: (T | undefined)[], priority: Record<string, number>): T | undefined {
  let best: T | undefined;
  for (const v of values) {
    if (v === undefined || !(v in priority)) continue;
    if (best === undefined || priority[v]! < priority[best]!) best = v;
  }
  return best;
}

function validateFinding(f: unknown): string[] {
  const errors: string[] = [];
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    return ["finding がオブジェクトでない"];
  }
  const rec = f as Record<string, unknown>;
  if (!Number.isInteger(rec.agent) || (rec.agent as number) < 1 || (rec.agent as number) > 5) {
    errors.push("agent は 1..5 の整数である必要がある");
  }
  for (const key of ["path", "title", "body", "existingCode"]) {
    const v = rec[key];
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${key} は非空文字列である必要がある`);
    }
  }
  const agent = rec.agent as number;
  if (RULE_AGENTS.has(agent)) {
    if (!Array.isArray(rec.ruleRefs) || rec.ruleRefs.length === 0) {
      errors.push("agent 1/2/5 は ruleRefs（非空配列）が必須");
    }
  }
  const category = rec.category as string;
  if (!VALID_CATEGORIES.has(category)) {
    errors.push(`category は ${[...VALID_CATEGORIES].join("/")} のいずれかである必要がある`);
  } else if (RULE_AGENTS.has(agent) !== (category === "rule-violation")) {
    errors.push(
      RULE_AGENTS.has(agent)
        ? "agent 1/2/5 の category は rule-violation である必要がある"
        : "agent 3/4 の category は rule-violation であってはならない",
    );
  }
  const severity = rec.severity as string;
  if (!VALID_SEVERITIES.has(severity)) {
    errors.push(`severity は ${[...VALID_SEVERITIES].join("/")} のいずれかである必要がある`);
  }
  return errors;
}

// agent 種別から kind を導出する（LLM に書かせない機械適用）。
function deriveKind(agent: number): "bug" | "rule" {
  return agent === 3 || agent === 4 ? "bug" : "rule";
}

// finding にアンカー解決結果を書き込む（初回・--retry 共通）。resolved:true なら
// params をセットし reason を消す、resolved:false なら reason をセットし params を消す
// （params/reason の相互排他をここ1か所で担保する）。finding を破壊的に更新して返す。
function applyAnchor(finding: Finding, filesByPath: FilesByPath): Finding {
  const r = resolveAnchor(finding, filesByPath);
  if (r.resolved) {
    finding.resolved = true;
    finding.params = r.params;
    delete finding.reason;
  } else {
    finding.resolved = false;
    finding.reason = r.reason;
    delete finding.params;
  }
  return finding;
}

// ---- 機械グルーピング --------------------------------------------------------
// union-find（素集合）。行範囲の重なりでの推移的連結に使う。
function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // 小さい index を根に寄せる（安定性）
  };
  return { find, union };
}

// 2 つの行範囲が1行以上重なるか。
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

// 合成範囲（グループ全体をカバーする最小の startLine..line）と params を組み立てる。
// side/startSide はグループ内で同一（同一 path+side でしかグルーピングしないため先頭を採用）。
function mergeParams(members: Finding[]): Params {
  let min = Infinity;
  let max = -Infinity;
  for (const m of members) {
    const [s, e] = lineRange(m.params!);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  const side = members[0]!.params!.side;
  if (min === max) {
    return { line: max, side, subjectType: "LINE" };
  }
  return {
    startLine: min,
    line: max,
    startSide: side,
    side,
    subjectType: "LINE",
  };
}

// findings を機械グルーピングする。戻り値は groups[]（各グループは members の id 配列と
// 合成 params / kind / needsMergeText を持つ）。
//   - 解決済み: 同一 path + side で行範囲が1行以上重なるものを union-find で推移的に連結
//   - 未解決:   同一 path + 正規化 existingCode 完全一致のみ同グループ
//   - kind:     グループ内に bug が1件でもあれば bug（由来種別優先の機械適用）
//   - members 2件以上 → needsMergeText:true（統合文章を LLM に作らせる対象）
function groupFindings(findings: Finding[]): Group[] {
  // グルーピング対象は valid かつ in-scope な finding のみ（invalid/out-of-scope は単独扱いしない）。
  const active = findings.filter((f) => f.status === "active");

  // --- 解決済み: path+side ごとに行範囲重なりで union-find 連結 ---
  const resolved = active.filter((f) => f.resolved);
  const bySideKey = new Map<string, number[]>(); // `${path}\0${side}` -> indices(resolved 配列内)
  resolved.forEach((f, i) => {
    const key = `${f.path}\0${f.params!.side}`;
    if (!bySideKey.has(key)) bySideKey.set(key, []);
    bySideKey.get(key)!.push(i);
  });
  const uf = makeUnionFind(resolved.length);
  for (const idxs of bySideKey.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const ra = lineRange(resolved[idxs[a]!]!.params!);
        const rb = lineRange(resolved[idxs[b]!]!.params!);
        if (rangesOverlap(ra, rb)) uf.union(idxs[a]!, idxs[b]!);
      }
    }
  }
  // root -> members。Map は挿入順を保つため、root が最初に現れた順＝入力順で並ぶ
  // （後続のグループ採番もこの順を使う）。
  const resolvedGroups = new Map<number, Finding[]>();
  resolved.forEach((f, i) => {
    const root = uf.find(i);
    if (!resolvedGroups.has(root)) resolvedGroups.set(root, []);
    resolvedGroups.get(root)!.push(f);
  });

  // --- 未解決: path + 正規化 existingCode 完全一致のみ同グループ ---
  const unresolved = active.filter((f) => !f.resolved);
  const unresolvedGroups = new Map<string, Finding[]>(); // key -> finding 配列
  for (const f of unresolved) {
    const key = `${f.path}\0${splitAndNormalize(f.existingCode ?? "").join("\n")}`;
    if (!unresolvedGroups.has(key)) unresolvedGroups.set(key, []);
    unresolvedGroups.get(key)!.push(f);
  }

  // --- グループ構造の組み立て（安定した順序で gN を採番）---
  const groups: Group[] = [];
  const buildGroup = (members: Finding[], { resolved }: { resolved: boolean }) => {
    const kind = members.some((m) => m.kind === "bug") ? "bug" : "rule";
    // severity: メンバー中の最大深刻度（critical > high > medium > low）。
    const severity = pickTop(members.map((m) => m.severity), SEVERITY_PRIORITY) as Severity | undefined;
    // category: kind が bug のグループはメンバーの category のうち最重要度
    // （security > bug > performance）を採用。rule のグループは rule-violation。
    const category: Category | undefined =
      kind === "bug"
        ? (pickTop(members.map((m) => m.category), CATEGORY_PRIORITY) as Category | undefined)
        : "rule-violation";
    const g: Group = {
      id: `g${groups.length + 1}`,
      path: members[0]!.path!,
      kind,
      category,
      severity,
      resolved,
      memberIds: members.map((m) => m.id),
      needsMergeText: members.length >= 2,
    };
    if (resolved) {
      g.params = mergeParams(members);
    } else {
      // 未解決グループは params を持たない。アンカー（先頭 finding の existingCode）は
      // merge-findings が転写する。
      g.reason = members[0]!.reason;
    }
    groups.push(g);
    // 各 finding に所属グループ id を刻む（成果物の追跡用）。
    for (const m of members) m.groupId = g.id;
  };

  // resolvedGroups は root 初出順（＝入力順）なので、そのまま採番していけばよい。
  for (const members of resolvedGroups.values()) {
    buildGroup(members, { resolved: true });
  }
  for (const members of unresolvedGroups.values()) {
    buildGroup(members, { resolved: false });
  }

  return groups;
}

// ---- 中核純粋関数 ------------------------------------------------------------
// rawInput: finding 配列（配列の配列も可）／--retry 時は前回 findings に prev として渡す
//   のではなく、rawInput をパッチ配列として扱う（下記 prev 分岐）。
// ctx: CTX オブジェクト（changedFiles / excludedFiles / diffArgs / excludeArgs）
// diffText: buildDiffArgs で取得済みの統一 diff テキスト
// prev: --retry 時のみ、前回 FINDINGS 成果物オブジェクト（findings を持つ）
//
// 戻り値: { findings, groups, stats }
export function processFindings(
  rawInput: unknown,
  { ctx, diffText, prev = null }: { ctx: Ctx; diffText: string; prev?: FindingsDoc | null },
): FindingsDoc {
  const changedSet = new Set(ctx.changedFiles ?? []);
  const excludedSet = new Set(ctx.excludedFiles ?? []);
  const filesByPath: FilesByPath = parseDiff(diffText);

  let findings: Finding[];
  if (prev) {
    // --retry: rawInput は [{id, existingCode}] のパッチ配列。前回 findings をベースに、
    // 該当 id の existingCode を差し替え、再解決対象（active かつ未解決だったもの）だけ
    // アンカー解決をやり直す。パッチに無い finding はそのまま維持する。
    if (!Array.isArray(rawInput)) {
      throw new Error("--retry の stdin は [{id, existingCode}] の配列である必要があります");
    }
    const patchById = new Map<string, unknown>();
    for (const p of rawInput as { id?: unknown; existingCode?: unknown }[]) {
      if (p && typeof p.id === "string") patchById.set(p.id, p.existingCode);
    }
    findings = prev.findings.map((f) => {
      // groupId は再グルーピングで振り直すため一旦落とす。
      const { groupId: _groupId, ...rest } = f;
      const patched: Finding = { ...rest };
      if (patchById.has(f.id) && typeof patchById.get(f.id) === "string") {
        patched.existingCode = patchById.get(f.id) as string;
      }
      // active かつ未解決だったものだけ再解決する（invalid/out-of-scope/解決済みは触らない）。
      if (patched.status === "active" && !patched.resolved) {
        applyAnchor(patched, filesByPath);
      }
      return patched;
    });
  } else {
    // 初回: 配列の配列を自動フラット化してから処理する。
    const flat = Array.isArray(rawInput) ? (rawInput as unknown[]).flat() : null;
    if (!Array.isArray(flat)) {
      throw new Error("stdin は finding 配列（または配列の配列）である必要があります");
    }
    findings = flat.map((raw, i) => {
      const id = `f${i + 1}`;
      const rec = raw as Record<string, unknown> | null | undefined;
      const errors = validateFinding(raw);
      if (errors.length > 0) {
        // 不正 finding も落とさず携行する（全体は止めない）。位置解決・グルーピングの対象外。
        return {
          id,
          agent: rec?.agent as number | undefined,
          path: rec?.path as string | undefined,
          title: rec?.title as string | undefined,
          status: "invalid",
          errors,
        } as Finding;
      }
      // ruleRefs: agent 1/2/5 は検証済みで非空配列、3/4 は省略可なので [] 補完(両者とも
      // `?? []` で足りる。検証を通っている以上 agent 1/2/5 で null になることはない）。
      const r = rec as Record<string, unknown>;
      const base: Finding = {
        id,
        agent: r.agent as number,
        path: r.path as string,
        title: r.title as string,
        body: r.body as string,
        existingCode: r.existingCode as string,
        ruleRefs: (r.ruleRefs as string[] | undefined) ?? [],
        kind: deriveKind(r.agent as number),
        category: r.category as Category,
        severity: r.severity as Severity,
        status: "active",
      };
      // スコープ機械チェック: diff 対象外ファイルへの指摘を機械的に弾く。
      if (!changedSet.has(base.path!) || excludedSet.has(base.path!)) {
        return { ...base, status: "out-of-scope" };
      }
      // アンカー解決（初回・--retry 共通の applyAnchor で params/reason を確定）。
      return applyAnchor(base, filesByPath);
    });
  }

  const groups = groupFindings(findings);

  const stats = {
    total: findings.length,
    valid: findings.filter((f) => f.status === "active").length,
    invalid: findings.filter((f) => f.status === "invalid").length,
    outOfScope: findings.filter((f) => f.status === "out-of-scope").length,
    resolved: findings.filter((f) => f.status === "active" && f.resolved).length,
    unresolved: findings.filter((f) => f.status === "active" && !f.resolved).length,
    groups: groups.length,
    multiGroups: groups.filter((g) => g.needsMergeText).length,
  };

  return { findings, groups, stats };
}
