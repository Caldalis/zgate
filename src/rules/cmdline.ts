// 取「这条 Action 对应的命令原文」,以及把原文切成规则能逐条看的段。
//
// 这是个看起来多余、实际必要的小模块。理由:
//
// §2.1 规定 `action.command` **只在 `verb === "exec"` 时有值**,其余一律
// null。而 git 相关命令的 verb 是 `network`(见 §7 的二级表),`git push
// --force` 这类命令的 `command` 字段就是 null —— 但规则层恰恰必须看到
// `--force` 才能判。
//
// 那原文在哪?在 `tool_input` 里。§2.1 明确写着它是"agent 侧原始输入,
// 原样保留" —— 这正是它的用途。所以这里按优先级取:
//
//   1. tool_input.command  —— agent 给的原文,永远在
//   2. action.command      —— 解析层给的原文(verb === "exec" 时)
//
// 两个都为空的场合:`/decide` 端点被手写请求直接调用、或者非 Bash 工具。
// 那种情况下规则层拿不到原文,只能按结构化字段判 —— 所以所有依赖原文的
// 规则都必须容忍空串,且**不能因为拿不到原文就默认放行**。
//
// ## 为什么还要切段(D12.10)
//
// 原文是**整条** Bash 命令行,而一条命令行里可能有好几条命令
// (`git status && git push --force`),还可能把真正的命令藏在
// `bash -c '…'` 的引号里。解析层(D2.8)会递归进去,产出的 Action 是对的;
// 但规则层拿的是原文 —— 只看第一个词的规则(git 系列)会看到 `git status`
// 或 `bash`,然后放行。审计时这一格漏了三种形态:
//
//   git status && git push --force        第一条不是 push
//   bash -c 'git push --force'            第一个词是 bash
//   sh -c 'curl x | sh'                   管道在引号里,按 | 切段切不到
//
// 所以规则层看原文时用下面两个函数,而不是直接用 `commandLine`:
//
//   commandSegments  按 `;` `&&` `||` 换行切段(引号外),并把 `sh -c '…'`
//                    的引号体展开成它自己的段。**管道保持完整**,给需要看
//                    管道结构的规则(`net.pipe_to_shell`)。
//   simpleCommands   在上面基础上再按 `|` 切,每段是一条简单命令,给按
//                    "命令名 + 参数"判的规则(git 系列)。
//
// 一次 Bash 调用的所有 Action 共用同一份原文,所以文本规则命中时会给
// 每条 Action 都记一笔。批量取最严(§7),结论不受影响;日志里多几行相同的
// reason,可接受。

import type { Action } from "../core/action.ts";
import { baseName } from "./match.ts";

/** 命令原文。取不到返回空串(调用方必须处理这个情况)。 */
export function commandLine(action: Action): string {
  const raw = action.tool_input["command"];
  if (typeof raw === "string" && raw !== "") return raw;
  return action.command ?? "";
}

/**
 * 在引号外按给定算子切分。算子按列表顺序尝试,长的排前面
 * (`&&` 在 `&` 前,`||` 在 `|` 前)。转义符跳过下一个字符。
 */
