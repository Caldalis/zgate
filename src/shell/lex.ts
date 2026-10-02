// 词法层:字符串 → token。不知道任何命令名、任何 verb(那是 classify.ts 的事)。
//   splitTopLevel  按换行切成段落(引号与 heredoc 之外)
//   tokenize       把一段切成 token:剥引号、处理转义、拆出连接符、重定向算子与 fd
//
// 这是"字符级正确性"决定安全的地方:漏一个字符,`rm -rf /` 可能就没有目标了。要改先改测试。

/** 分词结果。`fd` 是紧贴重定向的数字(`2>&1` 的 2),不是参数。 */
export interface Token {
  readonly text: string;
  /** 被引号包过 —— 影响 `-` 开头算不算选项 */
  readonly quoted: boolean;
  /** 紧贴在重定向前面的数字(如 `2>&1` 的 `2`),不是参数 */
  readonly fd: string | null;
  /**
   * 这个 token 是 `<<DELIM` 里的分隔符本身。分隔符在文本上就是个单词,不标记的话
   * `cat <<EOF > out.txt` 会变成 cat 带三个参数,既丢了重定向,又把分隔符当成了路径。
   */
  readonly heredoc?: true;
}

// ---------------------------------------------------------------------------
// 顶层切分 —— 按换行,引号之外
// ---------------------------------------------------------------------------

/**
 * 一个段落:文本 + 它的 heredoc 分隔符(如果有)。
 * 切分阶段是唯一知道"哪个词是分隔符"的地方,所以由这里传给 tokenize。
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
      // `<<` 算子留在 token 流里,AST 才知道后面的单词是分隔符而不是参数;正文照样吃掉。
      const op = input.slice(i, j).replace(/\s+$/, "");
      const opTok = op.startsWith("<<-") ? "<<-" : "<<";
      cur += " " + opTok + " " + delim + " ";
      i = j;

      // `<<EOF` 之后同一行可能还有重定向(`cat <<EOF > out.txt`),不能当正文吞掉,
      // 先接回 cur,再跳过正文。
      let sameLine = i;
      while (sameLine < input.length && at(sameLine) !== "\n") sameLine += 1;
      if (sameLine >= input.length) return null; // 没有正文行 —— 畸形
      const restOfLine = input.slice(i, sameLine);
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
      // 分隔符那一行就是本段的结尾,它后面可能没有换行,所以这里自己结段
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

    // 只在换行处切段落:`;` `&&` `||` `|` `&` 是结构,留给 tokenize + AST,
    // 在这里切掉的话树就看不到 `if …; then …; fi` 是一个整体。
    // 换行是两条独立命令行的边界,heredoc 正文也靠它划定。
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

    // `;` `&&` `||` `|` `&` 独立成 token:切分只认换行,这些连接符要在这里拆开,
    // AST 才看得到结构(`if [ -f x ]; then cat x; fi`、`f(){ rm -rf /; }`)。
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

    // 命令替换 / 进程替换:放弃整体解析
    if (c === "`") return null;
    if (c === "$" && at(i + 1) === "(") return null;
    if (c === "<" && at(i + 1) === "(") return null;
    if (c === ">" && at(i + 1) === "(") return null;

    // `(` `)` `{` `}` 是语法括号,自成一个 token,fork bomb `:(){ :|:& };:` 才能被正确拆开。
    // 例外:`${VAR}` 的花括号是变量展开的一部分,拆开的话 `rm -rf ${BUILD_DIR}` 的目标会碎成四段。
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

    // 重定向算子要认全:`>` `>>` `>|` `>&` `<` `<<` `<&` `&>` `&>>`。
    // 拆错的话下游会看到一个管道或后台符号,写目标就丢了。
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
      // 只有"数字 → 重定向 → 数字或 &数字"才是 fd 复制(`2>&1`),数字记进 fd;
      // 其余情况数字照常作为普通 token 推出去。
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

