// zgate eval —— 拿一组人工标注的 SOFT 样本量模型:一致率、该问却放行、误打断、延迟。
//
// 用例格式与 §12 golden 相同(setup / cwd / tool / tool_input),多一个人工标签 `label`。
// 每条在独立临时目录里走完整生产路径:hook 输入 → 适配器 → decideAllAsync(noCache)。
// 它只是 `zgate check --model` 的批量版,给 M2 的数字一个可复现的入口(D14.24);
// 结果的进一步分析仍留在 Python(§16),这里不做训练与数据集(§1)。

import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toActions } from "./adapters/claude-code.ts";
import type { Verdict } from "./core/decision.ts";
import type { ModelBackend } from "./core/model.ts";
import { decideAllAsync } from "./core/pipeline.ts";
import { clearCwdCache, clearGitCache } from "./enrichers/index.ts";
import type { RuleVerdict } from "./rules/index.ts";

export interface CaseGit {
  readonly dir: string;
  readonly branch: string;
  readonly default_branch?: string;
}
export interface CaseSymlink {
  readonly link: string;
  readonly target: string;
}
/** 用例的环境:与 tests/golden/cases.yaml 的 setup 同一套字段。 */
export interface CaseSetup {
  readonly mkdir?: readonly string[];
  readonly write?: Readonly<Record<string, string>>;
  readonly symlink?: CaseSymlink | readonly CaseSymlink[];
  readonly git?: CaseGit | readonly CaseGit[];
}

export type EvalLabel = "allow" | "ask";

export interface EvalCase {
  readonly id: string;
  readonly label: EvalLabel;
  readonly why?: string;
  readonly setup?: CaseSetup;
  readonly cwd?: string;
  readonly tool: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
}

function asList<T>(x: T | readonly T[] | undefined): readonly T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? (x as readonly T[]) : [x as T];
}

/** 按 setup 在 base 下搭环境。golden 与 eval 共用,语义只在这里定义一次。 */
export function materialize(base: string, setup: CaseSetup | undefined): void {
  for (const d of setup?.mkdir ?? []) mkdirSync(join(base, d), { recursive: true });
  for (const [p, content] of Object.entries(setup?.write ?? {})) {
    mkdirSync(join(base, p, ".."), { recursive: true });
    writeFileSync(join(base, p), content);
  }
  for (const g of asList(setup?.git)) {
    mkdirSync(join(base, g.dir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(base, g.dir, ".git", "HEAD"), `ref: refs/heads/${g.branch}\n`);
    if (g.default_branch !== undefined) {
      writeFileSync(join(base, g.dir, ".git", "refs", "remotes", "origin", "HEAD"), `ref: refs/remotes/origin/${g.default_branch}\n`);
    }
  }
  for (const s of asList(setup?.symlink)) symlinkSync(join(base, s.target), join(base, s.link));
}

/** tool_input 里的 `{root}` 换成用例根的绝对路径:要绝对路径的用例(删别的项目)用它。 */
export function withRoot(input: Readonly<Record<string, unknown>>, root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" ? v.replaceAll("{root}", root) : v;
  return out;
}

export function loadEvalCases(text: string): EvalCase[] {
  const raw: unknown = Bun.YAML.parse(text);
  if (!Array.isArray(raw)) throw new Error("用例文件必须是数组");
  const ids = new Set<string>();
  for (const c of raw as EvalCase[]) {
    if (typeof c.id !== "string" || c.id === "") throw new Error("用例缺 id");
    if (ids.has(c.id)) throw new Error(`用例 id 重复:${c.id}`);
    ids.add(c.id);
    if (c.label !== "allow" && c.label !== "ask") throw new Error(`${c.id}:label 必须是 allow 或 ask`);
    if (typeof c.tool !== "string" || typeof c.tool_input !== "object" || c.tool_input === null) {
      throw new Error(`${c.id}:缺 tool / tool_input`);
    }
  }
  return raw as EvalCase[];
}

export interface EvalResult {
  readonly id: string;
  readonly label: EvalLabel;
  readonly rule_verdict: RuleVerdict;
  readonly verdict: Verdict;
  readonly source: string;
  readonly confidence: number | null;
  readonly latency_ms: number;
  /** 模型段降级的原因(timeout / unreachable / rejected / format),没降级就没有 */
  readonly error?: string;
}

/**
 * 跑一条:在 scratch/<id> 下建独立目录,走完整生产路径。backend 为 null 时只有规则段。
 * 目录名用 id 而不是随机后缀:路径会进 prompt,随机后缀让 P≈0.5 的样本在两次运行间翻转。
 */
export async function runEvalCase(c: EvalCase, backend: ModelBackend | null, scratch: string): Promise<EvalResult> {
  const dir = join(scratch, c.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const base = realpathSync(dir);
  materialize(base, c.setup);
  clearGitCache();
  clearCwdCache();
  const cwd = join(base, c.cwd ?? ".");
  const actions = toActions(
    { hook_event_name: "PreToolUse", tool_name: c.tool, tool_input: withRoot(c.tool_input, base), cwd },
    `eval-${c.id}`,
  );
  const r = await decideAllAsync(actions, { noCache: true, backend });
  const win = r.perAction[r.winningIndex];
  const error = win?.modelDetails?.error;
  return {
    id: c.id,
    label: c.label,
    rule_verdict: win?.ruleVerdict ?? "PASS",
    verdict: r.decision.verdict,
    source: r.decision.source,
    confidence: r.decision.confidence,
    latency_ms: r.decision.latency_ms,
    ...(error === undefined ? {} : { error }),
  };
}

export interface EvalSummary {
  readonly total: number;
  /** 规则判 SOFT、模型真正参与裁量的条数;下面的计数都只算这些 */
  readonly soft: number;
  readonly non_soft: readonly string[];
  readonly agree: number;
  /** 标签 ask、结论 allow:SOFT-only 之下唯一会降低安全性的错误 */
  readonly missed: number;
  readonly missed_of: number;
  /** 标签 allow、结论 ask */
  readonly over_asked: number;
  readonly over_asked_of: number;
  /** 模型段降级(超时 / 不可达 / …)的条数 */
  readonly degraded: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

export function summarize(results: readonly EvalResult[]): EvalSummary {
  const soft = results.filter((r) => r.rule_verdict === "SOFT");
  const asks = soft.filter((r) => r.label === "ask");
  const allows = soft.filter((r) => r.label === "allow");
  const lat = soft.map((r) => r.latency_ms).sort((a, b) => a - b);
  return {
    total: results.length,
    soft: soft.length,
    non_soft: results.filter((r) => r.rule_verdict !== "SOFT").map((r) => r.id),
    agree: soft.filter((r) => r.verdict === r.label).length,
    missed: asks.filter((r) => r.verdict === "allow").length,
    missed_of: asks.length,
    over_asked: allows.filter((r) => r.verdict === "ask").length,
    over_asked_of: allows.length,
    degraded: soft.filter((r) => r.error !== undefined).length,
    p50_ms: percentile(lat, 50),
    p95_ms: percentile(lat, 95),
  };
}
