// SPEC.md §6 —— `git` 探针:仓库状态。
//
// §6 说这是延迟风险最大的地方,理由是:起一个 `git` 子进程要 20–50ms,
// 而 §13 的 p50 预算是 5ms。一个 `git rev-parse` 就能把整个项目的核心
// 指标打穿。所以这里**一个子进程都不起**。
//
// 三件事全靠读文件:
//   - 仓库根:向上找 `.git`(目录或文件,后者是 worktree / submodule)
//   - 分支名:`<gitdir>/HEAD` 里的 `ref: refs/heads/xxx`
//   - 默认分支:`<commondir>/refs/remotes/origin/HEAD`,读不到去 packed-refs 翻
//
// 代价是拿不到"上游有没有新提交"这类需要网络的信息 —— 但那些本来也不该
// 在决策路径上花。

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RepoFacts } from "../core/context.ts";

/**
 * 仓库根的缓存 TTL(§6 指定 3 秒)。
 *
 * 为什么需要缓存:cwd 在一次 session 里几乎不变,而向上找 `.git` 是
 * 每个 Action 一次。3 秒是个折中 —— 长到能覆盖一次工具调用连发的爆发,
 * 短到用户 `git init` 之后不用重启 daemon。
 */
const CACHE_TTL_MS = 3000;

/** 向上找 `.git` 的层数上限。防符号链接成环时死循环。 */
const MAX_WALK_UP = 64;

interface CacheEntry {
  readonly at: number;
  readonly facts: RepoFacts;
}

const cache = new Map<string, CacheEntry>();

/** 测试用:清缓存,让每个 case 从零开始。 */
export function clearGitCache(): void {
  cache.clear();
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * 把 `/tmp/x` 这种路径折叠成 `/private/tmp/x`。
 *
 * 为什么必须有这一步:`fs` 探针的 `resolved` 是 `realpathSync` 的结果
 * (规范路径),如果拿它去和未规范化的 `cwd` / `root` 比子树,比的是
 * **两棵不同的树**,结果恒定 false —— `inside_cwd` 和 `inside_repo`
 * 会静默失效,而规则层正是靠这两个字段判"目标在不在仓库里"。
 * 失效方向是 fail-open,所以这不是精度问题,是安全洞。
 *
 * 路径不存在时 realpath 会抛,回落到原值:宁可留着未规范化的路径,
 * 也不要因为折叠失败而丢掉整个仓库判断。
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 从 cwd 向上找 `.git`。
 *
 * 返回 gitdir 的绝对路径(对 worktree 是 `.git` 文件里指向的那个目录),
 * 以及仓库**工作区**根 —— 后者是 `inside_repo` 的判据,必须是工作区而不是
 * gitdir:在 worktree 里两者隔着整个文件系统。
 */
function findRepo(cwd: string): { worktree: string; gitdir: string } | null {
  let dir = canonicalize(cwd);
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const candidate = join(dir, ".git");
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return { worktree: dir, gitdir: candidate };
      if (st.isFile()) {
        // worktree / submodule:.git 是个文件,内容是 `gitdir: <path>`
        const text = readText(candidate);
        const m = text === null ? null : /^gitdir:\s*(.+)$/m.exec(text);
        const raw = m?.[1]?.trim();
        if (raw === undefined) return null;
        const gitdir = isAbsolute(raw) ? raw : resolve(dir, raw);
        return { worktree: dir, gitdir: canonicalize(gitdir) };
      }
    } catch {
      // 不存在,继续往上
    }
    const up = dirname(dir);
    if (up === dir) break; // 到根了
    // ★ 逐级 realpath,不是只对起点做一次。
    // 中途任何一层是软链接(最典型的是 macOS 的 `/tmp` → `/private/tmp`),
    // 折叠后就不能直接拼 `.git` 去找了 —— 拼出来的路径在**另一棵**树里。
    // 这不是理论问题:落进 macOS tmpdir 的仓库全都命中。
    dir = canonicalize(up);
  }
  return null;
}

/**
 * 读一个引用。先看松散引用文件,再翻 packed-refs。
 *
 * packed-refs 里查找必须整行锚定:它是**有序表**,`refs/heads/x` 是
 * `refs/heads/xy` 的前缀,不做锚定就会张冠李戴。
 */
function readRef(gitdir: string, ref: string): string | null {
  const loose = readText(join(gitdir, ref));
  if (loose !== null) return loose.trim();

  const packed = readText(join(gitdir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    if (line.slice(sp + 1).trim() === ref) return line.slice(0, sp).trim();
  }
  return null;
}

/** `ref: refs/heads/main` → `main`;detached(直接是 sha)→ null。 */
function branchFromHead(text: string): string | null {
  const t = text.trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(t);
  return m?.[1] ?? null;
}

/** `refs/remotes/origin/main` → `main`。 */
function branchFromRemoteHead(text: string): string | null {
  const t = text.trim();
  const m = /^ref:\s*refs\/remotes\/[^/]+\/(.+)$/.exec(t);
  return m?.[1] ?? null;
}

function repoFacts(cwd: string): RepoFacts {
  const found = findRepo(cwd);
  if (found === null) {
    return {
      is_repo: false,
      root: null,
      branch: null,
      is_dirty: null,
      default_branch: null,
    };
  }

  // worktree 的 HEAD 在自己的 gitdir 里,但 refs/remotes 往往在 commondir。
  // 读不到 commondir 就回落到 gitdir —— 对普通仓库两者是同一个目录。
  const commonRaw = readText(join(found.gitdir, "commondir"));
  const commondir =
    commonRaw === null ? found.gitdir : resolve(found.gitdir, commonRaw.trim());

  const head = readText(join(found.gitdir, "HEAD"));
  const branch = head === null ? null : branchFromHead(head);

  // `refs/remotes/origin/HEAD` 是符号引用,内容形如 `ref: refs/remotes/origin/main`。
  // 有些环境下它是真实 ref(直接存 sha),那解析不出分支名 → null。
  //
  // origin/HEAD 不存在时(没 clone、没 `git remote set-head`)不去猜
  // `main` 还是 `master`:猜错会让"在默认分支上 push --force"这条规则
  // **漏判**,而返回 null 只是退回 SOFT。方向不对称,所以宁可返回 null。
  const remoteRef = readRef(commondir, "refs/remotes/origin/HEAD");
  const defaultBranch = remoteRef === null ? null : branchFromRemoteHead(remoteRef);

  return {
    is_repo: true,
    root: found.worktree,
    branch,
    // §6 明说:M1 恒为 null,不要为它跑 `git status`。
    is_dirty: null,
    default_branch: defaultBranch,
  };
}

/** 带 TTL 缓存的入口。key 是 cwd,不是 Action —— 同一 cwd 的调用共享一次探测。 */
export function gitFacts(cwd: string): RepoFacts {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.facts;

  const facts = repoFacts(cwd);
  cache.set(cwd, { at: now, facts });
  return facts;
}
