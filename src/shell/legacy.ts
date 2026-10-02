// 手写状态机版解析器:已被 AST 路(walker.ts)替换,只被差分测试 import。
// 它是独立写出来的第二实现,和 AST 版对撞时差异就是信号。
//
// 只回答 shell 文法问题:拆命令、取命令词与参数、处理重定向 / 引号 / heredoc;命令语义问 classify.ts。
// 解析失败 / 命令替换 / eval ⇒ 整体返回 null,调用方落 unknown。raw 绝不规范化。
// 不做变量展开、不模拟 `cd` 对后续路径的影响、不 stat 任何路径(kind 恒为 "file")。

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


/** 一条命令的解析意图。与 walker.ts 的 ShellCommand 同构。 */
export interface ShellCommand {
  readonly verb: Verb;
  readonly targets: readonly ResourceSpec[];
}

/**
 * 解析一条 Bash 命令行。
 *
 * - `[]`   —— 命令里没有需要裁决的部分(空命令、纯赋值、纯 shell 内建)
 * - `null` —— 解析失败,调用方必须落 `verb: "unknown"`
 * - 数组   —— 每条独立命令一个意图
 */
export function parseCommand(command: string): ShellCommand[] | null {
  const segments = splitTopLevel(command);
  if (segments === null) return null;

  const out: ShellCommand[] = [];
  for (const segment of segments) {
    const tokens = tokenize(segment.text, segment.heredocDelimiter);
    if (tokens === null) return null;

    // splitTopLevel 只切换行,手写版是线性扫描,要的是"每条命令一段",所以自己再按算子切一次。
    // 两份实现切分假设不同,这个差异刻意保留,正好相互校验。
    for (const piece of splitLegacy(tokens)) {
      const result = analyzeSegment(piece);
      if (result === null) return null;
      for (const cmd of result) out.push(cmd);
    }
  }
  return out;
}

/** 按 `;` `&&` `||` `|` `&` 把 token 流切成"每条命令一段"。引号内的分隔符已被 tokenize 处理,只看 token 文本。 */
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

  // eval 一律放弃解析。`source` / `.` 要在命令名校验之前处理:`.` 不像命令名,却是常用内建。
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

  // 函数定义头(`f` `(` `)`)只声明不执行,不产出 Action:延迟执行没有当下的 turn_id。
  // fork bomb 由 pre 轮规则对原始命令做模式匹配兜住。
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
  // 命令名是变量(`$CMD -rf /`):不展开就不知道它是什么。归 exec 而不是 null ——
  // 它确实在跑东西;归 null 会让 `case $x in ... esac` 这类日常写法整条变打断。
  if (/^\$[A-Za-z_{]/.test(head)) return [{ kind: "exec" }];

  const name = basename(head);

  // 命令名不像命令(纯数字、含 `=`、空)说明前面某一层剥错了:落 null ⇒ unknown,比落 exec 诚实。
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
      // 表外子命令 ⇒ verb 为 null ⇒ exec
      const g = classifyGit(c.args);
      if (g.verb === null) return [{ kind: "exec" }];
      return [{ kind: "verb", verb: g.verb, targets: extractTargets(g.role, g.args, "git") }];
    }
  }
}

/**
 * `bash -c "rm -rf x"` 是万能逃逸口:名义上 exec,实际是 delete。把 `-c` 的实参当命令行递归解析;
 * 递归失败退回 exec 而不是整条 unknown,exec 仍会被规则层看见,不会静默放行。
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
 * 包装词各自的「吃值短选项」。`-n` 对 nice 吃值、对 rm 不吃值,两种用法会出现在同一条命令里,
 * 所以包装层和命令层各有一张表。
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

  // timeout 的第一个位置参数是时长(`timeout 5 rm …`),不吃掉的话 `5` 会被当成命令名,白打断一次
  if (head === "timeout") {
    const dur = rest[i];
    if (dur !== undefined && /^\d+(?:\.\d+)?[smhd]?$/.test(dur.text)) i += 1;
  }

  const remaining = rest.slice(i);
  if (remaining.length === 0) return null; // 光有包装词没有命令 —— 判失败
  return remaining;
}