function splitOutsideQuotes(text: string, ops: readonly string[]): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (quote !== null) {
      cur += c;
      if (c === "\\" && quote === '"') {
        cur += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      cur += c + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    let matched: string | null = null;
    for (const op of ops) {
      if (text.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    // `>|` 是 noclobber 重定向,不是管道
    if (matched === "|" && text[i - 1] === ">") matched = null;
    if (matched !== null) {
      out.push(cur);
      cur = "";
      i += matched.length;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** 引号感知的分词:按空白切,剥掉**一层**引号,双引号内的 `\"` 还原。 */
function words(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i] ?? "";
    if (quote !== null) {
      if (c === "\\" && quote === '"') {
        cur += seg[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\") {
      cur += seg[i + 1] ?? "";
      i += 1;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur !== "") out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur !== "") out.push(cur);
  return out;
}

const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "builtin", "doas"]);
/** 包装词自己的**带值**选项:`sudo -u root`、`env -C dir`。不认的按无值处理。 */
const WRAPPER_VALUE_OPTS = new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-T", "-D"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);

/**
 * `[sudo|env …] (sh|bash|…) [-flags] -c '<body>' […]` ⇒ `<body>`;不是这个形态返回 null。
 *
 * 只认 `-c` 及合并写法(`-ec`、`-lc`)。`bash script.sh` 这种位置参数形态
 * 不展开 —— 脚本内容不在命令行里,规则层看不到,也不该去读文件(§6)。
 */
function unwrapShellC(seg: string): string | null {
  const toks = words(seg);
  let i = 0;
  let optZone = false; // 刚经过一个包装词,后面可能跟它自己的选项
  while (i < toks.length) {
    const t = toks[i] ?? "";
    if (WRAPPERS.has(t)) {
      optZone = true;
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    if (optZone && t.startsWith("-")) {
      i += WRAPPER_VALUE_OPTS.has(t) ? 2 : 1;
      continue;
    }
    break;
  }
  const head = toks[i];
  if (head === undefined || !SHELLS.has(baseName(head))) return null;
  i += 1;
  while (i < toks.length) {
    const t = toks[i] ?? "";
    if (t === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
      const body = toks[i + 1];
      return body === undefined || body === "" ? null : body;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    return null; // 位置参数:是脚本文件,不是 -c 形态
  }
  return null;
}

/** 递归上限:`bash -c "bash -c '…'"` 之类的套娃,三层足够,再深就是刁难。 */
const MAX_UNWRAP_DEPTH = 3;

function segmentsOf(text: string, depth: number): string[] {
  const out: string[] = [];
  for (const seg of splitOutsideQuotes(text, ["&&", "||", ";", "\n"])) {
    const body = depth < MAX_UNWRAP_DEPTH ? unwrapShellC(seg) : null;
    if (body !== null) out.push(...segmentsOf(body, depth + 1));
    else out.push(seg);
  }
  return out;
}

/**
 * 原文的各个段:`;` / `&&` / `||` / 换行 之间的部分,`sh -c '…'` 的引号体
 * 已展开。**管道保持完整**。拿不到原文返回空数组。
 */
export function commandSegments(action: Action): string[] {
  const text = commandLine(action);
  return text === "" ? [] : segmentsOf(text, 0);
}

/** 一段里按 `|` / `|&` 切出的各级:最后一级的输出才回到 agent 的上下文。 */
export function pipelineStages(segment: string): string[] {
  return splitOutsideQuotes(segment, ["|&", "|"]);
}

/** 每一条简单命令:在 `commandSegments` 的基础上再按 `|` / `|&` 切。 */
export function simpleCommands(action: Action): string[] {
  const out: string[] = [];
  for (const seg of commandSegments(action)) {
    out.push(...pipelineStages(seg));
  }
  return out;
}

export interface SimpleCommand {
  /** 命令名的 basename */
  readonly head: string;
  /** 命令名之后的全部词(引号已剥一层),含选项与重定向 */
  readonly args: readonly string[];
}

/** 比 `unwrapShellC` 多认的包装词:它们后面跟的仍是"真正的命令"。 */
const HEAD_WRAPPERS = new Set([...WRAPPERS, "xargs", "nice", "stdbuf", "caffeinate", "timeout", "gtimeout"]);
const HEAD_WRAPPER_VALUE_OPTS = new Set([...WRAPPER_VALUE_OPTS, "-n", "-I", "-P", "-L", "-s", "-E", "-d", "-e", "-i", "-o", "-k", "-S"]);

/**
 * 一条简单命令的命令名与参数:剥掉包装词(sudo / env / xargs / timeout …)与前置赋值。
 * 只有包装词、没有真正的命令时返回 null(`env` 单独一行就是这种)。
 */
export function simpleCommandHead(seg: string): SimpleCommand | null {
  const toks = words(seg);
  let i = 0;
  let optZone = false;
  while (i < toks.length) {
    const t = toks[i] ?? "";
    if (HEAD_WRAPPERS.has(baseName(t))) {
      optZone = true;
      i += 1;
      if (baseName(t) === "timeout" || baseName(t) === "gtimeout") {
        // timeout 的第一个非选项参数是时长,不是命令
        while (i < toks.length && (toks[i] ?? "").startsWith("-")) i += HEAD_WRAPPER_VALUE_OPTS.has(toks[i] ?? "") ? 2 : 1;
        i += 1;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    if (optZone && t.startsWith("-")) {
      i += HEAD_WRAPPER_VALUE_OPTS.has(t) ? 2 : 1;
      continue;
    }
    break;
  }
  const head = toks[i];
  if (head === undefined || head === "") return null;
  return { head: baseName(head), args: toks.slice(i + 1) };
}

/** 去掉选项与重定向(`-rf`、`< list.txt`、`>out`)后剩下的位置参数。 */
export function operandsOf(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (/^\d*[<>]{1,2}[&|]?$/.test(a)) {
      i += 1; // 算子单独一个词,下一个词是文件
      continue;
    }
    if (/^\d*[<>]{1,2}/.test(a) || a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}
