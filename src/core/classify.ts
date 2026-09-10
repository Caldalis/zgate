// SPEC.md §7 —— 「命令语义」层:一条命令叫什么、该算什么 verb、哪些参数是目标。
//
// 为什么单独一层(见 DECISIONS.md 的 D3.x):
//   shell.ts 只回答**句法**问题 —— 这里面有几条命令、各自什么词、怎么重定向、
//   哪些 token 是选项哪些是操作数。那是 shell 文法,封闭、可枚举。
//      而「rm 是删除」「git push 是 network」「find -delete 是删除」不是文法,
//   是**每条命令自己的语义**。它同样是封闭且确定的(有唯一正确答案),
//   所以不该留给模型层 —— 模型层管的是「答案不在命令字符串里」的那类问题
//   (项目简介:build 是不是软链、在不在 main、是不是生产库)。
//
//   分层的直接收益:以后换 AST 只换 shell.ts 那一层,本文件一行不改。
//   本文件是纯函数,输入「命令名 + 参数」,输出「verb + 目标规则」,没有任何状态。
//
// 本层不做的事:
//   - 不碰文件系统、不 spawn、不判断危险与否
//   - 不展开变量。命令名是 `$CMD` 时只能老实说"不知道",交给 exec/规则层

import type { Verb } from "./action.ts";

/** 一个待裁决的资源。`raw` 是 agent 给的原始字符串,本层绝不规范化。 */
export interface ResourceSpec {
  readonly kind: "file" | "dir" | "url" | "unknown";
  readonly raw: string;
}

/**
 * 位置参数的取法。这是参数文法的一部分,但它由**命令自己的语义**决定
 * (grep 的第一个位置参数是模式,rm 的都是路径),所以放在本层。
 */
export type ArgRole =
  | "allArgs" // 所有非选项参数都是目标
  | "pathOnly" // 同上(留出语义差异的余地)
  | "grepLike" // 第一个非选项是模式,之后才是文件
  | "findPaths" // 到第一个表达式为止
  | "sedOperands"; // -i 时脚本是位置参数,文件在最后

/**
 * 选项解析:哪些字符吃值。
 *
 * 这是本层最像"文法"的部分,但它由**命令自己的语义**决定 ——
 * `-n` 对 `nice` / `head` 吃值,对 `rm` 不吃值。所以它住在本层,
 * 和 CMD_TABLE 放在一起,而不是住在句法层。
 */

/**
 * 全命令通用的「吃值短选项」。
 *
 * 只收跨命令几乎总是带值的字符。刻意不收 f / r / l / a / x:
 * `rm -rf x`、`ls -la`、`tar -xf a.tar` 里它们是标志位,收进来会把
 * 后面的操作数整个吞掉。漏判参数比多判参数危险得多。
 */
const VALUE_SHORT = new Set(["o", "O", "A", "B", "C", "m", "t", "u", "g"]);

/** 逐命令补充的「吃值短选项」 */
const PER_CMD_VALUE_SHORT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["grep", new Set(["e", "f", "A", "B", "C", "m"])],
  ["rg", new Set(["e", "f", "A", "B", "C", "m", "g", "t", "j"])],
  ["ag", new Set(["e", "A", "B", "C", "G"])],
  ["find", new Set(["E"])],
  ["sed", new Set(["e", "f"])],
  ["curl", new Set(["F", "H", "d", "X", "T", "w"])],
  ["wget", new Set(["O", "P", "T"])],
  ["head", new Set(["n"])],
  ["tail", new Set(["n"])],
  ["chmod", new Set(["t"])],
  ["du", new Set(["d"])],
  ["split", new Set(["d", "l", "a", "b", "n"])],
  ["cut", new Set(["d", "f"])],
  ["dd", new Set([])],
]);

/** 该吃下一个 token 作值的全命令长选项 */
const VALUE_LONG = new Set([
  "--output", "--output-document", "--user", "--group", "--color", "--exclude",
  "--regexp", "--file", "--max-count", "--format", "--timeout", "--proxy",
  "--header", "--data", "--request", "--upload-file", "--directory-prefix",
  "--chdir", "--git-dir", "--work-tree", "--depth", "--prefix", "--message",
  "--after-context", "--before-context", "--context", "--type", "--glob",
]);

