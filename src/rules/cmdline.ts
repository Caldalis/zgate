// 取「这条 Action 对应的命令原文」。
//
// 这是个看起来多余、实际必要的小函数。理由:
//
// §2.1 规定 `action.command` **只在 `verb === "exec"` 时有值**,其余一律
// null。而 git 相关命令的 verb 是 `network`(见 §7 的二级表),`git push
// --force` 这类命令的 `command` 字段就是 null —— 但规则层恰恰必须看到
// `--force` 才能判。
//
// 那原文在哪?在 `tool_input` 里。§2.1 明确写着它是"agent 侧原始输入,
// 原样保留" —— 这正是它的用途。所以这里按优先级取:
//
//   1. tool_input.command  —— agent 给的原文,永远在
//   2. action.command      —— 解析层给的原文(verb === "exec" 时)
//
// 两个都为空的场合:`/decide` 端点被手写请求直接调用、或者非 Bash 工具。
// 那种情况下规则层拿不到原文,只能按结构化字段判 —— 所以所有依赖原文的
// 规则都必须容忍空串,且**不能因为拿不到原文就默认放行**。

import type { Action } from "../core/action.ts";

/** 命令原文。取不到返回空串(调用方必须处理这个情况)。 */
export function commandLine(action: Action): string {
  const raw = action.tool_input["command"];
  if (typeof raw === "string" && raw !== "") return raw;
  return action.command ?? "";
}
