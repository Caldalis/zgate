// SPEC.md §2.3 — 冻结契约。字段命名理由见 action.ts 顶部。

import { z } from "zod";

export const VerdictSchema = z.enum(["allow", "ask", "deny"]);
export type Verdict = z.infer<typeof VerdictSchema>;

// 规则层的三档裁决,§4.1。不是线格式的一部分,只活在管线内部。
export type RuleVerdict = "HARD_DENY" | "SOFT" | "PASS";

export const DecisionSchema = z.object({
  verdict: VerdictSchema,
  reason: z.string(), // ≤40 字,直接展示给用户。allow 时可为 ""
  source: z.enum(["cache", "rule", "model", "fallback"]),
  rule_id: z.string().nullable(),
  confidence: z.number().nullable(), // M1 恒为 null
  latency_ms: z.number(),
  decision_id: z.string(),
});
export type Decision = Readonly<z.infer<typeof DecisionSchema>>;
