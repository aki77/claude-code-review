// PR レビュー（サマリ + インラインコメント）の投稿ペイロードを組み立てる純ロジック。
// 参照元: claude-plugins の post-review.mjs。投稿本体（gh api 呼び出し）は Phase 5 で実装する。
//
// 設計（決定論化）: LLM は params に一切触れない。FINAL の各 confirmed issue には既に
// resolved / params / path / existingCode が確定しているので、この関数が id で突き合わせて
// params を結合する。LLM は「どの issue に」「どんな文章を」「どんな suggestion を」だけを
// {id, commentBody, suggestion?, deleteLines?} で指定する。
//
// suggestion の破壊的編集防止（fail-closed）: 投稿される置換範囲は params（startLine..line）で
// 機械確定されるが、suggestion 本文の行数が範囲より短いと GitHub は余った行を削除する（実例:
// gitignore の `apm_modules/` がコメント指摘の巻き添えで消えた）。そこで LLM には ```suggestion
// フェンスを書かせず「置換後の行だけ」を渡させ、この関数が FINAL の existingCode（＝範囲の
// 逐語テキスト）と突き合わせて「意図しない行削除」を機械検出する。検出したら suggestion を捨てて
// 文章コメントのみ投稿する（コードは絶対に消さない・レビュー全体は止めない）。

import { prefixToolHeader } from "../report.ts";
import { lineRange, splitAndNormalize } from "./diff-anchor.ts";
import { execFileAsync } from "./exec.ts";
import { normalizeLlmNewlines } from "./sanitize-llm-text.ts";
import type {
  CritComment,
  FinalDoc,
  Issue,
  Params,
  PostReviewComment,
  PostReviewInput,
  RestComment,
  ReviewPayload,
} from "./types.ts";

type Exec = typeof execFileAsync;

// params を GitHub REST の snake_case へ変換する。単一行は line+side のみ、
// 複数行は start_line/start_side も含める。subjectType は落とす。
function toComment(issue: Issue, body: string): RestComment {
  const params = issue.params as Params;
  const comment: RestComment = { path: issue.path, body, line: params.line };
  if (params.side != null) comment.side = params.side;
  if ("startLine" in params && params.startLine != null)
    comment.start_line = params.startLine;
  if ("startSide" in params && params.startSide != null)
    comment.start_side = params.startSide;
  return comment;
}

// suggestion 入力を行配列へ正規化する（string[] / 改行区切り文字列の両方を受ける）。
// 末尾の空行は落とすが、途中の空行は保持する（コードの一部になりうるため）。
function toSuggestionLines(suggestion: string | string[]): string[] {
  const arr = Array.isArray(suggestion)
    ? suggestion
    : String(suggestion).split("\n");
  const lines = arr.map((l) => String(l));
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "")
    lines.pop();
  return lines;
}

// params の範囲行数を返す（単一行なら1、複数行なら line - startLine + 1）。
function rangeLineCount(params: Params): number {
  const [start, end] = lineRange(params);
  return end - start + 1;
}

// commentBody に「suggestion を機械判定で捨てた」注記を付ける（body が空にならないようにもする）。
function withStrippedNote(commentBody: string, reason: string): string {
  const note = `\n\n（自動判定: suggestion がアンカー範囲と不整合のため本文のみ投稿しました。理由: ${reason}）`;
  return `${(commentBody ?? "").trimEnd()}${note}`.trim();
}

export type SuggestionResult =
  | { ok: true; body: string }
  | { ok: false; reason: string };

