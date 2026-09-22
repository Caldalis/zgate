// SPEC.md §3 —— 管线。
//
//   Action ──▶ cache ──▶ rules ──▶ enrich ──▶ [model: M2] ──▶ Decision
//
// 两个容易做错的地方,都在这个文件的注释里标出来了:
//
// 1. **enrich 在 rules 之后**。大部分调用规则层拿 Action 就能定性,不该为
//    它们付出文件系统探测的代价。只有 pre 轮没判死时才探测。
//
// 2. **规则分两轮**(§4.3),缓存套在**整个规则段**上(pre + enrich + post),
//    而不是只套 pre 轮 —— 后者省下的是便宜的那一半。见 D9.2 与 cache.ts。
//
// 这个文件是**纯函数式**的:输入 Action,输出 Decision(连同判它时看到的
// Context),不碰 HTTP、不碰日志、不碰进程。那些在 server.ts / journal.ts。
// 这么切是为了让 golden test(§12)可以直接喂 Action 拿 Decision,不需要起
// daemon、不用等 flush、不用 mock 网络。
//
// 热路径上**不做 zod parse**(§2.4 / §13):Context 与 Decision 都是这里用
// 已定型的字段构造出来的,形状由编译器保证;zod 只在边界(HTTP 入口、
// journal 读取)出现。第一版在这里 parse 了两次,审计时删掉(D12.4)。

import type { Action } from "./action.ts";
import type { Context } from "./context.ts";
import type { Decision, Verdict } from "./decision.ts";
import { getCached, setCached } from "./cache.ts";
import { merge, mergeAll, strictest, type Merged } from "./merge.ts";
import { enrich } from "../enrichers/index.ts";
import { gitFacts } from "../enrichers/git.ts";
import { evaluate, type RuleHit } from "../rules/index.ts";
import { BACKENDS, type ModelBackend } from "../backends/index.ts";

/** §3.2 指定的硬超时。 */
export const DEFAULT_MODEL_TIMEOUT_MS = 200;

