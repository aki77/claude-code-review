// LLM ステップ（step2/3/5/6）向けのプロンプトテンプレートと JSON Schema。
//
// 副作用なし・ファイル I/O なしの純関数のみを置く。
// 大半のステップは allowedTools: []（ツール不可）のワンショットで、rules 本文・REVIEW.md・
// contextHints ファイルなど「埋め込み済み文字列」を受け取ってテンプレートへ差し込むだけに
// 徹する。ファイルの読み込みは steps.ts が行う。
// 例外: 検証(step6)・agent4（クロスファイル参照）は read-only ツール（Read/Grep/Glob）の
// 使用を前提にプロンプトを書く（steps.ts が allowedTools を明示的に渡す）。
import type { Cluster, Issue, JSONSchema } from "../lib/types.ts";

// ---- 誤検知除外リスト（元プラグイン shared/review-core.md 由来） -------------
// 元プラグインはステップ3・6の両方に適用していたが、本再実装では検証(step6)にのみ
// 集約する: 発見段階（agent1-5）は幅広く拾い、確度の担保は検証エージェントが
// read-only ツールで実コードに当たって行う（「既存問題か」「lint 類か」を実際に確認できる）。
export const FALSE_POSITIVE_EXCLUSIONS =
  "次に該当するものは誤検知として rejected にしてください:\n" +
  "- レビュー対象の変更より前から存在する問題（今回の変更が持ち込んだものではない）\n" +
  "- バグに見えるが実際は正しい挙動\n" +
  "- シニアエンジニアであれば指摘しないような細かすぎる指摘\n" +
  "- リンタが検出する類の問題（リンタを実際に走らせて検証する必要はない）\n" +
  "- プロジェクトルールで明示的に求められていない、一般的なコード品質の懸念" +
  "（テストカバレッジ不足、一般的なセキュリティ懸念など）\n" +
  "- プロジェクトルールに記載があっても、コード側で明示的に抑制されている事項" +
  "（lint の ignore コメントなど）";

// ---- モデルエイリアス定数 ----------------------------------------------------
// runStructured の model はそのまま SDK query() → claude CLI へ渡る（client.ts）。
// CLI が sonnet/opus エイリアスを解決するのでフルモデル ID をハードコードしない。
export const MODEL_LIGHT = "sonnet"; // agent1/2/5・rule 検証
export const MODEL_HEAVY = "opus"; // agent3/4・bug 検証

// read-only ツール一式（Read/Grep/Glob）。実コードに当たって判断する必要がある
// ステップ（検証(step6)・agent4 のクロスファイル参照）だけがこれを allowedTools に渡す。
// steps.ts の2箇所で同じ配列をベタ書きせず、ここを単一の情報源にする。
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

// ---- JSON Schema 定数 --------------------------------------------------------

export const SUMMARY_CLUSTERS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          theme: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          contextHints: { type: "array", items: { type: "string" } },
        },
        required: ["id", "theme", "changedFiles"],
      },
    },
  },
  required: ["summary", "clusters"],
};

// summary のみを求めるとき（small かつ clusters 不要）用の縮小スキーマ。
export const SUMMARY_ONLY_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

// finding 配列スキーマ。行番号フィールドを定義しない（設計原則の schema レベル担保）。
// Anthropic API の json_schema 出力はトップレベルが object である制約があるため
// （配列を直接トップレベルにすると `input_schema.type: Input should be 'object'` で
// 400 エラーになる）、{ findings: Finding[] } でラップする。呼び出し側（steps.ts）が
// .findings を取り出す。
// agent フィールドも定義しない: どのエージェント由来かはコード側（steps.ts の stampAgent）が
// 呼び出し元の文脈から機械的に確定するため、LLM に出力させて後から上書きする対症療法にしない。
export const FINDINGS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          existingCode: { type: "string" },
          ruleRefs: { type: "array", items: { type: "string" } },
          category: {
            type: "string",
            enum: ["bug", "security", "performance", "rule-violation"],
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
        },
        required: [
          "path",
          "title",
          "body",
          "existingCode",
          "category",
          "severity",
        ],
      },
    },
  },
  required: ["findings"],
};

// groupId は LLM に出させずコード側が付与する。
export const MERGE_TEXT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["title", "body"],
};

// id は LLM に出させずコード側が付与する。
export const VERDICT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["confirmed", "rejected"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
};

