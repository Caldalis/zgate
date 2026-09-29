// spec-m5 —— opencode 适配器。**只做格式转换。**
//
// opencode 没有 Claude Code 那样的 http hook;它的扩展点是进程内插件(`@opencode-ai/plugin` 的 Hooks)。
// 所以这里的线格式由 zgate 自己定义,发送方是随仓库分发的插件 `plugins/opencode/zgate.ts`:
//
//   { v: 1, event: "before",  session_id, call_id, tool, args, cwd, agent_version? }   → 回 Decision(§2.3)
//   { v: 1, event: "replied", session_id, call_id, reply: "once" | "always" | "reject" } → 回 {}
//   { v: 1, event: "after",   session_id, call_id, tool }                               → 回 {}
//
// 参照:opencode 1.18.33(2026-09-29,源码 packages/core/src/tool/*.ts):工具 id 与参数名
//   bash {command, workdir?} / read {path} / edit {path, oldString, newString} / write {path, content} /
//   glob {pattern, path?} / grep {pattern, path?, include?} / apply_patch {patchText} / webfetch {url} / websearch {query} /
//   task / todowrite / question / skill(无可判动作)。

import type { Action, Verb } from "../core/action.ts";
import type { HookDetails } from "../core/journal.ts";
import { parseCommand } from "../shell/index.ts";
import { resolve as resolvePath } from "node:path";

export interface OpencodeBefore {
  readonly kind: "before";
  readonly sessionId: string | null;
  readonly callId: string | null;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly cwd: string | null;
  readonly version: string | null;
}

export type OpencodeEvent =
  | OpencodeBefore
  | { readonly kind: "replied"; readonly sessionId: string | null; readonly callId: string; readonly reply: string }
  | { readonly kind: "after"; readonly sessionId: string | null; readonly callId: string }
  | { readonly kind: "other"; readonly name: string };

const AGENT_NAME = "opencode";

const TOOL_VERB: ReadonlyMap<string, Verb> = new Map<string, Verb>([
  ["read", "read"],
  ["glob", "read"],
  ["grep", "read"],
  ["list", "read"],
  ["edit", "write"],
  ["write", "write"],
  ["webfetch", "network"],
  ["websearch", "network"],
]);

/** 目标字段:opencode 一律叫 path(Claude Code 叫 file_path);websearch 的 query 与 Claude Code 同一处理(D15.10)。 */
const TARGET_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["read", ["path"]],
  ["glob", ["path"]],
  ["grep", ["path"]],
  ["list", ["path"]],
  ["edit", ["path"]],
  ["write", ["path"]],
  ["webfetch", ["url"]],
  ["websearch", ["url", "query"]],
]);

/** 没有可判动作的工具:子 agent 的调用各自触发钩子;其余是内部状态或与人对话。 */
const SKIPPED_TOOLS = new Set(["task", "todowrite", "todoread", "question", "skill", "plan_enter", "plan_exit", "batch"]);

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function kindFor(tool: string): "file" | "url" | "unknown" {
  if (tool === "webfetch" || tool === "websearch") return "url";
  if (TARGET_FIELDS.has(tool)) return "file";
  return "unknown";
}

/** 只认三种事件;别的名字归 other,server 回 {}。before 缺 tool 名 → null(与 parseHookInput 的 null 同义)。 */
export function parseOpencodeEvent(raw: unknown): OpencodeEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o["event"]);
  const sessionId = asString(o["session_id"]);
  const callId = asString(o["call_id"]);

  if (name === null || name === "before") {
    const tool = asString(o["tool"]);
    if (tool === null) return null;
    const args = o["args"];
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) return null;
    return {
      kind: "before",
      sessionId,
      callId,
      tool,
      args: (args ?? {}) as Record<string, unknown>,
      cwd: asString(o["cwd"]),
      version: asString(o["agent_version"]),
    };
  }
  if (name === "replied") {
    return callId === null ? { kind: "other", name } : { kind: "replied", sessionId, callId, reply: asString(o["reply"]) ?? "" };
  }
  if (name === "after") {
    return callId === null ? { kind: "other", name } : { kind: "after", sessionId, callId };
  }
  return { kind: "other", name };
}

/** 进 journal 的 hook 字段:opencode 的 callID 落在 tool_use_id 上(同一个角色:把"问了"和之后的事件对上)。没有模式的概念。 */
export function opencodeHookDetails(input: OpencodeBefore): HookDetails | null {
  return input.callId === null ? null : { tool_use_id: input.callId };
}

/**
 * apply_patch 的 patchText(OpenAI 的 patch 格式):
 *   *** Add File: a.txt / *** Update File: b.txt / *** Delete File: c.txt / *** Move to: d.txt
 * 每个文件一条 Action:Add / Update / Move to 是 write,Delete 是 delete。一个都认不出 → 一条 unknown(保守)。
 */
function patchTargets(text: string): { verb: Verb; raw: string }[] {
  const out: { verb: Verb; raw: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\*\*\*\s+(Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    if (m === null) continue;
    const op = m[1];
    const raw = m[2] ?? "";
    if (raw === "") continue;
    out.push({ verb: op === "Delete File" ? "delete" : "write", raw });
  }
  return out;
}

/**
 * before 事件 → Action 列表。语义与 Claude Code 适配器逐条对齐(§7:bash 按复合语句切分;空数组 = 无动作可判 ⇒ 放行)。
 * bash 的 workdir 会改变相对路径的基准,所以 Action.cwd 取 cwd/workdir。
 */
export function toActionsOpencode(input: OpencodeBefore, turnId: string): readonly Action[] {
  const tool = input.tool;
  if (SKIPPED_TOOLS.has(tool)) return [];

  const baseCwd = input.cwd ?? process.cwd();
  const agent = { name: AGENT_NAME, version: input.version, session_id: input.sessionId };
  const make = (verb: Verb, targets: { kind: "file" | "dir" | "url" | "unknown"; raw: string }[], command: string | null, cwd: string): Action => ({
    verb,
    targets,
    command,
    tool_name: tool,
    tool_input: input.args,
    agent,
    cwd,
    turn_id: turnId,
  });

  if (tool === "bash") {
    const command = asString(input.args["command"]);
    if (command === null) return [];
    const workdir = asString(input.args["workdir"]);
    const cwd = workdir === null ? baseCwd : resolvePath(baseCwd, workdir);
    const parsed = parseCommand(command);
    if (parsed === null || parsed.length === 0) return [make("unknown", [], command, cwd)];
    return parsed.map((c) =>
      make(c.verb, c.targets.map((t) => ({ kind: t.kind, raw: t.raw })), c.verb === "exec" ? command : null, cwd),
    );
  }

  if (tool === "apply_patch") {
    const text = asString(input.args["patchText"]);
    if (text === null) return [];
    const files = patchTargets(text);
    if (files.length === 0) return [make("unknown", [], null, baseCwd)];
    return files.map((f) => make(f.verb, [{ kind: "file", raw: f.raw }], null, baseCwd));
  }

  const verb = TOOL_VERB.get(tool) ?? "unknown";
  const kind = kindFor(tool);
  const targets: { kind: "file" | "url" | "unknown"; raw: string }[] = [];
  for (const field of TARGET_FIELDS.get(tool) ?? []) {
    const raw = asString(input.args[field]);
    if (raw !== null) targets.push({ kind, raw });
  }
  return [make(verb, targets, null, baseCwd)];
}
