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

/** 宽松:自由文本里第一个独立出现的 allow / ask(云端输出)。 */
export function parseVerdictWord(text: string): ModelVerdict | null {
  const m = /\b(allow|ask)\b/i.exec(text);
  if (m === null) return null;
  return m[1]?.toLowerCase() === "allow" ? "allow" : "ask";
}
