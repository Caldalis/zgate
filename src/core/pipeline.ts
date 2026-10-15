// 决策管线:
//
//   Action ──▶ cache ──▶ rules(pre) ──▶ enrich ──▶ rules(post) ──▶ [model] ──▶ Decision
//
// enrich 在 rules 之后:pre 轮判死的命令不付探测代价。缓存套在整个规则段上,模型的结论也随同一条缓存。
// 模型只看 SOFT:HARD_DENY 是终局,PASS 直接放行,两者都不问模型。
//
// 纯函数式:不碰 HTTP、日志、进程。热路径不做 zod parse。

import type { Action } from "./action.ts";
import type { Context } from "./context.ts";
import type { Decision } from "./decision.ts";
import { getCached, setCached, setCachedModel, stageKey } from "./cache.ts";
import { merge, mergeAll, strictest, type Merged } from "./merge.ts";
import {
  MODEL_TIMEOUT_CAP_MS,
  ModelFormatError,
  ModelHttpError,
  isAbortError,
  withDeadline,
  type ModelBackend,
  type ModelDecision,
  type ModelDetails,
} from "./model.ts";
import { enrich } from "../enrichers/index.ts";
import { gitFacts } from "../enrichers/git.ts";
import { t } from "../i18n.ts";
import { loadPolicy, policyDetails, type Policy, type PolicyDetails } from "../policy.ts";
import { evaluate, skipsModel, type RuleHit, type RuleVerdict } from "../rules/index.ts";
import { scopeHits } from "../rules/policy.ts";

export interface PipelineOptions {
  /** 模型后端。缺省 / null = 不走模型,只用规则层的结论。同步入口不看它 */
  readonly backend?: ModelBackend | null;
  /** 关掉缓存,给 golden test 与 check 用 */
  readonly noCache?: boolean;
  /** 环境变量。生产由 server 传 `process.env`;测试注入固定值 */
  readonly env?: Record<string, string | undefined>;
  /** 注入 id 生成器,给测试用 */
  readonly newId?: () => string;
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

/** 单条 Action 的规则段结果。 */
interface RuleStage {
  readonly hit: RuleHit;
  /** 判 hit 时看到的 Context。pre 轮判死时为 null —— 那时没探测 */
  readonly context: Context | null;
  readonly cached: boolean;
  /** 缓存里随规则段一起存着的模型结论(只有 SOFT 且模型判过才有) */
  readonly model: ModelDecision | null;
  /** 仓库根的策略;post 轮没跑(pre 判死)或不在仓库 / 没有文件时为 null */
  readonly policy: Policy | null;
  /** 命中的 scope 条目;进 prompt 的 policy_scope_hit 与 journal 的 scope_hit */
  readonly policyHit: readonly string[];
  readonly salt: string;
  readonly elapsedMs: number;
}

function buildContext(action: Action, opts: PipelineOptions): Context {
  const e = enrich(action.targets, action.cwd, opts.env ?? {});
  return { resources: e.resources, repo: e.repo, env_hints: e.env_hints, elapsed_ms: e.elapsed_ms };
}

/** 一批之内逐字相同的段(复合语句的两个 exec 段)共用一份规则段结论,key 与缓存同一把。 */
type Batch = Map<string, RuleStage>;

/** 缓存 salt:分支名;有策略时再拼 sha,策略一改立即换 key。 */
function saltOf(branch: string | null, policy: Policy | null): string {
  const b = branch ?? "";
  return policy === null ? b : `${b}\0${policy.sha256}`;
}

/**
 * 跑规则段:cache ──▶ rules(pre) ──▶ enrich ──▶ rules(post)。
 * `salt` 是分支名(加策略 sha),查缓存之前就要知道(git 探针与策略加载都自带 3 秒缓存,成本接近零)。
 * 传了 `batch` 时,批内重复的段直接复用先前那条,不查缓存也不重算。
 */
function runRules(action: Action, opts: PipelineOptions, batch?: Batch): RuleStage {
  const started = performance.now();
  const repo = gitFacts(action.cwd);
  const policy = loadPolicy(repo.root);
  const salt = opts.noCache === true ? "" : saltOf(repo.branch, policy);
  const key = stageKey(action, salt);
  const dup = batch?.get(key);
  if (dup !== undefined) return dup;

  const stage = computeStage(action, opts, salt, policy, started);
  batch?.set(key, stage);
  return stage;
}

/** 策略只随跑过 post 轮的结论走:pre 判死没有 Context,也就没有策略这回事。 */
function policyOf(context: Context | null, action: Action, policy: Policy | null): Pick<RuleStage, "policy" | "policyHit"> {
  if (context === null || policy === null) return { policy: null, policyHit: [] };
  return { policy, policyHit: scopeHits(action, context, policy) };
}

function computeStage(action: Action, opts: PipelineOptions, salt: string, policy: Policy | null, started: number): RuleStage {
  if (opts.noCache !== true) {
    const cached = getCached(action, salt);
    if (cached !== null) {
      return {
        hit: cached.hit, context: cached.context, cached: true, model: cached.model,
        ...policyOf(cached.context, action, policy), salt, elapsedMs: performance.now() - started,
      };
    }
  }

  // pre 轮只看 Action。判死就不探测,但要缓存:危险命令的裁决不依赖环境。
  const pre = evaluate(action, null, "pre");
  if (pre.verdict === "HARD_DENY") {
    if (opts.noCache !== true) setCached(action, pre, null, salt);
    return { hit: pre, context: null, cached: false, model: null, policy: null, policyHit: [], salt, elapsedMs: performance.now() - started };
  }

  const context = buildContext(action, opts);
  const post = evaluate(action, context, "post");
  // 同档 pre 优先:两轮同为 SOFT 时以 pre 为 hit。不然 `scope: .` 会把 `git reset --hard`
  // 标成 policy.scope,策略文本进了本不该进的 prompt。
  const hit = pre.verdict === "SOFT" && post.verdict !== "HARD_DENY" ? pre : post;
  if (opts.noCache !== true) setCached(action, hit, context, salt);

  return { hit, context, cached: false, model: null, ...policyOf(context, action, policy), salt, elapsedMs: performance.now() - started };
}

/** 模型这一段的结果:没问 / 规则说了不问 / 有结论 / 问了但失败。 */
type ModelOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "skipped" }
  | { readonly kind: "decision"; readonly decision: ModelDecision; readonly cached: boolean }
  | { readonly kind: "failed"; readonly cause: string; readonly details: ModelDetails };

