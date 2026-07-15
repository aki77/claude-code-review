import { describe, expect, it } from "vitest";
import {
  buildAssignments,
  buildExcludeArgs,
  classifyFiles,
  classifyTier,
  collectContext,
  fileMatchesPatterns,
  parseCheckAttrOutput,
  parseFrontmatterPaths,
  parseNumstat,
  resolvePrBaseRange,
  splitOversized,
} from "../src/lib/collect-context.ts";
import type { ExecResult } from "../src/lib/exec.ts";
import type { Rule } from "../src/lib/types.ts";

describe("fileMatchesPatterns", () => {
  const matches = (file: string, pattern: string) =>
    fileMatchesPatterns(file, [pattern]);

  it("** はディレクトリを跨いでマッチする", () => {
    expect(matches("app/views/x.erb", "app/views/**/*")).toBe(true);
    expect(
      matches(
        "app/views/active_storage/blobs/_blob.html.erb",
        "app/views/**/*",
      ),
    ).toBe(true);
    expect(matches("app/models/x.rb", "app/views/**/*")).toBe(false);
  });

  it("* は / を跨がない", () => {
    expect(matches("app/models/user.rb", "app/models/*.rb")).toBe(true);
    expect(matches("app/models/admin/user.rb", "app/models/*.rb")).toBe(false);
  });

  it("単一ファイルパスは完全一致のみ", () => {
    expect(matches("config/routes.rb", "config/routes.rb")).toBe(true);
    expect(matches("config/routes/admin.rb", "config/routes.rb")).toBe(false);
  });

  it("{a,b} と ? を扱える", () => {
    expect(matches("db/migrate/x.rb", "db/{migrate,seeds}/x.rb")).toBe(true);
    expect(matches("db/seeds/x.rb", "db/{migrate,seeds}/x.rb")).toBe(true);
    expect(matches("ab.rb", "a?.rb")).toBe(true);
    expect(matches("a/.rb", "a?.rb")).toBe(false);
  });

  it("削除ファイル等 FS に無いパスでも文字列で照合できる", () => {
    expect(matches("app/views/deleted/gone.erb", "app/views/**/*")).toBe(true);
  });

  it("いずれかにマッチすれば true", () => {
    const patterns = ["app/components/**/*", "app/views/**/*"];
    expect(fileMatchesPatterns("app/components/x.rb", patterns)).toBe(true);
    expect(fileMatchesPatterns("app/views/x.erb", patterns)).toBe(true);
    expect(fileMatchesPatterns("app/models/x.rb", patterns)).toBe(false);
  });
});

describe("parseFrontmatterPaths", () => {
  it("paths 未指定は null（全ファイル適用）", () => {
    expect(parseFrontmatterPaths("no frontmatter")).toBeNull();
    expect(parseFrontmatterPaths("---\nfoo: bar\n---\nbody")).toBeNull();
  });

  it("ブロック形式の paths を配列で返す", () => {
    const fm =
      "---\npaths:\n  - 'app/models/**/*.rb'\n  - \"config/routes.rb\"\n---\nbody";
    expect(parseFrontmatterPaths(fm)).toEqual([
      "app/models/**/*.rb",
      "config/routes.rb",
    ]);
  });

  it("インライン配列形式の paths を扱える", () => {
    const fm = "---\npaths: ['app/views/**/*']\n---\nbody";
    expect(parseFrontmatterPaths(fm)).toEqual(["app/views/**/*"]);
  });
});

