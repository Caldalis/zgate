// SPEC.md §10 —— Claude Code 适配器。
//
// **只做格式转换。** 不探测环境、不做任何判断、不读文件、不 spawn 进程。
// 判断全部留给 rules / model。
//
// ── 参照的官方文档 ────────────────────────────────────────────────
// URL:    https://code.claude.com/docs/en/hooks
// (旧域名 docs.claude.com/en/docs/claude-code/hooks 301 跳到上面这个)
// 查证日期: 2026-09-11
// 本机 Claude Code 版本: 2.1.268
//
// 核对结果 —— §10 描述的三处,文档全部一致,无需按 §15 停下来问:
//   1. hook 支持 `type: "http"`,POST 事件 JSON 到 url,响应体用同一套
//      JSON 输出格式。响应 2xx 即被接受。
//   2. PreToolUse 输出格式就是 §10 那段:
//      {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//       "permissionDecision":"allow"|"deny"|"ask",
//       "permissionDecisionReason":"..."}}
//      三个值文档均确认(allow 在 exit-code-2 那节出现,deny/ask 在示例)。
//   3. 输入含 session_id / cwd / hook_event_name / tool_name / tool_input。
//
// 另外用 `strings` 对 2.1.268 的二进制做了旁证:三个键
// (`hookSpecificOutput` / `permissionDecision` / `permissionDecisionReason`)
// 都实际存在于分发包里,共 37 处引用。文档与实现一致。
//
// 文档里两处 §10 没写、但对我们有利的事实:
//   - PreToolUse hook **超时不拦截**,工具调用继续走正常权限流程。
//     这正是 §3.2 要的降级方向,不冲突。
//   - 文档自己声明 `if` 过滤器是 best-effort,并建议"硬性 allow/deny 用权限
//     系统而不是 hook"。我们的定位本就是"减少打断",不是仅有的那道闸 ——
//     与 §3.2「最坏情况不低于纯规则 baseline」一致。
//
// 文档里有、§10 未提及、本实现**不使用**的输入字段:
//   agent_id / agent_type(仅在 --agent 或子 agent 内出现)、
//   permission_mode、transcript_path、prompt_id、scratchpad_dir、effort。
//   不使用的原因:§2.1 的 Action 形状固定,这些字段没有落脚点。
//   `permission_mode` 值得以后留意 —— `bypassPermissions` 下 hook 仍会跑。

import { ActionSchema } from "../core/action.ts";
import type { Action, Verb } from "../core/action.ts";
import { parseCommand } from "../shell/index.ts";
import type { Decision, Verdict } from "../core/decision.ts";

/** Claude Code 的 PreToolUse hook 原始输入。只声明我们真的会读的字段。 */
export interface HookInput {
  readonly session_id?: string | null;
  readonly cwd?: string | null;
  readonly hook_event_name?: string | null;
  readonly tool_name?: string | null;
  readonly tool_input?: Record<string, unknown> | null;
}

/**
 * 一次 hook 调用产出的 Action 列表。
 *
 * **为什么是数组而不是单个 Action:** SPEC §7 原文——"一次 Bash 调用可能产生
 * 多条命令…每条独立产出一个 Action,管线对每个都判一次,取最严的结果"。
 * 实测 `cat a.txt | grep foo` 产出 2 条,`:(){ :|:& };:` 产出 0 条。
 * 非 Bash 工具恒定产出 0 或 1 条。
 *
 * 空数组是**合法**结果,含义是"这次调用没有可判的动作"(§10 的 Task,
 * 以及解析出的空命令)。管线对空数组一律放行 —— 这个"空即放行"的语义
 * 在 §4.2 有例外,见 `TRIVIAL_EMPTY` 的注释。
 */
export type AdapterResult = readonly Action[];

/** 工具名 → verb。§10 的表,加 D15.10 补的 MultiEdit。 */
const TOOL_VERB: ReadonlyMap<string, Verb> = new Map<string, Verb>([
  ["Read", "read"],
  ["Glob", "read"],
  ["Grep", "read"],
  ["Edit", "write"],
  ["MultiEdit", "write"],
  ["Write", "write"],
  ["NotebookEdit", "write"],
  ["WebFetch", "network"],
  ["WebSearch", "network"],
  // Bash / Monitor 的 verb 由 §7 解析决定,不在这张表里
]);

/**
 * 没有可判动作的工具(D15.10):派生子 agent(子 agent 的工具调用各自触发 hook,§10 的 Task 就是这条)、
 * 内部状态、与人或别的 agent 对话、后台任务的管理。返回空数组,管线按"无动作"放行。
 * 不在这张表也不在 TOOL_VERB 里的工具名(包括所有 `mcp__*`)仍落 unknown → SOFT:回 allow 会跳过 Claude Code
 * 自己的确认框,对语义不明的工具那是 fail-open。
 */
const SKIPPED_TOOLS = new Set([
  "Task", "Agent", "Workflow",
  "TodoWrite", "TodoRead", "Skill", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "EndConversation",
  "SendMessage", "ListAgents", "TaskStop", "TaskOutput", "KillShell", "BashOutput",
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "PushNotification", "SendFeedback", "ReportFindings",
]);

