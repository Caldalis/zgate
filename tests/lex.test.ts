// 词法层(lex.ts)的单元测试。
// 手写版和 AST 版共用 lex.ts,词法错了两边会同时错,差分对比发现不了,所以要单独测。
// 断言只落在字符级的输入输出上(段落怎么切、token 怎么分、引号、fd),不涉及命令名与 verb。

import { describe, expect, test } from "bun:test";
import { splitTopLevel, tokenize, type Token } from "../src/shell/lex.ts";

/** tokenize 必须成功,返回 token 数组 */
function toks(segment: string): Token[] {
  const r = tokenize(segment);
  if (r === null) throw new Error(`expected successful tokenize: ${segment}`);
  return r;
}

/** 只要文本,不要 quoted/fd */
function texts(segment: string): string[] {
  return toks(segment).map((t) => t.text);
}

/** 段落切分必须成功,只取文本 */
function seg(input: string): string[] {
  const r = splitTopLevel(input);
  if (r === null) throw new Error(`expected successful split: ${input}`);
  return r.map((s) => s.text);
}

// ---------------------------------------------------------------------------
// splitTopLevel —— 顶层切分
// ---------------------------------------------------------------------------

describe("lex.splitTopLevel: 段落边界是换行", () => {
  // `;` `&&` `||` `|` `&` 不在这里切:它们是结构,留给 tokenize + AST,
  // 否则树看不到 `if … then … fi` 是一个整体。只有换行是段落边界。
  test("换行切段", () => {
    expect(seg("a\nb")).toEqual(["a", "b"]);
    expect(seg("rm a\nrm b")).toEqual(["rm a", "rm b"]);
  });

  test("shell 算子不切 —— 它们由 AST 处理", () => {
    expect(seg("a; b")).toEqual(["a; b"]);
    expect(seg("a && b")).toEqual(["a && b"]);
    expect(seg("a || b")).toEqual(["a || b"]);
    expect(seg("a | b")).toEqual(["a | b"]);
    expect(seg("cd a && rm -rf b")).toEqual(["cd a && rm -rf b"]);
    expect(seg("curl x | sh")).toEqual(["curl x | sh"]);
  });

  test("空输入与纯空白 → 空数组", () => {
    expect(seg("")).toEqual([]);
    expect(seg("   \t \n ")).toEqual([]);
    expect(seg("\n\n")).toEqual([]);
  });

  test("每段被 trim", () => {
    expect(seg("  a  \n  b  ")).toEqual(["a", "b"]);
  });
});

