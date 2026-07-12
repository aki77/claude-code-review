// 00-overview のデータ契約に対応する共通型。diff-anchor / process-findings /
// 後続フェーズ（02b–02d）が import して共有する。

// ---- diff-anchor 関連 -----------------------------------------------------

/** アンカー解決の内部表現での side（diff-anchor 内部）。 */
export type Side = "new" | "old";

/** GitHub REST の PR レビューコメント side。 */
export type CommentSide = "RIGHT" | "LEFT";

export interface DiffLine {
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface Hunk {
  lines: DiffLine[];
}

/** path -> hunks[]。挿入順を保持する。 */
export type FilesByPath = Map<string, Hunk[]>;

/** アンカー解決結果の GitHub コメント位置指定。単一行 or 複数行。 */
export type Params =
  | {
      line: number;
      side: CommentSide;
      subjectType: "LINE";
    }
  | {
      startLine: number;
      line: number;
      startSide: CommentSide;
      side: CommentSide;
      subjectType: "LINE";
    };

/** resolveAnchor の戻り値。resolved を discriminant にした判別 union。 */
export type AnchorResult =
  | { resolved: true; side: Side; params: Params }
  | { resolved: false; reason: string };

// ---- process-findings 関連 -------------------------------------------------

export type Kind = "bug" | "rule";
export type Category = "bug" | "security" | "performance" | "rule-violation";
export type Severity = "critical" | "high" | "medium" | "low";
export type FindingStatus = "active" | "invalid" | "out-of-scope";

export interface Finding {
  id: string;
  agent?: number;
  path?: string;
  title?: string;
  body?: string;
  existingCode?: string;
  ruleRefs?: string[];
  kind?: Kind;
  category?: Category;
  severity?: Severity;
  status: FindingStatus;
  resolved?: boolean;
  params?: Params;
  reason?: string;
  groupId?: string;
  errors?: string[];
}

export interface Group {
  id: string;
  path: string;
  kind: Kind;
  category: Category | undefined;
  severity: Severity | undefined;
  resolved: boolean;
  memberIds: string[];
  needsMergeText: boolean;
  params?: Params;
  reason?: string;
}

export interface Ctx {
  changedFiles?: string[];
  excludedFiles?: string[];
  diffArgs?: string[];
  excludeArgs?: { git?: string[] };
}

export interface Stats {
  total: number;
  valid: number;
  invalid: number;
  outOfScope: number;
  resolved: number;
  unresolved: number;
  groups: number;
  multiGroups: number;
}

export interface FindingsDoc {
  findings: Finding[];
  groups: Group[];
  stats: Stats;
}
