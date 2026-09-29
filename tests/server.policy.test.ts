// spec-m3 §5 —— daemon 端到端:仓库有 .zgatepolicy 时 hook 的裁决与日志里的 policy 字段。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCache } from "../src/core/cache.ts";
import { flushJournal, journalFileFor, replayFile, shutdownJournal } from "../src/core/journal.ts";
import { clearCwdCache, clearGitCache } from "../src/enrichers/index.ts";
import { POLICY_FILENAME, clearPolicyCache, resetPolicyWarnings } from "../src/policy.ts";
import { createServer, defaultConfig } from "../src/server.ts";

const POLICY = "# 边界\n- 不要动 migrations/ 下的任何文件。\nscope: migrations/\n";
const SHA = new Bun.CryptoHasher("sha256").update(POLICY).digest("hex");

let journalDir: string;
let repo: string;
let plain: string;
let server: ReturnType<typeof createServer>;
let base: string;
let stderr: ReturnType<typeof spyOn>;

function mkRepo(name: string, policy: string | null): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "001_init.sql"), "create table users();\n");
  if (policy !== null) writeFileSync(join(dir, POLICY_FILENAME), policy);
  return dir;
}

beforeAll(() => {
  journalDir = realpathSync(mkdtempSync(join(tmpdir(), "zgate-srvp-journal-")));
  repo = mkRepo("zgate-srvp-repo-", POLICY);
  plain = mkRepo("zgate-srvp-plain-", null);
  process.env["ZGATE_JOURNAL_DIR"] = journalDir;
  server = createServer(defaultConfig({ port: 0 }));
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  shutdownJournal();
  void server.stop(true);
  delete process.env["ZGATE_JOURNAL_DIR"];
  for (const d of [journalDir, repo, plain]) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  clearCache();
  clearGitCache();
  clearCwdCache();
  clearPolicyCache();
  resetPolicyWarnings();
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => stderr.mockRestore());

async function hook(command: string, cwd: string): Promise<string> {
  const res = await fetch(`${base}/hook/claude-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd, session_id: "s" }),
  });
  const body = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } };
  return body.hookSpecificOutput.permissionDecision;
}

function lastLine(): Record<string, any> {
  flushJournal();
  const lines = readFileSync(journalFileFor(new Date()), "utf8").split("\n").filter((l) => l !== "");
  return JSON.parse(lines.at(-1)!);
}

describe("hook 端到端(没配模型:SOFT 一律 ask)", () => {
  test("★ 核心论点对:同一条命令,有策略的仓库 ask,没有的 allow", async () => {
    expect(await hook("rm -rf ./migrations", plain)).toBe("allow");
    expect(await hook("rm -rf ./migrations", repo)).toBe("ask");
  });

  test("scope 命中的行:policy 带 path / sha256 / bytes / scope_hit,不带策略原文", async () => {
    await hook("rm -rf ./migrations", repo);
    const rec = lastLine();
    expect(rec["decision"]["rule_id"]).toBe("policy.scope");
    expect(rec["policy"]).toEqual({ path: join(repo, POLICY_FILENAME), sha256: SHA, bytes: Buffer.byteLength(POLICY), scope_hit: ["migrations"] });
    expect(JSON.stringify(rec)).not.toContain("不要动");
  });

  test("策略在场但没命中(PASS 放行)的行也带 policy,只是没有 scope_hit", async () => {
    expect(await hook("ls migrations", repo)).toBe("allow");
    const rec = lastLine();
    expect(rec["decision"]["verdict"]).toBe("allow");
    expect(rec["policy"]).toEqual({ path: join(repo, POLICY_FILENAME), sha256: SHA, bytes: Buffer.byteLength(POLICY) });
  });

  test("pre 轮 HARD_DENY:context 为 null,也没有 policy 键", async () => {
    expect(await hook("rm -rf /", repo)).toBe("deny");
    const rec = lastLine();
    expect(rec["context"]).toBeNull();
    expect("policy" in rec).toBe(false);
  });

  test("没有策略文件的仓库:行里没有 policy 键(与 M2 逐字节同形)", async () => {
    await hook("rm -rf ./migrations", plain);
    expect("policy" in lastLine()).toBe(false);
  });

  test("agent 改策略文件:hook 回 ask,日志 source rule、没有 model_details(D15.7)", async () => {
    expect(await hook("echo 'scope: src/' >> .zgatepolicy", repo)).toBe("ask");
    const rec = lastLine();
    expect(rec["decision"]["rule_id"]).toBe("policy.self_write");
    expect(rec["decision"]["source"]).toBe("rule");
    expect("model_details" in rec).toBe(false);
  });

  test("replay 带回 policy;/decide 也记 policy", async () => {
    const res = await fetch(`${base}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: {
          verb: "delete", targets: [{ kind: "dir", raw: "./migrations" }], command: null, tool_name: "Bash",
          tool_input: { command: "rm -rf ./migrations" }, agent: { name: "claude-code", version: null, session_id: null },
          cwd: repo, turn_id: "t-decide",
        },
      }),
    });
    const d = (await res.json()) as { verdict: string; rule_id: string | null };
    expect(d.verdict).toBe("ask");
    expect(d.rule_id).toBe("policy.scope");
    flushJournal();
    const { entries, badLines } = replayFile(journalFileFor(new Date()));
    expect(badLines).toBe(0);
    expect(entries.at(-1)?.policy?.sha256).toBe(SHA);
    expect(entries.at(-1)?.policy?.scope_hit).toEqual(["migrations"]);
  });
});
