// 降级表:规则层裁决 + 模型结论 → 最终 verdict。整个项目唯一的安全保证:
//
//   任何下游组件不可用或超时,降级到规则层的裁决。
//   绝不 fail-open(模型挂了全放行,网关形同虚设),
//   也绝不 fail-closed(模型挂了全拦,用户当天就会关掉它)。
//
// 模型只在 SOFT / PASS 上有裁量权,HARD_DENY 是终局,任何下游都不得推翻。

import type { Verdict } from "./decision.ts";
import type { RuleVerdict } from "../rules/index.ts";

/** 决策来源,即 Decision.source。 */
export type DecisionSource = "cache" | "rule" | "model" | "fallback";

export interface Merged {
  readonly verdict: Verdict;
  readonly source: DecisionSource;
}

/**
 * | 规则裁决   | 模型可用        | 模型不可用 / 超时 |
 * |-----------|----------------|------------------|
 * | HARD_DENY | deny(跳过模型)  | deny             |
 * | SOFT      | 模型自由裁量     | ask              |
 * | PASS      | 模型自由裁量     | allow            |
 *
 * `model` 为 null 表示不可用 / 超时 / 没配模型。
 *
 * HARD_DENY 与 PASS 两行的 `source` 是 `"rule"` 而不是 `"fallback"`:它们不是降级的产物,
 * 就是规则层本来的结论(PASS 根本不问模型)。`fallback` 只在真的降级(SOFT + 模型不可用或失败)时出现,
 * 否则降级率会把放行这个流量大头算进去。
 */
export function merge(rule: RuleVerdict, model: Verdict | null): Merged {
  switch (rule) {
    case "HARD_DENY":
      // 终局,模型即使可用也不问
      return { verdict: "deny", source: "rule" };

    case "SOFT":
      return model === null
        ? { verdict: "ask", source: "fallback" }
        : { verdict: model, source: "model" };

    case "PASS":
      return model === null
        ? { verdict: "allow", source: "rule" }
        : { verdict: model, source: "model" };
  }
}

/**
 * 多条 Action 取最严,`deny > ask > allow`。
 * 一条 Bash 调用可能切成好几条命令(`cd a && rm -rf /`),整体结论不能比其中任何一条宽松,
 * 否则把危险命令塞进复合语句的第二段就绕过了。
 */
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

export function strictest(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * 多条 Action 的整体裁决。带回胜出那条的序号:reason 和 rule_id 必须来自真正判死的那一条,
 * 用户看到的是"删除根目录",而不是"复合语句里有一条正常命令"。
 */
export function mergeAll(perAction: readonly Merged[]): { merged: Merged; index: number } {
  let bestIndex = 0;
  let best: Merged = perAction[0] ?? { verdict: "allow", source: "rule" };
  for (let i = 1; i < perAction.length; i += 1) {
    const cur = perAction[i];
    if (cur === undefined) continue;
    if (RANK[cur.verdict] > RANK[best.verdict]) {
      best = cur;
      bestIndex = i;
    }
  }
  return { merged: best, index: bestIndex };
}