export interface PipelineOptions {
  /** 后端名。管线代码里只许出现这个名字,不许出现任何 backend 的具体类型。 */
  readonly backend?: string;
  /** 模型硬超时(§3.2)。默认 200ms。 */
  readonly modelTimeoutMs?: number;
  /** 关掉缓存,给 golden test 用(测试要看到每次真实裁决)。 */
  readonly noCache?: boolean;
  /** 注入后端,给测试用。 */
  readonly backendImpl?: ModelBackend;
  /** 环境变量。生产由 server 传 `process.env`;测试注入固定值。 */
  readonly env?: Record<string, string | undefined>;
  /** 注入 id 生成器,给测试用(生产用 crypto.randomUUID)。 */
  readonly newId?: () => string;
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

/** 单条 Action 的规则段结果。 */
interface RuleStage {
  readonly hit: RuleHit;
  /** 判 hit 时看到的 Context。pre 轮判死时为 null —— 那时没探测。 */
  readonly context: Context | null;
  readonly cached: boolean;
}

/** 跑 §6 的探针并组装 Context。字段与 §2.2 一一对应,不经 zod。 */
function buildContext(action: Action, opts: PipelineOptions): Context {
  const e = enrich(action.targets, action.cwd, opts.env ?? {});
  return {
    resources: e.resources,
    repo: e.repo,
    env_hints: e.env_hints,
    elapsed_ms: e.elapsed_ms,
  };
}

/**
 * 跑规则段,顺序严格照 §3 的管线图:
 *
 *   cache ──▶ rules(pre) ──▶ enrich ──▶ rules(post)
 *
 * 缓存查在**最前面**,因为它缓存的是整段的结果(承接 cache.ts 的说明)。
 * 命中就整段跳过,包括 enrich —— 那正是缓存的价值所在;命中时带回的
 * Context 就是当初产出这个裁决时看到的那份,§9 的日志要记它。
 *
 * `salt` 是仓库分支名。它在查缓存**之前**就要知道,所以要先跑一次
 * git 探针(它命中自己的 TTL 3 秒缓存,成本接近零)。这是分支信息
 * 唯一必须提前到缓存之前的地方。
 */
function runRules(action: Action, opts: PipelineOptions): RuleStage {
  const salt = opts.noCache === true ? "" : (gitFacts(action.cwd).branch ?? "");

  // ── 缓存(§3.1) ──────────────────────────────────────────────────
  if (opts.noCache !== true) {
    const cached = getCached(action, salt);
    if (cached !== null) {
      return { hit: cached.hit, context: cached.context, cached: true };
    }
  }

  // ── 第一轮(pre):只看 Action,ctx 恒为 null ──────────────────────
  const pre = evaluate(action, null, "pre");
  if (pre.verdict === "HARD_DENY") {
    // 终局:不探测。但**要缓存** —— 下一次同一条危险命令应该立刻被拦,
    // 而不是重新跑一遍正则。危险命令的裁决不依赖环境,缓存它没有陈旧风险。
    if (opts.noCache !== true) setCached(action, pre, null, salt);
    return { hit: pre, context: null, cached: false };
  }

  // ── 探测(§6) ────────────────────────────────────────────────────
  //
  // 只有 pre 轮没判死才走到这里。这是 §3 那句"enrich 在 rules 之后"的
  // 全部内容:危险命令在**上一步**就返回了,不为它付出文件系统探测。
  const context = buildContext(action, opts);

  // ── 第二轮(post):可以看 Context ────────────────────────────────
  const post = evaluate(action, context, "post");
  const hit = post.verdict === "PASS" && pre.verdict !== "PASS" ? pre : post;

  if (opts.noCache !== true) setCached(action, hit, context, salt);

  return { hit, context, cached: false };
}

/** 一条 Action 的判定结果:Decision,加上判它时看到的 Context。 */
export interface Decided {
  readonly decision: Decision;
  /** pre 轮判死时为 null。§9 的日志要它(server.ts 负责记)。 */
  readonly context: Context | null;
}

/** 用规则段结果 + 模型裁决(M1 恒 null)组装 Decision。不经 zod。 */
function finish(
  stage: RuleStage,
  modelVerdict: Verdict | null,
  started: number,
  newId: () => string,
): Decision {
  const { hit } = stage;
  const merged = merge(hit.verdict, modelVerdict);
  return {
    verdict: merged.verdict,
    // §10:`verdict === "allow"` 时 reason 留空字符串。
    reason: merged.verdict === "allow" ? "" : hit.reason,
    source: stage.cached ? "cache" : merged.source,
    rule_id: hit.rule_id,
    confidence: null, // §2.3:M1 恒为 null
    latency_ms: performance.now() - started,
    decision_id: newId(),
  };
}

/** 取后端。§5:唯一允许的方式是查 `BACKENDS[name]`,管线里不出现具体类名。 */
function backendFor(opts: PipelineOptions): ModelBackend | undefined {
  const factory = BACKENDS[opts.backend ?? "null"] ?? BACKENDS["null"];
  return opts.backendImpl ?? factory?.();
}

/**
 * 判一条 Action,同时带回判它时看到的 Context。
 *
 * 热路径上的全部工作都在这里。**不 await 任何事** —— 日志由调用方
 * 推队列(§9),模型层在 M2 才会出现。
 */
export function decideWithContext(
  action: Action,
  opts: PipelineOptions = {},
): Decided {
  const started = performance.now();
  const newId = opts.newId ?? defaultNewId;

  const stage = runRules(action, opts);

  // ── [model: M2] ──────────────────────────────────────────────────
  //
  // M1 不接模型,所以这里的取值恒为 null,也就是 §3.2 表里的"模型不可用"
  // 那一列 —— **M1 的行为就是那一列**,降级是常态,不是异常。
  //
  // 这段代码存在的意义是**接口位置**(§1:M1 必须把模型层的接口位置留好)。
  // 取 backend 的唯一方式是 `BACKENDS[name]`:§5 明确禁止管线代码里出现
  // 任何具体后端的名字,一旦出现,M2 换后端就要改管线,而改管线意味着
  // 降级路径要重新验证。让"选哪个后端"只发生在一个查表的地方,降级逻辑
  // 就只需要证明一次。M2 落地时用的是下面的 `decideActionAsync`。
  let modelVerdict: Verdict | null = null;
  if (stage.hit.verdict !== "HARD_DENY") {
    // §3.2:HARD_DENY 那一行是"跳过模型"。所以这里不是优化,是语义 ——
    // 危险命令压根不该出现在模型的输入里。
    const backend = backendFor(opts);
    if (backend !== undefined) {
      void backend.name;
      modelVerdict = null;
    }
  }

  return { decision: finish(stage, modelVerdict, started, newId), context: stage.context };
}

/** 判一条 Action。CLI 与测试用;需要 Context 落日志的调用方用 `decideWithContext`。 */
export function decideAction(
  action: Action,
  opts: PipelineOptions = {},
): Decision {
  return decideWithContext(action, opts).decision;
}

/**
 * 异步版:把 `decideAction` 与 §5 的模型层接起来。
 *
 * **M1 不用它**(`NullBackend` 同步返 null,`decideAction` 就够了),
 * 它存在是为了让 §5 的接口位置是**可执行的**,而不是一句注释:
 * M2 接一个 HTTP 后端时,改的是这个函数,管线其余部分一行不动。
 *
 * 形状上刻意做成"同步判完规则、只在 SOFT/PASS 上 await 模型":
 *
 *   - HARD_DENY **不进** await(§3.2 那一行是"跳过模型")。危险命令
 *     不该出现在模型的输入里,也不该因为模型慢而延迟返回。
 *   - 超时/异常/返回 null 一律回落 `merge(rule, null)` —— 降级路径
 *     只有一条,不因为走的是异步入口就多出第二条。
 */
export async function decideActionAsync(
  action: Action,
  opts: PipelineOptions = {},
): Promise<Decision> {
  const started = performance.now();
  const newId = opts.newId ?? defaultNewId;

  const stage = runRules(action, opts);

  let modelVerdict: Verdict | null = null;
  if (stage.hit.verdict !== "HARD_DENY") {
    const backend = backendFor(opts);
    if (backend !== undefined) {
      // §3.2:硬超时 200ms,**用 AbortController 实现,不要用
      // `Promise.race` 泄漏请求**。这里的 timer 只是兜底 —— 真正遵守
      // 超时的责任在后端实现里(它必须把 signal 传给 fetch)。
      const controller = new AbortController();
      const timeoutMs = opts.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // 缓存命中时 Context 随裁决一起存着(cache.ts);只有 pre 轮判死才
      // 没有,而那条路进不到这里。补探测一次只是防御性的兜底。
      const ctxForModel = stage.context ?? buildContext(action, opts);
      try {
        const v = await backend.classify(action, ctxForModel, timeoutMs);
        modelVerdict = v === null ? null : v.verdict;
      } catch {
        // 模型抛异常 = 不可用。按 §3.2 降级,不向上抛。
        modelVerdict = null;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return finish(stage, modelVerdict, started, newId);
}

export interface BatchResult {
  readonly decision: Decision;
  /** 判出最终结论的那条 Action 的序号(§7 的"取最严") */
  readonly winningIndex: number;
  /** 全部 Action 各自的结论与 Context,给日志和调试用 */
  readonly perAction: readonly { action: Action; context: Context | null; decision: Decision }[];
}

/**
 * 判一批 Action —— 一次 Bash 调用可能产出多条(§7)。
 *
 * 取最严的那条作为整体结论。reason 和 rule_id 来自取胜的那条,而不是
 * 拼一串 —— 用户看到的是"递归删除文件系统根目录",不是一段摘要。
 */
export function decideAll(
  actions: readonly Action[],
  opts: PipelineOptions = {},
): BatchResult {
  if (actions.length === 0) {
    // §15.3 的约定:零条 Action = 没有要裁决的东西 = allow。
    const started = performance.now();
    const newId = opts.newId ?? defaultNewId;
    const decision: Decision = {
      verdict: "allow",
      reason: "",
      source: "rule",
      rule_id: null,
      confidence: null,
      latency_ms: performance.now() - started,
      decision_id: newId(),
    };
    return { decision, winningIndex: -1, perAction: [] };
  }

  const perAction = actions.map((action) => ({ action, ...decideWithContext(action, opts) }));
  const mergeds: Merged[] = perAction.map(({ decision }) => ({
    verdict: decision.verdict,
    source: decision.source,
  }));
  const { index } = mergeAll(mergeds);

  const winner = perAction[index];
  if (winner === undefined) {
    // 不可达(actions 非空),但不留 `!` 断言 —— noUncheckedIndexedAccess
    // 开着的时候,显式的兜底比断言好读。
    const fallback = decideAction(actions[0] as Action, opts);
    return { decision: fallback, winningIndex: 0, perAction };
  }

  // 整体结论用最严那条的 verdict / reason / rule_id,但 latency 和
  // decision_id 必须**重新生成** —— 它是这一批的决策,不是某一条的。
  const totalLatency = perAction.reduce((acc, p) => acc + p.decision.latency_ms, 0);
  const decision: Decision = {
    verdict: winner.decision.verdict,
    reason: winner.decision.reason,
    source: winner.decision.source,
    rule_id: winner.decision.rule_id,
    confidence: null,
    latency_ms: totalLatency,
    decision_id: (opts.newId ?? defaultNewId)(),
  };

  return { decision, winningIndex: index, perAction };
}

// 重新导出几个符号,让调用方不必从多个文件 import。
export { strictest };
export type { Merged };
