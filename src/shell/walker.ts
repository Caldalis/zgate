// 遍历层:AST → ShellCommand[]。
//   1. 遍历树,把每个 command 节点变成一条 ShellCommand
//   2. 摘重定向,把写目标追加到对应命令上
//   3. 处理逃逸口:`bash -c` 递归、`eval` 放弃、命令替换放弃
//   4. 遇到看不懂的东西返回 null(⇒ 上层落 unknown ⇒ SOFT)
//
// 命令语义(verb 是什么、哪些参数是目标)不在本层,问 classify.ts。

import { classifyCommand, classifyGit, extractTargets, findVerb, isAssignment, tarVerb } from "./classify.ts";
import type { ResourceSpec } from "./classify.ts";
import type { Node } from "./ast.ts";
import { parse, walk } from "./ast.ts";
import type { Token } from "./lex.ts";
import { splitTopLevel, tokenize } from "./lex.ts";

/** 一条命令的解析意图。与 legacy.ts 的 ShellCommand 同构。 */
export interface ShellCommand {
  readonly verb: import("../core/action.ts").Verb;
  readonly targets: readonly ResourceSpec[];
}

/** 递归上限:防 `bash -c "bash -c …"` 自引用 */
const MAX_DEPTH = 8;

/** 破坏性前置词:剥掉自己继续看后面那个命令 */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "timeout", "xargs", "command",
  "builtin", "nice", "ionice", "stdbuf", "setsid", "exec",
]);

/** 每个包装词自己的「吃值短选项」。与 legacy.ts 的同名表是同一份事实,两份实现各留一份 */
const WRAPPER_VALUE_SHORT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["nice", new Set(["n"])],
  ["ionice", new Set(["c", "n", "p", "P", "u"])],
  ["timeout", new Set(["s", "k"])],
  ["xargs", new Set(["I", "n", "P", "s", "a", "d", "E", "L", "e"])],
  ["sudo", new Set(["u", "g", "p", "C", "U", "R", "T", "r", "t", "h"])],
  ["doas", new Set(["u", "C"])],
  ["time", new Set(["o", "f"])],
  ["stdbuf", new Set(["i", "o", "e"])],
  ["env", new Set(["u", "C", "S"])],
  ["exec", new Set(["a", "c"])],
]);

/** 命令名取 basename */
function basenameOf(head: string): string {
  const slash = head.lastIndexOf("/");
  return slash === -1 ? head : head.slice(slash + 1);
}

/** 命令名得像命令,不像就别硬猜(落 unknown 比落 exec 诚实)。`[` 和 `.` 是合法的内建命令名,要单列。 */
const LOOKS_LIKE_COMMAND = /^(?:\[|\.|[A-Za-z_:][A-Za-z0-9_.+-]*)$/;

/**
 * 剥掉包装词,返回新的 head 下标;剥不下去返回 null。
 * 每个包装词有自己的选项表,不能用一张全局表:`-n` 对 nice 吃值、对 rm 不吃值。
 */
function peelWrappers(argv: readonly Token[], start: number): { head: number } | null {
  let i = start;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const tok = argv[i];
    if (tok === undefined) return null;
    if (!WRAPPERS.has(tok.text)) break;

    const table = WRAPPER_VALUE_SHORT.get(tok.text) ?? new Set<string>();
    i += 1;
    // 包装词自己的选项与赋值
    let sawBareNumber = false;
    while (i < argv.length) {
      const t = argv[i]!;
      if (t.text === "--") {
        i += 1;
        break;
      }
      if (!t.quoted && t.text.startsWith("--")) {
        i += 1;
        continue;
      }
      if (!t.quoted && t.text.startsWith("-") && t.text.length > 1) {
        // 短选项簇:最后一个字符吃值就吞下一个
        const body = t.text.slice(1);
        let takesValue = false;
        for (let k = 0; k < body.length; k += 1) {
          if (table.has(body[k]!)) {
            takesValue = k === body.length - 1;
            break;
          }
        }
        i += takesValue ? 2 : 1;
        continue;
      }
      if (!t.quoted && isAssignment(t.text)) {
        i += 1;
        continue;
      }
      // timeout 的时长参数
      if (tok.text === "timeout" && !sawBareNumber && /^\d+(?:\.\d+)?[smhd]?$/.test(t.text)) {
        sawBareNumber = true;
        i += 1;
        continue;
      }
      break;
    }
  }
  const head = argv[i];
  if (head === undefined) return null;
  return { head: i };
}

