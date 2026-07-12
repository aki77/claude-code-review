// PR メタ情報の取得＋著者情報整形。local-review の「著者意図情報」（git log 相当）を
// pr-review では PR タイトル/説明文＋コミット一覧から組み立てる。
import { execFileAsync } from "./exec.ts";

type Exec = typeof execFileAsync;

export interface PrMetaCommit {
  messageHeadline: string;
  messageBody?: string;
}

export interface PrMeta {
  title: string;
  body: string;
  commits: PrMetaCommit[];
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
}

// gh pr view <pr> --json title,body,commits,headRefOid,baseRefOid,baseRefName を1回で取得する。
// step0（HEAD 一致ゲート）が必要とする headRefOid、collectContext の PR モード
// （resolvePrBaseRange）が必要とする baseRefOid/baseRefName も同時に取れるため、
// gh pr view の重複呼び出しを避ける（計画doc参照）。
export async function fetchPrMeta(
  pr: string,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<PrMeta> {
  const result = await exec("gh", [
    "pr",
    "view",
    pr,
    "--json",
    "title,body,commits,headRefOid,baseRefOid,baseRefName",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `PR #${pr} のメタ情報を取得できませんでした: ${result.stderr.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  return {
    title: parsed.title ?? "",
    body: parsed.body ?? "",
    commits: Array.isArray(parsed.commits) ? parsed.commits : [],
    headRefOid: parsed.headRefOid,
    baseRefOid: parsed.baseRefOid,
    baseRefName: parsed.baseRefName,
  };
}

// PR タイトル・説明・コミットメッセージ一覧を著者意図情報として整形する純関数
// （local-review の git log 相当）。
export function formatPrAuthorInfo(meta: PrMeta): string {
  const lines: string[] = [`# ${meta.title}`];
  if (meta.body.trim()) {
    lines.push("", meta.body.trim());
  }
  if (meta.commits.length > 0) {
    lines.push("", "## コミット一覧");
    for (const commit of meta.commits) {
      lines.push(`- ${commit.messageHeadline}`);
      if (commit.messageBody?.trim()) {
        lines.push(
          ...commit.messageBody
            .trim()
            .split("\n")
            .map((l) => `  ${l}`),
        );
      }
    }
  }
  return lines.join("\n");
}

// 投稿先リポジトリ（owner/repo）を取得する。パーマリンク組立と gh api の投稿先 URL に使う。
export async function getNameWithOwner({
  exec = execFileAsync,
}: {
  exec?: Exec;
} = {}): Promise<string> {
  const result = await exec("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `リポジトリ情報（nameWithOwner）を取得できませんでした: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}
