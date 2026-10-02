// 「命令语义」层(classify.ts)的测试:直接喂 (命令名, 参数),不用构造完整命令行。
// 手写版和 AST 版共用这一层,换解析器时这里的断言应当一条不改地继续通过。

import { describe, expect, test } from "bun:test";
import {
  basename,
  classifyCommand,
  classifyGit,
  extractTargets,
  findVerb,
  isAssignment,
  LOOKS_LIKE_COMMAND,
  tarVerb,
  type ClassifyToken,
} from "../src/shell/classify.ts";

/** 把 ["-rf", "x"] 这样写法的参数变成未引用的 token */
function toks(...args: string[]): ClassifyToken[] {
  return args.map((text) => ({ text, quoted: false }));
}

/** 引用过的 token(语义等同 argv 里的字面量)*/
function q(text: string): ClassifyToken {
  return { text, quoted: true };
}

describe("classify: 命令名的归一化", () => {
  test("basename 掉路径", () => {
    expect(basename("/bin/rm")).toBe("rm");
    expect(basename("./bin/rm")).toBe("rm");
    expect(basename("~/bin/rm")).toBe("rm");
    expect(basename("rm")).toBe("rm");
  });

  test("LOOKS_LIKE_COMMAND 拒绝不像命令的名字", () => {
    for (const bad of ["10", "=", "FOO=", "1234", ""]) {
      expect(LOOKS_LIKE_COMMAND.test(bad)).toBe(false);
    }
    for (const good of ["rm", "[", "my-app", "a.b", "git", "_x"]) {
      expect(LOOKS_LIKE_COMMAND.test(good)).toBe(true);
    }
  });

  test("isAssignment", () => {
    expect(isAssignment("FOO=1")).toBe(true);
    expect(isAssignment("_A=")).toBe(true);
    expect(isAssignment("1FOO=1")).toBe(false);
    expect(isAssignment("FOO")).toBe(false);
  });
});

describe("classify: 五类裁决", () => {
  test("delete / read / write / network 直接来自表", () => {
    expect(classifyCommand("rm", toks("-rf", "x"))).toMatchObject({ kind: "cmd", verb: "delete" });
    expect(classifyCommand("cat", toks("a"))).toMatchObject({ kind: "cmd", verb: "read" });
    expect(classifyCommand("mkdir", toks("-p", "a"))).toMatchObject({ kind: "cmd", verb: "write" });
    expect(classifyCommand("curl", toks("https://x"))).toMatchObject({ kind: "cmd", verb: "network" });
  });

  test("表外可执行文件 → exec", () => {
    expect(classifyCommand("frobnicate", toks("--all"))).toEqual({ kind: "exec" });
    expect(classifyCommand("/usr/local/bin/weird", toks())).toEqual({ kind: "exec" });
  });

  test("会跑东西但参数有意义的 → exec 且保留参数", () => {
    const c = classifyCommand("kill", toks("-9", "12345"));
    expect(c).toMatchObject({ kind: "cmd", verb: "exec" });
    if (c?.kind !== "cmd") throw new Error("expected cmd");
    expect(extractTargets(c.role, c.args, c.name).map((t) => t.raw)).toEqual(["12345"]);
  });

  test("纯内建 → silent", () => {
    for (const cmd of ["cd", "export", "true", "sleep", ":", "alias"]) {
      expect(classifyCommand(cmd, toks("x"))).toEqual({ kind: "silent" });
    }
  });

  test("trap 不是 silent —— 至少留一条日志", () => {
    expect(classifyCommand("trap", toks("'rm -rf /'", "EXIT"))).toEqual({ kind: "exec" });
  });

  test("source / . → 带参数是 exec,不带是 silent", () => {
    expect(classifyCommand(".", toks("./env.sh"))).toEqual({ kind: "exec" });
    expect(classifyCommand("source", toks())).toEqual({ kind: "silent" });
  });

  test("命令名是变量 → exec(不展开变量,只能老实说不知道)", () => {
    expect(classifyCommand("$CMD", toks("-rf", "/"))).toEqual({ kind: "exec" });
    expect(classifyCommand("${CMD}", toks())).toEqual({ kind: "exec" });
  });

  test("前置赋值被剥掉", () => {
    const c = classifyCommand("rm", toks("FOO=1", "-rf", "x"));
    expect(c).toMatchObject({ kind: "cmd", verb: "delete" });
    if (c?.kind !== "cmd") throw new Error("expected cmd");
    expect(extractTargets(c.role, c.args, c.name).map((t) => t.raw)).toEqual(["x"]);
  });

  test("解释器走 shell 通道,把 argv 交给句法层递归", () => {
    const c = classifyCommand("bash", toks("-c", "rm -rf x"));
    expect(c).toMatchObject({ kind: "shell" });
    if (c?.kind !== "shell") throw new Error("expected shell");
    expect(c.argv.map((t) => t.text)).toEqual(["-c", "rm -rf x"]);
  });
});

describe("classify: sed 的 verb 取决于 -i", () => {
  test("不带 -i 是 read", () => {
    expect(classifyCommand("sed", toks("s/a/b/", "f.ts"))).toMatchObject({ verb: "read" });
  });

  test("带 -i 是 write", () => {
    expect(classifyCommand("sed", toks("-i", "s/a/b/", "f.ts"))).toMatchObject({ verb: "write" });
    expect(classifyCommand("sed", toks("-i.bak", "s/a/b/", "f.ts"))).toMatchObject({ verb: "write" });
    expect(classifyCommand("sed", toks("--in-place", "s/a/b/", "f.ts"))).toMatchObject({ verb: "write" });
  });

  test("-i 的目标只取最后一个位置参数(脚本不是文件)", () => {
    const c = classifyCommand("sed", toks("-i", "s/a/b/", "src/main.ts"));
    if (c?.kind !== "cmd") throw new Error("expected cmd");
    expect(extractTargets(c.role, c.args, c.name).map((t) => t.raw)).toEqual(["src/main.ts"]);
  });
});

