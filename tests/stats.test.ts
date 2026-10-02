// `zgate journal stats`:纯函数 outcomeStats 与 CLI 出口。
// 只测"数得对":问了几次、通过几次、unknown 几次、没结果几次,按 rule_id × source 分组;不做别的分析。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { outcomeStats } from "../src/core/stats.ts";
import { replay, type ReplayedDecision } from "../src/core/journal.ts";
import { ActionSchema } from "../src/core/action.ts";
import { DecisionSchema } from "../src/core/decision.ts";
import { hookSettingsSnippet, main } from "../src/cli.ts";

function entry(over: { verdict?: "allow" | "ask" | "deny"; rule_id?: string | null; source?: "cache" | "rule" | "model" | "fallback"; outcome?: ReplayedDecision["outcome"]; hook?: ReplayedDecision["hook"] } = {}): ReplayedDecision {
  const action = ActionSchema.parse({
    verb: "exec", targets: [], command: "npm publish", tool_name: "Bash", tool_input: { command: "npm publish" },
    agent: { name: "claude-code", version: null, session_id: "s" }, cwd: "/repo", turn_id: "t",
  });
  const decision = DecisionSchema.parse({
    verdict: over.verdict ?? "ask", reason: "", source: over.source ?? "fallback", rule_id: over.rule_id === undefined ? "exec.publish_deploy" : over.rule_id,
    confidence: null, latency_ms: 0.1, decision_id: crypto.randomUUID(),
  });
  return { action, context: null, decision, outcome: over.outcome ?? null, ts: "2026-09-29T00:00:00.000Z", model_details: null, policy: null, hook: over.hook ?? null };
}

const approvedOk = { user_action: "approved" as const, tool_succeeded: true };
const approvedFail = { user_action: "approved" as const, tool_succeeded: false };
const unknown = { user_action: "unknown" as const, tool_succeeded: null };
const rejected = { user_action: "rejected" as const, tool_succeeded: null };

describe("outcomeStats:数得对", () => {
  test("空日志 → 全零、没有行", () => {
    const st = outcomeStats([]);
    expect(st.total).toBe(0);
    expect(st.asked).toBe(0);
    expect(st.rows).toEqual([]);
  });

  test("★ 只数 ask 的行;allow / deny 只进 by_verdict", () => {
    const st = outcomeStats([
      entry({ verdict: "allow", rule_id: null, source: "rule" }),
      entry({ verdict: "deny", rule_id: "fs.rm_root", source: "rule" }),
      entry({ verdict: "ask", outcome: approvedOk }),
    ]);
    expect(st.by_verdict).toEqual({ allow: 1, ask: 1, deny: 1 });
    expect(st.asked).toBe(1);
    expect(st.approved).toBe(1);
    expect(st.rows.length).toBe(1);
  });

  test("★ 四种去向各归各位:通过(含工具失败)、拒绝、unknown、没有结果", () => {
    const st = outcomeStats([
      entry({ outcome: approvedOk }),
      entry({ outcome: approvedFail }),
      entry({ outcome: rejected }),
      entry({ outcome: unknown }),
      entry({ outcome: null }),
      entry({ outcome: null }),
    ]);
    expect(st.asked).toBe(6);
    expect(st.approved).toBe(2);
    expect(st.approved_failed).toBe(1);
    expect(st.rejected).toBe(1);
    expect(st.unknown).toBe(1);
    expect(st.pending).toBe(2);
    expect(st.approved + st.rejected + st.unknown + st.pending).toBe(st.asked);
  });

  test("按 rule_id × source 分组,asked 降序;rule_id 为 null 显示为 -", () => {
    const st = outcomeStats([
      entry({ rule_id: "fs.outside_cwd", source: "fallback", outcome: approvedOk }),
      entry({ rule_id: "fs.outside_cwd", source: "fallback", outcome: unknown }),
      entry({ rule_id: "fs.outside_cwd", source: "model", outcome: approvedOk }),
      entry({ rule_id: null, source: "fallback" }),
    ]);
    expect(st.rows.map((r) => [r.rule_id, r.source, r.asked])).toEqual([
      ["fs.outside_cwd", "fallback", 2],
      ["-", "fallback", 1],
      ["fs.outside_cwd", "model", 1],
    ]);
    expect(st.rows[0]).toMatchObject({ approved: 1, unknown: 1, pending: 0 });
  });

  test("with_hook 数的是带 hook 的行,不分 verdict", () => {
    const st = outcomeStats([
      entry({ verdict: "allow", hook: { tool_use_id: "t1" } }),
      entry({ verdict: "ask", hook: { tool_use_id: "t2" } }),
      entry({ verdict: "ask" }),
    ]);
    expect(st.with_hook).toBe(2);
  });

  test("★ 从真实形状的 JSONL 回放后能数:一条 ask 加一条 approved 补丁", () => {
    const e = entry({ hook: { tool_use_id: "toolu_1", permission_mode: "default" } });
    const line = { v: 1, decision_id: e.decision.decision_id, ts: e.ts, agent: e.action.agent, turn_id: "t", action: e.action, context: null, decision: e.decision, outcome: null, hook: e.hook };
    const patch = { v: 1, patch: "outcome", decision_id: e.decision.decision_id, ts: e.ts, outcome: approvedOk };
    const { entries } = replay(`${JSON.stringify(line)}\n${JSON.stringify(patch)}\n`);
    const st = outcomeStats(entries);
    expect(st.asked).toBe(1);
    expect(st.approved).toBe(1);
    expect(st.with_hook).toBe(1);
  });
});

