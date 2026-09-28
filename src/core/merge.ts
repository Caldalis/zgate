// SPEC.md §3.2 —— 降级表。
//
// 这个文件只有一张表,但它是整个项目**唯一的安全保证**:
//
//   任何下游组件不可用或超时,降级到规则层的裁决。
//   绝不 fail-open,也绝不 fail-closed。
//
// 两者都不是口号:
//   fail-open   模型挂了就全放行 → 网关形同虚设
//   fail-closed 模型挂了就全拦 → 用户当天就关掉它,比没有更糟
//
// 中间那条路是"回到规则层已经做出的判断",也就是这张表。
//
// 它同时是 §5 模型层的接口契约:模型只在 SOFT / PASS 上有裁量权,
// **HARD_DENY 是终局,任何下游都不得推翻**。

import type { Verdict } from "./decision.ts";
import type { RuleVerdict } from "../rules/index.ts";

/** 决策来源。§2.3 的 `source` 枚举。 */
export type DecisionSource = "cache" | "rule" | "model" | "fallback";

export interface Merged {
  readonly verdict: Verdict;
  readonly source: DecisionSource;
}

/**
 * §3.2 的表,逐行抄下来:
 *
 * | 规则裁决   | 模型可用        | 模型不可用 / 超时 |
 * |-----------|----------------|------------------|
 * | HARD_DENY | deny(跳过模型)  | deny             |
 * | SOFT      | 模型自由裁量     | ask              |
 * | PASS      | 模型自由裁量     | allow            |
 *
 * `model` 为 null 表示"不可用 / 超时 / M1 根本没接"。
 *
 * 注意 HARD_DENY 与 PASS 两行:`source` 是 `"rule"` 而不是 `"fallback"` ——
 * 它们**不是降级的产物**,就是规则层本来的结论(M2 起 PASS 根本不问模型,D14.2)。
 * 日志里 `source: "fallback"` 只在真的降级(SOFT + 模型不可用或失败)时出现,
 * 否则统计降级率会把放行这个流量大头算进去,数字就没意义了(D9.5 / D14.18)。
 */
export function merge(rule: RuleVerdict, model: Verdict | null): Merged {
  switch (rule) {
    case "HARD_DENY":
      // 终局。模型即使可用也不问它 —— 这一行是 §3.2 的加粗那句。
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
 * 多条 Action 取最严(§7:"管线对每个都判一次,取最严的结果")。
 *
 * 一条 Bash 调用可能切成好几条命令(`cd a && rm -rf /`),每条独立判。
 * 整体结论不能比其中任何一条宽松 —— 否则攻击者只要把危险命令塞进
 * 复合语句的第二段就绕过了。
 *
 * `deny > ask > allow`,和 §4.1 的三档同序。
 */
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

export function strictest(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * 多条 Action 的整体裁决。
 *
 * 返回值带**获胜那条 Action 的序号**,因为 reason 和 rule_id 必须来自
 * 真正判死的那一条 —— 用户看到的是"删除根目录",而不是"复合语句里
 * 有一条正常命令"。
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
