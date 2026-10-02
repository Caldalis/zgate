// Claude Code 适配器:hook 输入 ↔ Action / Decision 的格式转换。
// 不探测环境、不做判断、不读文件、不 spawn 进程,判断全部留给 rules / model。
//
// 协议参照 https://code.claude.com/docs/en/hooks(2026-09 按 Claude Code 2.1.284 核对)。
// PreToolUse hook 超时不拦截,工具调用回到正常权限流程,正好是我们要的降级方向。
//
// tool_use_id / permission_mode / prompt_id 只进 journal 的 `hook` 字段,不进 Action:
//   tool_use_id     把 ask 和之后的 Post 事件对上;形状随后端变(toolu_… / chatcmpl-tool-…),当不透明字符串
//   permission_mode bypassPermissions / dontAsk 下 hook 照样跑,离线分析靠它剔掉这些行
//   prompt_id       同一条用户提示下的调用共用,备查

import { ActionSchema } from "../core/action.ts";
import type { Action, Verb } from "../core/action.ts";
import { parseCommand } from "../shell/index.ts";
import type { Decision, Verdict } from "../core/decision.ts";
import type { HookDetails } from "../core/journal.ts";

/** Claude Code 的 hook 原始输入。只声明会读的字段。 */
export interface HookInput {
  readonly session_id?: string | null;
  readonly cwd?: string | null;
  readonly hook_event_name?: string | null;
  readonly tool_name?: string | null;
  readonly tool_input?: Record<string, unknown> | null;
  // 只进 journal 的 hook 字段,老版本 Claude Code 没有
  readonly tool_use_id?: string | null;
  readonly permission_mode?: string | null;
  readonly prompt_id?: string | null;
}

/**
 * 一次 hook 调用产出的 Action 列表。一次 Bash 调用可能含多条命令,每条一个 Action,管线取最严;
 * 非 Bash 工具产出 0 或 1 条。空数组表示没有可判的动作,管线放行(见文件末尾 TRIVIAL_EMPTY)。
 */
export type AdapterResult = readonly Action[];

/** 工具名 → verb。 */
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
  // Bash / Monitor 的 verb 由 shell 解析决定,不在这张表里
]);

/**
 * 没有可判动作的工具:派生子 agent(子 agent 的工具调用各自触发 hook)、内部状态、与人或别的 agent 对话、
 * 后台任务的管理。返回空数组,管线放行。
 * 两张表都不在的工具名(包括所有 `mcp__*`)落 unknown → SOFT:回 allow 会跳过 Claude Code 自己的确认框,
 * 对语义不明的工具那是 fail-open。
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
 * WebSearch 的 query 是搜索词不是 URL,落 `kind: "url"` 只为让规则层看见这是一次网络调用。
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

const AGENT_NAME = "claude-code";

/** hook 输入不带 Claude Code 的版本号:有 `CLAUDE_CODE_VERSION` 就用,否则 null,不为它 spawn 子进程。 */
function agentVersion(): string | null {
  const v = process.env["CLAUDE_CODE_VERSION"];
  return v && v.length > 0 ? v : null;
}

/**
 * 把 Claude Code 的 PreToolUse hook 输入转成 Action 列表。
 *
 * 不抛异常:看不懂的输入返回空数组,交回正常权限流程,与 hook 静默退出同义。
 *
 * @param turnId 本次决策的唯一 id,由网关生成
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

  if (SKIPPED_TOOLS.has(toolName)) return [];

  // Bash 是万能逃逸口,verb 和 targets 都由 shell 解析决定。三种产出:
  //
  //   parsed === null      解析失败($(...) / eval / 文法错)→ 一条 unknown ⇒ SOFT ⇒ ask
  //   parsed.length === 0  解析成功但零条命令(:(){ :|:& };: / 纯函数定义)→ 也一条 unknown
  //   parsed.length > 0    每条命令一个 Action,command 只在 exec 时填
  //
  // 第二种必须落 unknown:空数组会被当成"没有动作可判"而放行,而 fork bomb 解析出来正是 [],
  // 没有这条 Action,fork bomb 的 HARD_DENY 规则连 match 的机会都没有。
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
    // path / url 可能为空:取不到就不产出 target,空串落进 journal 是噪声
    if (raw !== null) targets.push({ kind, raw });
  }

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
  // 自己构造的结构不再 parse,只在 HTTP 入口校验一次。
  // 不加 `as Action`:漏字段或写错字段名会直接编译报错。
  return {
    verb,
    // 浅拷贝:调用方传进来的常是 readonly 数组,顺便切断别名
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
 * 校验 hook 输入的形状,只在 HTTP 入口调用。
 * 只判断能否继续:tool_name 是字符串、tool_input 是对象。返回 null 表示不可处理,调用方放行。
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
 * PreToolUse 输入里能与 Post 事件对账的字段。
 * 没有 `tool_use_id`(老版本 Claude Code,或 `/decide` 之类不经 hook 的入口)就是 null,journal 里就没有 `hook` 键。
 * permission_mode / prompt_id 有才写键。
 */
