// SPEC.md §7 — shell 解析。
//
// 唯一职责:把一条 Bash 命令行切成若干条「命令意图」,每条给出 verb + targets。
// 它不碰文件系统、不 spawn 子进程、不判断危险与否 —— 判断是规则层的事。
//
// 设计约束(全部来自 §7):
//   - 手写字符扫描状态机,不引第三方 parser
//   - 解析失败 / 命令替换 / eval ⇒ 整体返回 null,调用方落 verb:"unknown" 再走 §4.2
//   - targets 里的 raw 是 agent 给的原始字符串,这里绝不做规范化
//   - 一次 Bash 调用可能产出多条命令,管线对每条判一次,取最严
//
// 明确不做的事(理由见 DECISIONS.md 的 D2.x):
//   - 不做变量展开、不支持命令替换、不模拟 `cd` 对后续命令路径的影响
//   - 不 stat 任何路径。kind 恒为 "file":是不是目录、是不是软链,那是 enricher 的事(§6)。
//     在解析层声称 kind 是在猜。

import type { Verb } from "./action.ts";

export interface ResourceSpec {
  readonly kind: "file" | "dir" | "url" | "unknown";
  readonly raw: string;
}

/** 一条命令的解析意图。适配器把它补成完整 Action(补 cwd / agent / turn_id)。 */
export interface ShellCommand {
  readonly verb: Verb;
  readonly targets: readonly ResourceSpec[];
}

/**
 * 解析一条 Bash 命令行。
 *
 * - `[]`   —— 命令里没有需要裁决的部分(空命令、纯赋值、纯 shell 内建)
 * - `null` —— 解析失败,调用方必须落 `verb: "unknown"`(§4.2)
 * - 数组   —— 每条独立命令一个意图
 */
export function parseCommand(command: string): ShellCommand[] | null {
  const segments = splitTopLevel(command);
  if (segments === null) return null;

  const out: ShellCommand[] = [];
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens === null) return null;

    const result = analyzeSegment(tokens);
    if (result === null) return null;
    for (const cmd of result) out.push(cmd);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命令表 —— §7 的动词映射表,逐条对齐
// ---------------------------------------------------------------------------

/** 位置参数怎么变成 targets */
type ArgRole =
  | "allArgs" // 所有非选项参数都是目标
  | "pathOnly" // 同上(留出语义差异的余地)
  | "grepLike" // 第一个非选项是模式,之后才是文件
  | "findPaths" // 到第一个表达式为止
  | "sedOperands"; // -i 时脚本是位置参数,文件在最后

type Entry =
  | { readonly kind: "verb"; readonly verb: Verb; readonly role: ArgRole }
  | { readonly kind: "subcommand" } // git:看子命令
  | { readonly kind: "find" } // find:verb 由表达式决定(-delete → delete)
  | { readonly kind: "tar" } // tar:有 -c 是 write(打包),否则是 read(解包/列表)
  | { readonly kind: "silent" } // 只改 shell 自身状态,不产生 Action
  | { readonly kind: "shell" } // 解释器:-c 的实参是真正的命令,递归解析
  | { readonly kind: "opaque" }; // 语义未知,一律 exec

const execEntry: Entry = { kind: "opaque" };

