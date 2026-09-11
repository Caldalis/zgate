// SPEC.md §7 —— 手写状态机版解析器(**已被 AST 路替换,保留作差分参照**)。
//
// 生产代码走 index.ts(walker.ts)。这个文件只被差分测试 import。
// 保留它的价值:它是独立实现的第二版本,和 AST 版对撞时差异即信号。
//
// 唯一职责:把一条 Bash 命令行拆成若干条命令,给出每条的命令词与参数,
// 并处理重定向、引号、heredoc。**这里只回答 shell 文法问题。**
//
// 「rm 算什么 verb」「git push 算 network」不是文法,是命令语义 ——
// 那些表在 classify.ts。本文件通过 classifyCommand() 问它,自己不持有任何
// 命令名到 verb 的映射。这个分界是为了以后换 AST:换掉的只是本文件。
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

import type { Verb } from "../core/action.ts";
import { splitTopLevel, tokenize, type Token } from "./lex.ts";
import {
  basename,
  classifyCommand,
  classifyGit,
  extractTargets,
  findVerb,
  isAssignment,
  LOOKS_LIKE_COMMAND,
  tarVerb,
  type ResourceSpec,
} from "./classify.ts";

export type { ResourceSpec } from "./classify.ts";


/** 一条命令的解析意图。适配器把它补成完整 Action(补 cwd / agent / turn_id)。 */
export interface ShellCommand {
  readonly verb: Verb;
  readonly targets: readonly ResourceSpec[];
}

/**
 * 解析一条 Bash 命令行。了；
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
    const tokens = tokenize(segment.text, segment.heredocDelimiter);
    if (tokens === null) return null;

    // 参照实现:自己再按算子切一次。
    // splitTopLevel 现在只切换行(结构留给 AST),但手写版是线性扫描,
    // 它必须拿到的就是"每条命令一段" —— 这个差异**刻意保留**,
    // 正是它和 AST 版相互校验的地方。
    for (const piece of splitLegacy(tokens)) {
      const result = analyzeSegment(piece);
      if (result === null) return null;
      for (const cmd of result) out.push(cmd);
    }
  }
  return out;
}

/**
 * 按 `;` `&&` `||` `|` `&` 把 token 流切成"每条命令一段"。
 *
 * 这是手写版的核心假设:它拿到的输入是一段一条命令。
 * 引号内部的分隔符早被 tokenize 处理掉了,所以这里只看 token 文本。
 */
function splitLegacy(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  for (const tok of tokens) {
    const isSep = tok.text === ";" || tok.text === "&&" || tok.text === "||" ||
                  tok.text === "|" || tok.text === "&" || tok.text === ";;";
    if (isSep) {
      if (cur.length > 0) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(tok);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in",
  "{", "}", "(", ")",
  "!", "time",
]);

/** 破坏性前置词:剥掉自己继续解析后面那个命令 */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "timeout", "xargs", "command",
  "builtin", "nice", "ionice", "stdbuf", "setsid", "exec",
]);

