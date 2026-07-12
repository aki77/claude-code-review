import { describe, expect, it } from "vitest";
import {
  buildDiffArgs,
  hunkHeaderRe,
  parseDiff,
  resolveAnchor,
  sideLines,
} from "../src/lib/diff-anchor.ts";

// 新規ファイル diff（全行 added、new 側 1..N に対応）を組み立てるヘルパ。
const path = "src/sample.js";
const bodyLines = [
  "export function first() {}", // 1
  "", // 2
  "// このコメントは自明なので削除したい", // 3
  "export function target() {}", // 4
  "const UNIQUE_MARKER = 1;", // 5
];
const buildDiff = () =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${bodyLines.length} @@`,
    ...bodyLines.map((l) => `+${l}`),
  ].join("\n");

describe("diff-anchor", () => {
  it("parseDiff: 新規ファイルの全行に new 側行番号が 1 から付く", () => {
    const files = parseDiff(buildDiff());
    const hunks = files.get(path);
    expect(hunks && hunks.length === 1).toBeTruthy();
    const newLines = sideLines(hunks!, "new");
    expect(newLines[0]!.lineNo).toBe(1);
    expect(newLines[0]!.norm).toBe("export function first() {}");
    const target = newLines.find(
      (l) => l.norm === "export function target() {}",
    );
    expect(target!.lineNo).toBe(4);
  });

  it("hunkHeaderRe: count 省略ヘッダをパースできる", () => {
    const m = "@@ -1 +1 @@".match(hunkHeaderRe);
    expect(m).toBeTruthy();
    expect(m![1]).toBe("1");
    expect(m![3]).toBe("1");
  });

  it("resolveAnchor: コメント削除(2行→1行)は範囲 startLine..line を返す", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      {
        path,
        existingCode:
          "// このコメントは自明なので削除したい\nexport function target() {}",
      },
      files,
    );
    expect(r.resolved).toBe(true);
    expect((r as { side: string }).side).toBe("new");
    expect((r as { params: unknown }).params).toEqual({
      startLine: 3,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  it("resolveAnchor: 単一行アンカーは line と side のみ（startLine なし）", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path, existingCode: "const UNIQUE_MARKER = 1;" },
      files,
    );
    expect(r.resolved).toBe(true);
    expect((r as { params: unknown }).params).toEqual({
      line: 5,
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  it("正規化: インデント差・diff マーカー付き入力でも一致する", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path, existingCode: "+   export function target() {}" },
      files,
    );
    expect(r.resolved).toBe(true);
    expect((r as { params: { line: number } }).params.line).toBe(4);
    expect((r as { params: { subjectType: string } }).params.subjectType).toBe(
      "LINE",
    );
  });

  it("resolveAnchor: 不一致の existingCode は resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path, existingCode: "export function nonexistent() {}" },
      files,
    );
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/一致/);
  });

  it("resolveAnchor: 複数一致（曖昧）は resolved:false", () => {
    const diff = [
      "diff --git a/src/dup.js b/src/dup.js",
      "--- /dev/null",
      "+++ b/src/dup.js",
      "@@ -0,0 +1,3 @@",
      "+dup",
      "+other",
      "+dup",
    ].join("\n");
    const files = parseDiff(diff);
    const r = resolveAnchor({ path: "src/dup.js", existingCode: "dup" }, files);
    expect(r.resolved).toBe(false);
  });

  it("resolveAnchor: 差分にないファイルは resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path: "src/other.js", existingCode: "anything" },
      files,
    );
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/差分が見つからない/);
  });

  it("resolveAnchor: 削除行(old側)にもマッチする", () => {
    const diff = [
      "diff --git a/src/edit.js b/src/edit.js",
      "--- a/src/edit.js",
      "+++ b/src/edit.js",
      "@@ -10,3 +10,2 @@",
      " keep_before",
      "-removed_line",
      " keep_after",
    ].join("\n");
    const files = parseDiff(diff);
    const r = resolveAnchor(
      { path: "src/edit.js", existingCode: "removed_line" },
      files,
    );
    expect(r.resolved).toBe(true);
    expect((r as { side: string }).side).toBe("old");
    expect((r as { params: { line: number } }).params.line).toBe(11);
    expect((r as { params: { side: string } }).params.side).toBe("LEFT");
  });

  it("非ASCIIパス: quotepath=false の生UTF-8 diff で行番号を解決できる", () => {
    const nonAsciiPath = "docs/仕様メモ.md";
    const diff = [
      `diff --git a/${nonAsciiPath} b/${nonAsciiPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${nonAsciiPath}`,
      "@@ -0,0 +1,2 @@",
      "+# 見出し",
      "+本文行",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.get(nonAsciiPath)).toBeTruthy();
    const r = resolveAnchor(
      { path: nonAsciiPath, existingCode: "# 見出し" },
      files,
    );
    expect(r.resolved).toBe(true);
    expect((r as { params: { line: number } }).params.line).toBe(1);
    expect((r as { params: { side: string } }).params.side).toBe("RIGHT");
  });

  it("buildDiffArgs: range モードは core.quotepath=false 付きで range を渡す", () => {
    const args = buildDiffArgs({
      diffArgs: ["abc123...HEAD"],
      excludeArgs: { git: [] },
    });
    expect(args).toEqual([
      "-c",
      "core.quotepath=false",
      "diff",
      "abc123...HEAD",
    ]);
  });

  it("buildDiffArgs: staged モードと除外引数を連結する", () => {
    const args = buildDiffArgs({
      diffArgs: ["--staged"],
      excludeArgs: { git: ["--", ".", ":(exclude)dist/x.js"] },
    });
    expect(args).toEqual([
      "-c",
      "core.quotepath=false",
      "diff",
      "--staged",
      "--",
      ".",
      ":(exclude)dist/x.js",
    ]);
  });

  it("buildDiffArgs: diffArgs/excludeArgs 欠落時も落ちない", () => {
    expect(buildDiffArgs({})).toEqual(["-c", "core.quotepath=false", "diff"]);
  });
});