/** 一条 Action 的判定结果:Decision,加上判它时看到的 Context 与规则段的档位。 */
export interface Decided {
  readonly decision: Decision;
  /** pre 轮判死时为 null。日志要记它 */
  readonly context: Context | null;
  /** 规则段的结论。模型参与后 verdict 反推不出它 */
  readonly ruleVerdict: RuleVerdict;
  /** 模型参与时才有,进 journal 的 model_details */
  readonly modelDetails: ModelDetails | null;
  /** 策略在场(post 轮跑过且加载到了)时才有,进 journal 的 policy;pre 判死为 null */
  readonly policy: PolicyDetails | null;
}

/** 用规则段 + 模型段组装 Decision。不经 zod。 */
function assemble(stage: RuleStage, outcome: ModelOutcome, modelMs: number, newId: () => string): Decided {
  const { hit } = stage;
  const latency = stage.elapsedMs + modelMs;
  const base = { rule_id: hit.rule_id, latency_ms: latency, decision_id: newId() };
  const policy = stage.policy === null ? null : policyDetails(stage.policy, stage.policyHit);

  if (hit.verdict === "SOFT" && outcome.kind === "decision") {
    const m = outcome.decision;
    return {
      decision: {
        ...base,
        verdict: m.verdict,
        reason: m.verdict === "allow" ? "" : hit.reason,
        source: outcome.cached ? "cache" : "model",
        confidence: m.confidence,
      },
      context: stage.context,
      ruleVerdict: hit.verdict,
      modelDetails: m.details,
      policy,
    };
  }

  if (hit.verdict === "SOFT" && outcome.kind === "skipped") {
    // 规则自己说了不问模型(skipModel):这不是降级,是规则层的结论,source 记 rule
    return {
      decision: { ...base, verdict: "ask", reason: hit.reason, source: stage.cached ? "cache" : "rule", confidence: null },
      context: stage.context,
      ruleVerdict: hit.verdict,
      modelDetails: null,
      policy,
    };
  }

  if (hit.verdict === "SOFT" && outcome.kind === "failed") {
    // 模型超时或不可达,降级到 ask。理由仍是规则的那句,括号里补一句降级原因。
    const reason = t(`${hit.reason}(${outcome.cause})`, `${hit.reason} (${outcome.cause})`);
    return {
      decision: { ...base, verdict: "ask", reason, source: "fallback", confidence: 0 },
      context: stage.context,
      ruleVerdict: hit.verdict,
      modelDetails: outcome.details,
      policy,
    };
  }

  const merged = merge(hit.verdict, null);
  return {
    decision: {
      ...base,
      verdict: merged.verdict,
      reason: merged.verdict === "allow" ? "" : hit.reason,
      source: stage.cached ? "cache" : merged.source,
      confidence: null,
    },
    context: stage.context,
    ruleVerdict: hit.verdict,
    modelDetails: null,
    policy,
  };
}

