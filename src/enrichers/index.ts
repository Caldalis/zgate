// SPEC.md §6 —— 环境探针(enrichers)。
//
// 探针只做一件事:把**命令行里没有的信息**取出来。§3 把 enrich 排在 rules
// 之后,就是因为这部分贵 —— 大部分调用拿 Action 就能定性,不该为它们付出
// 文件系统探测的代价。所以边界是:
//
//   - 目标列表为空 ⇒ 一次 syscall 都不发
//   - 只有 §6 点名的两个探针,不做"可插拔探针框架"(§1 的最后一颗子弹)
//   - 全同步 API(理由见 fs.ts 顶部)
//
// 顺序上 git 先于 fs:fs 需要仓库根来填 `inside_repo`。这个依赖是单向的,
// 反过来不成立(git 探针不需要知道有哪些 target)。

import type { Resource } from "../core/action.ts";
import type { ResourceFacts, RepoFacts } from "../core/context.ts";
import { canonicalCwd, fsFacts } from "./fs.ts";
import { gitFacts } from "./git.ts";

export { fsFacts } from "./fs.ts";
export { gitFacts, clearGitCache } from "./git.ts";
export { isInside, canonicalCwd, clearCwdCache } from "./fs.ts";

/**
 * 白名单环境变量(§6)。
 *
 * 前三个只取**存在性**(布尔字符串)而不是值:它们能泄露工作站路径,
 * 而决策只需要知道"在不在 CI 里"。`TERM_PROGRAM` 例外 —— 值本身短且无
 * 信息量,但它是判别 agent 宿主的有用信号。
 *
 * 其余环境变量一律不进日志。这是硬约束,不是"暂时先这样"。
 */
const ENV_EXISTENCE = ["CI", "GIT_DIR", "VIRTUAL_ENV"] as const;
const ENV_VALUE = ["TERM_PROGRAM"] as const;

export function envHints(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_EXISTENCE) {
    const v = env[name];
    out[name] = v === undefined || v === "" ? "false" : "true";
  }
  for (const name of ENV_VALUE) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

export interface EnrichResult {
  readonly resources: ResourceFacts[];
  readonly repo: RepoFacts;
  readonly env_hints: Record<string, string>;
  readonly elapsed_ms: number;
}

/**
 * 跑完全部探针,组装 §2.2 的 Context 字段(**不含** decision_id 那类
 * 管线级信息)。
 *
 * 之所以返回字段而不是直接返回 `Context`:`elapsed_ms` 的语义是"这次
 * enrich 花了多久",只有调用方知道计时该从哪里开始。管线负责补上它。
 */
export function enrich(
  targets: readonly Resource[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): EnrichResult {
  const started = performance.now();
  // 顺序:先规范化 cwd,再问 git,最后才碰文件系统。
  //
  // 规范化这一步不是洁癖:target 的 `resolved` 是 realpathSync 的结果,
  // 拿它和未规范化的 cwd 比子树是在比两棵不同的树。而两边一旦不一致,
  // `inside_cwd` / `inside_repo` 会**静默恒为 false** —— 对"删除目标在
  // 仓库外"这条规则来说,恒 false 就是恒放行。所以它是安全前提,不是精度。
  const base = canonicalCwd(cwd);
  const repo = gitFacts(cwd);

  // 文件系统探针只在真有文件目标时才跑。纯 network 调用(WebFetch)
  // 或者 `verb: "unknown"` 在这条路径上省下的就是纯利润。
  const resources = fsFacts(targets, base, repo.root);

  return {
    resources,
    repo,
    env_hints: envHints(env),
    elapsed_ms: performance.now() - started,
  };
}
