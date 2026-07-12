// diff パース・アンカー（existingCode）解決の共通モジュール。
//
// 背景: LLM に行番号（line/startLine）を推測させると diff にマッピングできない指定
// （例: 削除を含む修正を単一行で表現してしまう）が生まれ、GitHub 側で位置解決に失敗し
// `line: null` 化する。そこで alibaba/open-code-review 方式を移植し、LLM には「diff 中に
// 実在する連続コード片（existingCode）」だけを出させ、行番号はここで diff hunk との
// テキストマッチで確定する。マッチできなければ行番号を付けず resolved: false を返し、
// 呼び出し側でインライン化せずサマリへ退避させる（誤位置に貼らない）。
//
// このモジュールは複数スクリプト（process-findings.ts 等）から import される純粋ロジック
// で、FS/ネットワークには依存しない（diff テキストと課題オブジェクトを受け取るだけ）。
import type { AnchorResult, Ctx, FilesByPath, Params, Side } from "./types.ts";

// ---- diff hunk パース --------------------------------------------------------
// unified diff の hunk ヘッダ。`@@ -oldStart,oldCount +newStart,newCount @@`
// count は省略可（1 行 hunk のとき）。
export const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// `diff --git a/<path> b/<path>` からファイルパスを取り出す。
// diff は `git -c core.quotepath=false diff` で取得するため、非ASCIIパスもクォート＋
// 8進エスケープされず生の UTF-8 で出力される（呼び出し元 SKILL の統一 diff と同一形式）。
export const fileHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;

// unified diff テキストを { path -> hunks[] } に分解する。
// 各 hunk は行の配列を持ち、各行は { text, oldLine, newLine } を持つ。
//   - context 行(' '): old/new 両方に行番号が付く
//   - added 行  ('+'): new のみ
//   - deleted 行('-'): old のみ
export function parseDiff(diffText: string): FilesByPath {
  const files: FilesByPath = new Map(); // path -> hunks[]
  let curPath: string | null = null;
  let curHunk: { lines: { text: string; oldLine: number | null; newLine: number | null }[] } | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diffText.split("\n")) {
    const fileMatch = raw.match(fileHeaderRe);
    if (fileMatch) {
      // b/ 側（新パス）を採用。リネーム時も新パスでコメントする。
      curPath = fileMatch[2] ?? null;
      if (curPath && !files.has(curPath)) files.set(curPath, []);
      curHunk = null;
      continue;
    }
    // メタ行（index/---/+++/new file 等）は hunk ヘッダ以外スキップ。
    const hunkMatch = raw.match(hunkHeaderRe);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1] ?? "0", 10);
      newLine = parseInt(hunkMatch[3] ?? "0", 10);
      curHunk = { lines: [] };
      if (curPath) files.get(curPath)?.push(curHunk);
      continue;
    }
    if (!curHunk || curPath === null) continue;
    // hunk 本文。先頭 1 文字が種別。'\' は「改行なし」注釈なので無視。
    const marker = raw[0];
    if (marker === "\\") continue;
    const text = raw.slice(1);
    if (marker === "+") {
      curHunk.lines.push({ text, oldLine: null, newLine });
      newLine++;
    } else if (marker === "-") {
      curHunk.lines.push({ text, oldLine, newLine: null });
      oldLine++;
    } else if (marker === " ") {
      curHunk.lines.push({ text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
    // それ以外（空文字＝末尾など）は無視。
  }
  return files;
}

// ---- 正規化 & マッチ ---------------------------------------------------------
// 比較用に行を正規化する。前後空白を除去し、LLM が付けがちな先頭の diff マーカー
// （'+' / '-' / 先頭スペース）を 1 つ剥がす。インデント差や貼り付け由来のマーカーを吸収。
export function normalizeLine(line: string): string {
  let s = line;
  if (s.startsWith("+") || s.startsWith("-")) s = s.slice(1);
  return s.trim();
}

export function splitAndNormalize(code: string): string[] {
  return code
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0); // 空行はアンカーにしない
}

interface SideLine {
  lineNo: number;
  norm: string;
}