/** 位置参数不是目标、只是修饰语的命令(sed 脚本、chmod 模式……) */
const NON_TARGET_POSITIONAL: ReadonlyMap<string, number> = new Map([
  ["sed", 1],
  ["chmod", 1],
  ["chown", 1],
  ["dd", 1],
]);

/** find 的表达式起点 —— 到此为止,后面不是路径 */
const FIND_EXPR = new Set([
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth",
  "-exec", "-execdir", "-delete", "-print", "-print0", "-size", "-mtime",
  "-atime", "-ctime", "-newer", "-user", "-group", "-perm", "-empty",
  "-not", "-a", "-o", "-and", "-or", "-prune", "-quit", "-depth", "-follow",
]);

/** shell.ts 的 Token 结构上满足这个接口 —— 两边共享,但本层不依赖它的实现 */
export interface ClassifyToken {
  readonly text: string;
  readonly quoted: boolean;
}

/** 分类结果。`null` 表示「这条命令我没看懂」,调用方必须落 unknown(§4.2)。 */
export type Classification =
  /** 不产生 Action(纯内建、纯赋值) */
  | { readonly kind: "silent" }
  /** 要跑东西,但说不出它读写什么 —— 表外可执行文件,或命令名是变量 */
  | { readonly kind: "exec" }
  /** `bash` / `sh` 这类:argv 里带内联脚本,该由句法层递归解析 */
  | { readonly kind: "shell"; readonly argv: readonly ClassifyToken[] }
  /** 正常命令:verb + args 交给句法层的 extractTargets */
  | {
      readonly kind: "cmd";
      readonly verb: Verb;
      readonly role: ArgRole;
      readonly args: readonly ClassifyToken[];
      /** 命令名本身,extractTargets 用它查逐命令的选项表 */
      readonly name: string;
    }
  /** find:verb 要看完表达式才知道 */
  | { readonly kind: "find"; readonly args: readonly ClassifyToken[] }
  /** tar:verb 由模式决定(-c 打包 / -x 解包 / -t 列表) */
  | { readonly kind: "tar"; readonly args: readonly ClassifyToken[] }
  /** git:verb 由子命令决定,走本层的二级表 */
  | { readonly kind: "git"; readonly args: readonly ClassifyToken[] };

// ---------------------------------------------------------------------------
// 表外可执行文件:一律 exec(§7)。下面这些表只描述"表内"的命令。
// ---------------------------------------------------------------------------

interface Entry {
  readonly verb: Verb;
  readonly role: ArgRole;
}

