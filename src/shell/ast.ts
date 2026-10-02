// 文法层:Token[] → Node(递归下降)。只回答 shell 文法问题,不知道任何命令名、任何 verb。
//
// 输入是一个段落的完整 token 流:`;` `&&` `||` `|` 在这里才构成 `list` / `pipeline` 节点,
// 规则才可能用上"这两条命令是 && 关系"这类结构。
//
// 节点命名对齐 tree-sitter-bash 的文法,便于对照。
// 不用 tree-sitter 本体:它会拖进 node-gyp-build 原生构建链,而依赖只有 zod;词法 lex.ts 已经有了,缺的只是结构这一层。

import type { Token } from "./lex.ts";

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/**
 * 抽象节点。`tokens` 是原始 token 切片而不是转写过的字符串,quoted / fd 这些词法信息不会丢。
 * 要文本用 `textOf()`(仅供日志 / 调试)。
 */
export interface Node {
  readonly type: NodeType;
  readonly tokens: readonly Token[];
  readonly children: readonly Node[];
}

export type NodeType =
  // 容器
  | "program"
  | "list" // `a; b` / `a && b` / `a || b` / `a & b`
  | "pipeline" // `a | b`
  | "negation" // `! cmd`
  // 命令
  | "command"
  | "command_name"
  | "variable_assignment"
  | "variable_name"
  | "word"
  | "number"
  | "string"
  | "raw_string"
  | "simple_expansion" // $VAR
  | "expansion" // ${VAR}
  | "concatenation"
  | "command_substitution" // $(…) / `…`
  | "process_substitution" // <(…) / >(…)
  | "comment"
  // 控制结构
  | "if_statement"
  | "for_statement"
  | "while_statement"
  | "until_statement"
  | "case_statement"
  | "case_item"
  | "elif_clause"
  | "else_clause"
  | "do_group"
  | "subshell"
  | "compound_statement" // { …; }
  | "function_definition"
  // 重定向
  | "redirected_statement"
  | "file_redirect"
  | "heredoc_redirect"
  | "herestring_redirect"
  | "file_descriptor"
  | "heredoc_start"
  | "heredoc_body"
  | "heredoc_end"
  // test
  | "test_command"
  // 没归类的 token 流
  | "raw";

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface ParseResult {
  readonly root: Node;
  /** 文法层面没能理解的部分。非空 ⇒ 调用方必须落 unknown */
  readonly errors: readonly string[];
  /** 预留,目前恒为空:`bash -c "…"` 由 walker 递归处理 */
  readonly nested: readonly string[];
}

/** 一个段落的 token 流 → AST。不抛异常:问题记进 `errors`,上层据此落 unknown。 */
export function parse(tokens: readonly Token[]): ParseResult {
  const b = new Builder(tokens);
  const root = b.parseProgram();
  return { root, errors: b.errors, nested: b.nested };
}

/**
 * 节点的文本,token 之间补一个空格。只给日志和调试用:补回的空格丢了"两个词原本是否相连",
 * 判断逻辑请读 `tokens`。
 */
export function textOf(node: Node): string {
  return node.tokens.map((t) => t.text).join(" ");
}

/** 深度优先遍历所有节点 */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

// ---------------------------------------------------------------------------
// 递归下降
// ---------------------------------------------------------------------------

/** 逻辑连接符 —— 它们构成 list 节点 */
const LOGICAL: ReadonlySet<string> = new Set([";", "&&", "||", "&", "\n"]);
/** 管道 */
const PIPE = "|";
/** 闭合关键字:命令名位置遇到它们就停 */
const CLOSERS: ReadonlySet<string> = new Set([
  "fi", "done", "esac", "}", ")", "then", "do", "else", "elif", "in",
]);

class Builder {
  readonly errors: string[] = [];
  readonly nested: string[] = [];
  private readonly tokens: readonly Token[];
  private i = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private at(text: string, offset = 0): boolean {
    return this.peek(offset)?.text === text;
  }

  private done(): boolean {
    return this.i >= this.tokens.length;
  }

  private node(type: NodeType, from: number, children: readonly Node[]): Node {
    return { type, tokens: this.tokens.slice(from, this.i), children };
  }

  /** 用一个已消费的 token 建叶子节点 */
  private leaf(type: NodeType, index: number): Node {
    const tok = this.tokens[index];
    return { type, tokens: tok === undefined ? [] : [tok], children: [] };
  }

