// spec-m3 §3 —— 两条策略规则与 §3.3 的顺序不变量。真实文件系统,走完整生产路径(toActions → 管线)。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toActions } from "../src/adapters/claude-code.ts";
import { clearCache } from "../src/core/cache.ts";
import type { Context } from "../src/core/context.ts";
import { decideAll, type BatchResult } from "../src/core/pipeline.ts";
import { clearCwdCache, clearGitCache, enrich } from "../src/enrichers/index.ts";
import { clearPolicyCache, loadPolicy, resetPolicyWarnings } from "../src/policy.ts";
import { RULES } from "../src/rules/index.ts";
import { POLICY_RULES, scopeHits } from "../src/rules/policy.ts";

let root: string;
let stderr: ReturnType<typeof spyOn>;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zgate-rules-policy-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  clearCache();
  clearGitCache();
  clearCwdCache();
  clearPolicyCache();
  resetPolicyWarnings();
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => stderr.mockRestore());

let n = 0;
/** 带 .git/HEAD 的仓库,几份文件,可选一份策略。 */
function repo(policy?: string, files: Record<string, string> = {}, git = true): string {
  const dir = join(root, `r${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  if (git) {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  if (policy !== undefined) writeFileSync(join(dir, ".zgatepolicy"), policy);
  return dir;
}
const MIG = { "migrations/001_init.sql": "create table users();\n", "src/index.ts": "export {}\n" };

function run(tool: string, input: Record<string, unknown>, cwd: string): BatchResult {
  return decideAll(toActions({ tool_name: tool, tool_input: input, cwd }, "t"), { noCache: true });
}
const bash = (command: string, cwd: string): BatchResult => run("Bash", { command }, cwd);
const win = (r: BatchResult) => r.perAction[r.winningIndex]!;

function hitsFor(tool: string, input: Record<string, unknown>, cwd: string): string[] {
  const a = toActions({ tool_name: tool, tool_input: input, cwd }, "t")[0]!;
  const e = enrich(a.targets, a.cwd, {});
  const ctx: Context = { resources: e.resources, repo: e.repo, env_hints: e.env_hints, elapsed_ms: 0 };
  const policy = loadPolicy(ctx.repo.root);
  expect(policy).not.toBeNull();
  return scopeHits(a, ctx, policy!);
}

describe("注册表", () => {
  test("两条策略规则在 RULES 末尾:同档先命中者胜,是 §3.3 不变量的一半", () => {
    expect(RULES.slice(-2).map((r) => r.id)).toEqual(["policy.self_write", "policy.scope"]);
    expect(POLICY_RULES.map((r) => `${r.stage}/${r.verdict}`)).toEqual(["pre/SOFT", "post/SOFT"]);
  });
});

describe("scopeHits(§2.3)", () => {
  test("read 不命中,哪怕目标就在 scope 里", () => {
    const dir = repo("scope: migrations/\n", MIG);
    expect(hitsFor("Read", { file_path: join(dir, "migrations/001_init.sql") }, dir)).toEqual([]);
    expect(hitsFor("Bash", { command: "cat migrations/001_init.sql" }, dir)).toEqual([]);
  });

  test("路径:目标落在条目内", () => {
    const dir = repo("scope: migrations/\n", MIG);
    expect(hitsFor("Bash", { command: "rm -rf ./migrations/001_init.sql" }, dir)).toEqual(["migrations"]);
    expect(hitsFor("Edit", { file_path: join(dir, "migrations/001_init.sql"), old_string: "a", new_string: "b" }, dir)).toEqual(["migrations"]);
  });

  test("路径:目标是条目的祖先(删祖先就是删它)", () => {
    const dir = repo("scope: src/migrations/\n", { "src/migrations/001.sql": "x\n" });
    expect(hitsFor("Bash", { command: "rm -rf ./src" }, dir)).toEqual(["src/migrations"]);
    expect(hitsFor("Bash", { command: "rm -rf ." }, dir)).toEqual(["src/migrations"]);
  });

  test("路径:还不存在的目标按将被创建的位置比(D12.11)", () => {
    const dir = repo("scope: migrations/\n", MIG);
    expect(hitsFor("Write", { file_path: join(dir, "migrations/002_new.sql"), content: "x" }, dir)).toEqual(["migrations"]);
  });

  test("路径:目标是指进 scope 的软链接别名", () => {
    const dir = repo("scope: migrations/\n", MIG);
    symlinkSync(join(dir, "migrations"), join(dir, "mig-link"));
    expect(hitsFor("Bash", { command: "rm -rf ./mig-link" }, dir)).toEqual(["migrations"]);
  });

  test("路径:条目本身是软链接时,直接碰真实目录也算", () => {
    const dir = repo("scope: current/\n", { "releases/v2/app.js": "x\n" });
    symlinkSync(join(dir, "releases", "v2"), join(dir, "current"));
    expect(hitsFor("Bash", { command: "rm current/app.js" }, dir)).toEqual(["current"]);
    expect(hitsFor("Bash", { command: "rm releases/v2/app.js" }, dir)).toEqual(["current"]);
  });

  test("文本:没有文件目标的命令靠原文字面片段够到", () => {
    const dir = repo("scope: prod-db.internal\n", MIG);
    expect(hitsFor("Bash", { command: "psql -h PROD-DB.internal -U app -c 'select 1'" }, dir)).toEqual(["prod-db.internal"]);
    expect(hitsFor("Bash", { command: "psql -h staging-db.internal -c 'select 1'" }, dir)).toEqual([]);
  });

  test("文本:条目短于 3 个字符不做字面匹配;`.` 只按路径", () => {
    const dir = repo("scope: ab\nscope: .\n", MIG);
    expect(hitsFor("Bash", { command: "echo ab" }, dir)).toEqual([]);
    expect(hitsFor("Bash", { command: "rm src/index.ts" }, dir)).toEqual(["."]);
  });

  test("非 Bash 工具没有原文,不做文本匹配", () => {
    const dir = repo("scope: prod-db.internal\n", MIG);
    expect(hitsFor("WebFetch", { url: "https://prod-db.internal/x" }, dir)).toEqual([]);
  });

  test("多条命中按策略里的顺序全部返回", () => {
    const dir = repo("scope: infra/\nscope: migrations/\nscope: src/\n", { ...MIG, "infra/main.tf": "x\n" });
    expect(hitsFor("Bash", { command: "rm -rf infra migrations" }, dir)).toEqual(["infra", "migrations"]);
  });
});

describe("policy.scope(post SOFT)", () => {
  test("★ 核心论点对:同一条命令,有没有策略,结论不同", () => {
    const without = bash("rm -rf ./migrations", repo(undefined, MIG));
    expect(without.decision.verdict).toBe("allow");
    expect(win(without).ruleVerdict).toBe("PASS");
    expect(without.decision.rule_id).toBeNull();

    const withPolicy = bash("rm -rf ./migrations", repo("不要动 migrations/。\nscope: migrations/\n", MIG));
    expect(withPolicy.decision.verdict).toBe("ask");
    expect(win(withPolicy).ruleVerdict).toBe("SOFT");
    expect(withPolicy.decision.rule_id).toBe("policy.scope");
    expect(withPolicy.decision.reason).toBe("触及策略保护范围 migrations");
  });

  test("cwd 不在仓库里 → 不找策略,哪怕目录里就有一份", () => {
    const r = bash("rm -rf ./migrations", repo("scope: migrations/\n", MIG, false));
    expect(r.decision.verdict).toBe("allow");
  });

  test("cwd 是仓库子目录时用的仍是仓库根的策略", () => {
    const dir = repo("scope: src/\n", MIG);
    const r = bash("rm index.ts", join(dir, "src"));
    expect(r.decision.rule_id).toBe("policy.scope");
  });

  test("策略文件是软链接 → 当不存在", () => {
    const dir = repo(undefined, { ...MIG, "real.txt": "scope: .\n" });
    symlinkSync(join(dir, "real.txt"), join(dir, ".zgatepolicy"));
    expect(bash("rm -rf ./migrations", dir).decision.verdict).toBe("allow");
  });

  test("reason 不超过 40 字:很长的条目被截", () => {
    const long = "a".repeat(80);
    const dir = repo(`scope: ${long}/\n`, { [`${long}/x.txt`]: "x\n" });
    const r = bash(`rm -rf ./${long}`, dir);
    expect(r.decision.rule_id).toBe("policy.scope");
    expect(r.decision.reason.length).toBeLessThanOrEqual(40);
  });
});

describe("policy.self_write(pre SOFT)", () => {
  test("重定向写、Write / Edit 工具、rm、sed -i 都问;文件名不分大小写", () => {
    const dir = repo(undefined, MIG);
    for (const cmd of ["echo 'scope: .' >> .zgatepolicy", "rm .zgatepolicy", "sed -i 's/a/b/' .zgatepolicy", "echo x > .ZGATEPOLICY", "bash -c 'echo x > .zgatepolicy'"]) {
      const r = bash(cmd, dir);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rule_id, cmd).toBe("policy.self_write");
      expect(r.decision.reason, cmd).toBe("修改仓库策略文件");
    }
    expect(run("Write", { file_path: join(dir, ".zgatepolicy"), content: "scope: .\n" }, dir).decision.rule_id).toBe("policy.self_write");
    expect(run("Edit", { file_path: join(dir, ".zgatepolicy"), old_string: "a", new_string: "b" }, dir).decision.rule_id).toBe("policy.self_write");
  });

  test("读策略文件不问", () => {
    const dir = repo("scope: .\n", MIG);
    const r = bash("cat .zgatepolicy", dir);
    expect(r.decision.verdict).toBe("allow");
    expect(win(r).ruleVerdict).toBe("PASS");
  });

  test("pre 轮不看环境:不在仓库里也一样问", () => {
    const r = bash("echo x > .zgatepolicy", repo(undefined, {}, false));
    expect(r.decision.rule_id).toBe("policy.self_write");
  });

  test("同名但不是这个文件不问:.zgatepolicy.bak / policy.md", () => {
    const dir = repo(undefined, MIG);
    expect(bash("echo x > .zgatepolicy.bak", dir).decision.verdict).toBe("allow");
    expect(bash("echo x > docs/policy.md", dir).decision.verdict).toBe("allow");
  });
});

describe("★ §3.3 顺序不变量:rule_id 是 policy.scope 当且仅当没有别的 SOFT 命中", () => {
  test("`scope: .` + cat .env → fs.secret_file(post,排在 policy 之前)", () => {
    const r = bash("cat .env", repo("scope: .\n", { ...MIG, ".env": "K=1\n" }));
    expect(r.decision.rule_id).toBe("fs.secret_file");
  });

  test("`scope: .` + rm -rf $(x) → fs.unknown", () => {
    expect(bash("rm -rf $(x)", repo("scope: .\n", MIG)).decision.rule_id).toBe("fs.unknown");
  });

  test("`scope: .` + 删指向仓库外的软链接 → fs.outside_cwd", () => {
    const dir = repo("scope: .\n", MIG);
    const outside = realpathSync(mkdtempSync(join(root, "outside-")));
    symlinkSync(outside, join(dir, "build"));
    expect(bash("rm -rf ./build", dir).decision.rule_id).toBe("fs.outside_cwd");
  });

  test("★ pre SOFT 与 post policy.scope 同时命中时 pre 胜(computeStage 同档 pre 优先)", () => {
    const dir = repo("scope: .\n", MIG);
    // 改策略文件本身:pre policy.self_write,post policy.scope(目标在 root 内)
    expect(bash("echo 'scope: x' >> .zgatepolicy", dir).decision.rule_id).toBe("policy.self_write");
    // 命令行里带凭据形态,写进 scope:pre secret.in_command,post policy.scope
    expect(bash("echo AKIAABCDEFGHIJKLMNOP > migrations/note", dir).decision.rule_id).toBe("secret.in_command");
    // 丢工作区改动,目标在 scope:pre git.destructive,post policy.scope
    const g = bash("git checkout -- src/index.ts", dir);
    expect(g.decision.verdict).toBe("ask");
    expect(g.decision.rule_id).toBe("git.destructive");
  });

  test("`scope: .` + rm -rf / → 仍 HARD_DENY,context 为 null,策略根本没参与", () => {
    const r = bash("rm -rf /", repo("scope: .\n", MIG));
    expect(r.decision.verdict).toBe("deny");
    expect(r.decision.rule_id).toBe("fs.rm_root");
    expect(win(r).context).toBeNull();
  });
});