/** §7 的动词映射表,逐条对齐 */
const CMD_TABLE: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  // delete —— rm rmdir shred unlink
  ["rm", { verb: "delete", role: "pathOnly" }],
  ["rmdir", { verb: "delete", role: "pathOnly" }],
  ["shred", { verb: "delete", role: "pathOnly" }],
  ["unlink", { verb: "delete", role: "pathOnly" }],

  // read —— cat less head tail grep find ls
  ["cat", { verb: "read", role: "allArgs" }],
  ["bat", { verb: "read", role: "allArgs" }],
  ["less", { verb: "read", role: "allArgs" }],
  ["more", { verb: "read", role: "allArgs" }],
  ["head", { verb: "read", role: "allArgs" }],
  ["tail", { verb: "read", role: "allArgs" }],
  ["grep", { verb: "read", role: "grepLike" }],
  ["rg", { verb: "read", role: "grepLike" }],
  ["ag", { verb: "read", role: "grepLike" }],
  ["fd", { verb: "read", role: "grepLike" }],
  ["ls", { verb: "read", role: "pathOnly" }],
  ["pwd", { verb: "read", role: "pathOnly" }],
  ["[", { verb: "read", role: "pathOnly" }],
  ["test", { verb: "read", role: "pathOnly" }],
  ["which", { verb: "read", role: "pathOnly" }],
  ["type", { verb: "read", role: "pathOnly" }],
  ["wc", { verb: "read", role: "allArgs" }],
  ["file", { verb: "read", role: "pathOnly" }],
  ["stat", { verb: "read", role: "pathOnly" }],
  ["readlink", { verb: "read", role: "pathOnly" }],
  ["realpath", { verb: "read", role: "pathOnly" }],
  ["du", { verb: "read", role: "pathOnly" }],
  ["df", { verb: "read", role: "pathOnly" }],
  ["tree", { verb: "read", role: "pathOnly" }],
  ["jq", { verb: "read", role: "allArgs" }],
  ["diff", { verb: "read", role: "allArgs" }],
  ["cmp", { verb: "read", role: "allArgs" }],
  ["awk", { verb: "read", role: "allArgs" }],
  ["uniq", { verb: "read", role: "allArgs" }],
  ["sort", { verb: "read", role: "allArgs" }],
  ["cut", { verb: "read", role: "allArgs" }],
  ["paste", { verb: "read", role: "allArgs" }],
  ["column", { verb: "read", role: "allArgs" }],
  ["xxd", { verb: "read", role: "pathOnly" }],
  ["md5sum", { verb: "read", role: "pathOnly" }],
  ["shasum", { verb: "read", role: "pathOnly" }],
  ["sha256sum", { verb: "read", role: "pathOnly" }],
  ["base64", { verb: "read", role: "pathOnly" }],
  ["strings", { verb: "read", role: "pathOnly" }],
  ["nl", { verb: "read", role: "pathOnly" }],
  ["od", { verb: "read", role: "allArgs" }],
  ["open", { verb: "read", role: "pathOnly" }],
  ["ps", { verb: "read", role: "allArgs" }],
  ["date", { verb: "read", role: "allArgs" }],
  ["uname", { verb: "read", role: "allArgs" }],
  ["printenv", { verb: "read", role: "allArgs" }],

  // write —— cp mv touch mkdir sed -i tee
  ["cp", { verb: "write", role: "allArgs" }],
  ["mv", { verb: "write", role: "allArgs" }],
  ["install", { verb: "write", role: "allArgs" }],
  ["touch", { verb: "write", role: "allArgs" }],
  ["mkdir", { verb: "write", role: "allArgs" }],
  ["tee", { verb: "write", role: "allArgs" }],
  ["truncate", { verb: "write", role: "pathOnly" }],
  ["ln", { verb: "write", role: "allArgs" }],
  ["dd", { verb: "write", role: "allArgs" }],
  ["sed", { verb: "read", role: "sedOperands" }], // -i 会翻成 write
  ["chmod", { verb: "write", role: "pathOnly" }],
  ["chown", { verb: "write", role: "pathOnly" }],
  ["patch", { verb: "write", role: "allArgs" }],
  ["unzip", { verb: "write", role: "allArgs" }],
  ["printf", { verb: "write", role: "allArgs" }],

  // network —— curl wget nc ssh scp
  ["curl", { verb: "network", role: "allArgs" }],
  ["wget", { verb: "network", role: "allArgs" }],
  ["nc", { verb: "network", role: "allArgs" }],
  ["ncat", { verb: "network", role: "allArgs" }],
  ["ssh", { verb: "network", role: "allArgs" }],
  ["scp", { verb: "network", role: "allArgs" }],
  ["sftp", { verb: "network", role: "allArgs" }],
  ["rsync", { verb: "network", role: "allArgs" }],
  ["telnet", { verb: "network", role: "allArgs" }],
  ["ping", { verb: "network", role: "allArgs" }],
  ["traceroute", { verb: "network", role: "allArgs" }],
  ["psql", { verb: "network", role: "allArgs" }],
  ["mysql", { verb: "network", role: "allArgs" }],
  ["redis-cli", { verb: "network", role: "allArgs" }],
]);

/**
 * 这些命令 verb 是 exec,但**位置参数仍然有意义** ——
 * `kill -9 12345` 的 pid、`lsof -i :8787` 的端口、`ss -an` 的输出范围。
 * 丢掉它们等于把"操作对象"从日志里抹掉,规则层也就无从判断
 * 「这是不是在生产机器上杀进程」。
 * 所以它们走 cmd 通道(verb=exec + pathOnly),而不是盲 exec。
 */