describe("zgate journal stats(CLI)", () => {
  let dir: string;
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "zgate-stats-")));
    out = "";
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = orig;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJournal(entries: ReplayedDecision[], patches: { decision_id: string; outcome: NonNullable<ReplayedDecision["outcome"]> }[] = []): string {
    const file = join(dir, "2026-09-29.jsonl");
    const lines = entries.map((e) => JSON.stringify({ v: 1, decision_id: e.decision.decision_id, ts: e.ts, agent: e.action.agent, turn_id: "t", action: e.action, context: null, decision: e.decision, outcome: null, ...(e.hook === null ? {} : { hook: e.hook }) }));
    for (const p of patches) lines.push(JSON.stringify({ v: 1, patch: "outcome", decision_id: p.decision_id, ts: "2026-09-29T00:00:01.000Z", outcome: p.outcome }));
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  test("★ 打印 \"问了 N 次:通过 M\" 与按规则的表", () => {
    const a = entry({ rule_id: "fs.outside_cwd", hook: { tool_use_id: "t1" } });
    const b = entry({ rule_id: "fs.outside_cwd", hook: { tool_use_id: "t2" } });
    const c = entry({ rule_id: "exec.publish_deploy", hook: { tool_use_id: "t3" } });
    const file = writeJournal([a, b, c, entry({ verdict: "allow", rule_id: null, source: "rule" })], [
      { decision_id: a.decision.decision_id, outcome: approvedOk },
      { decision_id: b.decision.decision_id, outcome: unknown },
    ]);
    const code = main(["journal", "stats", file]);
    expect(code).toBe(0);
    expect(out).toContain("决策 4 行:allow 1 / ask 3 / deny 0;带 hook 的 3 行");
    expect(out).toContain("问了 3 次:通过 1(其中工具失败 0)、拒绝 0、unknown 1、没有结果 1");
    expect(out).toContain("fs.outside_cwd");
    expect(out).toContain("exec.publish_deploy");
  });

  test("--json 输出可解析的结构,带文件名与坏行数", () => {
    const a = entry({ hook: { tool_use_id: "t1" } });
    const file = writeJournal([a], [{ decision_id: a.decision.decision_id, outcome: approvedFail }]);
    expect(main(["journal", "stats", file, "--json"])).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j["file"]).toBe(file);
    expect(j["bad_lines"]).toBe(0);
    expect(j["asked"]).toBe(1);
    expect(j["approved_failed"]).toBe(1);
    expect(Array.isArray(j["rows"])).toBe(true);
  });

  test("文件不存在 → 0 行、\"还没有问过用户的记录\",退出码 0", () => {
    expect(main(["journal", "stats", join(dir, "nope.jsonl")])).toBe(0);
    expect(out).toContain("决策 0 行");
    expect(out).toContain("还没有问过用户的记录");
  });

  test("journal 子命令仍拒绝未知名字", () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const code = main(["journal", "statz"]);
    process.stderr.write = origErr;
    expect(code).toBe(2);
  });
});

describe("zgate serve 打印的 settings 片段", () => {
  test("★ 五种事件同一个 URL;工具类事件带 matcher,PostToolBatch / SessionEnd 不带", () => {
    const snip = hookSettingsSnippet("127.0.0.1", 8787) as { hooks: Record<string, { matcher?: string; hooks: { type: string; url: string; timeout: number }[] }[]> };
    expect(Object.keys(snip.hooks).sort()).toEqual(["PostToolBatch", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd"]);
    for (const [name, groups] of Object.entries(snip.hooks)) {
      expect(groups.length).toBe(1);
      const g = groups[0]!;
      expect(g.hooks).toEqual([{ type: "http", url: "http://127.0.0.1:8787/hook/claude-code", timeout: 5 }]);
      if (name === "PostToolBatch" || name === "SessionEnd") expect("matcher" in g).toBe(false);
      else expect(g.matcher).toBe("");
    }
  });

  test("片段是合法 JSON 且能原样序列化", () => {
    const text = JSON.stringify(hookSettingsSnippet("127.0.0.1", 9000), null, 2);
    expect(JSON.parse(text)).toEqual(hookSettingsSnippet("127.0.0.1", 9000));
    expect(text).toContain("http://127.0.0.1:9000/hook/claude-code");
  });
});