describe("buildAssignments", () => {
  const fakeResolve = (file: string) => {
    const rules = ["CLAUDE.md", "comment"];
    if (file.startsWith("models/")) rules.push("app-models");
    if (file.startsWith("migrate/")) rules.push("db-migrate");
    if (file.startsWith("views/")) rules.push("app-views");
    return rules;
  };
  const build = (files: string[]) => buildAssignments(files, [], fakeResolve);
  const buildTier = (files: string[], tier: "small" | "normal") =>
    buildAssignments(files, [], fakeResolve, tier);
  const fileCounts = (assignments: ReturnType<typeof build>) =>
    assignments.map((a) => a.files.length);
  const bucketRuleUnion = (bucket: ReturnType<typeof build>[number]) =>
    new Set(bucket.files.flatMap((f) => f.rules));

  it("ルールなし → 両バケット空", () => {
    expect(fileCounts(build([]))).toEqual([0, 0]);
  });

  it("単一グループは2バケットへ均等割り", () => {
    expect(fileCounts(build(["a.txt", "b.txt", "c.txt", "d.txt"]))).toEqual([
      2, 2,
    ]);
  });

  it("巨大な共通グループ + 小グループ2つを均等化（#780型）", () => {
    // comment-only 30 + models 3 + migrate 3 = 36 → 18 対 18
    const files: string[] = [];
    for (let i = 0; i < 30; i++) files.push(`docs/d${i}.md`);
    for (let i = 0; i < 3; i++) files.push(`models/m${i}.rb`);
    for (let i = 0; i < 3; i++) files.push(`migrate/g${i}.rb`);
    const a = build(files);
    expect(fileCounts(a)).toEqual([18, 18]);
    const u0 = bucketRuleUnion(a[0]!);
    const u1 = bucketRuleUnion(a[1]!);
    expect(u0.has("app-models") && u0.has("db-migrate")).toBe(false);
    expect(u1.has("app-models") && u1.has("db-migrate")).toBe(false);
  });

  it("大グループ + 部分集合 filler を均等化（#792型）", () => {
    // views 17（app-views+comment） + config 6（comment のみ=views の部分集合）
    const files: string[] = [];
    for (let i = 0; i < 17; i++) files.push(`views/v${i}.erb`);
    for (let i = 0; i < 6; i++) files.push(`config/c${i}.yml`);
    const a = build(files);
    const counts = fileCounts(a).sort((x, y) => y - x);
    expect(counts).toEqual([17, 6]);
    const configBucket = a.find((b) =>
      b.files.some((f) => f.path.startsWith("config/")),
    );
    expect(bucketRuleUnion(configBucket!).has("app-views")).toBe(false);
  });

  it("各ファイルに適用ルールが付与される", () => {
    const a = build(["models/user.rb"]);
    const file = a
      .flatMap((b) => b.files)
      .find((f) => f.path === "models/user.rb");
    expect(file?.rules.slice().sort()).toEqual(
      ["CLAUDE.md", "app-models", "comment"].sort(),
    );
  });

  it("small は全ファイルを buckets[0] に寄せて buckets[1] を空にする", () => {
    const a = buildTier(["a.txt", "b.txt", "c.txt", "d.txt"], "small");
    expect(fileCounts(a)).toEqual([4, 0]);
  });

  it("small も複数グループを buckets[0] に集約する", () => {
    const files = ["models/m0.rb", "migrate/g0.rb", "docs/d0.md"];
    const a = buildTier(files, "small");
    expect(a[1]!.files.length).toBe(0);
    expect(a[0]!.files.length).toBe(3);
  });

  it("normal は従来どおり2バケットへ分割（後方互換）", () => {
    const a = buildTier(["a.txt", "b.txt", "c.txt", "d.txt"], "normal");
    expect(fileCounts(a)).toEqual([2, 2]);
  });
});

describe("classifyTier", () => {
  it("small はファイル数 AND 行数の両方がしきい値未満", () => {
    expect(classifyTier(2, 33)).toBe("small"); // PR #813 相当（2ファイル33行）
    expect(classifyTier(1, 49)).toBe("small");
    expect(classifyTier(2, 49)).toBe("small");
    expect(classifyTier(5, 149)).toBe("small");
    expect(classifyTier(3, 100)).toBe("small");
  });

  it("しきい値を超えたら normal", () => {
    expect(classifyTier(6, 100)).toBe("normal"); // ファイル数超過
    expect(classifyTier(5, 150)).toBe("normal"); // 行数超過
    expect(classifyTier(20, 500)).toBe("normal");
  });
});

