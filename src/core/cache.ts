// SPEC.md §3.1 —— 缓存。
//
// 一个 Map + 时间戳,没有别的。§3.1 明确说不许引入 LRU 库。
//
// ## 缓存的是"整个规则段的结论",不是 pre 轮(踩过一次,记下来)
//
// 第一版只缓存 pre 轮,理由是"post 轮依赖文件系统的当前状态,缓存会吃掉
// 环境变化"。实测之后这个理由站不住(见 D9.2):
//
//   pre 轮规则          p50 = 0.0014ms
//   enrich(2 个目标)    p50 = 0.0194ms   ← 大 14 倍
//
// 只缓存 pre 轮,省下的是**便宜的那一半**,贵的那一半(enrich 与 post 轮)
// 照跑。更糟的是 `source` 只能填 `cache`,而实际结论是 post 轮现算的 ——
// 那是在撒谎,日志里的 `source` 字段直接失去意义。
//
// §3.1 的原话是"只缓存 `source === rule` 的结果" —— 也就是规则层的
// 结论,包括依赖环境的那些。60 秒的 TTL 就是规格对陈旧度的答案。
//
// ## 缓存的是"裁决",不是"决策"
//
// Decision 里有 `latency_ms`、`decision_id`、`source` —— 这三个每次都必须
// 不一样。缓存的是规则层产出的 `RuleHit`(verdict / rule_id / reason),
// 连同产出它时看到的 Context;外壳由管线每次重新构造。缓存整个 Decision
// 会让日志里出现重复的 decision_id,那是不可接受的数据污染(§9 是命脉)。
//
// 为什么连 Context 一起存:§9 要求每条日志带 Context。命中缓存的那次决策
// 没有重新探测,它依据的**就是**缓存里那份 Context —— 把它记进日志才是
// 实话;记 null 会让"缓存命中"这一大类样本在训练数据里全部失去环境信息。
// pre 轮 HARD_DENY 本来就没探测,那时 context 为 null(D11.1)。

import type { Action } from "./action.ts";
import type { Context } from "./context.ts";
import type { ModelDecision } from "./model.ts";
import type { RuleHit } from "../rules/index.ts";

/**
 * TTL 60 秒(§3.1 指定)。
 *
 * 这个数字同时决定了**陈旧度**:`rm -rf ./build` 在 build 是普通目录时
 * 判了 allow,60 秒内即使 build 被换成指向生产目录的软链接,仍会 allow。
 *
 * 接受这个代价的理由:换链接这个动作本身要经过网关 ——
 * `ln -sf /srv/prod ./build` 会先被判一次并留下日志。所以窗口内的
 * 陈旧不是"环境偷偷变了而我们没看见",而是"用户刚做的改动还没被复查"。
 * 缩短 TTL 会让缓存失去意义(一次工具调用连发的爆发跨不了 60 秒),
 * 加长就接近"忽略环境变化"。
 */
const TTL_MS = 60_000;

/**
 * 容量上限。§3.1 没提,但一个跑一整天、服务几十个 cwd 的 daemon 必须有上界。
 *
 * 满了就**整个清空**,不做 LRU:2000 条在真实分布下不会触发,触发时
 * 的代价只是接下来几秒命中率低一点。写 LRU 是为不存在的场景增加一份
 * 需要测试的代码。
 */
const MAX_ENTRIES = 2000;

/** 缓存里的一项:规则段的裁决,以及产出它时看到的 Context。 */
export interface CachedStage {
  readonly hit: RuleHit;
  /** pre 轮判死时为 null —— 那条路没探测,不存在 Context。 */
  readonly context: Context | null;
  /** §3.1:M2 起模型的结论也缓存。只有 SOFT 且模型判过才有;失败不缓存 */
  readonly model: ModelDecision | null;
}

interface Entry extends CachedStage {
  readonly at: number;
}

const store = new Map<string, Entry>();

/**
 * 缓存 key。
 *
 * §3.1 给的公式是 `hash(verb, targets[].raw, command, cwd, repo.branch)`。
 * 这里有三处**有意的偏离**,都记在 D9.3:
 *
 *   1. 用 `tool_input.command` 的原文代替 `command`。§2.1 的 `command`
 *      字段只在 `verb === "exec"` 时有值,而规则层会读原文(D8.2)——
 *      只按原公式,两条原文不同、verb 相同的命令会撞成同一个 key。
 *   2. 加 `tool_name`。同样的 verb 从不同工具来,规则层可见的信息不同。
 *   3. `branch` 由调用方作为 `salt` 传进来(见 `keyOf` 的第二个参数)。
 *      分支是最会改变结论的环境因素(`git push --force` 在 main 上是
 *      deny、在 feature 上是 allow),它必须在查缓存之前就有。
 *
 * 用 `\0` 分隔而不是 `|`:`|` 是命令里极常见的字符(`cat a | grep b`),
 * 拿它当分隔符会让 `["a|b", "c"]` 和 `["a", "b|c"]` 撞 key。
 * NUL 不可能出现在 shell 命令里。**写成转义 `"\0"`,不要写字面 NUL 字节**:
 * 字面 NUL 会让 git 把整个文件当二进制,diff / blame 全部失效(D12.5)。
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
 * 查。过期条目在读到时顺手删掉 —— **惰性淘汰**,不起定时器。
 *
 * 定时器会让 daemon 永远有一个待触发的回调,而 Bun 的定时器在进程退出时
 * 会有边界行为(§9 那边的定时 flush 已经够了,多一个定时器就多一个
 * 要处理的东西)。
 *
 * `salt`:分支名。传空串表示不确定 —— 那会**跨分支**缓存命中,调用方
 * 只在明确不需要分支信息时(noCache 路径)这么传。
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

/** 测试 / 维护命令用。 */
export function clearCache(): void {
  store.clear();
}

export function cacheSize(): number {
  return store.size;
}

/** 暴露给测试:确认 TTL 确实是规格里的那个 60 秒。 */
export const CACHE_TTL_MS = TTL_MS;
