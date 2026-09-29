// 非 Bash 工具。MCP 工具(`mcp__<server>__<tool>`)语义不透明:可能只读一份设计稿,也可能删远端仓库。
// §4.2 未知即 SOFT;这条把 reason 从"命令语义无法判定"换成说清是哪个 MCP server,并成为 pre 轮的 rule_id。
// 不跳过它们:hook 回 allow 会跳过 Claude Code 自己的确认框,那是 fail-open(D15.10)。

import type { Action } from "../core/action.ts";
import { defineRule, type Rule } from "./index.ts";

const mcpTool = defineRule({
  id: "tool.mcp",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    const m = /^mcp__(.+?)__/.exec(action.tool_name);
    if (m === null) return null;
    const server = m[1] ?? "";
    return `MCP 工具(${server.length > 24 ? `${server.slice(0, 23)}…` : server})`;
  },
});

export const TOOL_RULES: readonly Rule[] = [mcpTool];
