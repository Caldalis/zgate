// Action:agent 的一次动作。HTTP 线格式与 journal 共用这份 schema,改字段会破坏兼容。
//
// 字段一律 snake_case:下游是 Python 工具链,统一 snake_case 就不需要映射层。
// schema 是唯一事实来源,类型由 z.infer 派生。

import { z } from "zod";

export const VerbSchema = z.enum([
  "exec",
  "read",
  "write",
  "delete",
  "network",
  "unknown",
]);
export type Verb = z.infer<typeof VerbSchema>;

export const ResourceSchema = z.object({
  kind: z.enum(["file", "dir", "url", "unknown"]),
  raw: z.string(), // agent 给的原始字符串,不做任何处理
});
export type Resource = Readonly<z.infer<typeof ResourceSchema>>;

export const AgentInfoSchema = z.object({
  name: z.string(), // "claude-code"
  version: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type AgentInfo = Readonly<z.infer<typeof AgentInfoSchema>>;

export const ActionSchema = z.object({
  verb: VerbSchema,
  targets: z.array(ResourceSchema),
  command: z.string().nullable(), // verb==="exec" 时的原始命令行,否则 null
  tool_name: z.string(), // agent 侧原始工具名,如 "Bash"
  tool_input: z.record(z.string(), z.unknown()), // agent 侧原始输入,原样保留
  agent: AgentInfoSchema,
  cwd: z.string(),
  turn_id: z.string(), // 本次决策唯一 id,由网关生成
});

// 不可变性只用 Readonly 在编译期表达,热路径不做 Object.freeze。
// Readonly<> 是浅的,targets 数组在类型上仍可变;约定任何代码都不得原地改已构造出的 Action。
export type Action = Readonly<z.infer<typeof ActionSchema>>;
