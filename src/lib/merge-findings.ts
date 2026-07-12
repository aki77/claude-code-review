// FINDINGS のグループ構造と、LLM が書いた統合文章（複数メンバーのグループのみ）を機械結合し、
// ISSUES 成果物にする。旧ステップ4「重複統合」のうち **統合可否・構造転写はスクリプト、
// 統合文章のみ LLM** という分担を実装する。
//
// singleton グループ（メンバー1件）は唯一の finding の title/body を自動コピーする。
// path / kind / category / severity / params / resolved / existingCode（グループ先頭メンバー）/
// ruleRefs（和集合）は**すべてスクリプトが機械転写**し、LLM を経由させない（転記ミス防止）。
// category/severity は process-findings のグループ集約規則で確定済みの値をそのままコピーする
// （kind と同じ扱い。LLM の統合文章 title/body とは独立）。
import type { FindingsDoc, Issue, IssuesDoc, MergeText } from "./types.ts";

// findingsDoc（FINDINGS の中身）と mergeTexts（LLM 統合文章配列）から ISSUES を組み立てる純粋関数。
export function mergeFindings(findingsDoc: FindingsDoc, mergeTexts: unknown): IssuesDoc {
  const { findings, groups } = findingsDoc;
  const findingById = new Map(findings.map((f) => [f.id, f]));

  if (!Array.isArray(mergeTexts)) {
    throw new Error("stdin は [{groupId, title, body}] の配列である必要があります");
  }

  // 統合文章を groupId で引けるようにしつつ、重複・未知・欠落を検証する。
  // needTextGroups（needsMergeText:true）が「文章が必要なグループ」の唯一の真。既知グループの
  // うちこれに含まれないものは singleton として扱う。
  const textByGroup = new Map<string, MergeText>();
  const needTextGroups = new Set(groups.filter((g) => g.needsMergeText).map((g) => g.id));
  const knownGroups = new Set(groups.map((g) => g.id));

  for (const t of mergeTexts as unknown[]) {
    const rec = t as Record<string, unknown> | null;
    if (!rec || typeof rec.groupId !== "string") {
      throw new Error("統合文章の各要素は groupId（文字列）を持つ必要があります");
    }
    const { groupId } = rec;
    if (!knownGroups.has(groupId)) {
      throw new Error(`未知の groupId: ${groupId}`);
    }
    if (!needTextGroups.has(groupId)) {
      throw new Error(`groupId=${groupId} は単一メンバーのため統合文章は不要です（自動コピーされます）`);
    }
    if (textByGroup.has(groupId)) {
      throw new Error(`groupId=${groupId} の統合文章が重複しています`);
    }
    const { title, body } = rec;
    if (
      typeof title !== "string" ||
      title.trim() === "" ||
      typeof body !== "string" ||
      body.trim() === ""
    ) {
      throw new Error(`groupId=${groupId} の統合文章は title/body（非空文字列）が必要です`);
    }
    textByGroup.set(groupId, { groupId, title, body });
  }
  // needsMergeText:true の全グループに文章が供給されているか。
  for (const gid of needTextGroups) {
    if (!textByGroup.has(gid)) {
      throw new Error(`groupId=${gid} は複数メンバーですが統合文章が供給されていません`);
    }
  }

  const issues: Issue[] = groups.map((g) => {
    const members = g.memberIds.map((id) => findingById.get(id)!);
    const head = members[0]!;
    // title/body: singleton は唯一のメンバーから自動コピー、複数は LLM 統合文章。
    let title: string;
    let body: string;
    if (g.needsMergeText) {
      const text = textByGroup.get(g.id)!;
      title = text.title;
      body = text.body;
    } else {
      title = head.title ?? "";
      body = head.body ?? "";
    }
    // ruleRefs は全メンバーの和集合（順序安定・重複排除）。
    const ruleRefs = [...new Set(members.flatMap((m) => m.ruleRefs ?? []))];
    const issue: Issue = {
      id: g.id,
      path: g.path,
      kind: g.kind,
      category: g.category,
      severity: g.severity,
      title,
      body,
      ruleRefs,
      existingCode: head.existingCode, // グループ先頭メンバーのアンカーを代表に採用
      resolved: g.resolved,
      sourceFindingIds: g.memberIds,
    };
    if (g.resolved) issue.params = g.params;
    else if (g.reason) issue.reason = g.reason;
    return issue;
  });

  const stats = {
    groups: groups.length,
    issues: issues.length,
    merged: groups.filter((g) => g.needsMergeText).length,
    resolved: issues.filter((i) => i.resolved).length,
    unresolved: issues.filter((i) => !i.resolved).length,
  };

  return { issues, stats };
}
