// SPEC.md §6 —— `fs` 探针:文件真实属性。
//
// 这一层的存在理由,是 §12 那两条核心 golden case:
//
//   rm -rf ./build  →  build 是普通目录        → allow
//   rm -rf ./build  →  build 是软链接指向仓库外 → ask
//
// 同一条命令,不同环境,不同结论。答案不在命令字符串里,所以必须在
// 规则层之外、用真实的文件系统回答。
//
// 三条硬约束(§6):
//   - 用**同步** API。单次 stat 的 promise 开销大于系统调用本身
//   - 不读文件内容,不递归遍历目录
//   - `realpathSync` 对不存在的路径会抛,用 try/catch 回落 exists: false

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * cwd 的规范化缓存。
 *
 * 为什么要缓存:cwd 在规则层和探针之间被反复比较,**必须**是规范路径
 * (见 factsFor 里的说明),而 realpath 是一次真实 syscall。cwd 在一次
 * session 里几乎不变,所以按 cwd 缓存、TTL 与 git 探针一致(3 秒)即可。
 *
 * 不设容量上限,但加一个粗暴的清理:超过 256 个 key 就整个清掉。
 * 一个 daemon 同时服务几十个 cwd 已经算多了,这个阈值实际不会触发。
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
 * 判断 `child` 是否落在 `parent` 子树内。
 *
 * 用路径**分段**比较而不是 `startsWith`:后者会把 `/repo-other` 判成
 * `/repo` 的子项,一个纯粹的前缀巧合就能让一次越界删除看起来正常。
 *
 * 两个入参都必须是已 realpath 的绝对路径 —— 这个函数不做 resolve,
 * 否则 `..` 和软链接又会被重新引入,前功尽弃。
 */
export function isInside(parent: string, child: string): boolean {
  if (parent === "" || child === "") return false;
  if (child === parent) return true;
  const root = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(root);
}

/**
 * 一个 target 的 facts。
 *
 * `inside_repo` 需要仓库根,所以它是入参而不是在这里算 —— 仓库根由 git
 * 探针负责,两个探针之间不做交叉调用(那会变成顺序耦合)。
 */
/**
 * 不存在的路径的**预期落点**:找最近一个能 realpath 成功的祖先目录,对它
 * realpath(折叠掉沿途的软链接),再把中途跳过的不存在部分拼回去。
 *
 * 为什么要它(D12.11):`cp key /elsewhere/new` 里目标还不存在,realpath 会抛,
 * `resolved` 只能是 null,于是 `inside_cwd` 无从判断 —— 往 cwd 外写一个新文件
 * 就静默放行了。有了预期落点,`inside_cwd` 对"还没创建的目标"也能算,规则层
 * 就能问"这个文件会落在 cwd 里还是外面"。
 *
 * 根目录一定存在,循环一定终止(到根还 realpath 不了才返回 null,几乎不可能)。
 * 祖先里若有软链接,realpath 会把它折叠进真实那棵树,`echo x > ./build/new`
 * 里 build 指向外部也能判出越界。
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

function factsFor(raw: string, cwd: string, repoRoot: string | null): ResourceFacts {
  // 相对路径按 cwd 解析。
  const joined = isAbsolute(raw) ? raw : resolve(cwd, raw);

  let exists = false;
  let isSymlink = false;
  let isDir = false;
  let symlinkTarget: string | null = null;
  let resolved: string | null = null;

  try {
    // lstat 先看**链接本身**:realpath 会把软链接折叠掉,折叠之后就再也
    // 看不出"这条路径是个链接"了,而那正是本探针最要紧的一个字段。
    const lst = lstatSync(joined);
    isSymlink = lst.isSymbolicLink();
    if (isSymlink) {
      // readlink 只给链接的**字面**内容(通常相对),不是解析后的绝对路径。
      const link = readlinkSync(joined);
      symlinkTarget = isAbsolute(link) ? link : resolve(joined, "..", link);
    }
    exists = true;

    // realpath 一次给出"最终落到哪里 + 最终是不是目录"。
    // 悬空软链接会在这里抛(ENOENT),于是 exists 保持 true 而 resolved
    // 保持 null —— 那是最诚实的描述:链接在,目标不在。
    resolved = realpathSync(joined);
    isDir = statSync(resolved).isDirectory();
  } catch {
    // 走到这里有两种可能:路径不存在,或路径是悬空软链接。
    // 前者 exists 保持 false;后者 exists 已在上面置为 true、resolved 保持 null。
  }

  // 真正不存在的普通路径(不是悬空软链接 —— 那种 exists 是 true):算出它
  // 将被创建在哪里,填进 resolved,让 inside_cwd 对"越界写新文件"也能判
  // (D12.11)。这就是 exists:false 但 resolved 非 null 的那个新组合:
  // resolved 从此表示"目标的真实位置,或不存在时它将被创建的位置";
  // 东西到底在不在,看 exists,不要拿 resolved 是否为 null 去推。
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
    // resolved 为 null(悬空软链接 / url)时一律 false。不存在的普通路径
    // 现在带预期落点(见上),所以 inside_cwd 对它也是有意义的。
    //
    // 两边都必须是规范路径:cwd 由 git 探针传给 fs 探针时已经 realpath 过
    // (见 git.ts 的 canonicalize),resolved 本身就是 realpathSync 的结果。
    // 一边规范化一边不规范化,比的会是两棵不同的树。
    inside_cwd: resolved !== null && isInside(cwd, resolved),
    inside_repo: resolved !== null && repoRoot !== null && isInside(repoRoot, resolved),
    // §6 没要求算 gitignore,而且这需要 git 子进程或一份完整的 ignore 解析器。
    // 恒为 null = 未知,规则层不该拿它做判断。
    gitignored: null,
  };
}

/**
 * 对所有 target 产出 facts。
 *
 * `url` / `kind: "unknown"` 直接跳过:它们不是文件系统对象,对它们调
 * lstat 只会白拿一次 ENOENT。跳过的条目**不出现在结果数组里** ——
 * 让"资源列表"和"文件系统事实列表"等长且一一对应,规则层才好按下标配对。
 * (规则层如果按 index 配对,那条约定就必须成立;见 D7.4。)
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
