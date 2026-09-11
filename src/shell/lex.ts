// SPEC.md §7 —— 词法层:字符串 → token。
//
// 只做两件事,都不涉及任何命令语义:
//   splitTopLevel  按 `;` `&&` `||` `|` `\n` `&` 切成段落(引号与 heredoc 之外)
//   tokenize       把一段切成 token:剥引号、处理转义、拆出重定向算子与 fd
//
// 为什么单独一层:这是全项目最脏的代码(§7 原话),也是唯一一处
// "字符级正确性"决定安全的地方 —— 漏一个字符,`rm -rf /` 可能就没有目标了。
// 它被 156 条测试钉着,所以**搬动它时只搬不改**;要改先改测试。
//
// 本层不知道任何命令名、任何 verb —— 那是 classify.ts 的事。

/** 分词结果。`fd` 是紧贴重定向的数字(`2>&1` 的 2),不是参数。 */
export interface Token {
  readonly text: string;
  /** 被引号包过 —— 影响 `-` 开头算不算选项 */
  readonly quoted: boolean;
  /** 紧贴在重定向前面的数字(如 `2>&1` 的 `2`),不是参数 */
  readonly fd: string | null;
  /**
   * 这个 token 是 `<<DELIM` 里的**分隔符本身**,不是普通参数。
   *
   * 为什么需要标记:heredoc 分隔符在文本上就是个单词(`EOF`),
   * 光看文本无法和参数区分。不标记的话 `cat <<EOF > out.txt` 会变成
   * `cat` 带三个参数(`EOF` `>` `out.txt`),既丢了重定向语义,
   * 又把分隔符当成了文件路径。
   */
  readonly heredoc?: true;
}

// ---------------------------------------------------------------------------
// 顶层切分 —— `;` `&&` `||` `|` `\n`,引号之外
// ---------------------------------------------------------------------------

/**
 * 一个段落。文本 + 它的 heredoc 分隔符(如果有)。
 *
 * 为什么要带分隔符:heredoc 的分隔符在文本上就是个普通单词,
 * `tokenize` 光看文本分不出它和参数的区别。切分阶段是唯一知道
 * "哪个词是分隔符"的地方,所以由这里传下去。
 */
export interface Segment {
  readonly text: string;
  /** `<<EOF` 里的 `EOF`;没有 heredoc 时为 null */
  readonly heredocDelimiter: string | null;
}

