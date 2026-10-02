// Decision:网关的裁决。字段命名理由见 action.ts 顶部。

import { z } from "zod";

export const VerdictSchema = z.enum(["allow", "ask", "deny"]);
export type Verdict = z.infer<typeof VerdictSchema>;

// 规则层的三档裁决。不进线格式,只在管线内部用。
export type RuleVerdict = "HARD_DENY" | "SOFT" | "PASS";

export const DecisionSchema = z.object({
  verdict: VerdictSchema,
  reason: z.string(), // ≤40 字,直接展示给用户。allow 时可为 ""
  source: z.enum(["cache", "rule", "model", "fallback"]),
  rule_id: z.string().nullable(),
  confidence: z.number().nullable(), // 本地模型的 P(裁决);其余为 null,模型失败降级时为 0
  latency_ms: z.number(),
  decision_id: z.string(),
});
export type Decision = Readonly<z.infer<typeof DecisionSchema>>;