/** 拿 `command` 字段跑 shell 的工具:Monitor 在后台跑一条命令,与 Bash 同一套解析。 */
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);

/**
 * 工具名 → 取 target 的 `tool_input` 字段名(按优先级)。
 *
 * Read/Edit/Write/NotebookEdit 用 `file_path`;Glob/Grep 用 `path`;
 * WebFetch 用 `url`;WebSearch 用 `query`。
 *
 * `query` 放在 `url` 之后:WebSearch 的输入是搜索词而不是 URL,
 * 但 §2.2 的 `ResourceFacts` 探测不了它 —— 它落 `kind: "url"` 只是为了
 * 让规则层看得见"这是一次网络调用",不是为了解析它。
 */
const TARGET_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Read", ["file_path"]],
  ["Edit", ["file_path"]],
  ["MultiEdit", ["file_path"]],
  ["Write", ["file_path"]],
  ["NotebookEdit", ["notebook_path", "file_path"]],
  ["Glob", ["path"]],
  ["Grep", ["path"]],
  ["WebFetch", ["url"]],
  ["WebSearch", ["url", "query"]],
]);

/** 网络类工具的 target kind 是 url,其余按路径处理。kind 只描述"这是哪类资源"。 */
function kindFor(toolName: string): "file" | "url" | "unknown" {
  if (toolName === "WebFetch" || toolName === "WebSearch") return "url";
  if (TARGET_FIELDS.has(toolName)) return "file";
  return "unknown";
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 网关自己的名字。§0:`zgate`,不要出现变体。 */
const AGENT_NAME = "claude-code";

/**
 * 从 hook 输入里捞 agent 版本。
 *
 * Claude Code 在 hook 输入里**不提供**自己的版本号(文档明确写了
 * "There is no `$CLAUDE_MODEL` environment variable",版本同理)。
 * `CLAUDE_CODE_VERSION` 若存在就用,取不到就是 null —— §2.1 的
 * `version` 本来就是 `nullable`。不为了填它去 spawn 子进程。
 */
function agentVersion(): string | null {
  const v = process.env["CLAUDE_CODE_VERSION"];
  return v && v.length > 0 ? v : null;
}

/**
 * 把 Claude Code 的 PreToolUse hook 输入转成 Action 列表。
 *
 * 这个函数**不抛异常**。看不懂的输入返回空数组(而不是 throw),
 * 因为 §3.2 的降级单位是"这一层给不出东西",不是"整个 hook 失败"。
 * 空数组 ⇒ 交回正常权限流程,与 hook 静默退出的语义一致(文档原文:
 * "staying silent doesn't approve it")。
 *
 * @param turnId 本次决策的唯一 id,由网关生成(§2.1 说是网关的职责)
 */
export function toActions(input: HookInput, turnId: string): AdapterResult {
  const toolName = asString(input.tool_name);
  if (toolName === null) return [];

  const cwd = asString(input.cwd) ?? process.cwd();
  const toolInput = input.tool_input ?? {};
  const agent = {
    name: AGENT_NAME,
    version: agentVersion(),
    session_id: asString(input.session_id),
  };

  // §10:Task 跳过 —— 子 agent 的工具调用会各自触发 hook;D15.10 把同性质的工具一并列进 SKIPPED_TOOLS。
  // 返回空数组,管线按"无动作"放行。见文件末尾 TRIVIAL_EMPTY 注释。
  if (SKIPPED_TOOLS.has(toolName)) return [];

  // Bash:Bash 是万能逃逸口(§7),它的 verb 和 targets 都由 shell 解析决定。
  //
  // 三种产出,分界是安全要求,不是风格:
  //
  //   parsed === null      解析失败($(...) / eval / 文法错)→ 一条 unknown
  //                        ⇒ §4.2 ⇒ SOFT ⇒ ask
  //   parsed.length === 0  解析成功但零条命令(:(){ :|:& };: / 纯函数定义)
  //                        → 也一条 unknown ⇒ SOFT ⇒ ask
  //   parsed.length > 0    每条命令一个 Action,command 只在 exec 时填
  //
  // 第二种是**必须**的:空数组会在管线里被当成"没有动作可判"而放行。
  // 实测 `:(){ :|:& };:` 解析出来正是 [],而它是 §4.5 pre 轮点名的第一条
  // HARD_DENY 模式。没有这条 Action,那条规则连 match 的机会都没有。
  if (SHELL_TOOLS.has(toolName)) {
    const command = asString(toolInput["command"]);
    // 输入里压根没有 command 字段 —— 这不是"命令看不懂",是真的没东西可判。
    if (command === null) return [];

    const parsed = parseCommand(command);
    if (parsed === null || parsed.length === 0) {
      return [makeAction("unknown", [], command, toolName, toolInput, agent, cwd, turnId)];
    }
    return parsed.map((c) =>
      makeAction(
        c.verb,
        c.targets.map((t) => ({ kind: t.kind, raw: t.raw })),
        // §2.1 的字面:command 只在 verb === "exec" 时是原始命令行,否则 null。
        c.verb === "exec" ? command : null,
        toolName,
        toolInput,
        agent,
        cwd,
        turnId,
      ),
    );
  }

  const verb = TOOL_VERB.get(toolName) ?? "unknown";
  const fields = TARGET_FIELDS.get(toolName) ?? [];
  const kind = kindFor(toolName);

  const targets: { kind: "file" | "url" | "unknown"; raw: string }[] = [];
  for (const field of fields) {
    const raw = asString(toolInput[field]);
    // §10 说 Glob/Grep 的 path "可能为空"、WebFetch/WebSearch 的 url "可能为空"。
    // 取不到就**不产出 target**,而不是产出 raw: "" 的空目标 ——
    // 目标的 raw 是要落进 journal 的,空串是噪声。
    if (raw !== null) targets.push({ kind, raw });
  }

  // 非 exec 的 command 恒为 null(§2.1)。
  return [makeAction(verb, targets, null, toolName, toolInput, agent, cwd, turnId)];
}

function makeAction(
  verb: Verb,
  targets: readonly { kind: "file" | "dir" | "url" | "unknown"; raw: string }[],
  command: string | null,
  toolName: string,
  toolInput: Record<string, unknown>,
  agent: { name: string; version: string | null; session_id: string | null },
  cwd: string,
  turnId: string,
): Action {
  // 结构由我们构造,不是外部输入 —— 按 §2.4「只在边界 parse 一次」,
  // 这里不 parse。真正的边界是 §8 的 HTTP 入口(用 parseHookInput)。
  //
  // 不加 `as Action` 断言:去掉断言后,漏字段/写错字段名会直接编译报错 ——
  // 这正是我们把"schema 是唯一事实来源"落到实处的办法(§2.1)。
  return {
    verb,
    // 复制一份:`Action.targets` 在类型上是可变数组(见 action.ts 的注释),
    // 而调用方传进来的常是 readonly。这里一次浅拷贝换掉 read/mutable 的
    // 类型摩擦,同时也切断了调用方与我们之间的别名。
    targets: [...targets],
    command,
    tool_name: toolName,
    tool_input: toolInput,
    agent,
    cwd,
    turn_id: turnId,
  };
}

/**
 * 校验 hook 输入的形状,供 §8 的 HTTP 入口使用(唯一该 parse 的地方)。
 *
 * 用 `ActionSchema` 反查没意义 —— 进来的是 hook 输入不是 Action。
 * 这里只做**能否继续**的判断:tool_name 是不是字符串、tool_input 是不是对象。
 * 返回 null 表示这条 hook 请求不可处理,调用方应放行(不产决策)。
 */
export function parseHookInput(raw: unknown): HookInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["tool_name"] !== "string") return null;
  const ti = o["tool_input"];
  if (ti !== undefined && ti !== null && (typeof ti !== "object" || Array.isArray(ti))) return null;
  return o as HookInput;
}