// suggestion を機械検証し、安全なら ```suggestion フェンス付き本文を、危険なら reason を返す
// （呼び出し側は ok:false なら suggestion を捨てて commentBody のみ投稿する = fail-closed）。
//
// 破壊の本質: GitHub は params の範囲（rangeLineCount 行）を suggestion 本文（sugCount 行）で
// 丸ごと置換する。コード消失が起きるのは sugCount < rangeLineCount のとき「だけ」。行数が同じ
// 編集（2→2, 1→1）や増える編集（1→3）は、内容が変わっても既存行の巻き添え削除は起きない。
// よって行削除（sugCount < rangeLineCount）のときだけ deleteLines での明示を要求すればよい。
//
// 判定（issue は resolved:true 前提。呼び出し側で担保）:
//   1. 複数メンバーグループ（sourceFindingIds.length >= 2）→ existingCode が範囲全体を表さない
//      ため ok:false（安全側）。
//   2. params の範囲行数 ≠ existingCode の行数 → 範囲とアンカーがズレている → ok:false。
//   3. 行削除（sugCount < rangeLineCount）が起きる場合のみ、削減分（shortfall = 範囲行数 -
//      suggestion 行数）だけ deleteLines で消える行を明示させる。消える行（existingCode のうち
//      suggestion に残らない行）がすべて deleteLines に含まれ、その数が shortfall と一致すれば許可。
//      deleteLines 無し／不足なら ok:false（gitignore 事故ケースはここで確実に弾かれる）。
export function buildSuggestionBody(
  issue: Issue,
  suggestion: string | string[],
  deleteLines?: string[],
): SuggestionResult {
  if (
    Array.isArray(issue.sourceFindingIds) &&
    issue.sourceFindingIds.length >= 2
  ) {
    return {
      ok: false,
      reason:
        "複数メンバーの統合 issue には suggestion を付けられません（アンカーが範囲全体を表さない）",
    };
  }
  const existingLines = splitAndNormalize(issue.existingCode ?? "");
  if (existingLines.length === 0) {
    return {
      ok: false,
      reason: "existingCode が空で suggestion を検証できません",
    };
  }
  // 範囲行数と existingCode 行数の一致確認。singleton では resolveAnchor が
  // splitAndNormalize(existingCode) を diff にマッチさせて params を作るため、通常この2つは
  // 一致する。ここは resolveAnchor の不変条件を投稿直前に念のため確認する fail-closed の防波堤。
  if (rangeLineCount(issue.params as Params) !== existingLines.length) {
    return {
      ok: false,
      reason: "params の範囲行数と existingCode の行数が一致しません",
    };
  }

  const sugLines = toSuggestionLines(suggestion);
  const sugNormLines = splitAndNormalize(sugLines.join("\n"));
  const shortfall = existingLines.length - sugNormLines.length;

  if (shortfall > 0) {
    // 行削除が起きる。消える行（既存行のうち suggestion 正規化集合に無いもの）を deleteLines で
    // 明示していないと危険なので捨てる。
    const sugNorm = new Set(sugNormLines);
    const deleteSet = new Set(
      splitAndNormalize((deleteLines ?? []).join("\n")),
    );
    const vanishing = existingLines.filter((l) => !sugNorm.has(l));
    const unexpected = vanishing.filter((l) => !deleteSet.has(l));
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: `suggestion が既存行を削除しますが deleteLines で明示されていません: ${unexpected.join(" / ")}`,
      };
    }
    // 明示された削除行数が実際の削減行数と一致すること（消し過ぎ・行ズレの検出）。
    if (vanishing.length !== shortfall) {
      return {
        ok: false,
        reason: `削除行数（${vanishing.length}）が範囲と suggestion の行数差（${shortfall}）と一致しません`,
      };
    }
  }

  const body = ["```suggestion", ...sugLines, "```"].join("\n");
  return { ok: true, body };
}

// 1 コメントの投稿本文を組み立てる純関数（GitHub REST / crit 出力で共通）。
// リテラル \n を実改行へ正規化し、suggestion があれば機械検証してフェンス結合する。
// 危険な suggestion は fail-closed で捨てて注記付き本文のみにする（コードを消さない）。
export function buildCommentBody(
  issue: Issue,
  comment: PostReviewComment,
): string {
  const normalizedCommentBody = normalizeLlmNewlines(comment.commentBody);
  if (comment.suggestion == null) return normalizedCommentBody;
  const r = buildSuggestionBody(issue, comment.suggestion, comment.deleteLines);
  return r.ok
    ? `${normalizedCommentBody.trimEnd()}\n\n${r.body}`
    : withStrippedNote(normalizedCommentBody, r.reason);
}