/** 不进模型段时的 outcome:标了 skipModel 的 SOFT 是 skipped,其余是 none。 */
function withoutModel(stage: RuleStage): ModelOutcome {
  return stage.hit.verdict === "SOFT" && skipsModel(stage.hit.rule_id) ? { kind: "skipped" } : { kind: "none" };
}

/** 同步判一条:只有规则段,不问模型。check / bench / golden 用。 */
export function decideWithContext(action: Action, opts: PipelineOptions = {}): Decided {
  const stage = runRules(action, opts);
  return assemble(stage, withoutModel(stage), 0, opts.newId ?? defaultNewId);
}

export function decideAction(action: Action, opts: PipelineOptions = {}): Decision {
  return decideWithContext(action, opts).decision;
}

/** 模型失败的降级原因:给 reason 一句话、给 journal 一个码。 */
function failureOf(err: unknown): { cause: string; details: Omit<ModelDetails, "backend"> } {
  if (isAbortError(err)) return { cause: t("模型超时", "model timed out"), details: { error: "timeout" } };
  if (err instanceof ModelFormatError) return { cause: t("模型输出异常", "malformed model output"), details: { error: "format" } };
  if (err instanceof ModelHttpError && err.status < 500) {
    return { cause: t("模型拒绝请求", "model rejected the request"), details: { error: "rejected", http_status: err.status } };
  }
  const unreachable = t("模型不可达", "model unreachable");
  if (err instanceof ModelHttpError) return { cause: unreachable, details: { error: "unreachable", http_status: err.status } };
  return { cause: unreachable, details: { error: "unreachable" } };
}

/**
 * 规则段之后接模型段。只有 SOFT 且 `consult` 为真才问模型;
 * 超时 / 异常降级为 ask,不向上抛。超时用 AbortController 真的断开请求。
 */
async function finishStage(
  action: Action,
  stage: RuleStage,
  opts: PipelineOptions,
  consult: boolean,
): Promise<Decided> {
  const newId = opts.newId ?? defaultNewId;
  const backend = opts.backend ?? null;
  if (stage.hit.verdict !== "SOFT" || backend === null || !consult || skipsModel(stage.hit.rule_id)) {
    return assemble(stage, withoutModel(stage), 0, newId);
  }
  if (stage.model !== null) {
    return assemble(stage, { kind: "decision", decision: stage.model, cached: true }, 0, newId);
  }

  const context = stage.context ?? buildContext(action, opts);
  // 策略文本只在这条调用是 SOFT 仅仅因为策略时进 prompt;由这里决定,后端不做判断
  const policy =
    stage.hit.rule_id === "policy.scope" && stage.policy !== null ? { policy: stage.policy, scopeHit: stage.policyHit } : null;
  const req = { action, context, flaggedRule: stage.hit.rule_id, policy };
  const started = performance.now();
  try {
    const decision = await withDeadline(null, Math.min(backend.timeoutMs, MODEL_TIMEOUT_CAP_MS), (signal) =>
      backend.classify(req, signal),
    );
    if (opts.noCache !== true) setCachedModel(action, stage.salt, decision);
    return assemble(stage, { kind: "decision", decision, cached: false }, performance.now() - started, newId);
  } catch (err) {
    const { cause, details } = failureOf(err);
    return assemble(stage, { kind: "failed", cause, details: { backend: backend.name, ...details } }, performance.now() - started, newId);
  }
}

/** 异步判一条:规则段 + 模型段。daemon 走这条。 */
export function decideWithContextAsync(action: Action, opts: PipelineOptions = {}): Promise<Decided> {
  return finishStage(action, runRules(action, opts), opts, true);
}