/**
 * 整条命令行 → 命令意图列表。
 *
 * - `[]`   没有需要裁决的部分
 * - `null` 没看懂(上层兜底成 SOFT)
 */
export function walkToCommands(command: string): ShellCommand[] | null {
  const segments = splitTopLevel(command);
  if (segments === null) return null;

  const out: ShellCommand[] = [];
  const ctx = new WalkContext();
  for (const segment of segments) {
    const tokens = tokenize(segment.text, segment.heredocDelimiter);
    if (tokens === null) return null;

    const { root, errors } = parse(tokens);
    // 文法层面有错 ⇒ 整条放弃(安全默认值)
    if (errors.length > 0) return null;

    if (!ctx.collect(root, out, 0)) return null;
  }
  return out;
}

class WalkContext {
  /** 重定向收集:遍历时把 file_redirect 挂到最近的一条命令上 */
  private pendingWrites: string[] = [];

  collect(node: Node, out: ShellCommand[], depth: number): boolean {
    if (depth > MAX_DEPTH) return false;

    switch (node.type) {
      case "program":
        return this.collectChildren(node, out, depth);

      case "list":
      case "pipeline":
      case "negation":
      case "compound_statement":
      case "subshell":
      case "do_group":
      case "if_statement":
      case "for_statement":
      case "while_statement":
      case "until_statement":
      case "case_statement":
      case "case_item":
      case "elif_clause":
      case "else_clause":
        return this.collectChildren(node, out, depth);

      // 函数定义体是延迟执行,声明时不产出 Action;危险内容(如 fork bomb)由 pre 轮规则对原始命令做模式匹配兜住。
      case "function_definition":
        return true;

      case "redirected_statement": {
        // 先收重定向,再收命令 —— 顺序反过来写目标就挂错了
        const writes = this.redirectTargets(node);
        const before = this.pendingWrites;
        this.pendingWrites = writes;
        const mark = out.length;
        const ok = this.collectChildren(node, out, depth);
        this.pendingWrites = before;
        if (!ok) return false;
        // 纯重定向(`> out.txt`,没有命令):它本身就是一次写
        if (writes.length > 0 && out.length === mark) {
          out.push({
            verb: "write",
            targets: writes.map((raw) => ({ kind: "file" as const, raw })),
          });
        }
        return true;
      }

      case "command": {
        // 本命令产出的意图落进 out 之后再统一挂上重定向目标,`echo hi > f` 和 `rm b &> f` 的 f 都不会丢
        const before = out.length;
        if (!this.emitCommand(node, out, depth)) return false;
        if (this.pendingWrites.length > 0) {
          for (let k = before; k < out.length; k += 1) {
            const cmd = out[k]!;
            out[k] = {
              verb: cmd.verb,
              targets: [
                ...cmd.targets,
                ...this.pendingWrites.map((raw) => ({
                  kind: "file" as const,
                  raw,
                  from: "redirect" as const,
                })),
              ],
            };
          }
        }
        return true;
      }

      // 叶子/无行为节点
      case "word":
      case "number":
      case "string":
      case "raw_string":
      case "variable_assignment":
      case "variable_name":
      case "simple_expansion":
      case "expansion":
      case "concatenation":
      case "file_redirect":
      case "heredoc_redirect":
      case "herestring_redirect":
      case "file_descriptor":
      case "heredoc_start":
      case "heredoc_body":
      case "heredoc_end":
      case "comment":
      case "raw":
        return true;

      // 命令替换 / 进程替换:放弃解析
      case "command_substitution":
      case "process_substitution":
        return false;

      case "command_name":
      case "test_command":
        return this.collectChildren(node, out, depth);
    }
  }

  private collectChildren(node: Node, out: ShellCommand[], depth: number): boolean {
    for (const child of node.children) {
      if (!this.collect(child, out, depth + 1)) return false;
    }
    return true;
  }

  /** file_redirect 节点的目标文本 */
  private redirectTargets(node: Node): string[] {
    const out: string[] = [];
    const visit = (n: Node): void => {
      if (n.type === "file_redirect") {
        const last = n.children[n.children.length - 1];
        // 目标是 file_descriptor 的(`2>&1`)不算写文件
        if (last !== undefined && last.type !== "file_descriptor" && last.tokens[0] !== undefined) {
          out.push(last.tokens[0].text);
        }
        return;
      }
      for (const c of n.children) visit(c);
    };
    for (const c of node.children) visit(c);
    return out;
  }

