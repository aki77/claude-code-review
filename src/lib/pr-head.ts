// step0: ローカル HEAD と PR HEAD の一致確認ゲート。
// pr-review/SKILL.md 準拠のメッセージで throw する。LLM コストを一切かける前に
// runPrReview の最初期で呼ぶ。
import { execFileAsync } from "./exec.ts";

type Exec = typeof execFileAsync;

export async function assertPrHeadMatches(
  pr: string,
  headRefOid: string,
  { exec = execFileAsync }: { exec?: Exec } = {},
): Promise<void> {
  const result = await exec("git", ["rev-parse", "HEAD"]);
  if (result.code !== 0) {
    throw new Error(
      `ローカルの HEAD を取得できませんでした: ${result.stderr.trim()}`,
    );
  }
  const localSha = result.stdout.trim();
  if (localSha !== headRefOid) {
    throw new Error(
      `ローカルの HEAD が PR #${pr} の HEAD（${headRefOid}）と一致しません（ローカル: ${localSha}）。` +
        `対象 PR のブランチをチェックアウト（または最新化）してから再実行してください。`,
    );
  }
}