/**
 * 复用 core 的 ActionSchema 做一次形状自检。仅测试用 ——
 * 生产路径不调用(§2.4:热路径不得重复 parse)。
 */
export function validateAction(a: Action): boolean {
  return ActionSchema.safeParse(a).success;
}

/** Claude Code 期望的响应体。 */
export interface HookResponse {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: Verdict;
    readonly permissionDecisionReason: string;
  };
}

/**
 * Decision → hook 响应体。
 *
 * §10:`verdict === "allow"` 时 reason 留空字符串。deny/ask 时把
 * `decision.reason` 直接给用户看 —— 它是 ≤40 字的自然语言(§2.3)。
 *
 * 不做的事:不加 `systemMessage`、不加 `additionalContext`。
 * 那些会给用户的终端加噪声,而本项目的卖点就是"不吵"。
 */
export function toHookResponse(decision: Decision): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.verdict,
      permissionDecisionReason: decision.verdict === "allow" ? "" : decision.reason,
    },
  };
}

// ── TRIVIAL_EMPTY ─────────────────────────────────────────────────
// 空 Action 列表的含义,写给 §4 / §5 的实现者:
//
// 适配器返回 [] **只有两种情况** —— §10 的 Task(子 agent 会各自触发
// hook),和 Bash 输入里压根没有 `command` 字段。两者都**不是**"命令看不懂"。
//
// "看不懂"走的是 verb: "unknown",有两条路进那里:
//   ① 解析失败          —— $(...) / 反引号 / eval / 文法错
//   ② 解析成功但零条命令 —— fork bomb、纯函数定义
// ② 曾经被错放进空数组那一格,结果是 `:(){ :|:& };:` 被静默放行 ——
// 而它是 §4.5 pre 轮 HARD_DENY 的第一条模式。见 D6.9。
//
// 所以管线对空数组应当**放行**(记一条 PASS),而不是落 SOFT。
// 这条在 §4.2 的射程之外:§4.2 说的是"解析失败、动词未知、目标解析不出来",
// 不包含"压根没有动作可判"。