  /** 一条 command 节点 → 一条(或多条)ShellCommand */
  private emitCommand(node: Node, out: ShellCommand[], depth: number): boolean {
    const argv = this.argvOf(node);
    if (argv.length === 0) return true;

    // 前置赋值在词法层可能就是 `FOO=1` 这样的单词
    let head = 0;
    while (head < argv.length && argv[head]!.quoted === false && isAssignment(argv[head]!.text)) {
      head += 1;
    }
    if (head >= argv.length) return true; // 光有赋值

    // 剥包装词(sudo / nice / timeout / xargs…):不剥的话 `nice -n 10 rm -rf /` 只会得到一个 exec,
    // 后面的 rm 就看不见了。
    const peeled = peelWrappers(argv, head);
    if (peeled === null) return false;
    head = peeled.head;

    const nameTok = argv[head]!;
    const args = argv.slice(head + 1);

    // 命令名取 basename(`/bin/rm` → `rm`),否则带路径的写法会整条落 exec,规则层什么都看不见
    const name = basenameOf(nameTok.text);
    if (!LOOKS_LIKE_COMMAND.test(name)) return false;

    // eval 一律放弃解析:实参是文本,不解析就不知道要跑什么,危险命令会藏在字符串里
    if (name === "eval") return false;

    const classified = classifyCommand(name, args);
    if (classified === null) return false;

    switch (classified.kind) {
      case "silent":
        return true;

      case "exec":
        out.push({ verb: "exec", targets: [] });
        return true;

      case "shell":
        return this.expandInlineScript(classified.argv, out, depth);

      case "cmd":
        out.push({
          verb: classified.verb,
          targets: extractTargets(classified.role, classified.args, classified.name),
        });
        return true;

      case "find":
        out.push({
          verb: findVerb(classified.args),
          targets: extractTargets("findPaths", classified.args, "find"),
        });
        return true;

      case "tar":
        out.push({
          verb: tarVerb(classified.args),
          targets: extractTargets("allArgs", classified.args, "tar"),
        });
        return true;

      case "git": {
        const g = classifyGit(classified.args);
        if (g.verb === null) {
          out.push({ verb: "exec", targets: [] });
          return true;
        }
        out.push({ verb: g.verb, targets: extractTargets(g.role, g.args, "git") });
        return true;
      }
    }
  }

  /** command 节点的 argv(命令名 + 参数),重定向不算 argv */
  private argvOf(node: Node): Token[] {
    const out: Token[] = [];
    const visit = (n: Node): void => {
      if (n.type === "command_name") {
        const leaf = n.children[0] ?? n;
        out.push(...leaf.tokens);
        return;
      }
      if (n.type === "variable_assignment") {
        out.push(...n.tokens);
        return;
      }
      // 重定向及其内容不是 argv
      if (
        n.type === "file_redirect" ||
        n.type === "heredoc_redirect" ||
        n.type === "herestring_redirect" ||
        n.type === "file_descriptor"
      ) {
        return;
      }
      if (n.children.length === 0) {
        out.push(...n.tokens);
        return;
      }
      for (const c of n.children) visit(c);
    };
    for (const c of node.children) visit(c);
    return out;
  }

  /**
   * `bash -c "rm -rf x"` 是万能逃逸口:把 `-c` 的实参递归走一遍 walkToCommands。
   * 递归失败退回 exec 而不是整条 unknown,exec 仍会被规则层看见,不会静默放行。
   */
  private expandInlineScript(
    argv: readonly { readonly text: string; readonly quoted: boolean }[],
    out: ShellCommand[],
    depth: number,
  ): boolean {
    let script: string | null = null;
    for (let i = 0; i < argv.length; i += 1) {
      const t = argv[i]!;
      if (t.text === "--") break;
      if (t.text === "-c") {
        script = argv[i + 1]?.text ?? "";
        break;
      }
      if (!t.quoted && t.text.startsWith("-") && !t.text.startsWith("--") && t.text.includes("c")) {
        script = argv[i + 1]?.text ?? "";
        break;
      }
    }
    if (script === null) {
      out.push({ verb: "exec", targets: [] });
      return true;
    }
    if (depth >= MAX_DEPTH) return false;

    const inner = walkToCommands(script);
    if (inner === null || inner.length === 0) {
      out.push({ verb: "exec", targets: [] });
      return true;
    }
    out.push(...inner);
    return true;
  }
}

export type { ResourceSpec };
export { walk };