// step9: PR コメント本文作成。```suggestion フェンス（buildSuggestionBody が組む、
// post-review.ts:142）と category/severity バッジ・パーマリンク（steps.ts が TS で付与）は
// スキーマに含めない。LLM には文章と「置換後の行だけ」の suggestion 案のみを書かせる。
export const COMMENT_BODIES_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    summaryBody: { type: "string" },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          commentBody: { type: "string" },
          suggestion: { type: "array", items: { type: "string" } },
          deleteLines: { type: "array", items: { type: "string" } },
        },
        required: ["id", "commentBody"],
      },
    },
  },
  required: ["summaryBody", "comments"],
};

// ---- 共通の「参照コンテキストなし」文言 --------------------------------------
// 埋め込みが空（ファイル欠落）の場合に使う。存在しないファイルを LLM に想像させない。
const NO_CONTEXT_NOTE = "（参照コンテキストなし）";

// FINDINGS_SCHEMA が { findings: Finding[] } でラップされている（Anthropic API の
// json_schema 出力はトップレベルが object である制約のため）ことを全レビューエージェントの
// user prompt 末尾で明示する共通文言。
const FINDINGS_OUTPUT_INSTRUCTION =
  '出力は { "findings": [...] } の形（findings キー配下に finding 配列）にすること。' +
  "指摘がなければ findings を空配列にすること。";

// 全レビューエージェント（agent1/2/3/4/5）の system prompt 共通の existingCode 指示。
// 行番号は resolveAnchor（diff-anchor.ts）が機械的に確定するため LLM には書かせず、
// diff に実在する連続コード片の逐語コピーのみを出力させる（設計原則の徹底のため4エージェント
// 分の文言を1箇所に集約）。
const EXISTING_CODE_INSTRUCTION =
  "existingCode には diff に実在する連続コード片を逐語コピーしてください（行番号は書かない）。" +
  "追加行と削除行を1つのアンカーに混在させないこと。";

