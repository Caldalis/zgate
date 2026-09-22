// SPEC.md §5 —— 模型层接口。
//
// **M1 只留位置,不实现。** §1 的不要做的事清单第一条就是"不要接入任何
// LLM"。这个文件的全部价值在于:当 M2 真的接上一个模型时,管线代码
// **一行都不用改** —— 只是 `BACKENDS["null"]` 换成 `BACKENDS["llama"]`。
//
// 为什么值得现在写:接口的形状决定了 M2 能不能接得上。等真接模型时
// 再设计接口,会不可避免地让模型的特异性渗进管线 —— 那时 §3.2 的
// 降级表就守不住了。
//
// 实现按 §11 的目录一个文件一个:M1 只有 null.ts。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import type { Verdict } from "../core/decision.ts";
import { NullBackend } from "./null.ts";

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

export { NullBackend };

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
