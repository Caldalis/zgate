// SPEC.md §4 —— 规则层。
//
// 这是整个网关的**底线**。§3.2 说得很清楚:模型挂了、超时了、根本没接,
// 最坏情况都不得低于纯规则 baseline。所以这一层必须:
//
//   - 不依赖任何外部组件(不 spawn、不联网、不读 Context 之外的东西)
//   - 1 毫秒量级(§13 的 p50 预算 5ms,这层占大头)
//   - 判不出来就说判不出来(§4.2:未知即 SOFT,绝不 PASS)
//
// 三档裁决的含义:
//   HARD_DENY  确定危险,终局。任何下游都不得推翻(§3.2)
//   SOFT       拿不准,倾向保守。无模型时 → ask
//   PASS       看起来正常。无模型时 → allow
//
// **注意 PASS 不是"安全",是"没发现危险"。** 用户仍然可能点开权限确认
// 之外的东西 —— 网关的价值是同等安全下少打扰,不是绝对安全。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { EXEC_RULES } from "./exec.ts";
import { FILESYSTEM_RULES } from "./filesystem.ts";
import { GIT_RULES } from "./git.ts";
import { NETWORK_RULES } from "./network.ts";
import { POLICY_POST_RULES, POLICY_PRE_RULES } from "./policy.ts";
import { SECRET_RULES } from "./secrets.ts";
import { TOOL_RULES } from "./tools.ts";

export type RuleVerdict = "HARD_DENY" | "SOFT" | "PASS";

export interface Rule {
  readonly id: string;
  readonly stage: "pre" | "post";
  readonly verdict: RuleVerdict;
  /**
   * SOFT 命中时不问模型,直接 ask(D15.7)。只给"模型结构性拿不到判据"的规则用:
   * 目前只有 policy.self_write —— 策略文本按设计不给模型看,它对这条没有依据,就不该让它判。
   */
  readonly skipModel?: true;
  /** 命中返回 reason 字符串(≤40 字),不命中返回 null */
  match(action: Action, ctx: Context | null): string | null;
}

export function defineRule(r: Rule): Rule {
  return r;
}

/**
 * 全部规则,按 stage 排序。
 *
 * 顺序**不是**优先级 —— 同一轮内所有规则都会被问到,裁决取最严的那个。
 * 顺序只影响 `reason` 的归属(同档位先命中者胜),那纯粹是给人看的。
 * 把它写成显式排序是为了让 reason 稳定可测,不是为了短路。
 */
export const RULES: readonly Rule[] = [
  // 必须在最前:写策略文件的任何形态都直接问人,不让同档的 git.destructive 之类抢走 rule_id 再去问模型(D15.7)
  ...POLICY_PRE_RULES,
  ...NETWORK_RULES,
  ...FILESYSTEM_RULES,
  // 命令本身就是对外部系统的破坏 / 外发(D15.10),全是 pre SOFT 文本规则
  ...EXEC_RULES,
  ...TOOL_RULES,
  ...SECRET_RULES,
  ...GIT_RULES,
  // 必须在末尾:同档先命中者胜,policy.scope 只在没有别的 SOFT 时成为 rule_id(spec-m3 §3.3)
  ...POLICY_POST_RULES,
];

const SKIP_MODEL: ReadonlySet<string> = new Set(RULES.filter((r) => r.skipModel === true).map((r) => r.id));

/** 这条 rule_id 命中的 SOFT 是否绕过模型段。 */
export function skipsModel(ruleId: string | null): boolean {
  return ruleId !== null && SKIP_MODEL.has(ruleId);
}

/** §4.1 的三档排序:数字越大越严。 */
const SEVERITY: Record<RuleVerdict, number> = {
  PASS: 0,
  SOFT: 1,
  HARD_DENY: 2,
};

export function stricter(a: RuleVerdict, b: RuleVerdict): RuleVerdict {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export interface RuleHit {
  readonly verdict: RuleVerdict;
  readonly rule_id: string | null;
  readonly reason: string;
}

/**
 * 跑一轮规则。
 *
 * **`stage === "post"` 的规则在这一轮里 `ctx` 必须是真实 Context;
 * `stage === "pre"` 的规则看到的一律是 `null`。** §4.3 靠这个分界把
 * "不用探测就能判的"和"必须看环境的"分开 —— 前者命中就省下一次
 * 文件系统探测。
 *
 * 返回的 `rule_id` 是同档位**先命中**的那条。理由要可直接展示给用户,
 * 多条规则同时命中时挑最早说清问题的那条,比挑最后一条稳定。
 */
export function evaluate(
  action: Action,
  ctx: Context | null,
  stage: "pre" | "post",
): RuleHit {
  let verdict: RuleVerdict = "PASS";
  let ruleId: string | null = null;
  let reason = "";

  for (const rule of RULES) {
    if (rule.stage !== stage) continue;

    // ★ HARD_DENY 是终局,一律短路。
    //   理由不只是省时间:取最严的语义下,HARD_DENY 后续不可能被改宽;
    //   而如果让后面的规则先命中并改写 `reason`,最终 deny 的理由就会被
    //   一条 SOFT 规则的文字覆盖 —— 那是对用户的误导。
    //   「先说死的那条说了算」是这里唯一自洽的规矩。
    if (verdict === "HARD_DENY") break;

    // §4.4:`stage === "pre"` 的规则,`match` 收到的 `ctx` 恒为 `null`。
    // 这里强行压成 null,而不是相信每条规则自己记得 —— 一条忘记检查的
    // pre 规则会读到 Context,那 §4.3 的分界就名存实亡了。
    const hit = rule.match(action, rule.stage === "pre" ? null : ctx);
    if (hit === null) continue;

    if (stricter(rule.verdict, verdict) !== verdict) {
      verdict = rule.verdict;
      ruleId = rule.id;
      reason = hit;
    }
  }

  return { verdict, rule_id: ruleId, reason };
}
