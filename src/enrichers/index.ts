// 环境探针:把命令行里没有的信息取出来。这部分贵,所以排在规则层之后,大部分调用拿 Action 就能定性。
//
//   - 只有 fs 与 git 两个探针,不做可插拔框架
//   - 没有文件目标时,fs 探针一次 syscall 都不发
//   - 全同步 API(理由见 fs.ts 顶部)
//
// git 先于 fs:fs 需要仓库根来填 `inside_repo`,反过来不需要。

import type { Resource } from "../core/action.ts";
import type { ResourceFacts, RepoFacts } from "../core/context.ts";
import { canonicalCwd, fsFacts } from "./fs.ts";
import { gitFacts } from "./git.ts";

export { fsFacts } from "./fs.ts";
export { gitFacts, clearGitCache } from "./git.ts";
export { isInside, canonicalCwd, clearCwdCache } from "./fs.ts";

/**
 * 白名单环境变量,其余一律不进日志。
 *
 * 前三个只取存在性("true" / "false"),不取值:值能泄露工作站路径,而决策只需要知道在不在 CI 里。
 * `TERM_PROGRAM` 取值:短且无敏感信息,是判别 agent 宿主的有用信号。
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

/** 跑完全部探针,组装 Context 的各字段。 */
export function enrich(
  targets: readonly Resource[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): EnrichResult {
  const started = performance.now();
  // 先规范化 cwd,再问 git,最后才碰文件系统。
  // cwd 必须规范化:target 的 resolved 是 realpath 的结果,拿它和未规范化的 cwd 比子树,
  // inside_cwd / inside_repo 会静默恒为 false。这是正确性前提,不是精度问题。
  const base = canonicalCwd(cwd);
  const repo = gitFacts(cwd);

  // fs 探针只对文件目标发 syscall,url / unknown 目标直接跳过
  const resources = fsFacts(targets, base, repo.root);

  return {
    resources,
    repo,
    env_hints: envHints(env),
    elapsed_ms: performance.now() - started,
  };
}