// ---------------------------------------------------------------------------
// 段落解析:摘重定向 + 定 verb + 取目标
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

    if (t.startsWith(">") || t.startsWith("&>")) {
      // `2>&1` / `>&2` / `&>file` —— 全是 fd 复制,不产生写目标
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

  // §7:遇到 eval 一律放弃解析。
  // `source` / `.` 要在命令名校验之前处理 —— `.` 本身不像命令名,
  // 但它是最常用的内建之一(见 classify.ts)。
  if (head === "eval") return null;
  if (head === "source" || head === ".") {
    return [{ kind: rest.length === 0 ? "silent" : "exec" }];
  }

  // ---- 句法剥离:一层层剥掉包装词、函数头、关键字 ----
  if (WRAPPERS.has(head)) {
    const inner = peelWrapper(head, rest);
    if (inner === null) return null;
    return resolveVerb(inner, depth + 1);
  }

  // 函数定义头(`f` `(` `)`)只声明,不执行。括号会被拆成独立 token,
  // 所以这里看的是「head 后面紧跟 `()`」这个形状。
  // 体会被 `;` / `&` 切分,但声明本身不产出 Action —— 延迟执行没有当下的
  // turn_id,编造一条会污染日志。fork bomb 的危险性由 §4.5 的 pre 规则
  // 对 raw command 做模式匹配兜住(见 D2.16)。
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

  // ---- 命令名归一化(句法) ----
  // 命令名是变量(`$CMD -rf /`):不展开变量就永远不知道它是什么(§7/D2.4)。
  // 归 exec 而不是 null —— 它确实是"要跑一个东西",exec 是诚实的描述;
  // 归 null 会让 `case $x in ... esac` 这类日常写法整条变打断
  // (项目简介的判据:把良性命令变打断是产品失败,不是保守)。
  if (/^\$[A-Za-z_{]/.test(head)) return [{ kind: "exec" }];

  const name = basename(head);

  // 命令名本身就不像命令(纯数字、含 `=`、空)—— 说明前面某一层剥错了,
  // 这条命令我们其实没看懂。落 null ⇒ unknown ⇒ SOFT,比落 exec 诚实。
  if (!LOOKS_LIKE_COMMAND.test(name)) return null;

  // ---- 命令语义:交给 classify.ts ----
  const c = classifyCommand(name, rest);
  if (c === null) return null;

  switch (c.kind) {
    case "silent":
      return [{ kind: "silent" }];
    case "exec":
      return [{ kind: "exec" }];
    case "shell":
      return resolveShell(c.argv);
    case "cmd":
      return [{ kind: "verb", verb: c.verb, targets: extractTargets(c.role, c.args, c.name) }];
    case "find":
      return [
        { kind: "verb", verb: findVerb(c.args), targets: extractTargets("findPaths", c.args, "find") },
      ];
    case "tar":
      return [
        { kind: "verb", verb: tarVerb(c.args), targets: extractTargets("allArgs", c.args, "tar") },
      ];
    case "git": {
      // 表外子命令 ⇒ verb 为 null ⇒ exec(§7)
      const g = classifyGit(c.args);
      if (g.verb === null) return [{ kind: "exec" }];
      return [{ kind: "verb", verb: g.verb, targets: extractTargets(g.role, g.args, "git") }];
    }
  }
}

/**
 * `bash -c "rm -rf x"` 是 §7 点名的万能逃逸口:名义上 exec,实际是 delete。
 * 这里把 `-c` 的实参当命令行递归解析 —— 它已经不是被引号保护的字符串了。
 *
 * 递归解析失败 ⇒ 退回 exec(而不是把整条命令判成 unknown):
 * exec 本身仍会被规则层看见,不会变成静默放行。
 */
function resolveShell(args: readonly { readonly text: string; readonly quoted: boolean }[]): Resolved[] {
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


/**
 * 剥掉包装词自己的选项,返回真正要执行的东西。
 *
 * **每个包装词有自己的选项表** —— 这是上一版最大的错:
 * 用一张全局表去剥所有包装词,于是 `nice -n 10 rm` 里的 `-n` 不被当成吃值,
 * `10` 就成了"命令名",整条命令落 unknown。
 * `-n` 对 `nice` 吃值、对 `rm` 不吃值,这两种用法会出现在同一条命令串里,
 * 所以包装层和命令层必须各有一张表。
 */
const WRAPPER_VALUE_SHORT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["nice", new Set(["n"])],
  ["ionice", new Set(["c", "n", "p", "P", "u"])],
  ["timeout", new Set(["s", "k"])],
  ["xargs", new Set(["I", "n", "P", "s", "a", "d", "E", "L", "e"])],
  ["sudo", new Set(["u", "g", "p", "C", "U", "R", "T", "r", "t", "h"])],
  ["doas", new Set(["u", "C"])],
  ["time", new Set(["o", "f"])],
  ["stdbuf", new Set(["i", "o", "e"])],
  ["nohup", new Set([])],
  ["env", new Set(["u", "C", "S"])],
  ["setsid", new Set([])],
  ["command", new Set([])],
  ["builtin", new Set([])],
  ["exec", new Set(["a", "c"])],
]);

/** 包装词里吃值的长选项 */
const WRAPPER_VALUE_LONG: ReadonlySet<string> = new Set([
  "--user", "--group", "--prompt", "--chdir", "--unset", "--close-from",
  "--process-group", "--signal", "--kill-after", "--replace", "--max-args",
  "--max-procs", "--delimiter", "--arg-file", "--eof", "--output", "--input",
  "--format", "--output-error", "--argv0", "--split-string",
]);

function peelWrapper(head: string, rest: readonly Token[]): Token[] | null {
  const shortTable = WRAPPER_VALUE_SHORT.get(head) ?? new Set<string>();
  let i = 0;

  while (i < rest.length) {
    const tok = rest[i]!;
    const t = tok.text;

    if (t === "--") {
      i += 1;
      break;
    }
    if (t.startsWith("--")) {
      if (!t.includes("=") && WRAPPER_VALUE_LONG.has(t)) i += 2;
      else i += 1;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      // 短选项簇:逐字符扫,遇到吃值字符且它是最后一位 → 吞下一个 token
      const body = t.slice(1);
      let takesValue = false;
      for (let k = 0; k < body.length; k += 1) {
        if (shortTable.has(body[k]!)) {
          takesValue = k === body.length - 1;
          break;
        }
      }
      i += takesValue ? 2 : 1;
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

  // timeout 的第一个位置参数是时长(`timeout 5 rm …` / `timeout 2.5s rm …`),
  // 不是命令。不吃掉它的话 `5` 会被当成命令名 → 落 unknown → 白打断一次。
  if (head === "timeout") {
    const dur = rest[i];
    if (dur !== undefined && /^\d+(?:\.\d+)?[smhd]?$/.test(dur.text)) i += 1;
  }

  const remaining = rest.slice(i);
  if (remaining.length === 0) return null; // 光有包装词没有命令 —— 判失败
  return remaining;
}
