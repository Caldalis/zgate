// spec-m4 §0 第 7 项 —— `zgate journal stats`:一眼看到飞轮转没转。
//
// 只数 verdict 为 ask 的行(问了的),按 rule_id × source 分组,列 outcome 的去向。
// 不做别的分析:哪些行能当标注、要不要按 permission_mode 过滤,是 Python 侧的事(SPEC §16)。

import type { ReplayedDecision } from "./journal.ts";

export interface StatsRow {
  readonly rule_id: string;
  readonly source: string;
  /** 这组里问了几次(verdict 为 ask 的行数) */
  readonly asked: number;
  /** 用户点了通过,工具真的执行了 */
  readonly approved: number;
  /** approved 里工具执行失败的 */
  readonly approved_failed: number;
  /** v1 的钩子不写 rejected,但 /outcome 外部可写,照数 */
  readonly rejected: number;
  /** 会话结束或调用落定时仍没通过 */
  readonly unknown: number;
  /** outcome 仍是 null:daemon 重启、悬着超过 30 分钟、老版本 Claude Code 没有 tool_use_id、SessionEnd 没来 */
  readonly pending: number;
}

export interface OutcomeStats {
  readonly total: number;
  readonly by_verdict: { readonly allow: number; readonly ask: number; readonly deny: number };
  /** 经 Claude Code 钩子进来且带 tool_use_id 的行 */
  readonly with_hook: number;
  readonly asked: number;
  readonly approved: number;
  readonly approved_failed: number;
  readonly rejected: number;
  readonly unknown: number;
  readonly pending: number;
  /** 按 asked 降序,再按 rule_id */
  readonly rows: readonly StatsRow[];
}

interface Acc {
  asked: number;
  approved: number;
  approved_failed: number;
  rejected: number;
  unknown: number;
  pending: number;
}

function tally(acc: Acc, e: ReplayedDecision): void {
  acc.asked += 1;
  const o = e.outcome;
  if (o === null) {
    acc.pending += 1;
  } else if (o.user_action === "approved") {
    acc.approved += 1;
    if (o.tool_succeeded === false) acc.approved_failed += 1;
  } else if (o.user_action === "rejected") {
    acc.rejected += 1;
  } else {
    acc.unknown += 1;
  }
}

export function outcomeStats(entries: readonly ReplayedDecision[]): OutcomeStats {
  const byVerdict = { allow: 0, ask: 0, deny: 0 };
  let withHook = 0;
  const totalAcc: Acc = { asked: 0, approved: 0, approved_failed: 0, rejected: 0, unknown: 0, pending: 0 };
  const groups = new Map<string, { rule_id: string; source: string; acc: Acc }>();

  for (const e of entries) {
    byVerdict[e.decision.verdict] += 1;
    if (e.hook !== null) withHook += 1;
    if (e.decision.verdict !== "ask") continue;
    tally(totalAcc, e);
    const ruleId = e.decision.rule_id ?? "-";
    const key = `${ruleId}\0${e.decision.source}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { rule_id: ruleId, source: e.decision.source, acc: { asked: 0, approved: 0, approved_failed: 0, rejected: 0, unknown: 0, pending: 0 } };
      groups.set(key, g);
    }
    tally(g.acc, e);
  }

  const rows: StatsRow[] = [...groups.values()]
    .map((g) => ({ rule_id: g.rule_id, source: g.source, ...g.acc }))
    .sort((a, b) => b.asked - a.asked || a.rule_id.localeCompare(b.rule_id) || a.source.localeCompare(b.source));

  return { total: entries.length, by_verdict: byVerdict, with_hook: withHook, ...totalAcc, rows };
}
