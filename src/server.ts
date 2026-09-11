// SPEC.md §8 —— HTTP 协议。
//
// `Bun.serve()` 监听 127.0.0.1:8787,只绑 loopback。
//
// 四个端点,职责分得很清楚:
//   /hook/claude-code  Claude Code 的 PreToolUse 钩子入口(§10 的格式转换)
//   /decide            通用入口,供测试和其他适配器用(收 Action,返回 Decision)
//   /outcome           M4 数据飞轮的入口。M1 只负责追加进日志,不做分析
//   /healthz           存活检查
//
// 关于 `/hook/claude-code` 有一条必须写下来的行为:**它永远返回 200**。
// 钩子进程挂掉、JSON 解析失败、内部异常 —— 一律回一个"不干预"的响应,
// 让 Claude Code 走它自己的权限流程。
//
// 为什么:§3.2 的降级方向是"绝不 fail-open 也绝不 fail-closed"。返回
// 非 200 等于把这个决定外包给 Claude Code(它可能当成错误而中断工具调用),
// 那是 fail-closed。回一个明确的 allow 也是错的 —— 那是在没有判断依据时
// 假装判断过了。正确做法是**不表态**:给 Claude Code 的回答是"我这边
// 没意见",于是它继续走原本的权限确认。用户看到的是没装网关时的行为,
// 也就是 §3.2 说的"最坏情况不低于纯规则 baseline"。

import { ActionSchema, type Action } from "./core/action.ts";
import { OutcomeSchema, record, recordOutcome, startJournal, shutdownJournal, journalStats, type Outcome } from "./core/journal.ts";
import { decideAll, DEFAULT_MODEL_TIMEOUT_MS, type PipelineOptions } from "./core/pipeline.ts";
import { parseHookInput, toActions, toHookResponse, type HookResponse } from "./adapters/claude-code.ts";

/** §8:默认 8787,只绑 loopback。 */
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

export const VERSION = "0.1.0";

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly backend: string;
  readonly modelTimeoutMs: number;
}

export function defaultConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    // 环境变量覆盖,给测试和高级用户用。不要做配置文件 —— M1 没有这个需求。
    port: Number(process.env["ZGATE_PORT"] ?? DEFAULT_PORT),
    host: process.env["ZGATE_HOST"] ?? DEFAULT_HOST,
    backend: process.env["ZGATE_BACKEND"] ?? "null",
    modelTimeoutMs: Number(process.env["ZGATE_MODEL_TIMEOUT_MS"] ?? DEFAULT_MODEL_TIMEOUT_MS),
    ...over,
  };
}

const startedAt = Date.now();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 网关**内部出错**时的响应。
 *
 * 回的是 `ask`,不是 `allow` 也不是 `deny`。理由要分清楚,因为这三个
 * 词在这里很容易被顺手写错:
 *
 *   allow  网关自己在故障时没有任何依据说 allow —— 那是 fail-open
 *   deny   同样没依据 —— 而且用户当天就会把网关卸掉,那是 fail-closed
 *   ask    把这个决定交还给人,也就是**没装网关时的行为**
 *
 * §3.2 要求"最坏情况不低于纯规则 baseline"。装网关之前的 baseline 就是
 * "Claude Code 照常问用户",所以这里必须回 ask。
 *
 * 注意这和 §15.3 那条"空 Action 列表 ⇒ allow"**不是一回事**:
 * 空列表是"我看懂了,这次没有要裁决的东西"(Task 工具、Bash 没带 command),
 * 那是有依据的放行。这里是无依据的故障,两者必须区分开。
 */
function neutralResponse(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * §8 的 `/decide`:收一个 Action,返回 Decision。
 *
 * 这个端点是**测试和其他适配器的入口**。它的 body 是 `{action: ...}`,
 * 不是 hook 的原始格式 —— 格式转换是适配器的活,不该在这里发生。
 */
async function handleDecide(req: Request, opts: PipelineOptions): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "body 不是合法 JSON" }, 400);
  }

  if (typeof raw !== "object" || raw === null) {
    return json({ error: "body 必须是对象" }, 400);
  }
  const actionRaw = (raw as Record<string, unknown>)["action"];
  // §2.4:只在边界 parse 一次。这里是边界。
  const parsed = ActionSchema.safeParse(actionRaw);
  if (!parsed.success) {
    return json({ error: "action 不符合 §2.1 的 schema", issues: parsed.error.issues }, 400);
  }

  const action = parsed.data as Action;
  const result = decideAll([action], opts);
  record(action, null, result.decision);
  return json(result.decision);
}

