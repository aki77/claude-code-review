// ステップ2（サマリ+クラスタ分割エージェント）が出した clusters JSON を機械検証・修復し、
// CLUSTERS 成果物にする。エージェント4（クロスファイル整合性）をクラスタ単位で並列起動
// するための入力を、決定論的に整える。
//
// 設計方針（ユーザー決定済み）: クラスタ分割は LLM 維持 + スクリプト検証。検証・修復が
// 破綻したら「全変更ファイルを単一クラスタとみなす」決定論的縮退へ一本化する。**サマリ
// エージェントが失敗した場合も stdin `[]` でこのスクリプトを通し、縮退経路をここに集約する。**
import type { Cluster, ClustersDoc } from "./types.ts";

export const MAX_CLUSTERS = 3;

// 単一クラスタ（全変更ファイル）を作る。縮退先。
function singleCluster(changedFiles: string[]): Cluster[] {
  return [{ id: 1, theme: "全変更ファイル", changedFiles: [...changedFiles], symbols: [], contextHints: [] }];
}

// tier（tiny/small）による決定論的な単一クラスタ縮退の結果を作る純粋関数。
// エージェント2の出力内容によらず縮退させるため clusters のパース前に使う。
// fallback（rawClusters が壊れていた縮退）とは区別し tierReduced:true で理由を残す。
export function tierReducedClusters(changedFiles: string[]): ClustersDoc {
  return {
    clusters: singleCluster(changedFiles),
    fallback: false,
    tierReduced: true,
    removedPaths: [],
    appendedPaths: [],
  };
}

// clusters を検証・修復する純粋関数。
//   rawClusters : ステップ2エージェントの出力（任意の型でありうる）
//   changedFiles: CTX の変更ファイル配列（レビュー対象。除外済み）
// 戻り値: { clusters, fallback, removedPaths, appendedPaths }
//   fallback=true のとき単一クラスタへ縮退した（rawClusters が使い物にならなかった）。
export function validateClusters(rawClusters: unknown, changedFiles: string[]): ClustersDoc {
  const changedSet = new Set(changedFiles);
  // 単一クラスタ縮退の唯一の生成点。removedPaths を先に宣言し（縮退前に溜まった分をそのまま
  // 携行する）、全ての縮退条件がこの1か所を呼ぶ。appendedPaths は縮退では常に空（全ファイルを
  // 1クラスタに載せるので「未カバー追加」の概念がない）。
  const removedPaths: string[] = [];
  const bail = (): ClustersDoc => ({
    clusters: singleCluster(changedFiles),
    fallback: true,
    removedPaths,
    appendedPaths: [],
  });

  // 縮退条件1: 配列でない / 3超過 / 要素に theme・changedFiles 欠落。
  if (!Array.isArray(rawClusters) || rawClusters.length > MAX_CLUSTERS) {
    return bail();
  }
  for (const c of rawClusters) {
    const rec = c as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object" || typeof rec.theme !== "string" || rec.theme.trim() === "") {
      return bail();
    }
    if (!Array.isArray(rec.changedFiles)) {
      return bail();
    }
  }

  // 修復: changedFiles を CTX と積集合（diff 外パスを除去）。symbols/contextHints を [] 補完。
  const repaired = (rawClusters as Array<Record<string, unknown>>).map((rec) => {
    const kept: string[] = [];
    for (const p of rec.changedFiles as unknown[]) {
      if (typeof p === "string" && changedSet.has(p)) kept.push(p);
      else if (typeof p === "string") removedPaths.push(p);
    }
    return {
      theme: rec.theme as string,
      changedFiles: [...new Set(kept)],
      symbols: Array.isArray(rec.symbols) ? (rec.symbols as string[]) : [],
      contextHints: Array.isArray(rec.contextHints) ? (rec.contextHints as string[]) : [],
    };
  });

  // 空クラスタ（積集合で全ファイルが落ちた）を削除。
  let clusters = repaired.filter((c) => c.changedFiles.length > 0);

  // 縮退条件2: 修復後0件。
  if (clusters.length === 0) {
    return bail();
  }

  // 未カバーの変更ファイルを、ファイル数最小のクラスタ（同数なら並び順で先＝id 最小相当）へ追加。
  // 同一ファイルが複数クラスタに現れる場合は最初のクラスタのものを正とし、後続からは既に
  // removedPaths ではなく単純に重複排除（積集合時点で各クラスタ内は unique、跨りは以下で解消）。
  const covered = new Set<string>();
  for (const c of clusters) {
    c.changedFiles = c.changedFiles.filter((p) => {
      if (covered.has(p)) return false; // 別クラスタが既に保持 → こちらからは落とす
      covered.add(p);
      return true;
    });
  }
  // 跨り解消で空になったクラスタを再度削除。
  clusters = clusters.filter((c) => c.changedFiles.length > 0);
  if (clusters.length === 0) {
    return bail();
  }

  const appendedPaths: string[] = [];
  for (const p of changedFiles) {
    if (covered.has(p)) continue;
    appendedPaths.push(p);
    // ファイル数最小のクラスタ（同数なら配列の先頭側）へ寄せる。
    const target = clusters.reduce((a, b) => (a.changedFiles.length <= b.changedFiles.length ? a : b));
    target.changedFiles.push(p);
    covered.add(p);
  }

  // id 振り直し（1始まり連番）。id を先頭キーにするため並べ替え（id, theme, ...）。
  const ordered: Cluster[] = clusters.map((c, i) => ({
    id: i + 1,
    theme: c.theme,
    changedFiles: c.changedFiles,
    symbols: c.symbols,
    contextHints: c.contextHints,
  }));

  return { clusters: ordered, fallback: false, removedPaths, appendedPaths };
}