/** 失败(未闭合引号)返回 null */
export function splitTopLevel(input: string): Segment[] | null {
  const segments: Segment[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  /** 本段是不是以 heredoc 结尾,以及它的分隔符 */
  let pendingDelim: string | null = null;

  const at = (n: number): string => input[n] ?? "";

  const flush = (): void => {
    const text = cur.trim();
    if (text !== "") segments.push({ text, heredocDelimiter: pendingDelim });
    pendingDelim = null;
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
      pendingDelim = delim;
      // 算子本身要留在 token 流里(`<<`),否则 AST 只看到一个孤零零的
      // 分隔符单词,没法知道它是重定向而不是参数。
      // 正文仍然被吃掉 —— 那部分才是"不产生写目标"的原因。
      const op = input.slice(i, j).replace(/\s+$/, "");
      const opTok = op.startsWith("<<-") ? "<<-" : "<<";
      cur += " " + opTok + " " + delim + " ";
      i = j;

      // `<<EOF` 之后、换行之前,同一行上可能还有别的东西:
      //   `cat <<EOF > out.txt`  ← `> out.txt` 是重定向,不能丢
      //   `cat > out.txt <<EOF`  ← 那就没有尾巴
      // 以前这里直接把整行当"正文行"跳过了,于是 `> out.txt` 被吞进正文,
      // 写目标整个消失。现在把这一行的剩余部分交回主循环处理。
      let sameLine = i;
      while (sameLine < input.length && at(sameLine) !== "\n") sameLine += 1;
      if (sameLine >= input.length) return null; // 没有正文行 —— 畸形
      const restOfLine = input.slice(i, sameLine);
      // 先把同行的剩余内容接回 cur,再跳过这一行
      cur += restOfLine;
      i = sameLine;
      let k = i + 1;
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

    // 只在**换行**处切段落。
    //
    // `;` `&&` `||` `|` `&` 一律留给 tokenize + AST —— 它们是结构,
    // 在切分阶段就切掉,树就永远看不到 `if … then … fi` 是一个整体。
    // (曾经在这里切,结果 `if [ -f x ]; then cat x; fi` 被切成三段,
    // if_statement 缺 fi,整条落 unknown。)
    //
    // 换行之所以仍然切:那是"两条独立的命令行"的边界,
    // 且 heredoc 正文靠它划定。
    if (c === "\n") {
      flush();
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
// 分词 —— 引号 / 转义 / 重定向
// ---------------------------------------------------------------------------

/** 失败返回 null */
export function tokenize(segment: string, heredocDelimiter: string | null = null): Token[] | null {
  const tokens: Token[] = [];
  let cur = "";
  let curQuoted = false;
  let i = 0;

  const at = (n: number): string => segment[n] ?? "";

  const push = (fd: string | null): void => {
    if (cur !== "" || curQuoted) {
      // heredoc 分隔符在文本上和普通单词无从区分,靠切分阶段传下来的信息标记
      if (heredocDelimiter !== null && cur.trim() === heredocDelimiter) {
        tokens.push({ text: cur, quoted: curQuoted, fd, heredoc: true });
      } else {
        tokens.push({ text: cur, quoted: curQuoted, fd });
      }
    }
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

    // `&>` / `&>>`:stdout 与 stderr 一起重定向,一个算子。
    // 不认的话会被拆成 `&`(后台符号)+ `>`(重定向),`rm b &> f` 的 f 就丢了。
    if (c === "&" && at(i + 1) === ">") {
      let op = "&>";
      i += 2;
      while (i < segment.length && at(i) === ">") {
        op += ">";
        i += 1;
      }
      push(null);
      tokens.push({ text: op, quoted: false, fd: null });
      continue;
    }

    // `;` `&&` `||` `|` `&` 独立成 token。
    //
    // 它们同时也是 splitTopLevel 的分隔符,那为什么不靠切分就行?
    // 因为**段落内部**仍会出现它们:`if [ -f x ]; then cat x; fi` 里的
    // `];` 和 `x;`、`f(){ rm -rf /; }` 里的 `/;`。
    // 切分只处理顶层,段落内部的这些必须在词法层拆开,AST 才看得到结构。
    // (index.ts 的 analyzeSegment 里有一条"下一个 token 以 > 开头就补认 fd"
    // 的补丁 —— 那正是没有这一层时打的手工补丁。)
    if (c === ";" || c === "&" || c === "|") {
      // `;;` 是 case 的项分隔符
      if (c === ";" && at(i + 1) === ";") {
        push(null);
        tokens.push({ text: ";;", quoted: false, fd: null });
        i += 2;
        continue;
      }
      if (c === "&" && at(i + 1) === "&") {
        push(null);
        tokens.push({ text: "&&", quoted: false, fd: null });
        i += 2;
        continue;
      }
      if (c === "|" && at(i + 1) === "|") {
        push(null);
        tokens.push({ text: "||", quoted: false, fd: null });
        i += 2;
        continue;
      }
      // `|&` 等价于 `2>&1 |`
      if (c === "|" && at(i + 1) === "&") {
        push(null);
        tokens.push({ text: "|&", quoted: false, fd: null });
        i += 2;
        continue;
      }
      push(null);
      tokens.push({ text: c, quoted: false, fd: null });
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
    //
    // 例外:`${VAR}` 的 `{` `}` 是变量展开的一部分,不是语法括号。
    // 不排除的话 `rm -rf ${BUILD_DIR}` 会被拆成 `$` `{` `BUILD_DIR` `}`,
    // 删除目标从一个路径变成四个碎片 —— 规则层再也认不出它是什么。
    if (c === "{" && cur.endsWith("$")) {
      // `${...}`:整个展开式合成一个 token,和 `$VAR` 同样处理
      let j = i + 1;
      while (j < segment.length && at(j) !== "}") j += 1;
      if (j >= segment.length) return null; // `${` 没闭合
      cur += segment.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      push(null);
      tokens.push({ text: c, quoted: false, fd: null });
      i += 1;
      continue;
    }

    // 重定向算子。
    //
    // 要认全:`>` `>>` `>|` `>&` `<` `<<` `<&` `&>` `&>>`
    // 之前漏了 `>|`(noclobber 下强制覆盖)和 `&>`(stdout+stderr 一起),
    // 它们被拆成 `>` + `|` 和 `&` + `>`,于是下游看到的是一个管道或一个
    // 后台符号 —— `echo hi >| o.txt` 整条落 unknown,`rm b &> f` 的目标丢了。
    if (c === ">" || c === "<") {
      let op = c;
      i += 1;
      while (i < segment.length && (at(i) === ">" || at(i) === "<")) {
        op += at(i);
        i += 1;
      }
      // `>|`:强制覆盖,仍是一个重定向算子(不是 `>` 加上一个管道)
      if (op === ">" && at(i) === "|") {
        op = ">|";
        i += 1;
      }
      // `>&` / `<&`:后面跟 fd 或文件名
      if (op === ">" || op === "<") {
        if (at(i) === "&") {
          op += "&";
          i += 1;
          while (i < segment.length && at(i) === ">") {
            op += ">";
            i += 1;
          }
        }
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