  /** 消费掉多余的分隔符(空语句) */
  private skipSeparators(): void {
    while (!this.done() && this.at(";")) this.i += 1;
  }

  // ---- program:整条命令行 ----

  parseProgram(): Node {
    const children: Node[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.done()) break;
      const before = this.i;
      const stmt = this.parseList();
      if (stmt !== null) children.push(stmt);
      if (this.i === before) this.i += 1; // 兜底防死循环
    }
    return { type: "program", tokens: this.tokens, children };
  }

  /** list:`a; b` / `a && b` / `a || b`。连接符留在 node.tokens 里,上层要能看出是 `&&` 还是 `;`。 */
  private parseList(): Node | null {
    const from = this.i;
    const parts: Node[] = [];
    let sawSeparator = false;

    for (;;) {
      const stmt = this.parsePipeline();
      if (stmt === null) break;
      parts.push(stmt);
      const sep = this.peek();
      if (sep !== undefined && LOGICAL.has(sep.text)) {
        sawSeparator = true;
        this.i += 1;
        this.skipSeparators();
        if (this.done()) break;
        continue;
      }
      break;
    }

    if (parts.length === 0) {
      this.i = from;
      return null;
    }
    if (parts.length === 1 && !sawSeparator) return parts[0]!;
    return this.node("list", from, parts);
  }

  // ---- pipeline ----

  private parsePipeline(): Node | null {
    const from = this.i;
    const parts: Node[] = [];
    for (;;) {
      const cmd = this.parseStatement();
      if (cmd === null) break;
      parts.push(cmd);
      if (this.at(PIPE)) {
        this.i += 1;
        this.skipSeparators();
        continue;
      }
      break;
    }
    if (parts.length === 0) {
      this.i = from;
      return null;
    }
    if (parts.length === 1) return parts[0]!;
    return this.node("pipeline", from, parts);
  }

  // ---- 一条语句:控制结构 / 重定向语句 / 简单命令 ----

  private parseStatement(): Node | null {
    const tok = this.peek();
    if (tok === undefined) return null;
    if (LOGICAL.has(tok.text) || tok.text === PIPE) return null;
    if (CLOSERS.has(tok.text)) return null;

    switch (tok.text) {
      case "!": {
        const from = this.i;
        this.i += 1;
        const inner = this.parseStatement();
        return this.node("negation", from, inner === null ? [] : [inner]);
      }
      case "if":
        return this.parseIf();
      case "for":
        return this.parseFor();
      case "while":
      case "until":
        return this.parseWhile();
      case "case":
        return this.parseCase();
      case "function": {
        const from = this.i;
        this.i += 1;
        const name = this.parseSimpleCommand();
        const body = this.at("{") ? this.parseCompound() : null;
        return this.node("function_definition", from, [
          ...(name === null ? [] : [name]),
          ...(body === null ? [] : [body]),
        ]);
      }
      case "{":
        return this.parseCompound();
      case "(":
        return this.parseSubshell();
      default:
        // 函数定义 `name () { … }` 要在 parseSimpleCommand 之前识别,
        // 否则 `f(){ ... }` 会被切成一个叫 f 的命令加一个孤立的 `{`。
        if (this.isFunctionDefinition()) return this.parseFunctionDefinition();
        return this.parseCommandOrRedirect();
    }
  }

  /** 命令 + 重定向 + 前置赋值 */
  private parseCommandOrRedirect(): Node | null {
    const from = this.i;

    const leading: Node[] = [];
    while (this.isRedirectStart()) {
      const r = this.parseRedirect();
      if (r === null) break;
      leading.push(r);
    }

    const assigns: Node[] = [];
    while (this.isAssignment()) assigns.push(this.parseAssignment());

    const cmd = this.parseSimpleCommand();

    // 尾随重定向。命令节点在 fd 数字前就停了,所以这里要先吃掉那个数字,
    // parseRedirect 才能把 `2> err.log` 当成一个整体(fd + 目标)。
    const trailing: Node[] = [];
    for (;;) {
      if (!this.isRedirectStart()) {
        if (!this.consumeRawFdPrefix()) break;
      }
      const r = this.parseRedirect();
      if (r === null) break;
      trailing.push(r);
    }

    if (cmd === null && assigns.length === 0 && leading.length === 0 && trailing.length === 0) {
      this.i = from;
      return null;
    }

    // 只有一个赋值、没有别的 → 就是赋值本身
    if (cmd === null && assigns.length === 1 && leading.length === 0 && trailing.length === 0) {
      return assigns[0]!;
    }

    const children: Node[] = [];
    if (cmd !== null) children.push(...(assigns.length > 0 ? assigns : []), cmd);
    else children.push(...assigns);
    children.push(...leading, ...trailing);

    const hasRedirect = leading.length > 0 || trailing.length > 0;
    if (hasRedirect) return this.node("redirected_statement", from, children);

    // 没有前置赋值 ⇒ 直接就是那条命令,不要再套一层
    if (assigns.length === 0 && cmd !== null && children.length === 1) return children[0]!;
    return this.node("command", from, children);
  }

  /** `name ( ) {` 的形状 —— 往后看几个 token 就能定 */
  private isFunctionDefinition(): boolean {
    const t0 = this.peek();
    if (t0 === undefined || t0.quoted) return false;
    // bash 的函数名允许 `:` —— fork bomb `:(){ :|:& };:` 就靠这个
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(t0.text)) return false;
    return this.at("(", 1) && this.at(")", 2);
  }

  private parseFunctionDefinition(): Node {
    const from = this.i;
    this.i += 1; // name
    this.i += 2; // ( )
    const body = this.at("{") ? this.parseCompound() : null;
    return this.node("function_definition", from, [
      this.leaf("word", from),
      ...(body === null ? [] : [body]),
    ]);
  }

  private isAssignment(): boolean {
    const tok = this.peek();
    if (tok === undefined || tok.quoted) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.text)) return true;
    const next = this.peek(1);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.text) && next?.text === "=";
  }

  private parseAssignment(): Node {
    const from = this.i;
    const tok = this.peek()!;
    const children: Node[] = [this.leaf("variable_name", from)];
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.text)) {
      this.i += 1; // 名字
      this.i += 1; // `=`
      const v = this.parseWord();
      if (v !== null) children.push(v);
    } else {
      this.i += 1;
    }
    return this.node("variable_assignment", from, children);
  }

  /** 简单命令:命令名 + 参数 */
  private parseSimpleCommand(): Node | null {
    const from = this.i;
    const tok = this.peek();
    if (tok === undefined) return null;
    if (
      LOGICAL.has(tok.text) ||
      tok.text === PIPE ||
      CLOSERS.has(tok.text) ||
      this.isRedirectStart()
    ) {
      return null;
    }

    this.i += 1;
    const nameIdx = from;
    const children: Node[] = [this.node("command_name", nameIdx, [this.leaf("word", nameIdx)])];

    while (!this.done()) {
      const t = this.peek()!;
      if (LOGICAL.has(t.text) || t.text === PIPE || CLOSERS.has(t.text) || this.isRedirectStart()) break;
      if (t.text === ";;") break; // case 项分隔符,不是参数
      // `2> file`:这个数字是 fd 前缀,不是参数。
      // 停在它前面,让 parseRedirect 认领 —— 否则它会成为删除目标的一部分。
      if (!t.quoted && /^\d+$/.test(t.text) && this.isRedirectStartAt(1)) break;
      const w = this.parseWord();
      if (w === null) break;
      children.push(w);
    }
    return this.node("command", from, children);
  }

  /** 一个词。`$VAR` / `${VAR}` / `$(…)` 在这里分流成不同节点。 */
  private parseWord(): Node | null {
    const tok = this.peek();
    if (tok === undefined) return null;
    const from = this.i;
    const t = tok.text;

    // heredoc 分隔符不是参数(正常情况下 parseRedirect 已经消费掉了)
    if (tok.heredoc === true) return null;

    // `${VAR}` 被词法层合成一个 token
    if (t.startsWith("${")) {
      this.i += 1;
      this.recordSubstitution(t, from);
      return this.node(
        t.includes("$(") || t.includes("`") ? "command_substitution" : "expansion",
        from,
        [this.leaf("variable_name", from)],
      );
    }
    if (t.startsWith("$(") || t.includes("$(")) {
      this.i += 1;
      this.recordSubstitution(t, from);
      return this.node("command_substitution", from, [this.leaf("raw", from)]);
    }
    if (t.startsWith("<(") || t.startsWith(">(")) {
      this.i += 1;
      this.recordSubstitution(t, from);
      return this.node("process_substitution", from, [this.leaf("raw", from)]);
    }
    if (t === "`" || t.startsWith("`")) {
      this.i += 1;
      this.recordSubstitution(t, from);
      return this.node("command_substitution", from, [this.leaf("raw", from)]);
    }
    if (t.startsWith("$")) {
      this.i += 1;
      return this.node("simple_expansion", from, []);
    }
    if (/^\d+$/.test(t)) {
      this.i += 1;
      return this.node("number", from, []);
    }
    this.i += 1;
    // 引号包过的 token 记成 string / raw_string,保住"这是字面量"的信息
    if (tok.quoted) return this.node("string", from, []);
    return this.node("word", from, []);
  }

  /** 占位,目前什么都不登记。 */
  private recordSubstitution(text: string, _index: number): void {
    void text;
    void _index;
  }

  // ---- 重定向 ----

  private isRedirectStart(): boolean {
    return this.isRedirectStartAt(0);
  }

  /** 吃掉一个裸 fd 数字(`2> err.log` 的 `2`)。后面紧贴重定向算子才算,`head -n 5 file` 的 `5` 不会被误吃。 */
  private consumeRawFdPrefix(): boolean {
    const t = this.peek();
    if (t === undefined || t.quoted || !/^\d+$/.test(t.text)) return false;
    if (!this.isRedirectStartAt(1)) return false;
    this.i += 1;
    return true;
  }

  private isRedirectStartAt(offset: number): boolean {
    const t = this.peek(offset)?.text;
    if (t === undefined) return false;
    return (
      t === ">" || t === ">>" || t === ">|" || t === "<" || t === "<<" ||
      t === "<<<" || t === ">&" || t === "<&" || t === "&>" || t === "&>>"
    );
  }

  private parseRedirect(): Node | null {
    const from = this.i;
    const op = this.peek();
    if (op === undefined) return null;

    if (op.text === "<<" || op.text === "<<<") {
      this.i += 1;
      const children: Node[] = [];
      const startIdx = this.i;
      // 分隔符由词法层标记(它和普通单词在文本上无从区分)
      if (this.peek()?.heredoc === true) {
        this.i += 1;
        children.push(this.leaf("heredoc_start", startIdx));
      } else if (!this.done()) {
        // `<<` 后面不是分隔符 —— 畸形
        this.errors.push("heredoc 没有分隔符");
      }
      return this.node(
        op.text === "<<" ? "heredoc_redirect" : "herestring_redirect",
        from,
        children,
      );
    }

    this.i += 1;

    // `2> file` 的 fd 是算子之前的独立数字 token,`2>&1` 的 fd 词法层已记进 op.fd。
    // 两种都要认,节点从 fd 的位置开始切 token。
    const fdIndex = op.fd !== null ? from : (() => {
      const prev = this.tokens[from - 1];
      return prev !== undefined && !prev.quoted && /^\d+$/.test(prev.text) ? from - 1 : -1;
    })();
    const nodeFrom = fdIndex >= 0 ? fdIndex : from;

    const children: Node[] = [];
    if (fdIndex >= 0) children.push(this.leaf("file_descriptor", fdIndex));

    const target = this.peek();
    if (target !== undefined && !LOGICAL.has(target.text) && target.text !== PIPE) {
      const targetIdx = this.i;
      this.i += 1;
      if (/^&\d+$/.test(target.text) || /^\d+$/.test(target.text)) {
        children.push(this.leaf("file_descriptor", targetIdx));
      } else {
        children.push(this.wordAt(targetIdx));
      }
    } else if (op.fd === null && !/^[<>]&$/.test(op.text)) {
      this.errors.push(`重定向 ${op.text} 没有目标`);
    }

    return this.node("file_redirect", nodeFrom, children);
  }

  /** 已消费位置的词节点 */
  private wordAt(index: number): Node {
    const tok = this.tokens[index];
    if (tok === undefined) return { type: "word", tokens: [], children: [] };
    const t = tok.text;
    if (t.startsWith("${")) return { type: "expansion", tokens: [tok], children: [] };
    if (t.startsWith("$")) return { type: "simple_expansion", tokens: [tok], children: [] };
    if (tok.quoted) return { type: "string", tokens: [tok], children: [] };
    return { type: "word", tokens: [tok], children: [] };
  }

  // ---- 控制结构 ----

  private parseIf(): Node {
    const from = this.i;
    this.i += 1; // if
    const children: Node[] = [];

    // 条件部分:一直读到 then
    children.push(...this.parseBodyUntil(new Set(["then"])));
    if (this.at("then")) this.i += 1;
    children.push(...this.parseBodyUntil(new Set(["elif", "else", "fi"])));

    for (;;) {
      if (this.at("elif")) {
        const e = this.i;
        this.i += 1;
        const cond = this.parseBodyUntil(new Set(["then"]));
        if (this.at("then")) this.i += 1;
        const body = this.parseBodyUntil(new Set(["elif", "else", "fi"]));
        children.push(this.node("elif_clause", e, [...cond, ...body]));
        continue;
      }
      if (this.at("else")) {
        const e = this.i;
        this.i += 1;
        children.push(this.node("else_clause", e, this.parseBodyUntil(new Set(["fi"]))));
        continue;
      }
      break;
    }
    if (this.at("fi")) this.i += 1;
    else this.errors.push("if 没有 fi");
    return this.node("if_statement", from, children);
  }

  /** 读到指定的闭合关键字为止(不消费闭合关键字) */
  private parseBodyUntil(stops: ReadonlySet<string>): Node[] {
    const out: Node[] = [];
    for (;;) {
      this.skipSeparators();
      const t = this.peek();
      if (t === undefined) break;
      if (stops.has(t.text) || CLOSERS.has(t.text) || t.text === ";;") break;
      if (t.text === ";") {
        this.i += 1;
        continue;
      }
      const before = this.i;
      const stmt = this.parseList();
      if (stmt !== null) out.push(stmt);
      if (this.i === before) this.i += 1;
    }
    return out;
  }

  private parseFor(): Node {
    const from = this.i;
    this.i += 1; // for
    const children: Node[] = [];

    // `for NAME in WORDS` / `for ((…))` / `for NAME; do`
    while (!this.done() && !this.at("do") && !this.at("done")) {
      if (this.at(";")) {
        this.i += 1;
        continue;
      }
      const w = this.parseWord();
      if (w === null) break;
      children.push(w);
    }
    if (this.at("do")) {
      const d = this.i;
      this.i += 1;
      children.push(this.node("do_group", d, this.parseDoBody()));
    }
    return this.node("for_statement", from, children);
  }

  private parseWhile(): Node {
    const from = this.i;
    const kind = this.peek()!.text;
    this.i += 1;
    const children: Node[] = [...this.parseBodyUntil(new Set(["do"]))];
    if (this.at("do")) {
      const d = this.i;
      this.i += 1;
      children.push(this.node("do_group", d, this.parseDoBody()));
    }
    return this.node(kind === "until" ? "until_statement" : "while_statement", from, children);
  }

  private parseDoBody(): Node[] {
    const out: Node[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.done() || this.at("done")) {
        if (this.at("done")) this.i += 1;
        break;
      }
      const before = this.i;
      const stmt = this.parseList();
      if (stmt !== null) out.push(stmt);
      if (this.i === before) this.i += 1;
    }
    return out;
  }

  private parseCase(): Node {
    const from = this.i;
    this.i += 1; // case
    const children: Node[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.done() || this.at("esac")) {
        if (this.at("esac")) this.i += 1;
        break;
      }
      if (this.at("|") || this.at("(")) {
        this.i += 1;
        continue;
      }
      // case 项 `PATTERN) CMD ;;`:模式读到 `)` 为止跳过去,剩下的才是命令,
      // 否则 `a)` 会被当成命令名,真正的 `rm -rf /` 反而被吃掉。
      const item = this.i;
      const close = this.findPatternClose();
      if (close >= 0) this.i = close + 1;
      const body = this.parseBodyUntil(new Set(["esac", ";;"]));
      children.push(this.node("case_item", item, body));
      if (this.at(";;")) this.i += 1;
      if (this.i === item) this.i += 1;
    }
    return this.node("case_statement", from, children);
  }

  /** 找 case 模式的收尾 `)`,找不到返回 -1 */
  private findPatternClose(): number {
    for (let k = this.i; k < this.tokens.length; k += 1) {
      const t = this.tokens[k]!;
      if (t.text === ")") return k;
      if (t.text === ";;" || t.text === "esac") return -1;
    }
    return -1;
  }

  private parseCompound(): Node {
    const from = this.i;
    this.i += 1; // {
    const body = this.parseBodyUntil(new Set(["}"]));
    if (this.at("}")) this.i += 1;
    return this.node("compound_statement", from, body);
  }

  private parseSubshell(): Node {
    const from = this.i;
    this.i += 1; // (
    const body = this.parseBodyUntil(new Set([")"]));
    if (this.at(")")) this.i += 1;
    return this.node("subshell", from, body);
  }
}
