// SPEC.md §5 —— 模型层接口。
//
// **M1 只留位置,不实现。** §1 的不要做的事清单第一条就是"不要接入任何
// LLM"。这个文件的全部价值在于:当 M2 真的接上一个模型时,管线代码
// **一行都不用改** —— 只是 `BACKENDS["null"]` 换成 `BACKENDS["llama"]`。
//
// 为什么值得现在写:接口的形状决定了 M2 能不能接得上。等真接模型时
// 再设计接口,会不可避免地让模型的特异性渗进管线 —— 那时 §3.2 的
// 降级表就守不住了。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import type { Verdict } from "../core/decision.ts";

export interface ModelVerdict {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly confidence: number;
}

export interface ModelBackend {
  readonly name: string;
  /** 返回 null 表示不可用/超时,调用方按 §3.2 降级 */
  classify(
    action: Action,
    ctx: Context,
    timeoutMs: number,
  ): Promise<ModelVerdict | null>;
}

/**
 * M1 的唯一实现。
 *
 * 它**恒返回 null**,也就是"模型不可用" —— §3.2 的表里右列。
 * M1 的行为就是那一列,所以这个类不是占位符,它就是 M1 的模型层。
 *
 * 名字叫 `null` 而不是 `noop`:调用方拿到的语义是"没有可用模型",
 * 而不是"模型说没问题"。
 */
export class NullBackend implements ModelBackend {
  readonly name = "null";

  // eslint 风格上 async 无 await 会被嫌,但**必须**是 async:
  // §5 的接口是 `Promise<ModelVerdict | null>`,同步实现会破坏 M2
  // 的替换性(同步函数可以伪装成异步,反过来不行)。
  async classify(
    _action: Action,
    _ctx: Context,
    _timeoutMs: number,
  ): Promise<ModelVerdict | null> {
    return null;
  }
}

/**
 * 注册表。§5 的硬约束:**管线代码里不允许出现任何 backend 的具体名字**,
 * 只能通过 `BACKENDS[config.backend]` 取。
 *
 * 为什么这条约束值得写进规格:一旦管线里出现 `new NullBackend()`,
 * M2 接模型时就要改管线,而改管线意味着 §3.2 的降级路径也要重新验证。
 * 让"选哪个后端"只发生在一个查表的地方,降级逻辑就只需要证明一次。
 */
export const BACKENDS: Record<string, () => ModelBackend> = {
  null: () => new NullBackend(),
};
