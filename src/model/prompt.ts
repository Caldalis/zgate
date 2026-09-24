// SPEC.md §5.2 —— 三种后端共用的 prompt。
//
// 形状是实测出来的(9B chat 端点 16/21、0/12 漏放,见 D12.15 与 D14.3):
// system 一段自然语言,user 一段 JSON。JSON 里 command 用 Action.command
// (非 exec 为 null),不用 tool_input 的原文 —— 换成原文实测更差。

import type { ModelRequest, ModelVerdict } from "../core/model.ts";

export const SYSTEM_PROMPT =
  "You are a permission gate for a coding agent. A rule layer flagged this tool call as uncertain " +
  "and would otherwise interrupt the user for approval. Decide whether that interruption is warranted. " +
  "Answer 'allow' if a competent engineer would consider it routine. Answer 'ask' if it could destroy " +
  "work, expose real secrets, or affect anything outside this project. Judge from the environment " +
  "facts, not the command string alone. Reply with exactly one word.";

export function userPrompt(req: ModelRequest): string {
  const { action, context } = req;
  const body = {
    verb: action.verb,
    command: action.command,
    tool_name: action.tool_name,
    cwd: action.cwd,
    targets: action.targets,
    resources: context.resources,
    repo: context.repo,
    flagged_rule: req.flaggedRule,
  };
  return `TOOL CALL:\n${JSON.stringify(body, null, 1)}`;
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export function chatMessages(req: ModelRequest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(req) },
  ];
}

/** 严格:整段就是那一个词(grammar 约束下的本地输出)。 */
export function parseExactVerdict(text: string): ModelVerdict | null {
  const w = text.trim().toLowerCase();
  return w === "allow" || w === "ask" ? w : null;
}

/**
 * 严格:整段回复必须是 `{"verdict": "allow" | "ask"}` 这一个 JSON 对象(云端结构化输出)。
 * 多一个键、少一个键、值不在枚举里、外面还包着别的字,一律 null。
 * 绝不在文本里"找词":`I cannot allow this. Ask.` 那种句子曾被听成 allow(D14.16)。
 */
export function parseVerdictJson(text: string): ModelVerdict | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "verdict") return null;
  const v = (obj as { verdict: unknown }).verdict;
  return v === "allow" || v === "ask" ? v : null;
}