// stdin の入力（{summaryBody, comments:[{id,commentBody,suggestion?,deleteLines?}]}）と
// FINAL（confirmed issue 群）を突き合わせて REST API のリクエストボディへ変換する純粋関数。
// 不正な入力（未知/重複 id・resolved:false のインライン化・resolved:true confirmed の黙殺・
// commentBody 空）は Error を投げて呼び出し側で即失敗させる。suggestion の危険は例外にせず
// fail-closed で捨てる（コードを消さない・レビューを止めない）。
export function buildPayload(
  input: PostReviewInput,
  finalDoc: FinalDoc,
  { commitId }: { commitId: string },
): ReviewPayload {
  if (!input || typeof input !== "object") {
    throw new Error("入力 JSON はオブジェクトである必要があります");
  }
  const { comments } = input;
  if (!Array.isArray(comments)) {
    throw new Error(
      "comments は配列である必要があります（[{id, body}] を渡してください）",
    );
  }

  const issues = finalDoc.issues ?? [];
  const issueById = new Map(issues.map((i) => [i.id, i]));
  // インライン投稿できる（=行番号が確定している）confirmed issue の集合。
  const resolvedIds = new Set(
    issues.filter((i) => i.resolved).map((i) => i.id),
  );

  const restComments: RestComment[] = [];
  const seen = new Set<string>();
  comments.forEach((c, i) => {
    if (!c || typeof c.id !== "string") {
      throw new Error(`comments[${i}] は id（文字列）を持つ必要があります`);
    }
    const issue = issueById.get(c.id);
    if (!issue) {
      throw new Error(
        `comments[${i}] の id=${c.id} は FINAL の confirmed issue に存在しません`,
      );
    }
    if (seen.has(c.id)) {
      throw new Error(`comments[${i}] の id=${c.id} が重複しています`);
    }
    seen.add(c.id);
    if (!issue.resolved) {
      // 行番号が確定していない issue はインライン化できない（誤位置に貼らない）。
      throw new Error(
        `comments[${i}] の id=${c.id} は resolved:false（行番号未確定）のためインライン投稿できません。サマリ本文で言及してください`,
      );
    }
    if (typeof c.commentBody !== "string" || c.commentBody.trim() === "") {
      throw new Error(`comments[${i}] の id=${c.id} は commentBody が空です`);
    }

    // 本文組み立て（正規化＋suggestion 検証・結合）は buildCommentBody に集約し、
    // crit 出力（buildCritComments）と共通化する。
    restComments.push(toComment(issue, buildCommentBody(issue, c)));
  });

  // 黙殺防止: インライン投稿可能（resolved:true）な confirmed issue が comments に無いのは
  // 課題が黙って消えるサイレント失敗。投稿前に必ず弾く。resolved 済み issue が0件なら
  // サマリのみ投稿を許容する（課題ゼロ投稿の現行仕様を維持）。
  for (const id of resolvedIds) {
    if (!seen.has(id)) {
      throw new Error(
        `confirmed issue id=${id} は resolved:true ですが comments に含まれていません（黙殺防止）。body を付けて渡すか、対応を見直してください`,
      );
    }
  }

  return {
    commit_id: commitId,
    event: "COMMENT",
    body: prefixToolHeader(normalizeLlmNewlines(input.summaryBody ?? "")),
    comments: restComments,
  };
}

// crit 連携用に PostReviewInput（llmCommentBodies の出力）を {file, line, body} 配列へ
// 変換する純関数。各コメントを id で FINAL の issue に突き合わせ（buildPayload と同じ
// issueById パターン）、本文は buildCommentBody で GitHub インラインと同一に組み立てる。
// line は params が単一行なら数値、複数行なら "start-end" 文字列（crit 準拠）。
// llmCommentBodies は inlineable（resolved:true）のみ comments に入れるため deferred は
// 自然に除外されるが、防御的に issue.resolved も確認する。
export function buildCritComments(
  input: PostReviewInput,
  finalDoc: FinalDoc,
): CritComment[] {
  const issueById = new Map((finalDoc.issues ?? []).map((i) => [i.id, i]));
  const result: CritComment[] = [];
  for (const comment of input.comments) {
    const issue = issueById.get(comment.id);
    if (!issue?.resolved || issue.params == null) continue;
    const [start, end] = lineRange(issue.params);
    const line = start === end ? end : `${start}-${end}`;
    result.push({
      file: issue.path,
      line,
      body: buildCommentBody(issue, comment),
    });
  }
  return result;
}

// step10: 投稿本体（副作用）。純ロジック（buildPayload / buildSuggestionBody）は一切変更せず、
// 検証済みペイロードを gh api 経由で REST に投稿するだけの薄い層に留める。
export async function postReview({
  pr,
  nameWithOwner,
  postInput,
  final,
  commitId,
  exec = execFileAsync,
}: {
  pr: string;
  nameWithOwner: string;
  postInput: PostReviewInput;
  final: FinalDoc;
  commitId: string;
  exec?: Exec;
}): Promise<string> {
  const payload = buildPayload(postInput, final, { commitId });
  const result = await exec(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${nameWithOwner}/pulls/${pr}/reviews`,
      "--input",
      "-",
    ],
    { input: JSON.stringify(payload) },
  );
  if (result.code !== 0) {
    throw new Error(
      `PR #${pr} へのレビュー投稿に失敗しました: ${result.stderr.trim()}`,
    );
  }
  const posted = JSON.parse(result.stdout);
  return posted.html_url;
}
