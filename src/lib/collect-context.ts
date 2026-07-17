// パイプライン step1（collectContext → CTX）に相当する決定論ロジック。
//
// 変更ファイルを git/gh から収集・分類し、tier とルール割当を確定する。
// 移植元 collect-review-context.mjs は execFileSync（同期・非0で throw）を使うが、
// 本リポジトリの exec.ts は execFileAsync（非同期・throw せず {stdout,stderr,code} を返す）
// に統一済みのため、全関数を async 化し throw ベースの制御フローを code チェックへ
// 書き換えている。外部から見た挙動は不変（例: base 不在時は fetch 指示付き Error を throw）。
//
// main()（CLI 化・writeFileSync・console.log・process.exit・parseArgs）は移植しない
// （CLI 責務は cli.ts、成果物はメモリ上の Context を return する）。
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { num, type ResolvedConfig } from "./config.ts";
import { execFileAsync } from "./exec.ts";
import type {
  Assignment,
  Context,
  ContextSource,
  Rule,
  Tier,
} from "./types.ts";
import { createWorkspaceIndex, mergeEnv } from "./workspace-index.ts";

type Exec = typeof execFileAsync;

const cwd = process.cwd();

// ---- レビュー対象外のデフォルト除外パターン ---------------------------------
// レビューして意味のないファイル（生成物・ミニファイ・バイナリ）を機械的に除外する。
// ロックファイル・スナップショットは含めない（有用な変更を誤って隠すリスクを避ける）。
// プロジェクト側で追加除外したい場合は .gitattributes に linguist 属性
// （linguist-generated / linguist-vendored / linguist-documentation）を付与する。
// 値なし記法（`path linguist-generated`）でも `=true` でも効く（detectLinguistExcluded が拾う）。
// glob は path.matchesGlob（fileMatchesPatterns）で照合する純粋な文字列マッチ。
export const DEFAULT_EXCLUDE_GLOBS = [
  // ミニファイ / source map / 典型的なビルド生成物ディレクトリ
  // `**/dist/**` は `**` が0セグメントにマッチするためトップレベルの `dist/x` も拾う
  // （`dist/**` は不要）。
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  // 画像バイナリ（SVG はテキスト diff として有用なので含めない）
  "**/*.{png,jpg,jpeg,gif,webp,ico,bmp,avif,heic}",
  // フォント
  "**/*.{woff,woff2,ttf,eot,otf}",
  // 圧縮・アーカイブ・ドキュメントバイナリ
  "**/*.{pdf,zip,gz,tgz,bz2,xz,7z,rar,jar}",
  // 動画・音声
  "**/*.{mp4,mov,webm,avi,mkv,mp3,wav,flac,ogg}",
];

// ---- 変更規模 tier のしきい値 ------------------------------------------------
// 小さい差分では固定コスト（サマリ+クラスタ分割エージェント・ルール準拠2体目・
// クラスタ整合性2体目以降・バグ検出）を削るため、変更規模を tier で分類する。
// 判定はここ（決定論・コード側）で確定させ、CTX の tier としてプロンプトへ渡す
// （プロンプトは規模判定ロジックを一切持たず tier の値を読むだけ）。
// totalFiles / totalChangedLines はいずれも「レビュー対象（kept）ファイル」基準。
// 環境変数で上書き可能（利用リポジトリごとにプロンプト改変なしで調整できる）。
// num() は config.ts へ移設済み（config.ts の resolveConfig と単一の情報源にするため）。
// この2定数は classifyTier() の thresholds 省略時（no-arg 呼び出し）のフォールバックとして残す。
const SMALL_MAX_FILES = num(process.env.CODE_REVIEW_SMALL_MAX_FILES, 5);
const SMALL_MAX_LINES = num(process.env.CODE_REVIEW_SMALL_MAX_LINES, 150);

// 1ファイルの変更行数（追加+削除）がこれを「超えたら」レビュー対象から外し oversizedFiles に
// 分離する（generated/バイナリの excludedFiles とは別枠。こちらは「大規模ゆえに個別レビューが
// 困難」）。本プラグインはトークン実測機構を持たないため行数で近似する。デフォルト 1000 は
// 複数ファイルを1エージェントに渡す本構成で単一ファイルがコンテキストを占有しすぎない中庸値。
// 環境変数で調整可能。tier の行数しきい値（SMALL_MAX_LINES 等）より大きい前提で、
// これを下げて tier しきい値を下回らせると「単一ファイルが tier しきい値を跨ぐ前に oversized 落ち」
// して tier の意味が変わるので注意（両しきい値とも「変更規模の分類」という同じ概念系に属する）。
const OVERSIZED_MAX_LINES = num(
  process.env.CODE_REVIEW_OVERSIZED_MAX_LINES,
  1000,
);