export function hookDetails(input: HookInput): HookDetails | null {
  const toolUseId = asString(input.tool_use_id);
  if (toolUseId === null) return null;
  const mode = asString(input.permission_mode);
  const promptId = asString(input.prompt_id);
  return {
    tool_use_id: toolUseId,
    ...(mode === null ? {} : { permission_mode: mode }),
    ...(promptId === null ? {} : { prompt_id: promptId }),
  };
}

/**
 * `/hook/claude-code` 收到的一次事件,按 `hook_event_name` 分类:
 *
 *   PreToolUse           裁决(input 即 parseHookInput 的结果)
 *   PostToolUse /
 *   PostToolUseFailure   工具真的执行了:悬着的 ask 补 approved
 *   PostToolBatch        一批落定:批里仍悬着的 id 没执行就落定了,补 unknown
 *   SessionEnd           该 session 悬着的全部补 unknown
 *   other                旁观:PermissionRequest / Notification / Stop / …,server 回 {}
 *
 * 没写 `hook_event_name` 的按 PreToolUse 处理(bench、测试只发这一种)。
 * 返回 null 只有一种情况:是 PreToolUse 却连 tool_name 都没有,server 回"不表态"。
 */
export type HookEvent =
  | { readonly kind: "PreToolUse"; readonly input: HookInput }
  | { readonly kind: "PostToolUse" | "PostToolUseFailure"; readonly sessionId: string | null; readonly toolUseId: string }
  | { readonly kind: "PostToolBatch"; readonly sessionId: string | null; readonly toolUseIds: readonly string[] }
  | { readonly kind: "SessionEnd"; readonly sessionId: string | null }
  | { readonly kind: "other"; readonly name: string };

export function parseHookEvent(raw: unknown): HookEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o["hook_event_name"]);
  const sessionId = asString(o["session_id"]);

  if (name === null || name === "PreToolUse") {
    const input = parseHookInput(raw);
    return input === null ? null : { kind: "PreToolUse", input };
  }
  if (name === "PostToolUse" || name === "PostToolUseFailure") {
    const toolUseId = asString(o["tool_use_id"]);
    // 没有 id 对不上任何悬着的 ask,只能旁观
    return toolUseId === null ? { kind: "other", name } : { kind: name, sessionId, toolUseId };
  }
  if (name === "PostToolBatch") {
    const calls = o["tool_calls"];
    const toolUseIds: string[] = [];
    if (Array.isArray(calls)) {
      for (const c of calls) {
        if (typeof c !== "object" || c === null) continue;
        const id = asString((c as Record<string, unknown>)["tool_use_id"]);
        if (id !== null) toolUseIds.push(id);
      }
    }
    return { kind: "PostToolBatch", sessionId, toolUseIds };
  }
  if (name === "SessionEnd") return { kind: "SessionEnd", sessionId };
  return { kind: "other", name };
}

/** 用 ActionSchema 做一次形状自检。仅测试用,生产路径不重复 parse。 */
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
 * Decision → hook 响应体。allow 时 reason 留空;deny / ask 时 reason 直接展示给用户。
 * 不加 `systemMessage` / `additionalContext`,不给用户的终端加噪声。
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
// 适配器返回 [] 只有两种情况:SKIPPED_TOOLS 里的工具,和 Bash 输入里压根没有 `command` 字段。
// 两者都不是"命令看不懂" —— 看不懂走 verb: "unknown"(解析失败,或解析成功但零条命令,如 fork bomb)。
// 所以管线对空数组放行(记一条 PASS),而不是落 SOFT。
