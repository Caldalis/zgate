// shell 解析的对外入口,由 AST 路径(walker.ts)实现。
// legacy.ts 是独立写出来的手写版,只作差分测试的参照:两份实现用同一批语料对撞,差异就是信号。
// 等差分持续稳定、有真实 journal 数据兜底后再删。

export type { ResourceSpec } from "./classify.ts";
export { walkToCommands as parseCommand } from "./walker.ts";
export type { ShellCommand } from "./walker.ts";

/** 差分测试专用:手写版实现。生产代码不要 import 这个。 */
export { parseCommand as parseCommandLegacy } from "./legacy.ts";
