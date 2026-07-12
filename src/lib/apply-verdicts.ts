// 検証エージェント（ステップ6）が返した verdict を機械適用し、FINAL 成果物にする。
// 旧ステップ6「検証されなかった課題は除外する」を、暗黙でなく成果物に残す形で機械化する
// （alibaba/open-code-review の executeReviewFilter に相当。LLM は判定のみ、削除はコード）。
//
// 検証エージェントは issue ごとに `{id, verdict, reason}` の1オブジェクトを返す。この関数が:
//   - confirmed のみを最終課題として残す
//   - rejected は理由付きで記録（黙って消さない）
//   - stdin に現れない issue は unverified として除外（検証エージェント失敗時の縮退もこの経路へ）
//
// confirmed の issue は merge-findings.ts が転写した category/severity をそのまま保持する
// （このモジュールは issue を丸ごと保持するため、コード変更なしで FINAL まで自動的に携行される）。
import type { FinalDoc, Issue, IssuesDoc, RejectedIssue, Verdict, VerdictKind } from "./types.ts";

export const VALID_VERDICTS = new Set<VerdictKind>(["confirmed", "rejected"]);

function isVerdictKind(value: unknown): value is VerdictKind {
  return typeof value === "string" && VALID_VERDICTS.has(value as VerdictKind);
}

// issuesDoc（ISSUES の中身）と verdicts（検証結果配列）から FINAL を組み立てる純粋関数。
export function applyVerdicts(issuesDoc: IssuesDoc, verdicts: unknown): FinalDoc {
  const { issues } = issuesDoc;
  const issueById = new Map(issues.map((i) => [i.id, i]));

  if (!Array.isArray(verdicts)) {
    throw new Error("stdin は [{id, verdict, reason}] の配列である必要があります");
  }

  const verdictById = new Map<string, Verdict>();
  for (const v of verdicts as unknown[]) {
    const rec = v as Record<string, unknown> | null;
    if (!rec || typeof rec.id !== "string") {
      throw new Error("verdict の各要素は id（文字列）を持つ必要があります");
    }
    const { id } = rec;
    if (!issueById.has(id)) {
      throw new Error(`未知の issue id: ${id}`);
    }
    if (verdictById.has(id)) {
      throw new Error(`issue id=${id} の verdict が重複しています`);
    }
    const { verdict, reason } = rec;
    if (!isVerdictKind(verdict)) {
      throw new Error(`issue id=${id} の verdict は "confirmed" または "rejected" である必要があります`);
    }
    verdictById.set(id, { id, verdict, reason: typeof reason === "string" ? reason : undefined });
  }

  const confirmed: Issue[] = [];
  const rejected: RejectedIssue[] = [];
  const unverified: string[] = [];
  for (const issue of issues) {
    const v = verdictById.get(issue.id);
    if (!v) {
      // stdin に現れない issue は検証されなかったものとして除外（成果物に残す）。
      unverified.push(issue.id);
    } else if (v.verdict === "confirmed") {
      confirmed.push(issue);
    } else {
      rejected.push({ id: issue.id, path: issue.path, title: issue.title, reason: v.reason ?? "" });
    }
  }

  const stats = {
    total: issues.length,
    confirmed: confirmed.length,
    rejected: rejected.length,
    unverified: unverified.length,
  };

  return { issues: confirmed, rejected, unverified, stats };
}
