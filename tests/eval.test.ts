// zgate eval(D14.24):用例集本身的约束 + 评测器的算术。真实模型不在这里跑。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelBackend, ModelDecision } from "../src/core/model.ts";
import { loadEvalCases, runEvalCase, summarize, withRoot, type EvalCase, type EvalResult } from "../src/eval.ts";

const CASES: readonly EvalCase[] = loadEvalCases(readFileSync(new URL("./eval/cases.yaml", import.meta.url), "utf8"));
const POLICY_CASES: readonly EvalCase[] = loadEvalCases(readFileSync(new URL("./eval/policy.yaml", import.meta.url), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "zgate-eval-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fixed = (v: "allow" | "ask"): ModelBackend => ({
  name: "local",
  timeoutMs: 200,
  async classify(): Promise<ModelDecision> {
    return { verdict: v, confidence: 0.8, latency_ms: 1, details: { backend: "local" } };
  },
});

async function runAll(backend: ModelBackend | null): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of CASES) out.push(await runEvalCase(c, backend, scratch));
  return out;
}

describe("用例集(tests/eval/cases.yaml)", () => {
  test("与 D12.15 同构:12 条该问、9 条该放行,id 唯一,每条有 why", () => {
    expect(CASES.filter((c) => c.label === "ask").length).toBe(12);
    expect(CASES.filter((c) => c.label === "allow").length).toBe(9);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) expect(typeof c.why, c.id).toBe("string");
  });

  test("★ 每条在当前规则下都是 SOFT:不是 SOFT 的用例模型根本看不到,等于死样本", async () => {
    for (const r of await runAll(null)) {
      expect(r.rule_verdict, r.id).toBe("SOFT");
      expect(r.verdict, r.id).toBe("ask");
      expect(r.source, r.id).toBe("fallback");
    }
  });
});

describe("策略用例集(tests/eval/policy.yaml,spec-m3 §8.2)", () => {
  test("8 条该问、3 条该放行,id 唯一且不与 cases.yaml 重名,每条有 why 且写了 .zgatepolicy", () => {
    expect(POLICY_CASES.filter((c) => c.label === "ask").length).toBe(8);
    expect(POLICY_CASES.filter((c) => c.label === "allow").length).toBe(3);
    const ids = new Set(POLICY_CASES.map((c) => c.id));
    expect(ids.size).toBe(POLICY_CASES.length);
    for (const c of CASES) expect(ids.has(c.id), c.id).toBe(false);
    for (const c of POLICY_CASES) {
      expect(typeof c.why, c.id).toBe("string");
      expect(Object.keys(c.setup?.write ?? {}).some((p) => p.endsWith("/.zgatepolicy")), c.id).toBe(true);
    }
  });

  test("★ 每条在当前规则下是 SOFT,且除 self-write 外 rule_id 都是 policy.scope:不然策略文本根本没进 prompt", async () => {
    for (const c of POLICY_CASES) {
      const r = await runEvalCase(c, null, scratch);
      expect(r.rule_verdict, c.id).toBe("SOFT");
      expect(r.verdict, c.id).toBe("ask");
      expect(r.rule_id, c.id).toBe(c.id === "policy-self-write" ? "policy.self_write" : "policy.scope");
    }
  });

  test("★ 同一条命令去掉策略文件后全是 PASS:这 11 条今天模型一条都看不到,策略是它们进模型的唯一原因", async () => {
    for (const c of POLICY_CASES) {
      if (c.id === "policy-self-write") continue; // 改策略文件本身与策略在不在场无关,pre 轮就问
      const write = Object.fromEntries(Object.entries(c.setup?.write ?? {}).filter(([p]) => !p.endsWith("/.zgatepolicy")));
      const stripped: EvalCase = { ...c, id: `${c.id}--no-policy`, setup: { ...c.setup, write } };
      const r = await runEvalCase(stripped, null, scratch);
      expect(r.rule_verdict, c.id).toBe("PASS");
      expect(r.verdict, c.id).toBe("allow");
    }
  });
});

describe("评测器算术", () => {
  test("模型恒 allow:该问却放行 = ask 标签数,误打断 0,一致 = allow 标签数", async () => {
    const s = summarize(await runAll(fixed("allow")));
    expect(s.total).toBe(CASES.length);
    expect(s.soft).toBe(CASES.length);
    expect(s.non_soft).toEqual([]);
    expect(s.missed).toBe(12);
    expect(s.missed_of).toBe(12);
    expect(s.over_asked).toBe(0);
    expect(s.agree).toBe(9);
    expect(s.degraded).toBe(0);
    expect(s.p50_ms).not.toBeNull();
  });

  test("模型恒 ask:误打断 = allow 标签数,该问却放行 0", async () => {
    const s = summarize(await runAll(fixed("ask")));
    expect(s.over_asked).toBe(9);
    expect(s.over_asked_of).toBe(9);
    expect(s.missed).toBe(0);
    expect(s.agree).toBe(12);
  });

  test("模型不可达:全部降级为 ask,degraded 计满", async () => {
    const broken: ModelBackend = {
      name: "local",
      timeoutMs: 200,
      async classify(): Promise<ModelDecision> {
        throw new Error("down");
      },
    };
    const s = summarize(await runAll(broken));
    expect(s.degraded).toBe(CASES.length);
    expect(s.missed).toBe(0);
  });

  test("非 SOFT 的结果不进计数,只列 id", () => {
    const s = summarize([
      { id: "a", label: "ask", rule_verdict: "HARD_DENY", rule_id: "fs.rm_root", verdict: "deny", source: "rule", confidence: null, latency_ms: 0.1 },
      { id: "b", label: "allow", rule_verdict: "PASS", rule_id: null, verdict: "allow", source: "rule", confidence: null, latency_ms: 0.1 },
      { id: "c", label: "ask", rule_verdict: "SOFT", rule_id: "fs.secret_file", verdict: "ask", source: "model", confidence: 0.9, latency_ms: 500 },
    ]);
    expect(s.soft).toBe(1);
    expect(s.non_soft).toEqual(["a", "b"]);
    expect(s.agree).toBe(1);
    expect(s.p50_ms).toBe(500);
  });

  test("loadEvalCases 拒绝重复 id 与非法 label;{root} 只替换字符串值", () => {
    expect(() => loadEvalCases('- {id: x, label: ask, tool: Bash, tool_input: {}}\n- {id: x, label: ask, tool: Bash, tool_input: {}}\n')).toThrow(/重复/);
    expect(() => loadEvalCases('- {id: y, label: maybe, tool: Bash, tool_input: {}}\n')).toThrow(/label/);
    expect(withRoot({ command: "rm -rf {root}/x", n: 1 }, "/base")).toEqual({ command: "rm -rf /base/x", n: 1 });
  });
});