// classifyTier の thresholds 省略時（no-arg 呼び出し）のフォールバック既定値。
const DEFAULT_TIER_THRESHOLDS = {
  smallMaxFiles: SMALL_MAX_FILES,
  smallMaxLines: SMALL_MAX_LINES,
} as const;

// 変更規模から tier を決める純粋関数。
// small は「ファイル数 AND 行数」の両方がしきい値未満のときのみ該当し、
// どちらか一方でも超えたら normal へ繰り上がる。
// thresholds 省略時は現行 env/module const（DEFAULT_TIER_THRESHOLDS）にフォールバックする。
export function classifyTier(
  totalFiles: number,
  totalChangedLines: number,
  thresholds: {
    smallMaxFiles: number;
    smallMaxLines: number;
  } = DEFAULT_TIER_THRESHOLDS,
): Tier {
  if (
    totalFiles <= thresholds.smallMaxFiles &&
    totalChangedLines < thresholds.smallMaxLines
  ) {
    return "small";
  }
  return "normal";
}

// ---- 変更ファイル取得 --------------------------------------------------------
// PR の base 先端（baseRefOid）を解決し、ローカル three-dot range `<baseRefOid>...HEAD`
// を返す。diff 取得を PR/local 両モードで完全に同型（ローカル git diff）にするための要。
// ステップ0で「ローカル HEAD == PR headRefOid」が保証されているため、この three-dot
// range の merge base は GitHub の PR base と一致する。base コミットがローカルに無い
// （fork PR / shallow clone）場合は actionable なメッセージで throw する。
// exec は依存注入（既存テストスタイルに合わせ、FS/プロセス非依存でテストするため）。
// baseRef が渡されれば gh pr view を呼ばない（呼び出し元が fetchPrMeta で既に
// baseRefOid/baseRefName を取得済みのときに使う。gh pr view の重複呼び出しを避ける）。
export async function resolvePrBaseRange(
  pr: string,
  {
    exec = execFileAsync,
    baseRef,
  }: {
    exec?: Exec;
    baseRef?: { baseRefOid: string; baseRefName: string };
  } = {},
): Promise<string> {
  let baseRefOid: string | undefined;
  let baseRefName: string | undefined;
  if (baseRef) {
    baseRefOid = baseRef.baseRefOid;
    baseRefName = baseRef.baseRefName;
  } else {
    const raw = await exec("gh", [
      "pr",
      "view",
      pr,
      "--json",
      "baseRefOid,baseRefName",
    ]);
    const meta = JSON.parse(raw.stdout);
    baseRefOid = meta.baseRefOid;
    baseRefName = meta.baseRefName;
  }
  if (!baseRefOid) {
    throw new Error(
      `PR #${pr} の baseRefOid を取得できませんでした（gh pr view の出力に baseRefOid がありません）。`,
    );
  }

  // base コミットがローカルに存在するか。fork PR / shallow clone では欠落しうる。
  const catFile = await exec("git", [
    "cat-file",
    "-e",
    `${baseRefOid}^{commit}`,
  ]);
  if (catFile.code !== 0) {
    throw new Error(
      `PR #${pr} の base コミット（${baseRefOid}）がローカルに存在しません。` +
        `\`git fetch origin ${baseRefName}\` を実行して再実行してください` +
        `（fork PR の場合は base リポジトリの remote を指定）。`,
    );
  }

  // three-dot の merge base を計算できるか。shallow clone では失敗しうる。
  const mergeBase = await exec("git", ["merge-base", baseRefOid, "HEAD"]);
  if (mergeBase.code !== 0) {
    throw new Error(
      `PR #${pr} の base（${baseRefOid}）と HEAD の merge base を計算できませんでした。` +
        `\`git fetch --unshallow\` または \`git fetch origin ${baseRefName}\` を実行して再実行してください。`,
    );
  }

  return `${baseRefOid}...HEAD`;
}