const EXEC_WITH_ARGS = new Set([
  "kill", "pkill", "killall", "lsof", "ss", "netstat",
]);

/** verb 说不准、但确实"跑东西"的表内命令 */
const EXEC_CMDS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish",
  "python", "python3", "node", "bun", "bunx", "npx",
  "npm", "pnpm", "yarn", "make", "cargo", "go",
  "docker", "kubectl", "systemctl", "brew", "apt", "apt-get",
  // trap 的参数是「以后要执行的命令」,不是当下发生的事。
  // 归 silent 等于连一条日志都不留(§15.2 体检时它是唯一一条可疑项);
  // 归 exec 至少让规则层看见这儿有个 trap。
  // 刻意不递归:延迟执行的命令没有当下的 turn_id,递归出来是编造假时刻(见 D2.16)。
  "trap",
  // echo 不读也不写文件,输出目标由重定向决定。
  // 给它编个 read 会让 §4.5 的 PASS 白名单误以为"读了仓库内的文件"。
  "echo",
]);

/** 只改 shell 自身状态,不产生 Action */
const SILENT_CMDS = new Set([
  "cd", "pushd", "popd", "export", "unset", "set", "shopt",
  "alias", "unalias", "umask", "ulimit", "history", "true", "false",
  ":", "sleep", "wait", "exit",
]);

/** 解释器:argv 里带内联脚本,句法层递归解析 */
const SHELL_CMDS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** git 二级表 —— §7:"git → 按子命令查二级表" */
const GIT_TABLE: ReadonlyMap<string, Verb> = new Map<string, Verb>([
  ["status", "read"], ["diff", "read"], ["log", "read"], ["show", "read"],
  ["branch", "read"], ["ls-files", "read"], ["rev-parse", "read"],
  ["grep", "read"], ["blame", "read"], ["describe", "read"],
  ["config", "read"], ["remote", "read"], ["tag", "read"], ["stash", "read"],

  ["push", "network"], ["pull", "network"], ["fetch", "network"],
  ["clone", "network"], ["ls-remote", "network"], ["submodule", "network"],

  ["add", "write"], ["commit", "write"], ["rm", "write"], ["mv", "write"],
  ["restore", "write"], ["reset", "write"], ["checkout", "write"],
  ["switch", "write"], ["clean", "write"], ["init", "write"], ["apply", "write"],
  ["cherry-pick", "write"], ["merge", "write"], ["rebase", "write"],
  ["revert", "write"], ["am", "write"],
]);

/** git 子命令的位置参数角色 */
const GIT_ROLE: ReadonlyMap<string, ArgRole> = new Map<string, ArgRole>([
  ["rm", "pathOnly"],
  ["clean", "pathOnly"],
  ["checkout", "pathOnly"],
  ["restore", "pathOnly"],
  ["show", "pathOnly"],
  ["add", "pathOnly"],
  ["ls-files", "pathOnly"],
  ["apply", "pathOnly"],
]);

/** git 全局选项里带值的那些 */
const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 判断一条命令叫什么、算什么 verb、参数怎么取。
 *
 * `null` = 没看懂,调用方必须落 `verb: "unknown"`(§4.2)。
 * 这不是"保守",是**诚实**:兜底方向绝不能是"什么都没有"(那等于 PASS)。
 *
 * @param head 命令名 token(可能带路径、可能是变量、可能是 `[`)
 * @param rest head 之后的所有 token(含选项)
 */