describe("parseNumstat", () => {
  it("added/deleted/path をパースし合計行数を出せる", () => {
    const out = "10\t5\tsrc/a.ts\n2\t0\tspec/b.rb\n";
    const rows = parseNumstat(out);
    expect(rows).toHaveLength(2);
    const total = rows.reduce(
      (s, r) => s + (r.added ?? 0) + (r.deleted ?? 0),
      0,
    );
    expect(total).toBe(17);
  });

  it("バイナリ行（- -）は added/deleted が null", () => {
    const out = "-\t-\tassets/logo.png\n3\t1\tsrc/a.ts\n";
    const rows = parseNumstat(out);
    expect(rows[0]!.added).toBeNull();
    expect(rows[0]!.deleted).toBeNull();
    expect(rows[1]!.added).toBe(3);
  });

  it("空行・不正行はスキップする", () => {
    const out = "\n5\t5\tsrc/a.ts\ngarbage\n";
    const rows = parseNumstat(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("src/a.ts");
  });

  it("rename 生パス（old => new）はそのまま path に入る", () => {
    // 正規化しない設計の確認（splitOversized 側の照合漏れ＝安全側挙動の前提）。
    const out = "10\t2\tsrc/old.rb => src/new.rb\n";
    const rows = parseNumstat(out);
    expect(rows[0]!.path).toBe("src/old.rb => src/new.rb");
    expect((rows[0]!.added ?? 0) + (rows[0]!.deleted ?? 0)).toBe(12);
  });
});

describe("classifyFiles", () => {
  it("デフォルト glob（ミニファイ/生成物/バイナリ）を除外する", () => {
    const files = [
      "src/app.js",
      "dist/bundle.js",
      "assets/app.min.js",
      "public/logo.png",
      "docs/guide.md",
    ];
    const { kept, excluded } = classifyFiles(files);
    expect(kept).toEqual(["src/app.js", "docs/guide.md"]);
    expect(excluded.slice().sort()).toEqual(
      ["assets/app.min.js", "dist/bundle.js", "public/logo.png"].sort(),
    );
  });

  it("SVG はテキスト diff として保持する", () => {
    const { kept, excluded } = classifyFiles(["icons/menu.svg"]);
    expect(kept).toEqual(["icons/menu.svg"]);
    expect(excluded).toEqual([]);
  });

  it("linguist 属性（attrExcludedSet 注入）を除外する", () => {
    const files = ["src/a.rb", "src/generated_schema.rb"];
    const attrExcludedSet = new Set(["src/generated_schema.rb"]);
    const { kept, excluded } = classifyFiles(files, { attrExcludedSet });
    expect(kept).toEqual(["src/a.rb"]);
    expect(excluded).toEqual(["src/generated_schema.rb"]);
  });

  it("defaultGlobs を注入してテストできる", () => {
    const { kept, excluded } = classifyFiles(["a.gen", "b.rb"], {
      defaultGlobs: ["**/*.gen"],
    });
    expect(kept).toEqual(["b.rb"]);
    expect(excluded).toEqual(["a.gen"]);
  });
});

describe("parseCheckAttrOutput", () => {
  it("値ごとの除外判定（無効値以外は除外）", () => {
    // 設定値（set/true/任意の値）→ 除外、無効値（unspecified/unset/false）→ 除外しない
    const cases: Array<[string, boolean]> = [
      ["set", true], // 値なし記法（`path linguist-generated`）
      ["true", true], // `=true`
      ["1", true], // `=1`（linguist は打ち消し以外の設定値を有効扱い）
      ["yes", true], // `=yes`
      ["unspecified", false], // 属性なし
      ["unset", false], // `-attr` で打ち消し
      ["false", false], // `=false`
    ];
    for (const [value, excluded] of cases) {
      const out = `f.rb\0linguist-generated\0${value}\0`;
      expect([...parseCheckAttrOutput(out)]).toEqual(excluded ? ["f.rb"] : []);
    }
  });

  it("3属性が並び、いずれか設定値なら含める", () => {
    const out =
      "vendor/x.rb\0linguist-generated\0unspecified\0" +
      "vendor/x.rb\0linguist-vendored\0set\0" +
      "vendor/x.rb\0linguist-documentation\0unspecified\0";
    expect([...parseCheckAttrOutput(out)]).toEqual(["vendor/x.rb"]);
  });

  it("空出力は空 Set", () => {
    expect([...parseCheckAttrOutput("")]).toEqual([]);
  });
});

describe("buildExcludeArgs", () => {
  it("空配列なら git は空", () => {
    expect(buildExcludeArgs([])).toEqual({ git: [] });
  });

  it("複数パスを git 向け引数に組み立てる", () => {
    const args = buildExcludeArgs(["dist/a.js", "b.png"]);
    expect(args.git).toEqual([
      "--",
      ".",
      ":(exclude)dist/a.js",
      ":(exclude)b.png",
    ]);
  });
});

describe("splitOversized", () => {
  const stat = (total: number) => ({ added: total, deleted: 0 });

  it("閾値を超えたファイルだけ分離し、境界（= 閾値）は残す", () => {
    const kept = ["a.rb", "b.rb", "c.rb"];
    const perFile = new Map([
      ["a.rb", stat(1001)], // 超過 → oversized
      ["b.rb", stat(1000)], // ちょうど → レビュー対象に残す（strictly greater）
      ["c.rb", stat(10)], // 通常
    ]);
    const { changedFiles, oversizedFiles } = splitOversized(
      kept,
      perFile,
      1000,
    );
    expect(oversizedFiles).toEqual(["a.rb"]);
    expect(changedFiles).toEqual(["b.rb", "c.rb"]);
  });

  it("added+deleted の合算で閾値判定する", () => {
    const kept = ["a.rb"];
    const perFile = new Map([["a.rb", { added: 600, deleted: 500 }]]); // 合計 1100 > 1000
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    expect(oversizedFiles).toEqual(["a.rb"]);
  });

  it("perFile に無い kept（照合漏れ・rename 生パス等）はレビュー対象に残す", () => {
    // numstat が rename を `old => new` で出し kept の新パスと一致しないケースの安全側挙動。
    const kept = ["src/renamed.rb"];
    const perFile = new Map([["src/old.rb => src/renamed.rb", stat(5000)]]);
    const { changedFiles, oversizedFiles } = splitOversized(
      kept,
      perFile,
      1000,
    );
    expect(oversizedFiles).toEqual([]);
    expect(changedFiles).toEqual(["src/renamed.rb"]);
  });

  it("oversized は sort 済み配列で返る", () => {
    const kept = ["z.rb", "a.rb"];
    const perFile = new Map([
      ["z.rb", stat(2000)],
      ["a.rb", stat(2000)],
    ]);
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    expect(oversizedFiles).toEqual(["a.rb", "z.rb"]);
  });

  it("全ファイルが oversized なら changedFiles は空", () => {
    const kept = ["a.rb", "b.rb"];
    const perFile = new Map([
      ["a.rb", stat(3000)],
      ["b.rb", stat(3000)],
    ]);
    const { changedFiles, oversizedFiles } = splitOversized(
      kept,
      perFile,
      1000,
    );
    expect(changedFiles).toEqual([]);
    expect(oversizedFiles).toEqual(["a.rb", "b.rb"]);
  });

  it("excluded と oversized の両方が :(exclude) に入る（buildExcludeArgs 連結）", () => {
    // main のフロー相当（生成物除外 + 大規模除外を1つの excludeArgs にまとめる）。
    const excludedFiles = ["dist/bundle.js"];
    const kept = ["src/big.rb", "src/small.rb"];
    const perFile = new Map([
      ["src/big.rb", stat(2000)],
      ["src/small.rb", stat(20)],
    ]);
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    const args = buildExcludeArgs([...excludedFiles, ...oversizedFiles]);
    expect(args.git).toEqual([
      "--",
      ".",
      ":(exclude)dist/bundle.js",
      ":(exclude)src/big.rb",
    ]);
  });
});

describe("resolvePrBaseRange", () => {
  type Stub = (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; code: number }>;

  it("正常系は <baseRefOid>...HEAD を返す", async () => {
    const exec: Stub = async (cmd) => {
      if (cmd === "gh") {
        return {
          stdout: JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" }),
          stderr: "",
          code: 0,
        };
      }
      // git cat-file / merge-base はどちらも成功
      return { stdout: "", stderr: "", code: 0 };
    };
    await expect(resolvePrBaseRange("7", { exec })).resolves.toBe(
      "abc123...HEAD",
    );
  });

  it("base コミット不在は fetch 指示を含めて throw", async () => {
    const exec: Stub = async (cmd, args) => {
      if (cmd === "gh") {
        return {
          stdout: JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" }),
          stderr: "",
          code: 0,
        };
      }
      if (cmd === "git" && args[0] === "cat-file") {
        return { stdout: "", stderr: "not found", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    await expect(resolvePrBaseRange("7", { exec })).rejects.toThrow(
      /git fetch origin main/,
    );
  });

  it("merge-base 不能（shallow）は --unshallow を含めて throw", async () => {
    const exec: Stub = async (cmd, args) => {
      if (cmd === "gh") {
        return {
          stdout: JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" }),
          stderr: "",
          code: 0,
        };
      }
      if (cmd === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "shallow", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    await expect(resolvePrBaseRange("7", { exec })).rejects.toThrow(
      /--unshallow/,
    );
  });

  it("baseRefOid 欠落は throw", async () => {
    const exec: Stub = async (cmd) => {
      if (cmd === "gh") {
        return {
          stdout: JSON.stringify({ baseRefName: "main" }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    await expect(resolvePrBaseRange("7", { exec })).rejects.toThrow(
      /baseRefOid/,
    );
  });

  it("不正 JSON は throw", async () => {
    const exec: Stub = async (cmd) => {
      if (cmd === "gh") return { stdout: "not json", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    await expect(resolvePrBaseRange("7", { exec })).rejects.toThrow();
  });

  it("baseRef 指定時は gh pr view を呼ばない（重複呼び出し回避）", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Stub = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0 };
    };
    const result = await resolvePrBaseRange("7", {
      exec,
      baseRef: { baseRefOid: "abc123", baseRefName: "main" },
    });
    expect(result).toBe("abc123...HEAD");
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);
  });
});

// Rule 型を明示的に使う型検証（未使用 import 警告を避けつつ、収集ルール定義の形が
// 仕様どおりであることを確認する）。
describe("Rule 型", () => {
  it("paths=null は全ファイル適用を表す", () => {
    const rule: Rule = { path: ".claude/rules/foo.md", paths: null };
    expect(rule.paths).toBeNull();
  });
});

// collectContext の workspace モード（range 未指定時のデフォルト）を検証する。
// 一時 index パスは実在しない架空パスを返す（existsSync が false になり copyFileSync は
// スキップされる。dispose の rmSync も force:true のため実ファイルには一切触れない）。
describe("collectContext: workspace モード", () => {
  type Stub = (
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => Promise<ExecResult>;

  // 呼び出しを記録しつつ、シナリオごとの応答テーブルで分岐するフェイク exec を作る。
  function makeExec(opts: {
    headExists?: boolean;
    untracked?: string[];
    trackedFiles?: string[];
    numstat?: string;
  }): { exec: Stub; calls: { args: string[] }[] } {
    const calls: { args: string[] }[] = [];
    const exec: Stub = async (command, args) => {
      calls.push({ args });
      if (command !== "git") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        return {
          stdout: "/tmp/fake-repo-does-not-exist/.git/index\n",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return (opts.headExists ?? true)
          ? { stdout: "head000\n", stderr: "", code: 0 }
          : { stdout: "", stderr: "fatal: HEAD 不在", code: 128 };
      }
      if (args[0] === "ls-files" && args.includes("--others")) {
        const untracked = opts.untracked ?? [];
        return {
          stdout: untracked.length ? `${untracked.join("\0")}\0` : "",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "add" && args.includes("-N")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        args[0] === "diff" &&
        args.includes("--name-only") &&
        args.includes("--find-renames")
      ) {
        return {
          stdout: `${(opts.trackedFiles ?? []).join("\n")}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "check-attr") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "diff" && args.includes("--numstat")) {
        return { stdout: opts.numstat ?? "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    return { exec, calls };
  }

  it("staged のみ: tracked ファイルが changedFiles に載り source=workspace", async () => {
    const { exec } = makeExec({
      trackedFiles: ["staged.ts"],
      numstat: "3\t0\tstaged.ts\n",
    });
    const { context, dispose } = await collectContext(
      { mode: "range" },
      { exec },
    );
    expect(context.source).toBe("workspace");
    expect(context.changedFiles).toEqual(["staged.ts"]);
    expect(context.diffArgs).toEqual(["HEAD"]);
    expect(context.diffEnv?.GIT_INDEX_FILE).toBeDefined();
    expect(context.range).toBeUndefined();
    dispose();
  });

  it("unstaged のみ / staged+unstaged 混在も同じ tracked 列挙経路にまとまる", async () => {
    const { exec } = makeExec({
      trackedFiles: ["staged.ts", "unstaged.ts"],
      numstat: "1\t1\tstaged.ts\n2\t0\tunstaged.ts\n",
    });
    const { context, dispose } = await collectContext(
      { mode: "range" },
      { exec },
    );
    expect(context.changedFiles.sort()).toEqual(["staged.ts", "unstaged.ts"]);
    dispose();
  });

  it("untracked のみ: ls-files の結果が changedFiles に合流する", async () => {
    const { exec, calls } = makeExec({
      untracked: ["new.ts"],
      trackedFiles: [],
      numstat: "5\t0\tnew.ts\n",
    });
    const { context, dispose } = await collectContext(
      { mode: "range" },
      { exec },
    );
    expect(context.changedFiles).toEqual(["new.ts"]);
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "-N", "--", "new.ts"]);
    dispose();
  });

  it("staged+unstaged+untracked 全部入り: 3種すべてが changedFiles に含まれる", async () => {
    const { exec } = makeExec({
      untracked: ["new.ts"],
      trackedFiles: ["staged.ts", "unstaged.ts"],
      numstat: "1\t0\tstaged.ts\n2\t1\tunstaged.ts\n3\t0\tnew.ts\n",
    });
    const { context, dispose } = await collectContext(
      { mode: "range" },
      { exec },
    );
    expect(context.changedFiles.sort()).toEqual([
      "new.ts",
      "staged.ts",
      "unstaged.ts",
    ]);
    dispose();
  });

  it("空リポ（HEAD 不在）: baseRef が空ツリー SHA になり diffArgs に反映される", async () => {
    const { exec } = makeExec({
      headExists: false,
      untracked: ["new.ts"],
      trackedFiles: [],
      numstat: "1\t0\tnew.ts\n",
    });
    const { context, dispose } = await collectContext(
      { mode: "range" },
      { exec },
    );
    expect(context.diffArgs).toEqual([
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    ]);
    expect(context.changedFiles).toEqual(["new.ts"]);
    dispose();
  });

  it("--range 明示指定時は従来どおり range モード（source=range）", async () => {
    const calls: { args: string[] }[] = [];
    const exec: Stub = async (command, args) => {
      calls.push({ args });
      if (command !== "git") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) {
        return { stdout: "a.ts\n", stderr: "", code: 0 };
      }
      if (args[0] === "check-attr") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "diff" && args.includes("--numstat")) {
        return { stdout: "1\t0\ta.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const { context, dispose } = await collectContext(
      { mode: "range", range: "main" },
      { exec },
    );
    expect(context.source).toBe("range");
    expect(context.range).toBe("main...HEAD");
    expect(context.diffEnv).toBeUndefined();
    // workspace-index 系のコマンド（rev-parse --git-path / ls-files 等）は呼ばれない。
    expect(calls.some((c) => c.args.includes("--git-path"))).toBe(false);
    expect(calls.some((c) => c.args[0] === "ls-files")).toBe(false);
    dispose();
  });
});
