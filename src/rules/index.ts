// 规则层:整个网关的底线。模型挂了、超时了、根本没接,最坏情况也不低于纯规则。所以这一层:
//
//   - 不依赖任何外部组件(不 spawn、不联网、不读 Context 之外的东西)
//   - 1 毫秒量级(p50 预算 5ms,这层占大头)
//   - 判不出来就说判不出来:未知即 SOFT,绝不 PASS
//
// 三档裁决:
//   HARD_DENY  确定危险,终局,任何下游都不得推翻
//   SOFT       拿不准,倾向保守。无模型时 → ask
//   PASS       没发现危险(不等于安全)。无模型时 → allow

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
   * SOFT 命中时不问模型,直接 ask。只给模型结构性拿不到判据的规则用:
   * 目前只有 policy.self_write —— 策略文本按设计不给模型看,模型对这条没有依据。
   */
  readonly skipModel?: true;
  /** 命中返回 reason 字符串(中文 ≤40 字、英文 ≤80 字符,用 t() 写两种),不命中返回 null */
  match(action: Action, ctx: Context | null): string | null;
}

export function defineRule(r: Rule): Rule {
  return r;
}

/**
 * 全部规则。顺序不是优先级:同一轮内所有规则都会被问到,裁决取最严。
 * 顺序只决定同档位时 reason / rule_id 归谁(先命中者胜),写成显式顺序是为了让 reason 稳定可测。
 */
export const RULES: readonly Rule[] = [
  // 必须在最前:写策略文件的任何形态都直接问人,不让同档的 git.destructive 之类抢走 rule_id 再去问模型
  ...POLICY_PRE_RULES,
  ...NETWORK_RULES,
  ...FILESYSTEM_RULES,
  // 命令本身就是对外部系统的破坏 / 外发,全是 pre SOFT 文本规则
  ...EXEC_RULES,
  ...TOOL_RULES,
  ...SECRET_RULES,
  ...GIT_RULES,
  // 必须在末尾:同档先命中者胜,policy.scope 只在没有别的 SOFT 时成为 rule_id
  ...POLICY_POST_RULES,
];

const SKIP_MODEL: ReadonlySet<string> = new Set(RULES.filter((r) => r.skipModel === true).map((r) => r.id));

/** 这条 rule_id 命中的 SOFT 是否绕过模型段。 */
export function skipsModel(ruleId: string | null): boolean {
  return ruleId !== null && SKIP_MODEL.has(ruleId);
}

/** 三档排序:数字越大越严。 */
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
 * post 轮的规则拿到真实 Context,pre 轮的规则看到的一律是 null:pre 轮只判不用探测就能判的,
 * 命中就省下一次文件系统探测。
 *
 * 返回的 rule_id 是同档位先命中的那条:多条同时命中时挑最早说清问题的,比挑最后一条稳定。
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

    // HARD_DENY 是终局,后面的规则不可能改变结论,直接短路。
    if (verdict === "HARD_DENY") break;

    // pre 规则的 ctx 在这里强行压成 null,不靠每条规则自己记得:
    // 一条忘了检查的 pre 规则读到 Context,pre / post 的分界就名存实亡。
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