/**
 * §10 的 `/hook/claude-code`。
 *
 * 流程:解析 hook 输入 → 适配成 Action[] → 逐条判 → 取最严 → 转成
 * hook 响应。**任何一步失败都回"不表态"**,理由见文件顶部。
 */
async function handleHook(req: Request, opts: PipelineOptions): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(neutralResponse("网关无法解析本次请求"));
  }

  const input = parseHookInput(body);
  if (input === null) {
    return json(neutralResponse("网关无法识别本次调用"));
  }

  // turn_id 由网关生成(§2.1),一次 hook 请求一个。
  const turnId = crypto.randomUUID();

  let actions: readonly Action[];
  try {
    actions = toActions(input, turnId);
  } catch {
    return json(neutralResponse("网关解析调用参数失败"));
  }

  // §15.3 的约定:空数组 = 没有要裁决的东西(Task,或 Bash 缺 command)。
  // 直接放行,记不记日志都不影响正确性 —— 这里不记,免得日志被空动作灌满。
  if (actions.length === 0) {
    return json(toHookResponse({
      verdict: "allow", reason: "", source: "rule", rule_id: null,
      confidence: null, latency_ms: 0, decision_id: turnId,
    }));
  }

  try {
    const result = decideAll(actions, opts);
    // §9:每条 Action 各记一行,整体结论也记一行。
    //
    // 为什么每条都记而不是只记整体:训练数据要的是"这条命令该判什么",
    // 而复合语句里的每一条都是独立样本(`cd a && rm -rf b` 里 `cd a`
    // 的判例和 `rm -rf b` 的判例都有价值)。整体结论单独记一行是因为
    // 用户实际看到的是它 —— override 标注会挂在它身上。
    for (const { action, decision } of result.perAction) {
      record(action, null, decision);
    }
    return json(toHookResponse(result.decision));
  } catch {
    return json(neutralResponse("网关内部错误"));
  }
}

/** §8 的 `/outcome`。M1 只追加进日志,不做任何分析。 */
async function handleOutcome(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body 不是合法 JSON" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "body 必须是对象" }, 400);
  }
  const o = body as Record<string, unknown>;
  const decisionId = o["decision_id"];
  if (typeof decisionId !== "string" || decisionId === "") {
    return json({ error: "decision_id 必须是非空字符串" }, 400);
  }

  const outcome = OutcomeSchema.safeParse({
    user_action: o["user_action"],
    tool_succeeded: o["tool_succeeded"] ?? null,
  });
  if (!outcome.success) {
    return json({ error: "outcome 字段不合法", issues: outcome.error.issues }, 400);
  }

  recordOutcome(decisionId, outcome.data as Outcome);
  // 不管有没有对应的 decision 都回 ok:补丁是追加的,读取端负责拼接。
  return json({ ok: true });
}

function handleHealthz(config: ServerConfig): Response {
  return json({
    ok: true,
    version: VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    backend: config.backend,
  });
}

/** 建 server。`cli.ts` 和测试都用这个,不直接调 `Bun.serve`。 */
export function createServer(config: ServerConfig = defaultConfig()) {
  startJournal();

  const opts: PipelineOptions = {
    backend: config.backend,
    modelTimeoutMs: config.modelTimeoutMs,
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // 只处理这四条路由;其余一律 404。不做通配、不做中间件链 ——
    // §1 说不许引入 HTTP 框架,那也包括"手写的迷你框架"。
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") {
        return req.method === "GET" ? handleHealthz(config) : json({ error: "只支持 GET" }, 405);
      }
      if (path === "/decide") {
        return req.method === "POST" ? handleDecide(req, opts) : json({ error: "只支持 POST" }, 405);
      }
      if (path === "/hook/claude-code") {
        return req.method === "POST" ? handleHook(req, opts) : json({ error: "只支持 POST" }, 405);
      }
      if (path === "/outcome") {
        return req.method === "POST" ? handleOutcome(req) : json({ error: "只支持 POST" }, 405);
      }
      return json({ error: "not found" }, 404);
    },
  });

  // §9:进程退出时 flush 剩余队列。同步实现,可以安全地放在信号处理器里。
  const onSignal = (): void => {
    shutdownJournal();
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return server;
}

export { journalStats };
