// SPEC.md §5 / §11 —— M1 唯一的模型后端实现。
//
// 它**恒返回 null**,也就是"模型不可用" —— §3.2 的表里右列。
// M1 的行为就是那一列,所以这个类不是占位符,它就是 M1 的模型层。
//
// 名字叫 `null` 而不是 `noop`:调用方拿到的语义是"没有可用模型",
// 而不是"模型说没问题"。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import type { ModelBackend, ModelVerdict } from "./index.ts";

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
