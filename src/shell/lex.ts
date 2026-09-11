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
}

// ---------------------------------------------------------------------------
// 顶层切分 —— `;` `&&` `||` `|` `\n`,引号之外
// ---------------------------------------------------------------------------

/** 失败(未闭合引号)返回 null */
export function splitTopLevel(input: string): string[] | null {
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
// 分词 —— 引号 / 转义 / 重定向
// ---------------------------------------------------------------------------

/** 失败返回 null */
export function tokenize(segment: string): Token[] | null {
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