export async function decideActionAsync(action: Action, opts: PipelineOptions = {}): Promise<Decision> {
  return (await decideWithContextAsync(action, opts)).decision;
}

export interface BatchItem extends Decided {
  readonly action: Action;
}

export interface BatchResult {
  readonly decision: Decision;
  /** 判出最终结论(最严)的那条 Action 的序号;空批为 -1 */
  readonly winningIndex: number;
  readonly perAction: readonly BatchItem[];
}

function emptyBatch(newId: () => string): BatchResult {
  // 零条 Action = 没有要裁决的东西 = allow。
  const decision: Decision = {
    verdict: "allow", reason: "", source: "rule", rule_id: null,
    confidence: null, latency_ms: 0, decision_id: newId(),
  };
  return { decision, winningIndex: -1, perAction: [] };
}

/**
 * 一批 Action 取最严(一次 Bash 可能切出多条)。整体结论的 verdict /
 * reason / rule_id / confidence 来自胜出那条,latency 是各条之和,
 * decision_id 重新生成 —— 它是这一批的决策。
 */
function combine(perAction: readonly BatchItem[], newId: () => string): BatchResult {
  const mergeds: Merged[] = perAction.map(({ decision }) => ({ verdict: decision.verdict, source: decision.source }));
  const { index } = mergeAll(mergeds);
  const winner = perAction[index] ?? perAction[0];
  if (winner === undefined) return emptyBatch(newId);
  const decision: Decision = {
    verdict: winner.decision.verdict,
    reason: winner.decision.reason,
    source: winner.decision.source,
    rule_id: winner.decision.rule_id,
    confidence: winner.decision.confidence,
    latency_ms: perAction.reduce((acc, p) => acc + p.decision.latency_ms, 0),
    decision_id: newId(),
  };
  return { decision, winningIndex: index, perAction };
}

/** 批内重复的段复用先前那条的结论,只换 decision_id;它没花时间,latency 记 0。 */
function reissue(prior: Decided, newId: () => string): Decided {
  return { ...prior, decision: { ...prior.decision, decision_id: newId(), latency_ms: 0 } };
}

/** 同步判一批:只有规则段。 */
export function decideAll(actions: readonly Action[], opts: PipelineOptions = {}): BatchResult {
  const newId = opts.newId ?? defaultNewId;
  if (actions.length === 0) return emptyBatch(newId);
  const batch: Batch = new Map();
  const done = new Map<RuleStage, Decided>();
  const perAction = actions.map((action) => {
    const stage = runRules(action, opts, batch);
    const prior = done.get(stage);
    if (prior !== undefined) return { action, ...reissue(prior, newId) };
    const decided = assemble(stage, withoutModel(stage), 0, newId);
    done.set(stage, decided);
    return { action, ...decided };
  });
  return combine(perAction, newId);
}

/**
 * 异步判一批:规则段 + 模型段。
 * 先把每条的规则段都跑完:有一条 HARD_DENY 整批就是 deny,谁都不问模型。
 * 然后按序问模型;一旦某条落到 ask,整批已经是 ask,后面的 SOFT 不再问
 * (省的是几百毫秒,不是钱),它们按没配模型处理,记 ask。
 * 批内逐字相同的段只算一次、只问一次模型。
 */
export async function decideAllAsync(actions: readonly Action[], opts: PipelineOptions = {}): Promise<BatchResult> {
  const newId = opts.newId ?? defaultNewId;
  if (actions.length === 0) return emptyBatch(newId);

  const batch: Batch = new Map();
  const stages = actions.map((action) => ({ action, stage: runRules(action, opts, batch) }));
  let consult = !stages.some((s) => s.stage.hit.verdict === "HARD_DENY");
  const perAction: BatchItem[] = [];
  const done = new Map<RuleStage, Decided>();
  for (const { action, stage } of stages) {
    const prior = done.get(stage);
    const decided = prior === undefined ? await finishStage(action, stage, opts, consult) : reissue(prior, newId);
    if (prior === undefined) done.set(stage, decided);
    if (decided.decision.verdict !== "allow") consult = false;
    perAction.push({ action, ...decided });
  }
  return combine(perAction, newId);
}

export { strictest };
export type { Merged };
