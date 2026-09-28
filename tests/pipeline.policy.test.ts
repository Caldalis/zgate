// spec-m3 §4 / §8.3 —— 管线与策略:什么时候附策略、什么时候不附、salt、HARD_DENY 零调用。真实文件系统,走完整生产路径。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toActions } from "../src/adapters/claude-code.ts";
import type { Action } from "../src/core/action.ts";
import { clearCache, getCached } from "../src/core/cache.ts";
import type { ModelBackend, ModelDecision, ModelRequest, ModelVerdict } from "../src/core/model.ts";
import { decideActionAsync, decideAllAsync } from "../src/core/pipeline.ts";
import { clearCwdCache, clearGitCache } from "../src/enrichers/index.ts";
import { chatMessages, systemPrompt, userPrompt } from "../src/model/prompt.ts";
import { POLICY_FILENAME, clearPolicyCache, resetPolicyWarnings } from "../src/policy.ts";

let root: string;
let stderr: ReturnType<typeof spyOn>;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zgate-pipe-policy-")));
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

class SpyBackend implements ModelBackend {
  readonly name = "local";
  readonly timeoutMs = 200;
  readonly seen: ModelRequest[] = [];
  constructor(private readonly v: ModelVerdict = "allow") {}
  async classify(req: ModelRequest): Promise<ModelDecision> {
    this.seen.push(req);
    return { verdict: this.v, confidence: 0.9, latency_ms: 1, details: { backend: "local" } };
  }
}

let n = 0;
const MIG = { "migrations/001_init.sql": "create table users();\n", "src/index.ts": "export {}\n", ".env": "K=1\n" };
function repo(policy?: string): string {
  const dir = join(root, `r${(n += 1)}`);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const [p, c] of Object.entries(MIG)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  if (policy !== undefined) writeFileSync(join(dir, POLICY_FILENAME), policy);
  return dir;
}
const setPolicy = (dir: string, text: string): void => {
  writeFileSync(join(dir, POLICY_FILENAME), text);
  clearPolicyCache(); // 等价于 3 秒 TTL 过期
};
const actions = (command: string, cwd: string): readonly Action[] => toActions({ tool_name: "Bash", tool_input: { command }, cwd }, "t");

describe("附策略的条件(§1 第 3 条)", () => {
  const POLICY = "# 边界\n- 不要动 migrations/ 下的任何文件。\nscope: migrations/\n";

  test("★ flagged 是 policy.scope → 请求带策略文本与命中列表,prompt 里有策略块", async () => {
    const dir = repo(POLICY);
    const spy = new SpyBackend("allow");
    const r = await decideAllAsync(actions("rm -rf ./migrations", dir), { noCache: true, backend: spy });
    expect(spy.seen).toHaveLength(1);
    const req = spy.seen[0]!;
    expect(req.flaggedRule).toBe("policy.scope");
    expect(req.policy?.policy.text).toBe(POLICY);
    expect(req.policy?.scopeHit).toEqual(["migrations"]);
    expect(systemPrompt(req)).toContain("scope: migrations/");
    expect(userPrompt(req)).toContain('"policy_scope_hit"');
    // 模型说 allow 就是 allow —— 那正是没有策略时这条调用本来的结论(PASS),策略最坏是没效果
    expect(r.decision.verdict).toBe("allow");
    expect(r.decision.source).toBe("model");
    expect(r.decision.rule_id).toBe("policy.scope");
  });

  test("★ 别的 SOFT 命中时策略不附,prompt 与无策略时逐字节相同(scope: . 三连)", async () => {
    const dir = repo();
    for (const cmd of ["cat .env", "git checkout -- src/index.ts", "rm -rf $(x)"]) {
      const before = new SpyBackend();
      await decideAllAsync(actions(cmd, dir), { noCache: true, backend: before });
      setPolicy(dir, "scope: .\n");
      const after = new SpyBackend();
      await decideAllAsync(actions(cmd, dir), { noCache: true, backend: after });
      rmSync(join(dir, POLICY_FILENAME));
      clearPolicyCache();

      expect(before.seen, cmd).toHaveLength(1);
      expect(after.seen, cmd).toHaveLength(1);
      expect(after.seen[0]!.policy, cmd).toBeNull();
      expect(after.seen[0]!.flaggedRule, cmd).not.toBe("policy.scope");
      expect(chatMessages(after.seen[0]!), cmd).toEqual(chatMessages(before.seen[0]!));
    }
  });

  test("有策略时 HARD_DENY 仍 deny,模型 0 次调用,context 为 null", async () => {
    const dir = repo("scope: .\n");
    const spy = new SpyBackend();
    const r = await decideAllAsync(actions("rm -rf /", dir), { noCache: true, backend: spy });
    expect(r.decision.verdict).toBe("deny");
    expect(spy.seen).toHaveLength(0);
    expect(r.perAction[0]!.context).toBeNull();
  });

  test("scope 之外的 PASS 照旧放行,不问模型", async () => {
    const dir = repo(POLICY);
    const spy = new SpyBackend();
    const r = await decideAllAsync(actions("rm -rf ./src", dir), { noCache: true, backend: spy });
    expect(r.decision.verdict).toBe("allow");
    expect(r.decision.source).toBe("rule");
    expect(spy.seen).toHaveLength(0);
  });

  test("复合语句:只有 scope 命中的那段问模型,并带策略", async () => {
    const dir = repo(POLICY);
    const spy = new SpyBackend("ask");
    const r = await decideAllAsync(actions("ls && rm -rf ./migrations && ls src", dir), { noCache: true, backend: spy });
    expect(spy.seen).toHaveLength(1);
    expect(spy.seen[0]!.policy?.scopeHit).toEqual(["migrations"]);
    expect(r.decision.verdict).toBe("ask");
    expect(r.decision.reason).toBe("触及策略保护范围 migrations");
  });

  test("没配模型:policy.scope 的 SOFT 按 §3.2 右列 ask,source fallback", async () => {
    const r = await decideAllAsync(actions("rm -rf ./migrations", repo(POLICY)), { noCache: true });
    expect(r.decision.verdict).toBe("ask");
    expect(r.decision.source).toBe("fallback");
  });
});

describe("缓存 salt(§2.4)", () => {
  test("无策略时 salt 就是分支名,与 M2 相同:按 branch 能直接查到", async () => {
    const dir = repo();
    const a = actions("rm -rf ./migrations", dir)[0]!;
    await decideActionAsync(a);
    expect(getCached(a, "main")).not.toBeNull();
    expect(getCached(a, "main\0")).toBeNull();
  });

  test("★ 策略一改,新 key:第二次不再命中缓存,结论按新策略", async () => {
    const dir = repo("scope: infra/\n");
    const a = actions("rm -rf ./migrations", dir)[0]!;
    expect((await decideActionAsync(a)).verdict).toBe("allow");
    expect((await decideActionAsync(a)).source).toBe("cache");
    setPolicy(dir, "scope: migrations/\n");
    const d = await decideActionAsync(a);
    expect(d.source).not.toBe("cache");
    expect(d.verdict).toBe("ask");
    expect(d.rule_id).toBe("policy.scope");
  });

  test("模型结论随规则段一起缓存;命中时请求不再发给模型", async () => {
    const dir = repo("scope: migrations/\n");
    const spy = new SpyBackend("allow");
    const a = actions("rm -rf ./migrations", dir)[0]!;
    expect((await decideActionAsync(a, { backend: spy })).source).toBe("model");
    expect((await decideActionAsync(a, { backend: spy })).source).toBe("cache");
    expect(spy.seen).toHaveLength(1);
  });
});