// hunk 群から、指定 side（"new" or "old"）の行だけを行番号付きで平坦化する。
export function sideLines(
  hunks: { lines: { text: string; oldLine: number | null; newLine: number | null }[] }[],
  side: Side,
): SideLine[] {
  const out: SideLine[] = [];
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      const ln = side === "new" ? l.newLine : l.oldLine;
      if (ln != null) out.push({ lineNo: ln, norm: normalizeLine(l.text) });
    }
  }
  return out;
}

interface MatchRange {
  startLine: number;
  endLine: number;
}

// side 行列（{lineNo, norm}[]）に対し、needle（正規化済み文字列配列）が連続一致する
// 箇所を探す。ちょうど 1 箇所だけ一致したとき { startLine, endLine } を返す。
// 0 箇所または複数箇所（曖昧）は null。
export function matchConsecutive(lines: SideLine[], needle: string[]): MatchRange | null {
  if (needle.length === 0) return null;
  const found: MatchRange[] = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j]?.norm !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const first = lines[i];
      const last = lines[i + needle.length - 1];
      if (first && last) {
        found.push({
          startLine: first.lineNo,
          endLine: last.lineNo,
        });
      }
    }
  }
  if (found.length !== 1) return null; // 0=不一致 / 2+=曖昧 はどちらも解決失敗扱い
  return found[0] ?? null;
}

// 1 課題のアンカー（existingCode）を解決する。new 側優先、なければ old 側でマッチを試みる。
// 戻り値:
//   解決成功: { resolved: true,  side, params: { line, startLine?, side?, startSide?, subjectType } }
//   解決失敗: { resolved: false, reason }
// side（"new"|"old"）を params とは別に併記するのは、機械グルーピングで side をキーに
// 使うため（params には GitHub 用の "RIGHT"/"LEFT" が入る）。
export function resolveAnchor(
  { path, existingCode }: { path?: string; existingCode?: string },
  filesByPath: FilesByPath,
): AnchorResult {
  if (!path || !existingCode) {
    return { resolved: false, reason: "path または existingCode が未指定" };
  }
  const hunks = filesByPath.get(path);
  if (!hunks || hunks.length === 0) {
    return { resolved: false, reason: "対象ファイルの差分が見つからない" };
  }
  const needle = splitAndNormalize(existingCode);
  if (needle.length === 0) {
    return { resolved: false, reason: "existingCode が空" };
  }

  for (const side of ["new", "old"] as const) {
    const m = matchConsecutive(sideLines(hunks, side), needle);
    if (!m) continue;
    const commentSide = side === "new" ? "RIGHT" : "LEFT";
    if (m.startLine === m.endLine) {
      // 単一行: line と side のみ。GitHub の単一行コメント形式。
      return {
        resolved: true,
        side,
        params: { line: m.endLine, side: commentSide, subjectType: "LINE" },
      };
    }
    // 複数行: startLine..line を範囲指定。
    return {
      resolved: true,
      side,
      params: {
        startLine: m.startLine,
        line: m.endLine,
        startSide: commentSide,
        side: commentSide,
        subjectType: "LINE",
      },
    };
  }
  return {
    resolved: false,
    reason: "existingCode が diff に一意に一致しない（不一致または複数一致）",
  };
}

// ---- Params 範囲ヘルパー ------------------------------------------------------
// params から [startLine, endLine] を取り出す（単一行は line が両方を兼ねる）。
export function lineRange(params: Params): [number, number] {
  const end = params.line;
  const start = "startLine" in params ? params.startLine : end;
  return [Math.min(start, end), Math.max(start, end)];
}

// ---- diff 取得引数の組み立て -------------------------------------------------
// CTX（collect-review-context の出力）から `git diff` の引数を組み立てる。
// review-core.md の統一則「git diff <diffArgs> <excludeArgs.git>」と同じ並びを再現し、
// アンカー（existingCode）を取ったのと同一の diff をマッチ対象にする。
// core.quotepath=false を明示することで非ASCIIパスも生の UTF-8 で出力させる。
export function buildDiffArgs(ctx: Ctx): string[] {
  const diffArgs = ctx.diffArgs ?? [];
  const excludeArgs = ctx.excludeArgs?.git ?? [];
  return ["-c", "core.quotepath=false", "diff", ...diffArgs, ...excludeArgs];
}
