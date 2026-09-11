// SPEC.md §7 —— 解析子系统的对外入口。
//
// 现在由 AST 路径实现(walker.ts)。手写状态机保留在 legacy.ts,
// 只作为差分测试的参照实现 —— 它不再被生产代码调用。
//
// 保留 legacy 的理由:它是**独立写出来**的第二实现。两份实现用同一批
// 语料和测试对撞,差异就是信号。等差分连续稳定(并且有真实 journal
// 数据兜底)之后再删。见 DECISIONS 的 D5.x。

export type { ResourceSpec } from "./classify.ts";
export { walkToCommands as parseCommand } from "./walker.ts";
export type { ShellCommand } from "./walker.ts";

/** 差分测试专用:手写版实现。生产代码不要 import 这个。 */
export { parseCommand as parseCommandLegacy } from "./legacy.ts";
