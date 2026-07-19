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

// ---- validate-clusters 関連 ------------------------------------------------

export interface Cluster {
  id: number;
  theme: string;
  changedFiles: string[];
  symbols: string[];
  contextHints: string[];
}

export interface ClustersDoc {
  clusters: Cluster[];
  fallback: boolean;
  removedPaths: string[];
  appendedPaths: string[];
  /** tierReducedClusters が生成した縮退のときだけ true（壊れ入力の fallback と区別）。 */
  tierReduced?: boolean;
}

// ---- merge-findings 関連 ---------------------------------------------------

export interface MergeText {
  groupId: string;
  title: string;
  body: string;
}

export interface Issue {
  id: string;
  path: string;
  kind: Kind;
  category: Category | undefined;
  severity: Severity | undefined;
  title: string;
  body: string;
  ruleRefs: string[];
  existingCode?: string;
  resolved: boolean;
  sourceFindingIds: string[];
  /** resolved のときのみ設定。 */
  params?: Params;
  /** 未 resolved かつ reason があるときのみ設定。 */
  reason?: string;
}

export interface MergeStats {
  groups: number;
  issues: number;
  merged: number;
  resolved: number;
  unresolved: number;
}

export interface IssuesDoc {
  issues: Issue[];
  stats: MergeStats;
}

// ---- apply-verdicts 関連 ----------------------------------------------------

export type VerdictKind = "confirmed" | "rejected";

export interface Verdict {
  id: string;
  verdict: VerdictKind;
  reason?: string;
}

export interface RejectedIssue {
  id: string;
  path: string;
  title: string;
  reason: string;
}

export interface FinalStats {
  total: number;
  confirmed: number;
  rejected: number;
  unverified: number;
}

export interface FinalDoc {
  issues: Issue[];
  rejected: RejectedIssue[];
  unverified: string[];
  stats: FinalStats;
}

// ---- collect-context 関連 ---------------------------------------------------

export type Tier = "small" | "normal";
export type ContextSource = "pr" | "range" | "workspace";

export interface Metrics {
  totalFiles: number;
  totalAdded: number;
  totalDeleted: number;
  totalChangedLines: number;
}

/** buildAssignments の1バケット。files はソート済み。 */
export interface Assignment {
  files: Array<{ path: string; rules: string[] }>;
}

export interface Context {
  source: ContextSource;
  changedFiles: string[];
  excludedFiles: string[];
  oversizedFiles: string[];
  excludeArgs: { git: string[] };
  assignments: Assignment[];
  metrics: Metrics;
  tier: Tier;
  diffArgs: string[];
  range?: string;
  /** workspace モードのときのみ設定。diff 取得・アンカー再解決の exec に渡す env override。 */
  diffEnv?: Record<string, string>;
  /** workspace モードで未コミット差分が空だったため base 差分にフォールバックしたとき true。 */
  fellBackToRange?: boolean;
}

/** collectRules / rulesForFile が扱うルール定義。paths=null は全ファイル適用。 */
export interface Rule {
  path: string;
  paths: string[] | null;
}

// ---- post-review 関連 -------------------------------------------------------

/** LLM が返す 1 コメント分の入力。 */
export interface PostReviewComment {
  id: string;
  commentBody: string;
  suggestion?: string | string[];
  deleteLines?: string[];
}

/** LLM が返す投稿入力全体。 */
export interface PostReviewInput {
  summaryBody?: string;
  comments: PostReviewComment[];
}

/**
 * crit 連携用の 1 コメント。`crit comment --json` がそのまま受け取れる
 * `{file, line, body}` 形式。line は単一行なら数値、複数行なら "start-end" 文字列。
 */
export interface CritComment {
  file: string;
  line: number | string;
  body: string;
}

/** REST PR レビューコメント（buildPayload の出力要素）。 */
export interface RestComment {
  path: string;
  body: string;
  line: number;
  side?: CommentSide;
  start_line?: number;
  start_side?: CommentSide;
}

/** REST POST /pulls/{n}/reviews のリクエストボディ。 */
export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: RestComment[];
}

// ---- llm/client 関連 --------------------------------------------------------

// LLM 構造化出力のスキーマ。SDK の JsonSchemaOutputFormat.schema と同形。
export type JSONSchema = Record<string, unknown>;

// ---- ファイル読込 DI ---------------------------------------------------------

// ファイル読込用の DI 関数型。読めなければ null を返す（例外を投げない）。
// `src/llm/steps.ts` の defaultReadFile（fs.readFileSync ベース）と
// `src/lib/background.ts` の loadBackgroundFile が共有する。
export type ReadFileFn = (relPath: string) => string | null;

// ---- --debug / --summary-file 関連 ------------------------------------------

// --debug 時に各パイプライン段が出す (label, obj) の蓄積単位。`src/pipeline.ts` の
// makeDebugSink が生成し、`src/report.ts` の formatDebugMarkdown が Markdown 化する。
export interface DebugEntry {
  label: string;
  obj: unknown;
}

// --debug 時のログ出力関数。`src/llm/steps.ts`（各ステップ）・`src/llm/client.ts`
// （runStructured）・`src/pipeline.ts`（makeDebugSink が実体を生成）が共有する型のため、
// 特定レイヤに属させず types.ts に置く。
export type DebugSink = (label: string, obj: unknown) => void;