function joinFileTexts(
  files: { path: string; content: string | null }[],
): string {
  const available = files.filter((f) => f.content !== null);
  if (available.length === 0) return NO_CONTEXT_NOTE;
  return available.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

// ---- step2: サマリ + 影響クラスタ分割 ----------------------------------------

export function summaryClustersSystem({
  wantClusters,
}: {
  wantClusters: boolean;
}): string {
  const base =
    "あなたはコードレビューの準備を行うアシスタントです。与えられたコミット情報/diff から、" +
    "変更の意図・全体像・主要な変更点を要約してください。";
  if (!wantClusters) {
    return `${base}\nクラスタ分割は不要です。summary のみを返してください。`;
  }
  return (
    `${base}\n` +
    "加えて、後続のクロスファイル整合性チェックを並列化するための「影響クラスタ」分割案を作成してください。\n" +
    "指針:\n" +
    "- 変更を「一緒に見ないと整合性を判定できないファイル群」ごとにまとめる。呼び出し側と定義側、型と参照側、" +
    "相互に依存する変更は同一クラスタにする。\n" +
    "- クラスタ数は最大3にキャップする。変更が小さく分けられない場合はクラスタ1つでよい。\n" +
    "- 各クラスタの changedFiles の合計が変更ファイルをおおむね覆うようにする。\n" +
    "- changedFiles と symbols は、与えられた diff に現れるものだけを列挙する。diff に無いファイルを含めない。" +
    "diff 外の参照先は contextHints にのみ記載する。"
  );
}

export function summaryClustersUser({
  authorInfo,
  diffText,
  wantClusters,
}: {
  authorInfo: string;
  diffText: string;
  wantClusters: boolean;
}): string {
  const clusterNote = wantClusters
    ? ""
    : "\n\nclusters は空配列 [] を返してください（分割は不要です）。";
  return `## 著者意図情報\n${authorInfo}\n\n## 差分\n${diffText}${clusterNote}`;
}

// ---- agent1/2: プロジェクトルール準拠チェック --------------------------------

export function ruleAgentSystem(): string {
  return (
    "あなたはプロジェクトルール（CLAUDE.md および .claude/rules/ 配下のルールファイル）への" +
    "準拠を監査するレビューエージェントです。\n" +
    "担当ファイルの `rules` に列挙されたルールファイルのみを適用してください。`rules` に含まれない" +
    "ルールでそのファイルを指摘しないこと。\n" +
    "各指摘は category を必ず rule-violation にし、ruleRefs に適用したルールファイルのパスを" +
    "非空配列で含めてください。\n" +
    `${EXISTING_CODE_INSTRUCTION}\n` +
    "確信が持てない指摘は行わないこと。"
  );
}

export function ruleAgentUser({
  agent,
  assignment,
  ruleTexts,
  summary,
  diffText,
}: {
  agent: number;
  assignment: { files: { path: string; rules: string[] }[] };
  ruleTexts: { path: string; content: string | null }[];
  summary: string | null;
  diffText: string;
}): string {
  const filesList = assignment.files
    .map(
      (f) =>
        `- ${f.path} (rules: ${f.rules.length > 0 ? f.rules.join(", ") : "なし"})`,
    )
    .join("\n");
  return (
    `あなたはエージェント${agent}です。\n\n` +
    `## 担当ファイル\n${filesList}\n\n` +
    `## 適用ルール本文\n${joinFileTexts(ruleTexts)}\n\n` +
    `## 著者意図情報\n${summary ?? "（サマリなし）"}\n\n` +
    `## 差分（全体）\n${diffText}\n\n` +
    `担当ファイルについて、上記ルールへの違反を指摘してください。${FINDINGS_OUTPUT_INSTRUCTION}`
  );
}

// ---- agent3: バグ検出（diff 限定） -------------------------------------------

export function bugAgentSystem(): string {
  return (
    "あなたはバグ検出を専門とするレビューエージェントです。明らかなバグを探してください。\n" +
    "diff の内容のみに注目し、追加コンテキストの参照は行わないこと。git diff 外のコンテキストを" +
    "参照しないと判断できない指摘は行わないこと。\n" +
    "重大なバグのみを指摘し、些細な指摘や誤検知の可能性が高いものは無視してください。\n" +
    "category は bug / security / performance のいずれか最も当てはまるものを選んでください" +
    "（rule-violation は使わないこと）。\n" +
    EXISTING_CODE_INSTRUCTION
  );
}

export function bugAgentUser({
  summary,
  diffText,
}: {
  summary: string | null;
  diffText: string;
}): string {
  return (
    `## 著者意図情報\n${summary ?? "（サマリなし）"}\n\n` +
    `## 差分\n${diffText}\n\n` +
    `明らかなバグを指摘してください。${FINDINGS_OUTPUT_INSTRUCTION}`
  );
}

// ---- agent4: クロスファイル整合性チェック（クラスタ単位） --------------------

export function clusterAgentSystem(): string {
  return (
    "あなたはバグ検出／クロスファイル整合性チェックを専門とするレビューエージェントです。" +
    "担当クラスタの changedFiles に導入された問題（セキュリティ問題、ロジック誤り、" +
    "クロスファイル整合性の崩れなど）を探してください。\n" +
    "diff と埋め込みコンテキストに加え、Read/Grep/Glob ツールで呼び出し元・関連定義・" +
    "テストなど diff 外のファイルも必要に応じて確認してよい。それでも確信が持てない場合は" +
    "指摘しないこと。\n" +
    "確認observation の例:\n" +
    "- 変更したメソッド/関数のシグネチャ変更が、呼び出し側と整合しているか\n" +
    "- 変更で導入/変更した定数・列挙値・型が、参照側の分岐ロジックと整合しているか\n" +
    "- 変更したモジュール/クラスが、依存する他モジュール・テストと整合しているか\n" +
    "自クラスタの changedFiles に導入された問題のみを指摘し、他クラスタの変更は担当外として" +
    "無視してください。\n" +
    "category は bug / security / performance のいずれか（rule-violation は使わないこと）。\n" +
    EXISTING_CODE_INSTRUCTION
  );
}

export function clusterAgentUser({
  cluster,
  summary,
  diffText,
  contextFiles,
}: {
  cluster: Cluster;
  summary: string | null;
  diffText: string;
  contextFiles: { path: string; content: string | null }[];
}): string {
  return (
    `## 担当クラスタ\n` +
    `id: ${cluster.id}\n` +
    `theme: ${cluster.theme}\n` +
    `changedFiles: ${cluster.changedFiles.join(", ")}\n` +
    `symbols: ${cluster.symbols.join(", ") || "（なし）"}\n\n` +
    `## 著者意図情報\n${summary ?? "（サマリなし）"}\n\n` +
    `## 参照コンテキスト（contextHints のうち存在するファイルのみ）\n${joinFileTexts(contextFiles)}\n\n` +
    `## 差分（このクラスタの changedFiles のみ）\n${diffText}\n\n` +
    `担当クラスタの changedFiles に導入された問題を指摘してください。${FINDINGS_OUTPUT_INSTRUCTION}`
  );
}

// ---- agent5: REVIEW.md 準拠チェック ------------------------------------------

export function reviewMdAgentSystem(): string {
  return (
    "あなたは REVIEW.md に記載されたレビュー観点への新規違反を監査するレビューエージェントです。\n" +
    "高シグナルな指摘のみを対象とします。以下に該当する指摘のみを行ってください:\n" +
    "- コードがコンパイル/パースに失敗する（構文エラー、型エラー、import漏れ、未定義参照など）\n" +
    "- 入力に関わらず明らかに誤った結果を返す（明確なロジックエラー）\n" +
    "- 該当ルールを引用できる、明白かつ明確なプロジェクトルール違反\n" +
    "以下は指摘しないこと: コードスタイルや品質に関する懸念、特定の入力や状態に依存する潜在的な問題、" +
    "主観的な提案や改善案。実際に問題かどうか確信が持てない場合は指摘しないこと。\n" +
    "category は必ず rule-violation にし、ruleRefs に REVIEW.md（および参照した観点ファイル）の" +
    "パスを非空配列で含めてください。\n" +
    EXISTING_CODE_INSTRUCTION
  );
}

export function reviewMdAgentUser({
  reviewMd,
  summary,
  diffText,
}: {
  reviewMd: string;
  summary: string | null;
  diffText: string;
}): string {
  return (
    `## REVIEW.md\n${reviewMd}\n\n` +
    `## 著者意図情報\n${summary ?? "（サマリなし）"}\n\n` +
    `## 差分\n${diffText}\n\n` +
    `REVIEW.md への新規違反を指摘してください。${FINDINGS_OUTPUT_INSTRUCTION}`
  );
}

// ---- step5: 統合文章作成 -----------------------------------------------------

export function mergeTextSystem(): string {
  return (
    "あなたは複数の重複する指摘を1件に統合するレビューエージェントです。\n" +
    "同一箇所の重複指摘を1件にまとめてください。趣旨の異なる指摘が同一箇所に集まっている場合は、" +
    "箇条書きで両方の趣旨を残してください（片方を捨てないこと）。\n" +
    "引用元リンク（ルール系の指摘なら該当ルールファイルへのリンク）を残してください。"
  );
}

export function mergeTextUser({
  members,
}: {
  members: { title?: string; body?: string }[];
}): string {
  const list = members
    .map(
      (m, i) =>
        `### 指摘${i + 1}\ntitle: ${m.title ?? ""}\nbody: ${m.body ?? ""}`,
    )
    .join("\n\n");
  return `以下の複数の指摘を1件に統合し、title と body を返してください。\n\n${list}`;
}

// ---- step6: 検証 --------------------------------------------------------------

export function verifySystem(): string {
  return (
    "あなたは提示された課題が高い確度で実際の問題であるかを検証するレビューエージェントです。\n" +
    "Read/Grep/Glob ツールを使って対象ファイルの実コードを確認し、既存の挙動・呼び出し元・型定義を" +
    "踏まえて判定してください。ツールを使わず issue の説明文だけで判定しないこと。\n" +
    "例えば「変数が未定義」と指摘された場合、コード上で実際にそれが正しいかを確認してください。\n" +
    "プロジェクトルール違反の場合、適用スコープは確定済みのため、その範囲内で実際に違反しているかのみを" +
    "検証してください。\n" +
    `${FALSE_POSITIVE_EXCLUSIONS}\n\n` +
    "実際の問題だと高い確度で確認できたら confirmed、そうでなければ rejected を返してください。" +
    "reason には判定の根拠を1〜2文で書いてください。"
  );
}

export function verifyUser({
  issue,
  summary,
  diffText,
}: {
  issue: {
    path: string;
    kind: string;
    title: string;
    body: string;
    params?: unknown;
  };
  summary: string | null;
  diffText: string;
}): string {
  const lineInfo =
    issue.params && typeof issue.params === "object" && "line" in issue.params
      ? `\n行番号情報: ${JSON.stringify(issue.params)}`
      : "";
  return (
    `## 著者意図情報\n${summary ?? "（サマリなし）"}\n\n` +
    `## 検証対象 issue\n` +
    `path: ${issue.path}\n` +
    `kind: ${issue.kind}\n` +
    `title: ${issue.title}\n` +
    `body: ${issue.body}` +
    lineInfo +
    `\n\n## 検証対象の差分（このファイル）\n${diffText || NO_CONTEXT_NOTE}\n\n` +
    `まず上記の差分で今回の変更が実際に何を変えたか（追加/削除行）を確認し、` +
    `そのうえで Read ツールで ${issue.path} を読み、必要なら Grep/Glob で呼び出し元や` +
    "関連定義も確認してください。指摘が今回の変更で持ち込まれたものか、変更より前から" +
    "存在するものかは差分で判断してください。そのうえでこの課題が実際の問題かどうかを" +
    "検証し、verdict と reason を返してください。"
  );
}

// ---- step4b: 未解決アンカー再解決 ---------------------------------------------
// 既存の RETRY_ANCHOR_SCHEMA も Anthropic API のトップレベル object 制約に合わせ
// { patches: [...] } でラップする（FINDINGS_SCHEMA と同型の理由）。
export const RETRY_ANCHOR_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          existingCode: { type: "string" },
        },
        required: ["id", "existingCode"],
      },
    },
  },
  required: ["patches"],
};

