// fs 探针:目标的真实文件属性。
//
// 同一条 `rm -rf ./build`,build 是普通目录 → allow,是指向仓库外的软链接 → ask。
// 答案不在命令字符串里,只能用真实的文件系统回答。
//
// 约束:
//   - 用同步 API:单次 stat 的 promise 开销大于系统调用本身
//   - 不读文件内容,不递归遍历目录
//   - `realpathSync` 对不存在的路径会抛,用 try/catch 回落

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * cwd 的规范化缓存。cwd 要和 realpath 过的目标反复比较,必须是规范路径,而 realpath 是一次真实 syscall;
 * cwd 在一次 session 里几乎不变,所以按 cwd 缓存,TTL 与 git 探针一致(3 秒)。超过 256 个 key 就整个清掉。
 */
const CWD_CACHE_TTL_MS = 3000;
const CWD_CACHE_MAX = 256;
const cwdCache = new Map<string, { at: number; path: string }>();

export function canonicalCwd(cwd: string): string {
  const now = Date.now();
  const hit = cwdCache.get(cwd);
  if (hit !== undefined && now - hit.at < CWD_CACHE_TTL_MS) return hit.path;

  let path: string;
  try {
    path = realpathSync(cwd);
  } catch {
    // cwd 不存在(agent 报了个已经删掉的目录)。留着原值,后面的
    // exists check 会各自失败,方向是保守的。
    path = cwd;
  }
  if (cwdCache.size >= CWD_CACHE_MAX) cwdCache.clear();
  cwdCache.set(cwd, { at: now, path });
  return path;
}

/** 测试用:清规范化缓存。 */
export function clearCwdCache(): void {
  cwdCache.clear();
}

import type { Resource } from "../core/action.ts";
import type { ResourceFacts } from "../core/context.ts";

/**
 * `child` 是否落在 `parent` 子树内。按路径分段比,不用裸 startsWith:后者会把 `/repo-other` 判成 `/repo` 的子项。
 * 两个入参都必须是已 realpath 的绝对路径;这里不做 resolve,否则 `..` 和软链接又会被引入。
 */
export function isInside(parent: string, child: string): boolean {
  if (parent === "" || child === "") return false;
  if (child === parent) return true;
  const root = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(root);
}

/**
 * 不存在的路径的预期落点:找最近一个能 realpath 成功的祖先,对它 realpath(折叠沿途的软链接),
 * 再把跳过的不存在部分拼回去。这样 `inside_cwd` 对还没创建的目标也能算,往 cwd 外写新文件不会静默放行;
 * 祖先里的软链接也被折叠,`echo x > ./build/new` 里 build 指向外部同样能判出越界。
 * 根目录一定存在,循环一定终止(到根还 realpath 不了才返回 null)。
 */
function projectPath(joined: string): string | null {
  const tail: string[] = [];
  let dir = joined;
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    tail.push(basename(dir));
    dir = parent;
    try {
      return join(realpathSync(dir), ...tail.reverse());
    } catch {
      // 这一层也不存在,继续往上找
    }
  }
}

/** 一个 target 的 facts。仓库根由 git 探针给出、作为入参传入,两个探针之间不交叉调用。 */
function factsFor(raw: string, cwd: string, repoRoot: string | null): ResourceFacts {
  // 相对路径按 cwd 解析。
  const joined = isAbsolute(raw) ? raw : resolve(cwd, raw);

  let exists = false;
  let isSymlink = false;
  let isDir = false;
  let symlinkTarget: string | null = null;
  let resolved: string | null = null;

  try {
    // lstat 先看链接本身:realpath 会把软链接折叠掉,之后就看不出它是链接了。
    const lst = lstatSync(joined);
    isSymlink = lst.isSymbolicLink();
    if (isSymlink) {
      // readlink 只给链接的字面内容(通常相对),不是解析后的绝对路径。
      const link = readlinkSync(joined);
      symlinkTarget = isAbsolute(link) ? link : resolve(joined, "..", link);
    }
    exists = true;

    // 悬空软链接在这里抛(ENOENT):exists 为 true、resolved 为 null,即链接在、目标不在。
    resolved = realpathSync(joined);
    isDir = statSync(resolved).isDirectory();
  } catch {
    // 路径不存在(exists 为 false),或悬空软链接(exists 已为 true、resolved 为 null)。
  }

  // 不存在的普通路径:resolved 填它将被创建的位置。所以 resolved 表示"真实位置,或将被创建的位置",
  // 东西在不在看 exists,不要拿 resolved 是否为 null 去推。
  if (!exists) {
    resolved = projectPath(joined);
  }

  return {
    raw,
    resolved,
    exists,
    is_symlink: isSymlink,
    symlink_target: symlinkTarget,
    is_dir: isDir,
    // resolved 为 null 时一律 false。两边都是规范路径:cwd 经过 canonicalCwd,resolved 来自 realpath。
    inside_cwd: resolved !== null && isInside(cwd, resolved),
    inside_repo: resolved !== null && repoRoot !== null && isInside(repoRoot, resolved),
    // 算 gitignore 需要 git 子进程或完整的 ignore 解析器,不做。恒为 null = 未知,规则层不该拿它做判断。
    gitignored: null,
  };
}

/**
 * 对文件目标产出 facts。`url` / `kind: "unknown"` 跳过且不出现在结果里:对它们 lstat 只会白拿一次 ENOENT。
 * 所以结果与过滤后的文件目标一一对应(顺序相同),不与 action.targets 等长;按下标配对前要先过滤。
 */
export function fsFacts(
  targets: readonly Resource[],
  cwd: string,
  repoRoot: string | null = null,
): ResourceFacts[] {
  const out: ResourceFacts[] = [];
  for (const t of targets) {
    if (t.kind === "url" || t.kind === "unknown") continue;
    out.push(factsFor(t.raw, cwd, repoRoot));
  }
  return out;
}