export async function getChangedFilesFromRange(
  range: string,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<string[]> {
  // GitHub は常時 rename 検出のため --find-renames を明示する
  // （diff.renames=false なリポジトリでの列挙差異を防ぐ）。
  const out = await exec("git", [
    "diff",
    "--name-only",
    "--find-renames",
    range,
  ]);
  return splitLines(out.stdout);
}

// workspace モード: baseRef（HEAD or 空ツリー SHA）に対する tracked ファイルの変更
// （staged+unstaged 統合）を、一時 index の env 付きで列挙する。untracked は呼び出し側
// （workspace-index が返す untracked 一覧）で合流させるため、ここでは含めない。
export async function getWorkspaceTrackedFiles(
  baseRef: string,
  env: NodeJS.ProcessEnv,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<string[]> {
  const out = await exec(
    "git",
    ["diff", baseRef, "--name-only", "--find-renames"],
    { env },
  );
  return splitLines(out.stdout);
}

// `git diff --numstat` の生出力を [{ added, deleted, path }] にパースする純粋関数。
// numstat の各行は `added<TAB>deleted<TAB>path`。バイナリファイルは added/deleted が
// `-` になるため数値化できず、行数集計から除外する（null で表現）。
// rename は `old => new` 形式や `{a => b}` 形式になるが、path 自体は tier 判定では
// kept セットとの照合に使わない（集計は行数のみ）ため、パスの厳密復元は不要。
export interface NumstatRow {
  added: number | null;
  deleted: number | null;
  path: string;
}

export function parseNumstat(out: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? null : Number(parts[0]);
    const deleted = parts[1] === "-" ? null : Number(parts[1]);
    rows.push({ added, deleted, path: parts.slice(2).join("\t") });
  }
  return rows;
}

export interface ChangedLinesResult {
  totalAdded: number;
  totalDeleted: number;
  totalChangedLines: number;
  perFile: Map<string, { added: number; deleted: number }>;
}

// レビュー対象（kept）ファイルの変更「行数」を算出する。
// diffArgs（range or HEAD/空ツリーSHA）と excludeArgs.git（生成物・バイナリの除外 pathspec）を
// 本 diff とまったく同じ引数で numstat に渡すことで、tier 判定が本 diff とズレないようにする。
// バイナリ行（added/deleted が null）は行数集計に含めない。
// perFile は「numstat の生パス → { added, deleted }」の Map。oversized 検出と、oversized を
// 除いた metrics の再計算（git を再実行せず減算で求める）に使う。
// numstat の path は rename 時に `old => new` 等の形式になりうるが、正規化はしない
// （呼び出し側で kept セットと素朴照合し、照合できないものは oversized 判定から漏れて
// レビュー対象に残る＝安全側。複雑な rename 正規化を持ち込んでバグ源にしない）。
export async function collectChangedLines(
  diffArgs: string[],
  excludeArgs: string[],
  { exec = execFileAsync, env }: { exec?: Exec; env?: NodeJS.ProcessEnv } = {},
): Promise<ChangedLinesResult> {
  const args = [
    "diff",
    "--numstat",
    "--find-renames",
    ...diffArgs,
    ...excludeArgs,
  ];
  const result = await exec("git", args, {
    maxBuffer: 256 * 1024 * 1024,
    env,
  });
  if (result.code !== 0) {
    // numstat の取得に失敗しても tier 判定を落とさない（normal 相当＝全エージェント起動）。
    return {
      totalAdded: 0,
      totalDeleted: 0,
      totalChangedLines: 0,
      perFile: new Map(),
    };
  }
  let totalAdded = 0;
  let totalDeleted = 0;
  const perFile = new Map<string, { added: number; deleted: number }>();
  for (const r of parseNumstat(result.stdout)) {
    if (r.added != null) totalAdded += r.added;
    if (r.deleted != null) totalDeleted += r.deleted;
    if (r.added != null && r.deleted != null) {
      perFile.set(r.path, { added: r.added, deleted: r.deleted });
    }
  }
  return {
    totalAdded,
    totalDeleted,
    totalChangedLines: totalAdded + totalDeleted,
    perFile,
  };
}

function splitLines(out: string): string[] {
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// exec を実行し、成功（code===0）かつ stdout が非空 trim 済みならその文字列を、
// 失敗または空なら null を返す。resolveRange の各フォールバック段で共通の
// 「成功時のみ trim 済み stdout を使う」判定を1箇所に集約するためのヘルパー。
async function execTrimmedOrNull(
  exec: Exec,
  command: string,
  args: string[],
): Promise<string | null> {
  const result = await exec(command, args);
  const trimmed = result.stdout.trim();
  return result.code === 0 && trimmed ? trimmed : null;
}

// range 引数の自動解決。4段のフォールバック（各段は成功したら即確定、失敗したら次段へ）。
// 全段失敗時は throw する（元 CLI の process.exit はライブラリ関数の責務ではないため、
// 呼び出し側 cli.ts が処理する）。
export async function resolveRange(
  arg: string | undefined,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<string> {
  if (arg) {
    // `..` を含まない場合は base のみとみなして `<arg>...HEAD` に補完
    if (!arg.includes("..")) {
      return `${arg}...HEAD`;
    }
    return arg;
  }

  // 自動解決
  const branchResult = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.stdout.trim();

  // 1. github-pr-base-branch（`owner/repo#123` 形式から `#番号` を除去してブランチ名を得る）
  const ghPrBase = await execTrimmedOrNull(exec, "git", [
    "config",
    `branch.${branch}.github-pr-base-branch`,
  ]);
  const baseBranch = ghPrBase?.replace(/#\S*$/, "").trim();
  if (baseBranch) {
    const base = await execTrimmedOrNull(exec, "git", [
      "merge-base",
      baseBranch,
      "HEAD",
    ]);
    if (base) return `${base}...HEAD`;
  }

  // 2. vscode-merge-base
  const vscodeBase = await execTrimmedOrNull(exec, "git", [
    "config",
    `branch.${branch}.vscode-merge-base`,
  ]);
  if (vscodeBase) return `${vscodeBase}...HEAD`;

  // 3. @{upstream}
  const upstreamBase = await execTrimmedOrNull(exec, "git", [
    "merge-base",
    "@{upstream}",
    "HEAD",
  ]);
  if (upstreamBase) return `${upstreamBase}...HEAD`;

  // 4. origin/HEAD
  const originBase = await execTrimmedOrNull(exec, "git", [
    "merge-base",
    "origin/HEAD",
    "HEAD",
  ]);
  if (originBase) return `${originBase}...HEAD`;

  throw new Error(
    "ベースブランチを自動解決できませんでした。\n" +
      "引数として範囲を明示してください。例: --range main",
  );
}

// ---- CLAUDE.md 収集 ----------------------------------------------------------
// 単一ファイルに適用される CLAUDE.md 群を、親ディレクトリを遡って収集する。
// 同一ディレクトリ配下の複数ファイルで同じ遡上 stat を繰り返さないよう、結果を
// ディレクトリ単位でメモ化する（多数の変更ファイルで existsSync 反復を削減）。
const claudeMdCache = new Map<string, string[]>();

export function claudeMdForFile(file: string): string[] {
  const startDir = path.dirname(file);
  const cached = claudeMdCache.get(startDir);
  if (cached) return cached;
  const results: string[] = [];
  if (existsSync(path.join(cwd, "CLAUDE.md"))) {
    results.push("CLAUDE.md");
  }
  let dir = startDir;
  while (dir && dir !== "." && dir !== "/") {
    const candidate = path.join(dir, "CLAUDE.md");
    if (existsSync(path.join(cwd, candidate))) {
      results.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const sorted = [...new Set(results)].sort();
  claudeMdCache.set(startDir, sorted);
  return sorted;
}

// ---- .claude/rules/ パース ---------------------------------------------------
export function parseFrontmatterPaths(content: string): string[] | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const lines = fm.split("\n");

  let inPaths = false;
  let pathsIndent = -1;
  const collected: string[] = [];
  let foundPathsKey = false;

  for (const line of lines) {
    if (!inPaths) {
      const m = line.match(/^(\s*)paths\s*:\s*(.*)$/);
      if (m) {
        foundPathsKey = true;
        const rest = (m[2] ?? "").trim();
        if (rest.startsWith("[")) {
          const inline = rest.replace(/^\[|\]$/g, "");
          for (const item of inline.split(",")) {
            const v = item.trim().replace(/^["']|["']$/g, "");
            if (v) collected.push(v);
          }
          return collected;
        }
        inPaths = true;
        pathsIndent = (m[1] ?? "").length;
      }
    } else {
      if (line.trim() === "") continue;
      const indent = (line.match(/^\s*/)?.[0] ?? "").length;
      const itemMatch = line.match(/^\s*-\s+(.+)$/);
      if (itemMatch && indent > pathsIndent) {
        const v = (itemMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
        collected.push(v);
      } else {
        break;
      }
    }
  }

  return foundPathsKey ? collected : null;
}

export async function listRuleFiles(): Promise<string[]> {
  const rulesDir = path.join(cwd, ".claude/rules");
  if (!existsSync(rulesDir)) return [];
  const matches: string[] = [];
  for await (const entry of glob("**/*.md", { cwd: rulesDir })) {
    matches.push(path.join(".claude/rules", entry));
  }
  return matches.sort();
}

// 単一ファイルのパスが patterns のいずれかにマッチするか。
// path.matchesGlob はパス文字列同士のマッチ（ファイルシステムを走査しない）なので、
// 削除ファイルや浅いクローンなど作業ツリーに実在しないパスでも正しく判定できる。
export function fileMatchesPatterns(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

// ---- レビュー対象ファイルのフィルタリング ------------------------------------
// .gitattributes の linguist 除外属性が付いた変更ファイルの集合を返す。
// 対象属性は GitHub linguist が言語統計から外すのと同じ3つ:
//   linguist-generated / linguist-vendored / linguist-documentation
// git check-attr を --stdin -z で一括問い合わせし、プロセス呼び出しを1回に抑える。
// 変更ファイルが空なら git を呼ばず空の Set を返す。
const LINGUIST_EXCLUDE_ATTRS = [
  "linguist-generated",
  "linguist-vendored",
  "linguist-documentation",
];

export async function detectLinguistExcluded(
  files: string[],
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const input = files.map((f) => `${f}\0`).join("");
  const out = await exec(
    "git",
    ["check-attr", "--stdin", "-z", ...LINGUIST_EXCLUDE_ATTRS],
    { input },
  );
  return parseCheckAttrOutput(out.stdout);
}

// git check-attr --stdin -z の出力をパースして、除外対象パスの Set を返す純粋関数。
// 出力は NUL 区切りで <path>\0<attr>\0<value>\0 の3つ組が繰り返される。問い合わせた
// 属性ごとに1つ組が出るため、同一パスが複数回現れる。value の意味:
//   set … 値なし記法（`path linguist-generated`）／true・任意の値 … `=true`/`=1` 等で付与
//   unspecified … 属性なし ／ unset … `-attr` で打ち消し ／ false … `=false`
// GitHub linguist は「明示的な打ち消し以外の設定値」を override 有効として扱うため、
// 除外は「無効値（unspecified/unset/false）でない」を判定する。こうすることで
// `=1`・`=yes` のような set/true 以外の設定値でも取りこぼさない。
const ATTR_NEGATIVE_VALUES = new Set(["unspecified", "unset", "false"]);

export function parseCheckAttrOutput(out: string): Set<string> {
  const parts = out.split("\0");
  const excluded = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const path_ = parts[i];
    const value = parts[i + 2];
    if (
      path_ !== undefined &&
      value !== undefined &&
      !ATTR_NEGATIVE_VALUES.has(value)
    ) {
      excluded.add(path_);
    }
  }
  return excluded;
}

// 変更ファイルを「レビュー対象（kept）」と「除外（excluded）」に分類する純粋関数。
// 除外条件: デフォルト glob にマッチ、または .gitattributes の linguist 属性
// （generated/vendored/documentation）が付いている。
// attrExcludedSet / defaultGlobs を注入可能にして FS/プロセス非依存にテストする。
export function classifyFiles(
  files: string[],
  {
    attrExcludedSet = new Set<string>(),
    defaultGlobs = DEFAULT_EXCLUDE_GLOBS,
  }: { attrExcludedSet?: Set<string>; defaultGlobs?: string[] } = {},
): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const file of files) {
    if (fileMatchesPatterns(file, defaultGlobs) || attrExcludedSet.has(file)) {
      excluded.push(file);
    } else {
      kept.push(file);
    }
  }
  return { kept, excluded };
}

// 除外パス配列から、diff 取得コマンド向けの除外引数を組み立てる純粋関数。
//   git: `git diff <diffArgs> -- . ':(exclude)p1' ':(exclude)p2' ...`
// diff 取得は PR/local 両モードともローカル git diff に統一されたため、git キーのみ。
export function buildExcludeArgs(excludedFiles: string[]): { git: string[] } {
  if (excludedFiles.length === 0) return { git: [] };
  const git = ["--", ".", ...excludedFiles.map((p) => `:(exclude)${p}`)];
  return { git };
}

// kept ファイルを、変更行数（added+deleted）が maxLines を「超える」oversized と、それ以外の
// changedFiles に単一ループで振り分ける純粋関数（classifyFiles と同じ2バケット push 方式）。
// perFile は collectChangedLines が返す「numstat 生パス → { added, deleted }」の Map。
// 境界（ちょうど maxLines）はレビュー対象に残す（strictly greater）。numstat 側にしか現れない
// rename 生パス等は kept に無い＝perFile.get が undefined なので oversized 判定から漏れる（安全側）。
export function splitOversized(
  keptFiles: string[],
  perFile: Map<string, { added: number; deleted: number }>,
  maxLines: number,
): { changedFiles: string[]; oversizedFiles: string[] } {
  const changedFiles: string[] = [];
  const oversizedFiles: string[] = [];
  for (const f of keptFiles) {
    const stat = perFile.get(f);
    const lines = stat ? stat.added + stat.deleted : null;
    (lines != null && lines > maxLines ? oversizedFiles : changedFiles).push(f);
  }
  return { changedFiles, oversizedFiles: oversizedFiles.sort() };
}

// PR/range 全体で「適用されうる」ルール一覧を収集する。
// paths が null（全ファイル適用）か、変更ファイルのいずれかが paths にマッチするものを残す。
export async function collectRules(changedFiles: string[]): Promise<Rule[]> {
  const files = await listRuleFiles();
  const results: Rule[] = [];
  for (const file of files) {
    const content = readFileSync(path.join(cwd, file), "utf8");
    const paths = parseFrontmatterPaths(content);
    if (paths === null) {
      results.push({ path: file, paths: null });
    } else if (paths.length === 0) {
    } else if (changedFiles.some((f) => fileMatchesPatterns(f, paths))) {
      results.push({ path: file, paths });
    }
  }
  return results;
}

// ---- ファイル単位の適用ルール算出 ------------------------------------------
// 各変更ファイルについて、適用されるルールファイルのパス一覧を求める。
// CLAUDE.md と .claude/rules/ を区別せず、エージェントが参照すべきファイルとして
// 1つの配列に統合する（CLAUDE.md → .claude/rules/ の順で並べる）。
export function rulesForFile(file: string, allRules: Rule[]): string[] {
  const rules = [...claudeMdForFile(file)];
  for (const rule of allRules) {
    if (rule.paths === null) {
      rules.push(rule.path);
    } else if (fileMatchesPatterns(file, rule.paths)) {
      rules.push(rule.path);
    }
  }
  return rules;
}

// ---- ルールセット単位グルーピング + 2バケットパック ------------------------
// 適用ルールセット（適用ルールファイルのパス集合）が同一のファイルを1グループに集約し、
// 2エージェント分のバケットへ振り分ける。配置の方針:
//   1. 各バケットの「ルール和集合」を骨格グループ（他グループのルールセットの部分集合に
//      ならない極大グループ）で確定する。
//   2. 自分のルールセットがバケットのルール和集合の部分集合になっているグループ（=どちらに
//      入れても余分なルールを読まない）は、ファイル数が少ないバケットへ自由に振り分けて
//      均等化する。これにより「コンテキスト重複ゼロ」を保ったままファイル数を平準化できる。
interface RuleGroup {
  ruleSet: Set<string>;
  files: Array<{ path: string; rules: string[] }>;
}

interface Bucket {
  files: Array<{ path: string; rules: string[] }>;
  ruleUnion: Set<string>;
}

export function buildAssignments(
  changedFiles: string[],
  allRules: Rule[],
  resolveRules: (file: string, allRules: Rule[]) => string[] = rulesForFile,
  tier: Tier = "normal",
): Assignment[] {
  // ファイル → 適用ルールセット（グループ化）
  const groupsByKey = new Map<string, RuleGroup>();
  for (const file of changedFiles) {
    const rules = resolveRules(file, allRules);
    const key = JSON.stringify([...rules].sort());
    let group = groupsByKey.get(key);
    if (!group) {
      group = { ruleSet: new Set(rules), files: [] };
      groupsByKey.set(key, group);
    }
    group.files.push({ path: file, rules });
  }

  const groups = [...groupsByKey.values()];
  const bucketA: Bucket = { files: [], ruleUnion: new Set<string>() };
  const bucketB: Bucket = { files: [], ruleUnion: new Set<string>() };
  const buckets: [Bucket, Bucket] = [bucketA, bucketB];

  const isSubset = (sub: Set<string>, sup: Set<string>) => {
    for (const r of sub) if (!sup.has(r)) return false;
    return true;
  };
  const smaller = () =>
    bucketA.files.length <= bucketB.files.length ? bucketA : bucketB;
  const place = (
    bucket: Bucket,
    group: { ruleSet: Set<string> },
    files: Array<{ path: string; rules: string[] }>,
  ) => {
    for (const f of files) bucket.files.push(f);
    for (const r of group.ruleSet) bucket.ruleUnion.add(r);
  };

  if (tier !== "normal") {
    // fast-path（small）: ルール準拠チェックを1エージェントに寄せる。
    // 全グループのファイルを bucketA に集約し bucketB を空にする
    // （→ review-core の「assignments[1].files が空ならエージェント2を起動しない」条件が
    //   自動的に成立し、プロンプト側の変更なしにエージェント2起動が抑止される）。
    // small は総ファイル数がしきい値以内（small で最大5）なので1体が読むルール量も限定的。
    for (const g of groups) place(bucketA, g, g.files);
  } else if (groups.length === 1) {
    // 縮退ケース: グループが1つだけなら、その単一グループを2バケットへ均等割りする
    // （同一ルールセットなのでコンテキスト重複は発生しない）。
    const only = groups[0]!;
    const half = Math.ceil(only.files.length / 2);
    place(bucketA, only, only.files.slice(0, half));
    place(bucketB, only, only.files.slice(half));
  } else {
    // 「骨格グループ」= ルールセットが他グループのルールセットの真部分集合になっていない
    // 極大グループ。これらが各バケットのルール和集合を決める。残りは filler。
    const isMaximal = (g: RuleGroup) =>
      !groups.some(
        (o) =>
          o !== g &&
          o.ruleSet.size > g.ruleSet.size &&
          isSubset(g.ruleSet, o.ruleSet),
      );
    const skeleton: RuleGroup[] = [];
    const fillers: RuleGroup[] = [];
    for (const g of groups) (isMaximal(g) ? skeleton : fillers).push(g);

    // 骨格はファイル数降順に LPT 配置（分割しない）。各バケットのルール和集合が確定する。
    for (const g of skeleton.sort((a, b) => b.files.length - a.files.length)) {
      place(smaller(), g, g.files);
    }

    // filler グループのファイルは1ファイル単位で、ルール和集合の部分集合になっている
    // バケットのうち少ない方へ入れて均等化する（余分なルールは読ませない）。
    const flatFillers = fillers.flatMap((g) =>
      g.files.map((f) => ({ file: f, ruleSet: g.ruleSet })),
    );
    for (const { file, ruleSet } of flatFillers) {
      // 余分なルールを読ませないバケットを優先候補にする。次のいずれかを満たすバケット:
      //   - ruleSet がバケット和集合の部分集合（入れても和集合が増えない）
      //   - バケット和集合が ruleSet の部分集合（入れてもそのバケットは ruleSet 内の
      //     ルールしか読まない。空バケットも常にこれを満たす）
      const candidates = buckets.filter(
        (b) => isSubset(ruleSet, b.ruleUnion) || isSubset(b.ruleUnion, ruleSet),
      );
      const pool = candidates.length ? candidates : buckets;
      const target = pool.reduce((a, b) =>
        a.files.length <= b.files.length ? a : b,
      );
      place(target, { ruleSet }, [file]);
    }
  }

  return buckets.map((b) => ({
    files: b.files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  }));
}

// ---- オーケストレータ本体 ----------------------------------------------------
export type CollectContextOpts =
  | {
      mode: "pr";
      pr: string;
      // 呼び出し元が fetchPrMeta で既に取得済みなら渡す（gh pr view の重複呼び出しを避ける）。
      baseRef?: { baseRefOid: string; baseRefName: string };
    }
  | { mode: "range"; range?: string };

export interface CollectContextResult {
  context: Context;
  // range/pr モードでは no-op。workspace モードでは一時 index ファイルを削除する
  // （実 index・作業ツリーには触れない）。呼び出し側（pipeline.ts）は全ステップ完了後の
  // finally で必ず呼ぶこと。
  dispose(): void;
}

const noopDispose = (): void => {};

export async function collectContext(
  opts: CollectContextOpts,
  {
    exec = execFileAsync,
    config,
  }: { exec?: Exec; config?: ResolvedConfig } = {},
): Promise<CollectContextResult> {
  let range: string | undefined;
  let rawFiles: string[];
  let diffEnv: Record<string, string> | undefined;
  let dispose: () => void = noopDispose;
  let fellBackToRange = false;

  try {
    if (opts.mode === "pr") {
      range = await resolvePrBaseRange(opts.pr, {
        exec,
        baseRef: opts.baseRef,
      });
      rawFiles = await getChangedFilesFromRange(range, { exec });
    } else if (opts.range) {
      // --range 明示指定 → 従来どおり range モード（後方互換）。
      range = await resolveRange(opts.range, { exec });
      rawFiles = await getChangedFilesFromRange(range, { exec });
    } else {
      // 引数なし実行（デフォルト）→ workspace モード: staged+unstaged+untracked を
      // 一時 GIT_INDEX_FILE 経由で単一の統一 diff として扱う（案B。詳細は workspace-index.ts）。
      // createWorkspaceIndex 自体がこの try の中にあるため、シード後の失敗（abort 含む）で
      // 一時 index に到達不能になることはない（正常 return 後は関数内で dispose 差し替え済み、
      // 例外時は createWorkspaceIndex 内で掃除済みのため catch の dispose() は no-op）。
      const workspaceIndex = await createWorkspaceIndex({ exec });
      diffEnv = workspaceIndex.env;
      dispose = workspaceIndex.dispose;
      const trackedFiles = await getWorkspaceTrackedFiles(
        workspaceIndex.baseRef,
        mergeEnv(diffEnv),
        { exec },
      );
      rawFiles = [...new Set([...trackedFiles, ...workspaceIndex.untracked])];
      range = workspaceIndex.baseRef;

      // 未コミット変更が1件もない（＝全てコミット済み）場合は base ブランチとの差分に
      // 自動フォールバックする。workspace の一時 index は不要になるので破棄する。
      if (rawFiles.length === 0) {
        dispose();
        dispose = noopDispose;
        diffEnv = undefined;
        try {
          range = await resolveRange(undefined, { exec });
        } catch (cause) {
          throw new Error(`未コミット変更がなく、${(cause as Error).message}`);
        }
        rawFiles = await getChangedFilesFromRange(range, { exec });
        fellBackToRange = true;
      }
    }

    // レビュー対象外（生成物・バイナリ・linguist 属性付き）を機械的に除外する。
    // 除外したファイルは excludedFiles として明示し、暗黙のスキップにしない。
    // 先にデフォルト glob で除外できるものを外し、残りだけ git check-attr に問い合わせる
    // （バイナリ多数の diff で check-attr へ渡すパスを減らす）。
    const globSurvivors = rawFiles.filter(
      (f) => !fileMatchesPatterns(f, DEFAULT_EXCLUDE_GLOBS),
    );
    const attrExcludedSet = await detectLinguistExcluded(globSurvivors, {
      exec,
    });
    const { kept: keptFiles, excluded: excludedFiles } = classifyFiles(
      rawFiles,
      { attrExcludedSet },
    );

    const diffArgs = [range as string];

    // まず「生成物/バイナリのみ除外」した diff で numstat を取り、ファイル別行数を得る。
    // この perFile から oversized（1ファイルが巨大な変更）を分離する。行数集計は同じ出力から
    // 得られるので numstat は1回だけ（追加コストなし）。
    const lineStats = await collectChangedLines(
      diffArgs,
      buildExcludeArgs(excludedFiles).git,
      {
        exec,
        env: diffEnv ? mergeEnv(diffEnv) : undefined,
      },
    );
    const { changedFiles, oversizedFiles } = splitOversized(
      keptFiles,
      lineStats.perFile,
      config?.thresholds.oversizedMaxLines ?? OVERSIZED_MAX_LINES,
    );

    const rules = await collectRules(changedFiles);

    // 最終の除外引数は excludedFiles（生成物/バイナリ）と oversizedFiles（大規模）の両方を含む。
    // 以降の diff 取得・アンカー解決はすべてこの excludeArgs.git を経由するため、oversized は
    // 全 diff から一様に消える（emit-diff / diff-anchor は無改修で整合する）。
    const excludeArgs = buildExcludeArgs([...excludedFiles, ...oversizedFiles]);

    // メトリクス・tier は oversized を除いた「実際にレビューする」規模で確定する。
    // oversized 分の行数は上の numstat（perFile）から減算するだけで求まるため git は再実行しない。
    // oversized は kept と照合済みで perFile に必ず存在し、バイナリ行は perFile に載らないので
    // 減算に混入しない。ファイル数は changedFiles.length（oversized 除外後）。
    let oversizedAdded = 0;
    let oversizedDeleted = 0;
    for (const f of oversizedFiles) {
      const stat = lineStats.perFile.get(f);
      if (stat) {
        oversizedAdded += stat.added;
        oversizedDeleted += stat.deleted;
      }
    }
    const totalAdded = lineStats.totalAdded - oversizedAdded;
    const totalDeleted = lineStats.totalDeleted - oversizedDeleted;
    const metrics = {
      totalFiles: changedFiles.length,
      totalAdded,
      totalDeleted,
      totalChangedLines: totalAdded + totalDeleted,
    };
    const tier = classifyTier(
      metrics.totalFiles,
      metrics.totalChangedLines,
      config?.thresholds,
    );

    // tier に応じてルール準拠エージェントの割り当てを縮退させる
    // （small は buckets[1] を空にして2体目の起動を抑止する）。
    const assignments = buildAssignments(changedFiles, rules, undefined, tier);

    // --range 明示指定 or フォールバック時は range 扱い（source/range 判定で共通利用）。
    const isRangeLike = opts.mode !== "pr" && (!!opts.range || fellBackToRange);

    // source は全モードで出力する。PR モードもローカル range に統一されたため、diffArgs /
    // range を持つ（PR は `<baseRefOid>...HEAD`、workspace は `HEAD` or 空ツリー SHA）。
    const source: ContextSource =
      opts.mode === "pr" ? "pr" : isRangeLike ? "range" : "workspace";
    const context: Context = {
      source,
      changedFiles,
      excludedFiles,
      // 変更行数が閾値超で個別レビューが困難と判断し、レビュー対象から外したファイル。
      // excludedFiles（生成物/バイナリ）とは除外理由が異なる別枠。excludeArgs.git にも含まれる。
      oversizedFiles,
      // 各 diff 取得コマンド向けの除外引数。
      excludeArgs,
      assignments,
      // 変更規模と tier（プロンプトはこの tier を読み、起動エージェント数を決める）。
      metrics,
      tier,
      // diffArgs は後続の `git diff <diffArgs>` 用引数（全モードで差分取得を一様化）。
      diffArgs,
      // range は PR モードと range モードで持つ（workspace モードでは undefined。
      // baseRef は内部実装の詳細であり、ユーザー向けの「範囲指定」とは意味が異なるため）。
      range: opts.mode === "pr" || isRangeLike ? range : undefined,
      diffEnv,
      fellBackToRange,
    };

    return { context, dispose };
  } catch (error) {
    // ここまでの処理で失敗した場合、workspace モードの一時 index を残さない
    // （呼び出し側の finally に到達しないため、ここで dispose する）。
    dispose();
    throw error;
  }
}
