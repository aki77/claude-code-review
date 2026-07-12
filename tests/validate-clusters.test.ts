import { describe, expect, it } from "vitest";
import { MAX_CLUSTERS, tierReducedClusters, validateClusters } from "../src/lib/validate-clusters.ts";

const changed = ["a.js", "b.js", "c.js", "d.js"];

describe("validateClusters", () => {
  it("正常通過: 全ファイルをカバーする2クラスタはそのまま", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "b.js"], symbols: ["f"], contextHints: ["x.js"] },
      { id: 2, theme: "T2", changedFiles: ["c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(false);
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters[1]!.symbols).toEqual([]); // 欠落補完
    expect(r.clusters[1]!.contextHints).toEqual([]);
  });

  it("縮退: 配列でない入力は単一クラスタ", () => {
    const r = validateClusters(null, changed);
    expect(r.fallback).toBe(true);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.changedFiles).toEqual(changed);
  });

  it("縮退: 4クラスタ（3超過）は単一クラスタ", () => {
    expect(MAX_CLUSTERS).toBe(3);
    const raw = [1, 2, 3, 4].map((n) => ({ id: n, theme: `T${n}`, changedFiles: [] }));
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(true);
  });

  it("正常通過: ちょうど3クラスタは縮退しない", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js"] },
      { id: 3, theme: "T3", changedFiles: ["c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(false);
    expect(r.clusters).toHaveLength(3);
  });

  it("縮退: theme 欠落要素があれば単一クラスタ", () => {
    const raw = [{ id: 1, changedFiles: ["a.js"] }];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(true);
  });

  it("縮退: 空配列 [] は単一クラスタ（サマリ失敗経路）", () => {
    const r = validateClusters([], changed);
    expect(r.fallback).toBe(true);
    expect(r.clusters[0]!.changedFiles).toEqual(changed);
  });

  it("修復: diff 外パスを除去し removedPaths に記録", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "ghost.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js", "c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(false);
    expect(r.removedPaths).toEqual(["ghost.js"]);
    expect(r.clusters[0]!.changedFiles).toEqual(["a.js"]);
  });

  it("修復: 未カバーの変更ファイルを最小クラスタへ追加し appendedPaths に記録", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js"] },
    ];
    const r = validateClusters(raw, changed);
    // c.js, d.js が未カバー → それぞれ最小クラスタへ
    expect([...r.appendedPaths].sort()).toEqual(["c.js", "d.js"]);
    const all = r.clusters.flatMap((c) => c.changedFiles).sort();
    expect(all).toEqual(changed);
  });

  it("修復: 全ファイル diff 外 → 空クラスタ削除 → 縮退", () => {
    const raw = [{ id: 1, theme: "T1", changedFiles: ["ghost.js"] }];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(true);
  });

  it("id 振り直し: 1始まり連番になる", () => {
    const raw = [
      { id: 5, theme: "T1", changedFiles: ["a.js", "b.js"] },
      { id: 9, theme: "T2", changedFiles: ["c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.clusters.map((c) => c.id)).toEqual([1, 2]);
  });

  it("跨り解消: 同一ファイルが複数クラスタなら先頭クラスタのみ保持", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "b.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js", "c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.clusters[0]!.changedFiles).toEqual(["a.js", "b.js"]);
    expect(r.clusters[1]!.changedFiles).toEqual(["c.js", "d.js"]); // b.js は落ちる
  });

  it("修復と未カバー追加が同時に発生するケース", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "ghost.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js"] },
    ];
    const r = validateClusters(raw, changed);
    expect(r.fallback).toBe(false);
    expect(r.removedPaths).toEqual(["ghost.js"]);
    expect([...r.appendedPaths].sort()).toEqual(["c.js", "d.js"]);
    const all = r.clusters.flatMap((c) => c.changedFiles).sort();
    expect(all).toEqual(changed);
  });

  it("tierReducedClusters: 全変更ファイルを単一クラスタにまとめ tierReduced を立てる", () => {
    const r = tierReducedClusters(changed);
    expect(r.tierReduced).toBe(true);
    expect(r.fallback).toBe(false); // fallback（壊れた入力）とは区別する
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.changedFiles).toEqual(changed);
    expect(r.removedPaths).toEqual([]);
    expect(r.appendedPaths).toEqual([]);
  });
});
