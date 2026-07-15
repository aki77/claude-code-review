// local レビューの workspace モード（staged+unstaged+untracked を単一の統一 diff として
// 扱う）を支えるための一時 index ライフサイクル。
//
// 背景・採用方式（案B: 一時 GIT_INDEX_FILE）は
// .claude/plans/code-review-local-open-code-review-claud-staged-kay.md 参照。
// untracked ファイルを「作業ツリーを汚さず」統一 diff に載せるため、実 index をコピーした
// 一時 index に対して `git add -N`（intent-to-add）する。これにより `git diff <baseRef>` /
// `--numstat` / `--name-only` が tracked の staged+unstaged 統合 + untracked を
// `new file` 追加扱いで単一の統一 diff として出力する。実 index・作業ツリーは一切変更しない。
//
// 落とし穴1（必須）: 一時 index は必ず実 index を cp でシードする。空 index に
// `git add -N` すると staged 済み内容が diff から消える（実測済み）。
// 落とし穴2: HEAD が無い（初回コミット前の）リポジトリでは `git diff HEAD` が fatal。
// 空ツリー SHA へフォールバックする。
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { execFileAsync } from "./exec.ts";

type Exec = typeof execFileAsync;

// git の空ツリー SHA（`git hash-object -t tree /dev/null` の結果）。全リポジトリ共通の固定値
// なので都度 git を呼ばず定数として持つ。
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// 同一プロセス内で複数回呼ばれても一時ファイル名が衝突しないよう、pid に加えて
// モジュールロード後の呼び出し回数をカウンタとして付与する
// （Math.random/Date.now はこの環境の一部実行コンテキストで使えないため使用しない）。
let counter = 0;

export interface WorkspaceIndex {
  /** exec に渡す env の override 分。呼び出し側で process.env とマージして使う。 */
  env: { GIT_INDEX_FILE: string };
  /** intent-to-add した untracked ファイル一覧。 */
  untracked: string[];
  /** `git diff` の base 引数。HEAD があれば "HEAD"、無ければ空ツリー SHA。 */
  baseRef: string;
  /** 一時 index ファイルを削除する。実 index には触れない。 */
  dispose(): void;
}

// 実 env と override をマージした env を作る。GIT_INDEX_FILE だけの env にすると PATH 等が
// 消えるため、呼び出し側の exec 呼び出しごとにこのヘルパーでマージした env を渡す。
export function mergeEnv(override: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...override };
}

export async function createWorkspaceIndex({
  exec = execFileAsync,
}: {
  exec?: Exec;
} = {}): Promise<WorkspaceIndex> {
  const realIndexResult = await exec("git", [
    "rev-parse",
    "--git-path",
    "index",
  ]);
  const realIndexPath = realIndexResult.stdout.trim();

  const tmpIndexPath = `${realIndexPath}.review-${process.pid}-${counter++}`;
  const removeTmpIndex = (): void => rmSync(tmpIndexPath, { force: true });

  // シード処理（copyFileSync）を含め、これ以降に例外（abort・git エラー・コピー失敗等）が
  // 起きた場合はここで一時 index を掃除してから rethrow する。正常 return 後の掃除責務は
  // 呼び出し側が受け取る dispose() に移る。
  try {
    if (existsSync(realIndexPath)) {
      copyFileSync(realIndexPath, tmpIndexPath);
    }
    // 実 index が存在しない（コミット無し・add 未実行の空リポ）場合でも、空の一時 index から
    // 開始すれば git add -N が動作する（新規 index として初期化される）。

    const override = { GIT_INDEX_FILE: tmpIndexPath };
    const env = mergeEnv(override);

    // HEAD 不在の判定（初回コミット前のリポジトリ）と untracked（新規未追加）ファイルの列挙は
    // どちらも一時 index シード後は独立に実行できるため並列化する。
    const [headCheck, lsFiles] = await Promise.all([
      exec("git", ["rev-parse", "--verify", "HEAD"], { env }),
      exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        env,
      }),
    ]);
    const baseRef = headCheck.code === 0 ? "HEAD" : EMPTY_TREE_SHA;
    // -z（NUL 区切り）はファイル名中の空白・改行を安全に扱うための出力なので trim しない。
    // 末尾の空要素だけ filter(Boolean) で除去する。
    const untracked = lsFiles.stdout.split("\0").filter(Boolean);

    // untracked を一時 index に intent-to-add する（untracked 確定後のみ実行できるため直列）。
    if (untracked.length > 0) {
      const addResult = await exec("git", ["add", "-N", "--", ...untracked], {
        env,
      });
      if (addResult.code !== 0) {
        throw new Error(
          `untracked ファイルの intent-to-add に失敗しました（git add -N, exit ${addResult.code}）: ${addResult.stderr.trim()}`,
        );
      }
    }

    return {
      env: override,
      untracked,
      baseRef,
      dispose: removeTmpIndex,
    };
  } catch (error) {
    removeTmpIndex();
    throw error;
  }
}