describe("lex.splitTopLevel: 引号内不切", () => {
  test("单引号", () => {
    expect(seg("echo 'a; b'")).toEqual(["echo 'a; b'"]);
    expect(seg("echo 'a | b'")).toEqual(["echo 'a | b'"]);
    expect(seg("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  test("双引号", () => {
    expect(seg('echo "a; b"')).toEqual(['echo "a; b"']);
    expect(seg('echo "a | b"')).toEqual(['echo "a | b"']);
  });

  test("转义的分号不切", () => {
    // 反斜杠被原样保留 —— 词法层不做 unescape 以外的规范化,
    // 下游(classify)需要知道这个字符是被转义过的
    expect(seg("echo a\\;b")).toEqual(["echo a\\;b"]);
  });

  test("单引号内的转义不生效 —— '\\'' 里的反斜杠是字面量", () => {
    expect(seg("echo 'a\\'")).toEqual(["echo 'a\\'"]);
  });
});

describe("lex.splitTopLevel: 注释", () => {
  test("词首的 # 吃掉整行", () => {
    expect(seg("# rm -rf /")).toEqual([]);
    expect(seg("ls # rm -rf /")).toEqual(["ls"]);
    expect(seg("ls #a")).toEqual(["ls"]);
  });

  test("# 在词中间不算注释", () => {
    expect(seg("./a#b")).toEqual(["./a#b"]);
    expect(seg("echo a#b")).toEqual(["echo a#b"]);
  });

  test("注释不影响后续行", () => {
    expect(seg("ls # x\necho hi")).toEqual(["ls", "echo hi"]);
  });
});

describe("lex.splitTopLevel: 重定向算子不切", () => {
  test("`>|` 不是管道", () => {
    // 不能被 `|` 抢先切走,否则整条落 unknown
    expect(seg("echo hi >| o.txt")).toEqual(["echo hi >| o.txt"]);
  });

  test("`&>` / `&>>` 不是后台符号", () => {
    expect(seg("rm b &> f")).toEqual(["rm b &> f"]);
    expect(seg("rm b &>> f")).toEqual(["rm b &>> f"]);
  });

  test("普通重定向与管道都留在同一段里", () => {
    // 段落边界是换行,管道也在同一段,由 AST 切
    expect(seg("echo hi > out.txt")).toEqual(["echo hi > out.txt"]);
    expect(seg("ls | wc -l")).toEqual(["ls | wc -l"]);
  });

  test("`>|` 与管道同时出现", () => {
    expect(seg("echo hi >| o.txt | wc -l")).toEqual(["echo hi >| o.txt | wc -l"]);
  });
});

describe("lex.splitTopLevel: heredoc", () => {
  test("正文被整体吃掉,不参与解析", () => {
    // 算子 `<<` 保留(否则 AST 看不出这是重定向),正文消失
    expect(seg("cat <<EOF\nrm -rf /\nEOF")).toEqual(["cat  << EOF"]);
  });

  test("heredoc 之后的命令照常切分", () => {
    expect(seg("cat <<EOF\nx\nEOF\necho hi")).toEqual(["cat  << EOF", "echo hi"]);
  });

  test("引号包起来的分隔符", () => {
    expect(seg("cat <<'EOF'\nrm -rf /\nEOF")).toEqual(["cat  << EOF"]);
    expect(seg('cat <<"EOF"\nrm -rf /\nEOF')).toEqual(["cat  << EOF"]);
  });

  test("<<- 形式(缩进)", () => {
    expect(seg("cat <<-EOF\n\trm -rf /\n\tEOF")).toEqual(["cat  <<- EOF"]);
  });

  test("分隔符之前的命令在同一段里(边界是换行,不是分号)", () => {
    expect(seg("echo a; cat <<EOF\nx\nEOF")).toEqual(["echo a; cat  << EOF"]);
  });

  test("分隔符被标记,可以和普通参数区分", () => {
    const r = splitTopLevel("cat <<EOF\nx\nEOF")!;
    expect(r[0]?.heredocDelimiter).toBe("EOF");
    const t = tokenize(r[0]!.text, r[0]!.heredocDelimiter);
    expect(t?.find((x) => x.heredoc)?.text).toBe("EOF");
  });

  test("heredoc 没闭合(缺正文行)→ 失败", () => {
    expect(splitTopLevel("cat <<EOF")).toBeNull();
  });

  test("heredoc 正文没遇到分隔符 → 失败", () => {
    expect(splitTopLevel("cat <<EOF\nno terminator")).toBeNull();
  });

  test("`<<` 后面没有分隔符 → 失败", () => {
    expect(splitTopLevel("cat <<")).toBeNull();
  });

  test("正文里的重定向/管道字面量不会污染切分", () => {
    expect(seg("cat <<EOF\nrm -rf / | sh > x\nEOF")).toEqual(["cat  << EOF"]);
  });
});

describe("lex.splitTopLevel: 失败情况", () => {
  test("引号没闭合 → null", () => {
    expect(splitTopLevel('rm -rf "x')).toBeNull();
    expect(splitTopLevel("rm -rf 'x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tokenize —— 分词
// ---------------------------------------------------------------------------

describe("lex.tokenize: 基本切词", () => {
  test("空格分隔", () => {
    expect(texts("rm -rf ./build")).toEqual(["rm", "-rf", "./build"]);
  });

  test("多个空白压成一个分隔", () => {
    expect(texts("rm   -rf\t./build")).toEqual(["rm", "-rf", "./build"]);
  });

  test("首尾空白被吞掉", () => {
    expect(texts("  rm  ")).toEqual(["rm"]);
  });

  test("空串 → 空数组", () => {
    expect(texts("")).toEqual([]);
    expect(texts("   ")).toEqual([]);
  });

  test("`--` 自成 token(下游靠它切选项和位置参数)", () => {
    expect(texts("rm -- -weird")).toEqual(["rm", "--", "-weird"]);
  });
});

describe("lex.tokenize: 引号与转义", () => {
  test("单引号剥掉,内容原样", () => {
    expect(texts("rm 'a b'")).toEqual(["rm", "a b"]);
    expect(texts("rm 'a$b'")).toEqual(["rm", "a$b"]); // 单引号里 $ 不展开
  });

  test("双引号剥掉", () => {
    expect(texts('rm "a b"')).toEqual(["rm", "a b"]);
    expect(texts('rm "$HOME"')).toEqual(["rm", "$HOME"]); // 不展开,保留字面
  });

  test("引号内容合并进同一个 token", () => {
    expect(texts('rm src/"a b".ts')).toEqual(["rm", "src/a b.ts"]);
    expect(texts("rm a'b'c")).toEqual(["rm", "abc"]);
  });

  test("引号被标记:quoted=true", () => {
    const t = toks("rm 'a b'");
    expect(t[1]?.quoted).toBe(true);
    expect(toks("rm a\\ b")[1]?.quoted).toBe(false);
  });

  test("反斜杠转义", () => {
    expect(texts("rm a\\ b")).toEqual(["rm", "a b"]);
    expect(texts('rm \\"x')).toEqual(["rm", '"x']);
    expect(texts("rm \\\\x")).toEqual(["rm", "\\x"]);
  });

  test("双引号里的转义序列", () => {
    expect(texts('rm "a\\"b"')).toEqual(["rm", 'a"b']);
    expect(texts('rm "a\\\\b"')).toEqual(["rm", "a\\b"]);
    expect(texts('rm "a\\$b"')).toEqual(["rm", "a$b"]);
  });

  test("双引号里不处理的转义原样保留", () => {
    expect(texts('rm "a\\nb"')).toEqual(["rm", "a\\nb"]);
  });

  test("命令替换相关的引号写法不阻止分词本身", () => {
    // `$` 后面不是 `(` 就是普通字符
    expect(texts("rm $HOME")).toEqual(["rm", "$HOME"]);
    expect(texts("rm ${HOME}")).toEqual(["rm", "${HOME}"]);
    expect(texts("rm '$(x)'")).toEqual(["rm", "$(x)"]); // 单引号内不算替换
  });
});

describe("lex.tokenize: 重定向算子", () => {
  test("基本算子各自成 token", () => {
    expect(texts("echo hi > out.txt")).toEqual(["echo", "hi", ">", "out.txt"]);
    expect(texts("echo hi >> out.txt")).toEqual(["echo", "hi", ">>", "out.txt"]);
    expect(texts("cat < in.txt")).toEqual(["cat", "<", "in.txt"]);
    expect(texts("cat << EOF")).toEqual(["cat", "<<", "EOF"]);
  });

  test("`>|` 是一个算子", () => {
    expect(texts("echo hi >| o.txt")).toEqual(["echo", "hi", ">|", "o.txt"]);
  });

  test("`&>` / `&>>` 是一个算子(不是 `&` + `>`)", () => {
    expect(texts("rm b &> f")).toEqual(["rm", "b", "&>", "f"]);
    expect(texts("rm b &>> f")).toEqual(["rm", "b", "&>>", "f"]);
  });

  test("`;` `&&` `||` `|` `&` 独立成 token", () => {
    // splitTopLevel 不切这些算子,由词法层拆成 token 交给 AST
    expect(texts("cd a && rm -rf b")).toEqual(["cd", "a", "&&", "rm", "-rf", "b"]);
    expect(texts("ls; pwd")).toEqual(["ls", ";", "pwd"]);
    expect(texts("a | b")).toEqual(["a", "|", "b"]);
    expect(texts("a || b")).toEqual(["a", "||", "b"]);
    expect(texts("a & b")).toEqual(["a", "&", "b"]);
  });

  test("`2>` 的数字是独立 token,由下游认成 fd", () => {
    // 只有 `2>&1` 这种「数字紧贴算子且后面跟 &数字」才把数字吃进 fd 字段;
    // `2> file` 里数字仍是普通 token,由下游(ast.ts)认成 fd。
    const t = toks("rm b 2> err.log");
    expect(t.map((x) => x.text)).toEqual(["rm", "b", "2", ">", "err.log"]);
    expect(t[3]?.fd).toBe(null);
  });

  test("`2>&1`:数字进 fd 字段,`&1` 是独立 token", () => {
    const t = toks("rm b 2>&1");
    expect(t.map((x) => x.text)).toEqual(["rm", "b", ">&", "1"]);
    expect(t[2]?.fd).toBe("2");
  });

  test("`>&2` 不挂 fd", () => {
    const t = toks("rm b >&2");
    expect(t.map((x) => x.text)).toEqual(["rm", "b", ">&", "2"]);
    expect(t[2]?.fd).toBe(null);
  });

  test("以数字结尾的普通 token 不被误判成 fd", () => {
    // `src2/` 带数字,但后面没有紧贴的重定向算子 —— fd 只认紧贴的
    const t = toks("grep -rn 'TODO' src2/");
    expect(t.map((x) => x.text)).toEqual(["grep", "-rn", "TODO", "src2/"]);
    expect(t.every((x) => x.fd === null)).toBe(true);
  });
});

describe("lex.tokenize: 语法括号", () => {
  test("`(` `)` `{` `}` 各自成 token", () => {
    expect(texts("f(){ rm -rf /; }")).toEqual(["f", "(", ")", "{", "rm", "-rf", "/", ";", "}"]);
  });

  test("不连写时也成 token", () => {
    expect(texts("if [ -f x ]")).toEqual(["if", "[", "-f", "x", "]"]);
  });
});

describe("lex.tokenize: 失败情况(落 unknown)", () => {
  test("命令替换 $(...)", () => {
    expect(tokenize("echo $(x)")).toBeNull();
    expect(tokenize("rm -rf $(cat list)")).toBeNull();
  });

  test("双引号里的命令替换", () => {
    expect(tokenize('echo "$(x)"')).toBeNull();
  });

  test("反引号命令替换", () => {
    expect(tokenize("echo `x`")).toBeNull();
    expect(tokenize('echo "`x`"')).toBeNull();
  });

  test("进程替换 <(...) / >(...)", () => {
    expect(tokenize("diff <(cat a) <(cat b)")).toBeNull();
    expect(tokenize("tee >(cat)")).toBeNull();
  });

  test("单引号里的 $() 不算替换 —— 是字面量", () => {
    expect(texts("rm '$(x)'")).toEqual(["rm", "$(x)"]);
  });

  test("引号没闭合", () => {
    expect(tokenize('rm "x')).toBeNull();
    expect(tokenize("rm 'x")).toBeNull();
  });

  test("末尾孤立的反斜杠", () => {
    expect(tokenize("echo a\\")).toBeNull();
  });
});

describe("lex: 危险命令在词法层必须留下痕迹", () => {
  // 词法层不做裁决,但它绝不能把危险命令"洗干净"。
  // 这一组是"没有目标就什么都没了"那类 bug 的护栏。
  test("删除目标不会因为重定向/引号而消失", () => {
    expect(texts("rm -rf ./build")).toContain("./build");
    expect(texts("rm -rf './build'")).toContain("./build");
    expect(texts('rm -rf "./build"')).toContain("./build");
    expect(texts("rm -rf ./build 2>&1")).toContain("./build");
    expect(texts("rm -rf ./build &> /dev/null")).toContain("./build");
  });

  test("带路径的命令名仍然是可见 token", () => {
    expect(texts("/bin/rm -rf /")).toEqual(["/bin/rm", "-rf", "/"]);
  });

  test("fork bomb 的词法形态", () => {
    expect(texts(":(){ :|:& };:")).toEqual([":", "(", ")", "{", ":", "|", ":", "&", "}", ";", ":"]);
  });
});