export function retryAnchorSystem(): string {
  return (
    "あなたは diff アンカー（existingCode）の再解決を行うアシスタントです。\n" +
    "各 finding の existingCode が diff に一意一致せず未解決になりました。diff に実在する" +
    "連続コード片へ逐語コピーし直してください。\n" +
    `${EXISTING_CODE_INSTRUCTION}\n` +
    "id は入力のまま変更せずそのまま返してください。"
  );
}

export function retryAnchorUser({
  unresolved,
  diffText,
}: {
  unresolved: {
    id: string;
    path?: string;
    existingCode?: string;
    reason?: string;
  }[];
  diffText: string;
}): string {
  const list = unresolved
    .map(
      (f) =>
        `### id: ${f.id}\n` +
        `path: ${f.path ?? ""}\n` +
        `現在の existingCode:\n${f.existingCode ?? ""}\n` +
        `未解決理由: ${f.reason ?? ""}`,
    )
    .join("\n\n");
  return (
    `## 未解決 finding 一覧\n${list}\n\n` +
    `## 差分\n${diffText}\n\n` +
    "各 finding について、diff に実在する連続コード片へ existingCode を逐語コピーし直し、" +
    '{ "patches": [{ "id": ..., "existingCode": ... }, ...] } の形で返してください。'
  );
}

