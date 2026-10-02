// 规则段结论的缓存:一个 Map + 时间戳,不引入 LRU 库。
//
// 缓存的是整个规则段(pre + enrich + post)的结论,包括依赖环境的那些:pre 轮本来就便宜,
// 贵的是 enrich;只缓存 pre 轮时 source 记 cache、结论却是现算的,日志会失真。
// 环境的陈旧度由 TTL 兜住,见 TTL_MS。
//
// 存的是 RuleHit 和产出它时看到的 Context,不是整个 Decision:latency_ms / decision_id / source
// 每次都要新的,重复的 decision_id 会污染日志。命中缓存的决策依据的就是那份 Context,
// 日志要如实记下它;pre 轮 HARD_DENY 没探测,context 为 null。

import type { Action } from "./action.ts";
import type { Context } from "./context.ts";
import type { ModelDecision } from "./model.ts";
import type { RuleHit } from "../rules/index.ts";

/**
 * TTL 60 秒,也是陈旧度上限:`rm -rf ./build` 在 build 是普通目录时判了 allow,
 * 60 秒内 build 被换成指向生产目录的软链接仍会 allow。
 *
 * 可以接受:换链接本身(`ln -sf /srv/prod ./build`)也要经过网关、留下日志。
 * 缩短 TTL 缓存就失去意义,加长就接近忽略环境变化。
 */
const TTL_MS = 60_000;

/**
 * 容量上限:daemon 跑一整天、服务几十个 cwd,必须有上界。
 * 满了整个清空,不做 LRU:真实分布下 2000 条触发不了,触发的代价只是接下来几秒命中率低一点。
 */
const MAX_ENTRIES = 2000;

/** 缓存里的一项:规则段的裁决,以及产出它时看到的 Context。 */
export interface CachedStage {
  readonly hit: RuleHit;
  /** pre 轮判死时为 null —— 那条路没探测,不存在 Context。 */
  readonly context: Context | null;
  /** 模型结论随同一条缓存。只有 SOFT 且模型判过才有;失败不缓存 */
  readonly model: ModelDecision | null;
}

interface Entry extends CachedStage {
  readonly at: number;
}

const store = new Map<string, Entry>();

/**
 * 缓存 key:verb、cwd、tool_name、salt、命令原文、command、各 target 的 kind / raw。
 *
 *   - 带 `tool_input.command` 原文:`command` 只在 exec 时有值,而规则层会读原文,
 *     不带它的话两条原文不同、verb 相同的命令会撞 key。
 *   - 带 `tool_name`:同样的 verb 从不同工具来,规则层可见的信息不同。
 *   - `salt` 是分支名,由调用方传入:分支最会改变结论(`git push --force` 在 main 上 deny、
 *     在 feature 上 allow),查缓存之前就要有。
 *
 * 用 `\0` 分隔而不是 `|`:`|` 在命令里极常见,会让 `["a|b", "c"]` 和 `["a", "b|c"]` 撞 key。
 * 写成转义 `"\0"`,不要写字面 NUL 字节:那会让 git 把整个文件当二进制。
 */
function keyOf(action: Action, salt: string): string {
  const parts: string[] = [
    action.verb,
    action.cwd,
    action.tool_name,
    salt,
    String(action.tool_input["command"] ?? ""),
    action.command ?? "",
  ];
  for (const t of action.targets) {
    parts.push(t.kind, t.raw);
  }
  return parts.join("\0");
}

/**
 * 查。过期条目在读到时顺手删掉(惰性淘汰),不起定时器。
 * `salt` 是分支名(有策略时再拼策略 sha);空串表示不区分分支。
 */
export function getCached(action: Action, salt = ""): CachedStage | null {
  const key = keyOf(action, salt);
  const e = store.get(key);
  if (e === undefined) return null;
  if (Date.now() - e.at >= TTL_MS) {
    store.delete(key);
    return null;
  }
  return { hit: e.hit, context: e.context, model: e.model };
}

/** 存。由管线在规则段出结论后调用。`context` 为 null 只在 pre 轮判死时出现。 */
export function setCached(
  action: Action,
  hit: RuleHit,
  context: Context | null = null,
  salt = "",
): void {
  if (store.size >= MAX_ENTRIES) store.clear();
  store.set(keyOf(action, salt), { at: Date.now(), hit, context, model: null });
}

/** 模型判完后挂到已有条目上;条目已过期或被清掉就算了(不延长 TTL)。 */
export function setCachedModel(action: Action, salt: string, model: ModelDecision): void {
  const key = keyOf(action, salt);
  const e = store.get(key);
  if (e !== undefined) store.set(key, { ...e, model });
}

/** 批内识别逐字相同的段,用同一把 key。 */
export const stageKey = keyOf;

/** 测试 / 维护命令用。 */
export function clearCache(): void {
  store.clear();
}

export function cacheSize(): number {
  return store.size;
}

/** 暴露给测试。 */
export const CACHE_TTL_MS = TTL_MS;