const CMD_TABLE: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  // delete —— rm rmdir shred unlink
  ["rm", { kind: "verb", verb: "delete", role: "pathOnly" }],
  ["rmdir", { kind: "verb", verb: "delete", role: "pathOnly" }],
  ["shred", { kind: "verb", verb: "delete", role: "pathOnly" }],
  ["unlink", { kind: "verb", verb: "delete", role: "pathOnly" }],

  // read —— cat less head tail grep find ls
  ["cat", { kind: "verb", verb: "read", role: "allArgs" }],
  ["bat", { kind: "verb", verb: "read", role: "allArgs" }],
  ["less", { kind: "verb", verb: "read", role: "allArgs" }],
  ["more", { kind: "verb", verb: "read", role: "allArgs" }],
  ["head", { kind: "verb", verb: "read", role: "allArgs" }],
  ["tail", { kind: "verb", verb: "read", role: "allArgs" }],
  ["grep", { kind: "verb", verb: "read", role: "grepLike" }],
  ["rg", { kind: "verb", verb: "read", role: "grepLike" }],
  ["ag", { kind: "verb", verb: "read", role: "grepLike" }],
  ["find", { kind: "find" }],
  ["tar", { kind: "tar" }],
  ["fd", { kind: "verb", verb: "read", role: "grepLike" }],
  ["ls", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["pwd", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["[", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["test", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["which", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["type", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["wc", { kind: "verb", verb: "read", role: "allArgs" }],
  ["file", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["stat", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["readlink", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["realpath", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["du", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["df", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["tree", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["jq", { kind: "verb", verb: "read", role: "allArgs" }],
  ["diff", { kind: "verb", verb: "read", role: "allArgs" }],
  ["cmp", { kind: "verb", verb: "read", role: "allArgs" }],
  ["awk", { kind: "verb", verb: "read", role: "allArgs" }],
  ["uniq", { kind: "verb", verb: "read", role: "allArgs" }],
  ["sort", { kind: "verb", verb: "read", role: "allArgs" }],
  ["cut", { kind: "verb", verb: "read", role: "allArgs" }],
  ["paste", { kind: "verb", verb: "read", role: "allArgs" }],
  ["column", { kind: "verb", verb: "read", role: "allArgs" }],
  ["xxd", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["md5sum", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["shasum", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["sha256sum", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["base64", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["strings", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["nl", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["od", { kind: "verb", verb: "read", role: "allArgs" }],
  ["open", { kind: "verb", verb: "read", role: "pathOnly" }],
  ["unzip", { kind: "verb", verb: "write", role: "allArgs" }],

  // write —— cp mv touch mkdir sed -i tee
  ["cp", { kind: "verb", verb: "write", role: "allArgs" }],
  ["mv", { kind: "verb", verb: "write", role: "allArgs" }],
  ["install", { kind: "verb", verb: "write", role: "allArgs" }],
  ["touch", { kind: "verb", verb: "write", role: "allArgs" }],
  ["mkdir", { kind: "verb", verb: "write", role: "allArgs" }],
  ["tee", { kind: "verb", verb: "write", role: "allArgs" }],
  ["truncate", { kind: "verb", verb: "write", role: "pathOnly" }],
  ["ln", { kind: "verb", verb: "write", role: "allArgs" }],
  ["dd", { kind: "verb", verb: "write", role: "allArgs" }],
  ["sed", { kind: "verb", verb: "read", role: "sedOperands" }], // -i 会翻成 write
  ["chmod", { kind: "verb", verb: "write", role: "pathOnly" }],
  ["chown", { kind: "verb", verb: "write", role: "pathOnly" }],
  ["patch", { kind: "verb", verb: "write", role: "allArgs" }],

  // network —— curl wget nc ssh scp
  ["curl", { kind: "verb", verb: "network", role: "allArgs" }],
  ["wget", { kind: "verb", verb: "network", role: "allArgs" }],
  ["nc", { kind: "verb", verb: "network", role: "allArgs" }],
  ["ncat", { kind: "verb", verb: "network", role: "allArgs" }],
  ["ssh", { kind: "verb", verb: "network", role: "allArgs" }],
  ["scp", { kind: "verb", verb: "network", role: "allArgs" }],
  ["sftp", { kind: "verb", verb: "network", role: "allArgs" }],
  ["rsync", { kind: "verb", verb: "network", role: "allArgs" }],
  ["telnet", { kind: "verb", verb: "network", role: "allArgs" }],
  ["ping", { kind: "verb", verb: "network", role: "allArgs" }],
  ["traceroute", { kind: "verb", verb: "network", role: "allArgs" }],
  ["psql", { kind: "verb", verb: "network", role: "allArgs" }],
  ["mysql", { kind: "verb", verb: "network", role: "allArgs" }],
  ["redis-cli", { kind: "verb", verb: "network", role: "allArgs" }],

  // exec —— 语义上确实是"跑东西",但不是文件操作
  ["bash", { kind: "shell" }],
  ["sh", { kind: "shell" }],
  ["zsh", { kind: "shell" }],
  ["dash", { kind: "shell" }],
  ["ksh", { kind: "shell" }],
  ["fish", execEntry],
  ["python", execEntry],
  ["python3", execEntry],
  ["node", execEntry],
  ["bun", execEntry],
  ["bunx", execEntry],
  ["npx", execEntry],
  ["npm", execEntry],
  ["pnpm", execEntry],
  ["yarn", execEntry],
  ["make", execEntry],
  ["cargo", execEntry],
  ["go", execEntry],
  ["docker", execEntry],
  ["kubectl", execEntry],
  ["systemctl", execEntry],
  ["kill", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["pkill", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["killall", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["lsof", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["ss", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["netstat", { kind: "verb", verb: "exec", role: "allArgs" }],
  ["ps", { kind: "verb", verb: "read", role: "allArgs" }],
  ["date", { kind: "verb", verb: "read", role: "allArgs" }],
  ["uname", { kind: "verb", verb: "read", role: "allArgs" }],
  ["printenv", { kind: "verb", verb: "read", role: "allArgs" }],
  // echo 不读也不写文件,它的输出目标由重定向决定。
  // 归 exec(表外默认)是对的:给它编个 read 会让 §4.5 的 PASS 白名单
  // 误以为"读了仓库内的文件"。
  ["echo", execEntry],
  ["brew", execEntry],
  ["apt", execEntry],
  ["apt-get", execEntry],

  // 只改 shell 自身状态,不该产生 Action
  ["cd", { kind: "silent" }],
  ["pushd", { kind: "silent" }],
  ["popd", { kind: "silent" }],
  ["export", { kind: "silent" }],
  ["unset", { kind: "silent" }],
  ["set", { kind: "silent" }],
  ["shopt", { kind: "silent" }],
  ["alias", { kind: "silent" }],
  ["unalias", { kind: "silent" }],
  ["umask", { kind: "silent" }],
  ["ulimit", { kind: "silent" }],
  // trap 的参数是「以后要执行的命令」,不是当下发生的事。
  // 归 silent 等于连一条日志都不留(§15.2 体检时它是唯一一条"什么都不产出"
  // 的可疑项);归 opaque 至少让规则层看见这儿有个 trap。
  // 刻意不递归:延迟执行的命令没有当下的 turn_id,递归出来会编造一条假时刻。
  ["trap", { kind: "opaque" }],
  ["history", { kind: "silent" }],
  ["true", { kind: "silent" }],
  ["false", { kind: "silent" }],
  [":", { kind: "silent" }],
  ["printf", { kind: "verb", verb: "write", role: "allArgs" }],
  ["sleep", { kind: "silent" }],
  ["wait", { kind: "silent" }],
  ["exit", { kind: "silent" }],

  // 看子命令
  ["git", { kind: "subcommand" }],
]);

/** git 二级表 —— §7:"git → 按子命令查二级表" */
const GIT_TABLE: ReadonlyMap<string, Verb> = new Map<string, Verb>([
  ["status", "read"],
  ["diff", "read"],
  ["log", "read"],
  ["show", "read"],
  ["branch", "read"],
  ["ls-files", "read"],
  ["rev-parse", "read"],
  ["grep", "read"],
  ["blame", "read"],
  ["describe", "read"],
  ["config", "read"],
  ["remote", "read"],
  ["tag", "read"],
  ["stash", "read"], // `stash list` 是读;`stash pop` 是取消 stash,单列见 D2.8

  ["push", "network"],
  ["pull", "network"],
  ["fetch", "network"],
  ["clone", "network"],
  ["ls-remote", "network"],
  ["submodule", "network"],

  ["add", "write"],
  ["commit", "write"],
  ["rm", "write"],
  ["mv", "write"],
  ["restore", "write"],
  ["reset", "write"],
  ["checkout", "write"],
  ["switch", "write"],
  ["clean", "write"],
  ["init", "write"],
  ["apply", "write"],
  ["cherry-pick", "write"],
  ["merge", "write"],
  ["rebase", "write"],
  ["revert", "write"],
  ["am", "write"],
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

/**
 * shell 复合语句的开头关键字。
 *
 * 这些不是命令,但它们的**后面**跟着真正的命令。归 exec 等于把整块内容
 * 变成规则层看不见的盲区(`for f in *.log; do rm -f $f; done` 会变成
 * 一条空的 exec);归 null 等于每次打断一次 —— 按项目简介的判据,
 * 那是产品失败。所以正确的做法是剥掉关键字,继续解析剩下的。
 *
 * 为什么 `[` / `[[` 不在这里:它们是 test 内建,已经单独进表归 read 了。
 * 收进来会把它后面的路径丢掉,正好丢掉 §4.5 PASS 白名单需要的东西。
 */
const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in",
  "{", "}", "(", ")",
  "!", "time",
]);

/** 破坏性前置词:剥掉自己继续解析后面那个命令 */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "xargs", "command", "builtin",
  "nice", "ionice", "stdbuf", "setsid", "exec",
]);

/**
 * 该吃下一个 token 作值的短选项 —— 全表通用的那份。
 *
 * 只收「跨命令几乎总是带值」的字符。刻意不收 f / r / l / a / x:
 * `rm -rf x`、`ls -la`、`tar -xf a.tar` 里它们是标志位,收进来会把
 * 后面的操作数整个吞掉。漏判参数比多判参数危险得多 ——
 * 宁可把 `curl -F x` 的 x 当目标让规则层多看一眼,
 * 也不能把 `rm -rf x` 的 x 吞掉。
 *
 * 每条命令的专有选项在 PER_CMD_VALUE_SHORT 里补(不合并进这个集合,
 * 否则 `grep -e` 和 `rm -f` 会互相污染)。
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
  ["split", new Set(["d"])],
  ["cut", new Set(["d", "f"])],
  ["split", new Set(["d", "l", "a", "b", "n"])],
  ["sort", new Set([])],
  ["uniq", new Set([])],
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

// ---------------------------------------------------------------------------
// 1. 顶层切分 —— `;` `&&` `||` `|` `\n`,引号之外
// ---------------------------------------------------------------------------

/** 失败(未闭合引号)返回 null */
function splitTopLevel(input: string): string[] | null {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;

  const at = (n: number): string => input[n] ?? "";

  const flush = (): void => {
    const text = cur.trim();
    if (text !== "") segments.push(text);
    cur = "";
  };

  while (i < input.length) {
    const c = at(i);

    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (c === "\\" && i + 1 < input.length) {
        cur += c + at(i + 1);
        i += 2;
        continue;
      }
      cur += c;
      if (c === '"') quote = null;
      i += 1;
      continue;
    }

    // ---- 引号之外 ----
    if (c === "\\" && i + 1 < input.length) {
      cur += c + at(i + 1);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      i += 1;
      continue;
    }

    // heredoc:把 <<EOF 和它的正文一起吃掉,正文不参与解析
    // (正文里的 .env 内容不是命令,当成命令会造出假 Action)
    if (c === "<" && at(i + 1) === "<" && at(i + 2) !== "<") {
      let j = i + 2;
      if (at(j) === "-") j += 1; // <<-EOF
      while (at(j) === " " || at(j) === "\t") j += 1;
      // 分隔符可以是引号包起来的
      let delim = "";
      const q = at(j);
      if (q === '"' || q === "'") {
        j += 1;
        while (j < input.length && at(j) !== q) {
          delim += at(j);
          j += 1;
        }
        if (j >= input.length) return null;
        j += 1;
      } else {
        while (j < input.length && !/[\s;&|]/.test(at(j))) {
          delim += at(j);
          j += 1;
        }
      }
      if (delim === "") return null; // `<<` 后面没分隔符 —— 畸形
      cur += " " + delim + " "; // 只留分隔符本体, heredoc 目标不产生写目标
      i = j;
      // 吞掉正文:到下一行开头是 delim 的那一行为止
      let k = i;
      while (k < input.length && at(k) !== "\n") k += 1;
      if (k >= input.length) return null; // 没有正文行 —— 畸形
      k += 1;
      for (;;) {
        const lineEnd = input.indexOf("\n", k);
        const stop = lineEnd === -1 ? input.length : lineEnd;
        const line = input.slice(k, stop).trim();
        if (line === delim) {
          i = lineEnd === -1 ? input.length : lineEnd + 1;
          break;
        }
        if (lineEnd === -1) return null; // 正文没闭合
        k = lineEnd + 1;
      }
      // 分隔符那一行就是本段命令的结尾。原文里它后面可能没有换行
      // (`cat <<EOF\nhi\nEOF\nrm x` 的 EOF 后面直接是换行,但
      // `rm x\ncat <<EOF\nhi\nEOF` 的 EOF 后面什么都没有),
      // 所以这里必须自己把段落结掉,不能指望下一轮循环碰到 `\n`。
      flush();
      continue;
    }

    // `#` 注释:必须在词首才是注释(./a#b 里的 # 不是)
    if (c === "#") {
      const prev = i === 0 ? "\n" : at(i - 1);
      if (prev === " " || prev === "\t" || prev === "\n" || prev === ";" || prev === "&" || prev === "|") {
        while (i < input.length && at(i) !== "\n") i += 1;
        continue;
      }
    }

    if (c === ";" || c === "\n") {
      flush();
      i += 1;
      continue;
    }
    if (c === "&" && at(i + 1) === "&") {
      flush();
      i += 2;
      continue;
    }
    if (c === "|") {
      flush();
      i += at(i + 1) === "|" || at(i + 1) === "&" ? 2 : 1;
      continue;
    }
    if (c === "&" && (at(i + 1) === "" || at(i + 1) === " " || at(i + 1) === "\t")) {
      flush(); // 后台执行,等价于 `;`
      i += 1;
      continue;
    }

    cur += c;
    i += 1;
  }

  if (quote !== null) return null;
  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// 2. 分词 —— 引号 / 转义 / 重定向
// ---------------------------------------------------------------------------

interface Token {
  readonly text: string;
  /** 被引号包过 —— 影响 `-` 开头算不算选项 */
  readonly quoted: boolean;
  /** 紧贴在重定向前面的数字(如 `2>&1` 的 `2`),不是参数 */
  readonly fd: string | null;
}

/** 失败返回 null */
function tokenize(segment: string): Token[] | null {
  const tokens: Token[] = [];
  let cur = "";
  let curQuoted = false;
  let i = 0;

  const at = (n: number): string => segment[n] ?? "";

  const push = (fd: string | null): void => {
    if (cur !== "" || curQuoted) tokens.push({ text: cur, quoted: curQuoted, fd });
    cur = "";
    curQuoted = false;
  };

  while (i < segment.length) {
    const c = at(i);

    if (c === " " || c === "\t") {
      push(null);
      i += 1;
      continue;
    }

    if (c === "'") {
      curQuoted = true;
      i += 1;
      while (i < segment.length && at(i) !== "'") {
        cur += at(i);
        i += 1;
      }
      if (i >= segment.length) return null;
      i += 1;
      continue;
    }

    if (c === '"') {
      curQuoted = true;
      i += 1;
      while (i < segment.length && at(i) !== '"') {
        const d = at(i);
        if (d === "\\" && i + 1 < segment.length) {
          const n = at(i + 1);
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            cur += n;
            i += 2;
            continue;
          }
          cur += d;
          i += 1;
          continue;
        }
        if (d === "`") return null; // 双引号里的命令替换照样放弃解析
        if (d === "$" && at(i + 1) === "(") return null;
        cur += d;
        i += 1;
      }
      if (i >= segment.length) return null;
      i += 1;
      continue;
    }

    if (c === "\\") {
      if (i + 1 >= segment.length) return null;
      cur += at(i + 1);
      i += 2;
      continue;
    }

    // 命令替换 / 进程替换 —— §7:放弃整体解析
    if (c === "`") return null;
    if (c === "$" && at(i + 1) === "(") return null;
    if (c === "<" && at(i + 1) === "(") return null;
    if (c === ">" && at(i + 1) === "(") return null;

    // `(` `)` `{` `}` 是语法括号,自成一个 token。
    // 不拆的话 `:(){ :|:& };:` 的 `:(){` 会变成一个"像命令名但不是"的
    // 东西,整条命令于是判失败 —— 而它其实是 fork bomb。
    // 拆开之后 `:` 是 silent 内建、`()` / `{` 是关键字,各归各位。
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      push(null);
      tokens.push({ text: c, quoted: false, fd: null });
      i += 1;
      continue;
    }

    // 重定向算子
    if (c === ">" || c === "<") {
      let op = c;
      i += 1;
      while (i < segment.length && (at(i) === ">" || at(i) === "<")) {
        op += at(i);
        i += 1;
      }
      if (at(i) === "&" && at(i + 1) === ">") {
        op += "&>";
        i += 2; // &>file
      }
      // 紧贴重定向的数字是 fd(`2>` / `2>&1`),不是参数。
      // 只有"数字 → 这个重定向 → 数字或 &数字"才是 fd 复制;
      // 否则只是普通 token 里恰好以数字结尾(如 grep -rn 'TODO' src/),
      // 那种情况 op 后面跟的不是数字也不是 &数字。
      const fd = /^\d+$/.test(cur) ? cur : null;
      const followsDup = /^\d+$/.test(at(i)) || at(i) === "&";
      if (fd === null || !followsDup) {
        push(null);
        tokens.push({ text: op, quoted: false, fd: null });
      } else {
        tokens.push({ text: op, quoted: false, fd });
      }
      cur = "";
      curQuoted = false;
      continue;
    }

    cur += c;
    i += 1;
  }

  push(null);
  return tokens;
}

// ---------------------------------------------------------------------------
// 3. 段落解析
// ---------------------------------------------------------------------------

interface Partial {
  readonly verb: Verb;
  readonly targets: readonly ResourceSpec[];
}

function analyzeSegment(rawTokens: readonly Token[]): Partial[] | null {
  // 摘重定向。`2>&1` 这类 fd 复制不是写目标,文件才是。
  const writeTargets: string[] = [];
  const tokens: Token[] = [];

  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]!;
    const t = tok.text;

    if (t === "<<" || t === "<<<") return null; // heredoc 没在切分阶段吃掉 —— 判失败

    // `rm build 2> err.log` 里的 `2`:tokenize 不认识它,这里补认
    if (/^\d+$/.test(t) && rawTokens[i + 1] !== undefined && rawTokens[i + 1]!.text.startsWith(">")) {
      continue;
    }

    if (t.startsWith(">")) {
      // `2>&1` / `>&2` / `&>file`
      const next = rawTokens[i + 1];
      const fdDup =
        /^>&\d+$/.test(t) ||
        /^&>\d+$/.test(t) ||
        ((t === ">&" || t === "&>") && /^\d+$/.test(next?.text ?? ""));
      // `2>&1`:词法层给出 `>`(fd=2) + `&1`,这两半都是 fd 复制
      if (tok.fd !== null && /^&\d+$/.test(next?.text ?? "")) {
        i += 1;
        continue;
      }
      if (/^&\d+$/.test(next?.text ?? "")) {
        // `>&1` 被词法层拆成 `>&` + `1`,紧贴的重定向算子才是本体
        if (t === ">&" || t === "&>") i += 1;
        continue;
      }
      if (fdDup) {
        if (t === ">&" || t === "&>") i += 1;
        continue;
      }
      if (next === undefined) return null; // 重定向后面没有目标 —— 畸形
      writeTargets.push(next.text);
      i += 1;
      continue;
    }

    if (t.startsWith("<")) continue; // 输入重定向不产生写目标
    if (tok.fd !== null) continue; // 该吃掉的 fd 前缀

    tokens.push(tok);
  }

  const applyRedirect = (partials: readonly Partial[], redirectVerb: Verb): Partial[] => {
    if (writeTargets.length === 0) return [...partials];
    const writes: ResourceSpec[] = writeTargets.map((raw) => ({ kind: "file", raw }));
    if (partials.length === 0) return [{ verb: redirectVerb, targets: writes }];
    return partials.map((p) => ({ verb: p.verb, targets: [...p.targets, ...writes] }));
  };

  if (tokens.length === 0) {
    if (writeTargets.length === 0) return [];
    return applyRedirect([], "write");
  }

  const resolved = resolveVerb(tokens);
  if (resolved === null) return null;

  const partials: Partial[] = [];
  for (const r of resolved) {
    if (r.kind === "silent") continue;
    if (r.kind === "exec") {
      partials.push({ verb: "exec", targets: [] });
      continue;
    }
    partials.push({ verb: r.verb, targets: r.targets });
  }

  if (partials.length === 0) {
    // 纯内建 + 重定向:`cd x > f` 只有写目标值得看
    if (writeTargets.length === 0) return [];
    return applyRedirect([], "write");
  }

  return applyRedirect(partials, "write");
}

type Resolved =
  | { readonly kind: "silent" }
  | { readonly kind: "exec" }
  | { readonly kind: "verb"; readonly verb: Verb; readonly targets: readonly ResourceSpec[] };

/**
 * 一条命令可能展开成多条 Resolved(包装词、`bash -c "a && b"`)。
 * 返回 null 表示解析失败。
 */
function resolveVerb(tokens: readonly Token[], depth = 0): Resolved[] | null {
  if (depth > 8) return null; // 包装套太深

  let i = 0;

  // 前置变量赋值:FOO=1 cmd
  while (i < tokens.length && !tokens[i]!.quoted && isAssignment(tokens[i]!.text)) i += 1;
  if (i >= tokens.length) return [{ kind: "silent" }];

  const head = tokens[i]!.text;
  const rest = tokens.slice(i + 1);

  // §7:遇到 eval 一律放弃解析
  if (head === "eval") return null;
  if (head === "source" || head === ".") {
    return [{ kind: rest.length === 0 ? "silent" : "exec" }];
  }

  if (WRAPPERS.has(head)) {
    const inner = peelWrapper(head, rest);
    if (inner === null) return null;
    return resolveVerb(inner, depth + 1);
  }

  // 函数定义头(`name()` / `name ()`)只声明,不执行。
  // 括号现在会被拆成独立 token(`f` `(` `)` `{`),所以这里看的是
  // 「head 后面紧跟 `()`」这个形状,而不是靠一个 token 里的正则。
  // 体会被 `;` / `&` 切分,但声明本身不产出 Action —— 延迟执行没有当下的
  // turn_id,编造一条会污染日志。fork bomb 的危险性由 §4.5 的 pre 规则
  // 对 raw command 做模式匹配兜住(见 D2.11)。
  if (rest.length >= 2 && rest[0]!.text === "(" && rest[1]!.text === ")") {
    return [{ kind: "silent" }];
  }

  // 复合语句关键字:剥掉看后面,而不是整块放弃
  if (SHELL_KEYWORDS.has(head)) {
    // `case x in` 的 `in` 后面是模式,不是命令;`do` / `then` 后面才是。
    // 统一按"剥掉看后面"处理,多解出来的那点噪声由规则层过滤。
    if (rest.length === 0) return [{ kind: "silent" }];
    return resolveVerb(rest, depth + 1);
  }

  // 命令名是个变量(`$CMD -rf /`)—— 不展开变量就永远不知道它是什么(§7/D2.4)。
  // 归 exec 而不是 null:它确实是"要跑一个东西",exec 是诚实的描述;
  // 归 null 会让 `case $x in ... esac` 这类日常写法整条变打断(简介的判据:
  // 那是产品失败,不是保守)。
  if (/^\$[A-Za-z_{]/.test(head)) return [{ kind: "exec" }];

  const name = basename(head);

  // 命令名本身就不像命令(纯数字、含 `=`、空)—— 说明前面某一层剥错了,
  // 这条命令我们其实没看懂。落 null ⇒ unknown ⇒ SOFT,比落 exec 诚实。
  if (!LOOKS_LIKE_COMMAND.test(name)) return null;

  const entry = CMD_TABLE.get(name);
  if (entry === undefined) {
    // 表外可执行文件 → exec(§7)
    return [{ kind: "exec" }];
  }

  switch (entry.kind) {
    case "silent":
      return [{ kind: "silent" }];
    case "opaque":
      return [{ kind: "exec" }];
    case "subcommand":
      return resolveGit(rest);
    case "find":
      return [resolveFind(rest)];
    case "tar":
      return [resolveTar(rest)];
    case "shell":
      return resolveShell(rest);
    case "verb": {
      const verb = entry.role === "sedOperands" ? sedVerb(rest, entry.verb) : entry.verb;
      return [{ kind: "verb", verb, targets: extractTargets(entry.role, rest, head) }];
    }
  }
}

/**
 * find 的 verb 不能由命令名定,得看表达式。
 *
 * `find . -name "*.log" -delete` 现在是 read(.),而 §4.5 的 post 轮把
 * 「read + 目标在仓库内」列进了显式 PASS 白名单 —— 这是全部漏判里
 * 唯一一条「不是没看见,而是被主动放行」的。所以它单独走一条路。
 *
 * -delete / -exec / -execdir / -ok 出现即改变 verb;
 * 路径仍然只取表达式之前的那些(还是 findPaths 的老规则)。
 */
function resolveFind(args: readonly Token[]): Resolved {
  let verb: Verb = "read";
  for (const tok of args) {
    if (tok.quoted) continue;
    if (tok.text === "-delete") {
      verb = "delete";
      break;
    }
    if (tok.text === "-exec" || tok.text === "-execdir" || tok.text === "-ok" || tok.text === "-okdir") {
      verb = "exec";
      break;
    }
  }
  return { kind: "verb", verb, targets: extractTargets("findPaths", args, "find") };
}

/**
 * tar 的 verb 取决于模式:`-czf` 打包是 write,`-xzf` 解包是 write(会落地文件),
 * `-tf` 列表是 read。
 *
 * 解包为什么算 write:它往磁盘写文件,而且路径由归档内容决定 ——
 * 正是 §1 说的"只有模型能判断"的那类不确定性。归 write 让规则层至少看一眼。
 */
function resolveTar(args: readonly Token[]): Resolved {
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
  const verb: Verb = mode === "list" || mode === null ? "read" : "write";
  return { kind: "verb", verb, targets: extractTargets("allArgs", args, "tar") };
}

/**
 * `bash -c "rm -rf x"` 是 §7 点名的万能逃逸口:名义上 exec,实际是 delete。
 * 这里把 `-c` 的实参当命令行递归解析 —— 它已经不是被引号保护的字符串了。
 *
 * 递归解析失败 ⇒ 退回 exec(而不是把整条命令判成 unknown):
 * exec 本身仍会被规则层看见,不会变成静默放行。
 */
function resolveShell(args: readonly Token[]): Resolved[] {
  let i = 0;
  let script: string | null = null;

  while (i < args.length) {
    const tok = args[i]!;
    const t = tok.text;

    if (t === "--") break;
    if (t === "-c") {
      script = args[i + 1]?.text ?? "";
      break;
    }
    // 组合短选项里的 c,如 -lc
    if (!tok.quoted && t.startsWith("-") && !t.startsWith("--") && t.length > 1 && t.includes("c")) {
      script = args[i + 1]?.text ?? "";
      break;
    }
    i += 1;
  }

  if (script === null) return [{ kind: "exec" }];

  const inner = parseCommand(script);
  if (inner === null || inner.length === 0) return [{ kind: "exec" }];

  // 内部脚本的命令一条都不能丢:丢弃就是漏判
  return inner.map((cmd) => ({ kind: "verb", verb: cmd.verb, targets: cmd.targets }) as Resolved);
}


/** sed:只有 -i / --in-place 才是写 */
function sedVerb(args: readonly Token[], fallback: Verb): Verb {
  for (const tok of args) {
    if (tok.text === "--in-place" || tok.text.startsWith("--in-place=")) return "write";
    if (!tok.quoted && tok.text.startsWith("-") && !tok.text.startsWith("--") && tok.text.includes("i")) {
      return "write";
    }
  }
  return fallback;
}

/** 剥掉包装词自己的选项,返回真正要执行的东西 */
function peelWrapper(head: string, rest: readonly Token[]): Token[] | null {
  let i = 0;

  while (i < rest.length) {
    const t = rest[i]!.text;

    if (t === "--") {
      i += 1;
      break;
    }
    if (t.startsWith("--")) {
      if (!t.includes("=") && VALUE_LONG.has(t)) i += 1;
      i += 1;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      const body = t.slice(1);
      const last = body[body.length - 1] ?? "";
      i += VALUE_SHORT.has(last) && body.length === 1 ? 2 : 1;
      continue;
    }
    if (isAssignment(t)) {
      i += 1;
      continue;
    }
    break;
  }

  if (head === "env") {
    // env 后面还可能有 VAR=VAL
    while (i < rest.length && isAssignment(rest[i]!.text)) i += 1;
  }

  const remaining = rest.slice(i);
  if (remaining.length === 0) return null; // 光有包装词没有命令 —— 判失败
  return remaining;
}

function resolveGit(rest: readonly Token[]): Resolved[] {
  let i = 0;

  // 全局选项: -C dir / -c k=v / --no-pager / --git-dir=…
  while (i < rest.length) {
    const t = rest[i]!.text;
    if (t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "-c") {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  const sub = rest[i]?.text;
  if (sub === undefined) return [{ kind: "exec" }]; // 光一个 git,没有子命令

  const after = rest.slice(i + 1);
  const verb = GIT_TABLE.get(sub);
  if (verb === undefined) {
    return [{ kind: "exec" }]; // 表外子命令 → exec
  }

  const role = GIT_ROLE.get(sub) ?? "allArgs";
  return [{ kind: "verb", verb, targets: extractTargets(role, after, "git") }];
}

function isAssignment(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

/**
 * 命令名取 basename:`/bin/rm`、`/usr/bin/curl`、`./bin/rm`、`~/bin/rm` 都归到 `rm`。
 *
 * 为什么不 basename 是错的:带路径写命令名是脚本和 hook 里的常见写法,
 * 而 `/bin/rm -rf /` 落 exec 等于规则层什么都看不见。
 * 代价是 `./build/myapp` 这类同名自定义脚本会被认成系统命令 —— 方向是多看一眼。
 */
function basename(head: string): string {
  const slash = head.lastIndexOf("/");
  return slash === -1 ? head : head.slice(slash + 1);
}

/**
 * 命令名得像命令。不满足就别硬猜 —— 落未知比落 exec 诚实。
 *
 * 这一条是 P1-2 的修法:`nice -n 10 rm -rf /` 为什么曾经变成 exec 无目标?
 * 因为 `-n` 不在选项表里,没被当成"吃值",于是 `10` 被当成了命令名。
 * `10` 不像命令,这里就该拒绝,而不是给一个空的 exec。
 */
const LOOKS_LIKE_COMMAND = /^(?:\[|[A-Za-z_:][A-Za-z0-9_.+-]*)$/;

// ---------------------------------------------------------------------------
// 4. 取目标
// ---------------------------------------------------------------------------

function extractTargets(
  role: ArgRole,
  args: readonly Token[],
  cmd: string,
): ResourceSpec[] {
  const ops = operands(args, cmd);

  switch (role) {
    case "allArgs":
    case "pathOnly": {
      // 按 positionals 数量推断目标时,命令自己先占掉几个位置参数
      const drop = NON_TARGET_POSITIONAL.get(cmd) ?? 0;
      return ops.slice(Math.max(drop, 0)).map(toSpec);
    }

    case "grepLike": {
      // -e/-f 已经给了模式,位置参数就全是文件
      const patternGiven = args.some((a) => /^-[A-Za-z]*[ef]/.test(a.text) || a.text === "--regexp" || a.text === "--file");
      // 否则第一个非选项是模式,之后才是文件
      const drop = patternGiven ? 0 : 1;
      return ops.slice(Math.max(drop, 0)).map(toSpec);
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
function operands(args: readonly Token[], cmd: string): Token[] {
  const extra = PER_CMD_VALUE_SHORT.get(cmd);
  const out: Token[] = [];
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
    // 只看最后一个字符会漏掉 `-rn`(n 吃值?不,n 是行号)这类组合,
    // 也可能把 `-ef` 里的 e 当成最后一位,而 e 在簇中间。
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

function toSpec(tok: Token): ResourceSpec {
  // kind 一律 "file":这里没有文件系统信息,声称 dir 是在猜(§6 是 enricher 的活)
  return { kind: "file", raw: tok.text };
}