// ---- step9: PR コメント本文作成 ------------------------------------------------

export function commentBodiesSystem(): string {
  return (
    "あなたは確定した課題一覧を GitHub PR レビューコメントの文章に仕立てるアシスタントです。\n" +
    "各課題の commentBody には、指摘内容の説明文のみを書いてください。" +
    "category/severity のバッジや引用元パーマリンクは書かないこと（コード側が自動的に先頭へ付与します）。\n" +
    "suggestion は、修正が小規模・自己完結・かつ単一 finding 由来の課題のときのみ付けてください" +
    "（複数の指摘が統合された課題には付けないこと）。\n" +
    "suggestion を書く場合は ```suggestion フェンスを書かず、置換後の行だけを配列で渡してください。" +
    "existingCode の行のうち、suggestion に残らず削除される行があれば、その行の内容をそのまま" +
    "deleteLines に明示してください（明示が無い・不足していると suggestion は投稿時に破棄されます）。\n" +
    "resolved:false（行番号未確定）の課題は comments に含めず、summaryBody 側で言及してください。"
  );
}

export function commentBodiesUser({
  inlineable,
  deferred,
}: {
  inlineable: Issue[];
  deferred: Issue[];
}): string {
  const formatIssue = (issue: Issue) =>
    `### id: ${issue.id}\n` +
    `path: ${issue.path}\n` +
    `category: ${issue.category ?? "-"}\n` +
    `severity: ${issue.severity ?? "-"}\n` +
    `title: ${issue.title}\n` +
    `body: ${issue.body}\n` +
    `existingCode:\n${issue.existingCode ?? "（なし）"}`;

  const inlineableSection =
    inlineable.length > 0
      ? inlineable.map(formatIssue).join("\n\n")
      : "（なし）";
  const deferredSection =
    deferred.length > 0 ? deferred.map(formatIssue).join("\n\n") : "（なし）";

  return (
    `## インライン投稿対象（行番号確定済み）\n${inlineableSection}\n\n` +
    `## サマリのみ言及対象（行番号未確定）\n${deferredSection}\n\n` +
    "インライン投稿対象それぞれについて { id, commentBody, suggestion?, deleteLines? } を、" +
    "サマリのみ言及対象については summaryBody 内で触れてください。" +
    '出力は { "summaryBody": string, "comments": [...] } の形にすること。'
  );
}