export function classifyCommand(head: string, rest: readonly ClassifyToken[]): Classification | null {
  // 前置变量赋值已经在句法层剥掉了,但 env 后面可能还留着
  let i = 0;
  while (i < rest.length && !rest[i]!.quoted && isAssignment(rest[i]!.text)) i += 1;
  const args = rest.slice(i);

  // 命令名是变量(`$CMD -rf /`)—— 不展开变量就永远不知道它是什么(§7/D2.4)。
  // 归 exec 而不是 null:它确实是"要跑一个东西",exec 是诚实的描述;
  // 归 null 会让 `case $x in ... esac` 这类日常写法整条变打断
  // (项目简介的判据:把良性命令变打断是产品失败,不是保守)。
  if (/^\$[A-Za-z_{]/.test(head)) return { kind: "exec" };

  if (head === "source" || head === ".") {
    return args.length === 0 ? { kind: "silent" } : { kind: "exec" };
  }

  if (SILENT_CMDS.has(head)) return { kind: "silent" };

  if (SHELL_CMDS.has(head)) return { kind: "shell", argv: args };

  if (head === "git") return { kind: "git", args };
  if (head === "find") return { kind: "find", args };
  if (head === "tar") return { kind: "tar", args };

  const entry = CMD_TABLE.get(head);
  if (entry !== undefined) {
    // sed:只有 -i / --in-place 才是写
    const verb = entry.role === "sedOperands" && hasInPlace(args) ? "write" : entry.verb;
    return { kind: "cmd", verb, role: entry.role, args, name: head };
  }

  if (EXEC_WITH_ARGS.has(head)) {
    return { kind: "cmd", verb: "exec", role: "pathOnly", args, name: head };
  }

  if (EXEC_CMDS.has(head)) return { kind: "exec" };

  // 表外的可执行文件 → exec(§7)
  return { kind: "exec" };
}

/** sed 的 -i / --in-place */
function hasInPlace(args: readonly ClassifyToken[]): boolean {
  for (const tok of args) {
    if (tok.text === "--in-place" || tok.text.startsWith("--in-place=")) return true;
    if (!tok.quoted && tok.text.startsWith("-") && !tok.text.startsWith("--") && tok.text.includes("i")) {
      return true;
    }
  }
  return false;
}

/**
 * find 的 verb 不能由命令名定,得看表达式。
 *
 * `find . -name "*.log" -delete` 若算 read,而 §4.5 的 post 轮把
 * 「read + 目标在仓库内」列进了显式 PASS 白名单 —— 那是全部漏判里
 * 唯一一条「不是没看见,而是被主动放行」的。
 */
export function findVerb(args: readonly ClassifyToken[]): Verb {
  for (const tok of args) {
    if (tok.quoted) continue;
    if (tok.text === "-delete") return "delete";
    if (tok.text === "-exec" || tok.text === "-execdir" || tok.text === "-ok" || tok.text === "-okdir") {
      return "exec";
    }
  }
  return "read";
}

/**
 * tar 的 verb 取决于模式:`-czf` 打包是 write,`-xzf` 解包也是 write
 * (它会往磁盘落文件,而且路径由归档内容决定),`-tf` 列表是 read。
 */
export function tarVerb(args: readonly ClassifyToken[]): Verb {
  let mode: "create" | "extract" | "list" | null = null;
  for (const tok of args) {
    if (tok.quoted || !tok.text.startsWith("-") || tok.text.startsWith("--")) {
      if (tok.text === "--create") mode = "create";
      if (tok.text === "--extract" || tok.text === "--get") mode = "extract";
      if (tok.text === "--list") mode = "list";
      continue;
    }
    const body = tok.text.slice(1);
    if (body.includes("c")) mode = "create";
    else if (body.includes("x")) mode = "extract";
    else if (body.includes("t")) mode = "list";
  }
  return mode === "list" || mode === null ? "read" : "write";
}

/** git:剥掉全局选项,查二级表。 */
export function classifyGit(
  args: readonly ClassifyToken[],
): { readonly verb: Verb | null; readonly role: ArgRole; readonly args: readonly ClassifyToken[] } {
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.text;
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  const sub = args[i]?.text;
  if (sub === undefined) return { verb: null, role: "allArgs", args: [] }; // 光一个 git

  const after = args.slice(i + 1);
  const verb = GIT_TABLE.get(sub);
  if (verb === undefined) return { verb: null, role: "allArgs", args: after }; // 表外子命令

  return { verb, role: GIT_ROLE.get(sub) ?? "allArgs", args: after };
}

/** `FOO=1` 形式的前置赋值 */
export function isAssignment(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

/**
 * 命令名得像命令。不满足就别硬猜 —— 落未知比落 exec 诚实。
 *
 * 为什么需要这条:`nice -n 10 rm -rf /` 曾经变成 exec 无目标,
 * 因为 `-n` 没被当成"吃值",于是 `10` 被当成了命令名。
 * `10` 不像命令,这里就该拒绝,而不是给一个空的 exec。
 */
export const LOOKS_LIKE_COMMAND = /^(?:\[|[A-Za-z_:][A-Za-z0-9_.+-]*)$/;

/** 命令名取 basename:`/bin/rm`、`./bin/rm`、`~/bin/rm` 都归到 `rm` */
export function basename(head: string): string {
  const slash = head.lastIndexOf("/");
  return slash === -1 ? head : head.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// 取目标:哪些位置参数是这条命令真正读写的资源
// ---------------------------------------------------------------------------

export function extractTargets(
  role: ArgRole,
  args: readonly ClassifyToken[],
  cmd: string,
): ResourceSpec[] {
  const ops = operands(args, cmd);

  switch (role) {
    case "allArgs":
    case "pathOnly": {
      // 命令自己可能先占掉几个位置参数(sed 的脚本、chmod 的模式)
      const drop = NON_TARGET_POSITIONAL.get(cmd) ?? 0;
      return ops.slice(Math.max(drop, 0)).map(toSpec);
    }

    case "grepLike": {
      // -e/-f 已经给了模式,位置参数就全是文件
      const patternGiven = args.some(
        (a) => /^-[A-Za-z]*[ef]/.test(a.text) || a.text === "--regexp" || a.text === "--file",
      );
      // 否则第一个非选项是模式,之后才是文件
      return ops.slice(patternGiven ? 0 : 1).map(toSpec);
    }

    case "findPaths": {
      const out: ResourceSpec[] = [];
      for (const tok of args) {
        if (tok.quoted) {
          out.push(toSpec(tok));
          continue;
        }
        if (tok.text.startsWith("-") || tok.text === "(" || tok.text === "!") break;
        if (FIND_EXPR.has(tok.text)) break;
        out.push(toSpec(tok));
      }
      return out;
    }

    case "sedOperands": {
      // -i 时脚本是位置参数,文件在最后
      const last = ops[ops.length - 1];
      return last === undefined ? [] : [toSpec(last)];
    }
  }
}

/** 位置参数:跳过选项与该吃值的选项。cmd 决定逐命令的选项表。 */
function operands(args: readonly ClassifyToken[], cmd: string): ClassifyToken[] {
  const extra = PER_CMD_VALUE_SHORT.get(cmd);
  const out: ClassifyToken[] = [];
  let i = 0;
  let noMoreFlags = false;

  while (i < args.length) {
    const tok = args[i]!;
    const t = tok.text;

    if (noMoreFlags) {
      out.push(tok);
      i += 1;
      continue;
    }
    if (!tok.quoted && t === "--") {
      noMoreFlags = true;
      i += 1;
      continue;
    }
    if (tok.quoted || t === "-" || !t.startsWith("-")) {
      out.push(tok);
      i += 1;
      continue;
    }

    if (t.startsWith("--")) {
      // --flags=value 自带值;--flags value 看表
      if (!t.includes("=") && VALUE_LONG.has(t)) i += 2;
      else i += 1;
      continue;
    }

    // 短选项簇:逐字符扫,遇到第一个吃值字符就停 —— 它后面才是值。
    // 只看最后一个字符会漏掉 `-rn` 这类组合,也可能把 `-ef` 里的 e
    // 当成最后一位,而 e 在簇中间。
    const body = t.slice(1);
    let takesValue = false;
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k]!;
      if (VALUE_SHORT.has(ch) || extra?.has(ch) === true) {
        takesValue = k === body.length - 1; // 只有它是最后一位时才吃下一个 token
        break;
      }
    }
    i += takesValue ? 2 : 1;
  }

  return out;
}

function toSpec(tok: ClassifyToken): ResourceSpec {
  // kind 一律 "file":这里没有文件系统信息,声称 dir 是在猜(§6 是 enricher 的活)
  return { kind: "file", raw: tok.text };
}