describe("classify: git 二级表", () => {
  test("查询 → read", () => {
    for (const sub of ["status", "diff", "log", "rev-parse", "show"]) {
      expect(classifyCommand("git", toks(sub))).toMatchObject({ kind: "git" });
      expect(classifyGit(toks(sub)).verb).toBe("read");
    }
  });

  test("push / pull / fetch → network", () => {
    for (const sub of ["push", "pull", "fetch", "clone"]) {
      expect(classifyGit(toks(sub)).verb).toBe("network");
    }
  });

  test("reset / clean / checkout → write", () => {
    for (const sub of ["reset", "clean", "checkout", "commit"]) {
      expect(classifyGit(toks(sub)).verb).toBe("write");
    }
  });

  test("全局选项被跳过", () => {
    expect(classifyGit(toks("-C", "/tmp/repo", "status")).verb).toBe("read");
    expect(classifyGit(toks("-c", "core.pager=cat", "log")).verb).toBe("read");
  });

  test("表外子命令 / 光一个 git → verb 为 null(调用方落 exec)", () => {
    expect(classifyGit(toks("lfs", "install")).verb).toBeNull();
    expect(classifyGit(toks()).verb).toBeNull();
  });

  test("git rm 的目标是路径", () => {
    const g = classifyGit(toks("rm", "--cached", "src/a.ts"));
    expect(g.role).toBe("pathOnly");
    expect(extractTargets(g.role, g.args, "git").map((t) => t.raw)).toEqual(["src/a.ts"]);
  });
});

describe("classify: find 的 verb 由表达式决定", () => {
  test("-delete → delete", () => {
    expect(findVerb(toks(".", "-name", "*.log", "-delete"))).toBe("delete");
  });

  test("-exec → exec", () => {
    expect(findVerb(toks(".", "-type", "f", "-exec", "rm", "{}", ";"))).toBe("exec");
    expect(findVerb(toks(".", "-execdir", "ls", ";"))).toBe("exec");
  });

  test("纯查询 → read", () => {
    expect(findVerb(toks(".", "-name", "*.ts"))).toBe("read");
  });

  test("路径只取表达式之前", () => {
    expect(extractTargets("findPaths", toks("./src", "-type", "f"), "find").map((t) => t.raw)).toEqual(["./src"]);
    expect(extractTargets("findPaths", toks(".", "-name", "*.key"), "find").map((t) => t.raw)).toEqual(["."]);
  });
});

describe("classify: tar 的 verb 由模式决定", () => {
  test("-c 打包 / -x 解包 → write", () => {
    expect(tarVerb(toks("-czf", "out.tar.gz", "src/"))).toBe("write");
    expect(tarVerb(toks("-xzf", "a.tar.gz"))).toBe("write");
  });

  test("-t 列表 → read", () => {
    expect(tarVerb(toks("-tf", "a.tar.gz"))).toBe("read");
  });

  test("长选项形式", () => {
    expect(tarVerb(toks("--create", "-f", "o.tar"))).toBe("write");
    expect(tarVerb(toks("--list", "-f", "o.tar"))).toBe("read");
  });
});

describe("classify: 目标提取", () => {
  test("grep 的第一个非选项是模式", () => {
    expect(extractTargets("grepLike", toks("TODO", "src/a.ts"), "grep").map((t) => t.raw)).toEqual(["src/a.ts"]);
  });

  test("-e 给了模式,位置参数全是文件", () => {
    expect(extractTargets("grepLike", toks("-e", "TODO", "src/a.ts"), "grep").map((t) => t.raw)).toEqual(["src/a.ts"]);
  });

  test("普通命令的位置参数都是目标,选项被跳过", () => {
    expect(extractTargets("pathOnly", toks("-rf", "a", "b"), "rm").map((t) => t.raw)).toEqual(["a", "b"]);
    expect(extractTargets("allArgs", toks("-n", "5", "README.md"), "head").map((t) => t.raw)).toEqual(["README.md"]);
  });

  test("dd / chmod 的第一个位置参数不是目标", () => {
    expect(extractTargets("allArgs", toks("if=/dev/zero", "of=/dev/sda"), "dd").map((t) => t.raw)).toEqual(["of=/dev/sda"]);
    expect(extractTargets("pathOnly", toks("755", "bin/tool"), "chmod").map((t) => t.raw)).toEqual(["bin/tool"]);
  });

  test("引用过的 token 即使以 - 开头也是位置参数", () => {
    expect(extractTargets("pathOnly", toks("--"), "rm").map((t) => t.raw)).toEqual([]);
    expect(extractTargets("pathOnly", [q("-weird-name")], "rm").map((t) => t.raw)).toEqual(["-weird-name"]);
  });

  test("kind 恒为 file —— 是不是目录是 enricher 的事", () => {
    expect(extractTargets("pathOnly", toks("build"), "rm")[0]?.kind).toBe("file");
  });

  test("raw 原样保留,不做任何规范化", () => {
    for (const raw of ["./build/", "~/secrets", "../outside", "$HOME/x", "*.ts"]) {
      expect(extractTargets("pathOnly", toks(raw), "rm")[0]?.raw).toBe(raw);
    }
  });
});
