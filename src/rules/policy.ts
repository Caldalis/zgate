// 仓库策略规则。`policy.scope` 在 RULES 末尾:同档先命中者胜,所以它只在没有别的 SOFT 命中时成为 rule_id,
// 从结构上保证"策略文本只在 policy.scope 是唯一理由时进 prompt"。
// `policy.self_write` 在 RULES 最前且不问模型:写策略文件的任何形态都直接问人。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { isInside } from "../enrichers/fs.ts";
import { t } from "../i18n.ts";
import { POLICY_FILENAME, loadPolicy, type Policy } from "../policy.ts";
import { commandLine, commandSegments } from "./cmdline.ts";
import { defineRule, type Rule } from "./index.ts";
import { baseName, redirectDestinations } from "./match.ts";

/**
 * 命中的 scope 条目,空数组表示不命中。read 不受约束。
 * 路径:目标的 resolved(realpath,或将被创建的位置)落在条目内,或目标是条目的祖先(删祖先就是删它)。
 * 文本:条目长度 ≥ 3 且命令原文小写后包含它 —— `psql -h prod-db.internal` 这类没有文件目标的调用靠它够到。
 */
export function scopeHits(action: Action, ctx: Context, policy: Policy): string[] {
  if (action.verb === "read") return [];
  const cmd = commandLine(action).toLowerCase();
  const hits: string[] = [];
  for (const s of policy.scope) {
    const byPath = s.paths.some((abs) =>
      ctx.resources.some((r) => r.resolved !== null && (isInside(abs, r.resolved) || isInside(r.resolved, abs))),
    );
    const byText = !byPath && cmd !== "" && s.entry.length >= 3 && cmd.includes(s.entry.toLowerCase());
    if (byPath || byText) hits.push(s.entry);
  }
  return hits;
}

function clip(s: string, max = 30): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const scopeRule = defineRule({
  id: "policy.scope",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null || ctx.repo.root === null) return null;
    const policy = loadPolicy(ctx.repo.root);
    if (policy === null) return null;
    const hits = scopeHits(action, ctx, policy);
    if (hits.length === 0) return null;
    const entry = clip(hits[0] ?? "");
    return t(`触及策略保护范围 ${entry}`, `inside policy-protected scope ${entry}`);
  },
});

/**
 * agent 改策略文件:SOFT 不 HARD_DENY —— 让 agent 起草策略是正当场景,策略被改的最坏结果只是回到无策略。
 * 但这条不问模型(skipModel):策略文本按设计不给模型看,零样本模型不知道 `.zgatepolicy` 是权限策略,
 * 会把"往点文件追加一行"当日常放行;全自动模式下 agent 改掉自己的边界再删东西就是两步绕过。
 * 文件名按小写比:macOS 的文件系统不分大小写,`.ZGATEPOLICY` 写的是同一个文件。
 */
const selfWrite = defineRule({
  id: "policy.self_write",
  stage: "pre",
  verdict: "SOFT",
  skipModel: true,
  match(action: Action): string | null {
    const candidates = action.verb === "write" || action.verb === "delete" ? action.targets.map((t) => t.raw) : [];
    for (const seg of commandSegments(action)) candidates.push(...redirectDestinations(seg));
    for (const raw of candidates) {
      if (baseName(raw).toLowerCase() === POLICY_FILENAME) return t("修改仓库策略文件", "modifies the repo policy file");
    }
    return null;
  },
});

export const POLICY_PRE_RULES: readonly Rule[] = [selfWrite];
export const POLICY_POST_RULES: readonly Rule[] = [scopeRule];
export const POLICY_RULES: readonly Rule[] = [...POLICY_PRE_RULES, ...POLICY_POST_RULES];
