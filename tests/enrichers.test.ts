// SPEC.md §6 —— enrichers 的测试。
//
// 这一层的测试有个和别处不同的地方:**它必须动真实的文件系统**。
// 探针的全部价值就是"答案在环境里",把 fs 模拟掉就把被测对象删了。
// 所以每个 case 在 mkdtemp 出来的临时目录里搭一个真实的小场景。
//
// 临时目录建在系统 tmp 下,不建在仓库里(§15.2 的 D2.17 已经踩过一次:
// 探针脚本落进仓库,git status 就脏了)。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrich, envHints, clearGitCache, isInside } from "../src/enrichers/index.ts";
import { fsFacts } from "../src/enrichers/fs.ts";
import { gitFacts } from "../src/enrichers/git.ts";
import type { Resource } from "../src/core/action.ts";

let root: string;

beforeAll(() => {
  // ★ 必须 realpath 一次。macOS 的 tmpdir 是 `/var/folders/...`,而 `/var`
  // 本身是指向 `/private/var` 的软链接 —— 于是 mkdtempSync 给的路径和
  // realpathSync 的结果**字面不等**,inside_cwd 会全线判成 false。
  //
  // 这不是探针的 bug,是探针要的输入本来就得是规范路径:cwd 由 agent 给出,
  // 在真实机器上通常是 `/Users/...`(没有软链接)。测试这里替 agent 规范一下。
  root = tmp("zgate-enrich-");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearGitCache();
});

/** mkdtemp 的规范版本:探针要的是规范路径,测试也得给规范路径(理由见 beforeAll)。 */
function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function res(raw: string, kind: Resource["kind"] = "file"): Resource {
  return { raw, kind };
}

function mk(rel: string, content = ""): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function mkdirp(rel: string): string {
  const p = join(root, rel);
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
describe("isInside:按路径分段比较,不是字符串前缀", () => {
  test("同名前缀的兄弟目录不算在里面", () => {
    // 这是本函数存在的**唯一**理由。`startsWith` 会把下面这条判成 true,
    // 于是一次删到 /repo-other 的操作看起来完全正常。
    expect(isInside("/a/repo", "/a/repo-other/x")).toBe(false);
    expect(isInside("/a/repo", "/a/repositories")).toBe(false);
  });

  test("自身算在自己里面", () => {
    expect(isInside("/a/repo", "/a/repo")).toBe(true);
  });

  test("真正的子路径算在里面", () => {
    expect(isInside("/a/repo", "/a/repo/build/x")).toBe(true);
  });

  test("父目录不算", () => {
    expect(isInside("/a/repo", "/a")).toBe(false);
  });

  test("空字符串一律 false(未解析的路径不许被当成在里面)", () => {
    expect(isInside("", "/a")).toBe(false);
    expect(isInside("/a", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("fs 探针:目标不存在", () => {
  // ★ D12.11:不存在的普通路径带**预期落点**。exists 仍是 false(东西不在),
  //   但 resolved 是它将被创建的位置(最近存在祖先 realpath + 剩余部分),
  //   于是 inside_cwd 对"越界写新文件"也能判。
  test("不存在但在 cwd 内 → exists false,resolved 为预期落点,inside_cwd true", () => {
    const [f] = fsFacts([res(join(root, "nope/nothing"))], root, root);
    expect(f?.exists).toBe(false);
    expect(f?.resolved).toBe(join(root, "nope/nothing"));
    expect(f?.is_symlink).toBe(false);
    expect(f?.symlink_target).toBeNull();
    expect(f?.is_dir).toBe(false); // 还没创建,谈不上目录
    expect(f?.inside_cwd).toBe(true);
    expect(f?.inside_repo).toBe(true);
    expect(f?.gitignored).toBeNull();
  });

  test("★ 不存在且在 cwd 外 → resolved 落在外面,inside_cwd false(D12.11 的判据)", () => {
    const outside = tmp("zgate-enrich-out-");
    try {
      const [f] = fsFacts([res(join(outside, "new"))], root, root);
      expect(f?.exists).toBe(false);
      expect(f?.resolved).toBe(join(outside, "new"));
      expect(f?.inside_cwd).toBe(false);
      expect(f?.inside_repo).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("不存在路径的预期落点会折叠沿途软链接", () => {
    // link -> outside;link/new 不存在,预期落点应落在 outside 里,不是 cwd 里
    const outside = tmp("zgate-enrich-lnk-");
    try {
      symlinkSync(outside, join(root, "linkdir"));
      const [f] = fsFacts([res(join(root, "linkdir/new"))], root, root);
      expect(f?.exists).toBe(false);
      expect(f?.resolved).toBe(join(outside, "new"));
      expect(f?.inside_cwd).toBe(false);
    } finally {
      rmSync(join(root, "linkdir"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("realpathSync 抛异常不会冒泡出去(§6 明确要求 try/catch)", () => {
    expect(() => fsFacts([res(join(root, "no/such/deep/path"))], root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("fs 探针:普通文件与目录", () => {
  test("文件:exists,非链接,非目录,inside_cwd", () => {
    mk("plain.txt", "hi");
    const [f] = fsFacts([res(join(root, "plain.txt"))], root);
    expect(f?.exists).toBe(true);
    expect(f?.is_symlink).toBe(false);
    expect(f?.is_dir).toBe(false);
    expect(f?.inside_cwd).toBe(true);
    expect(f?.resolved).toBe(join(root, "plain.txt"));
  });

  test("目录:is_dir true", () => {
    mkdirp("adir");
    const [f] = fsFacts([res(join(root, "adir"), "dir")], root);
    expect(f?.is_dir).toBe(true);
    expect(f?.exists).toBe(true);
  });

  test("相对路径按 cwd 解析", () => {
    mk("rel.txt", "x");
    const [f] = fsFacts([res("rel.txt")], root);
    expect(f?.exists).toBe(true);
    expect(f?.resolved).toBe(join(root, "rel.txt"));
  });
});

// ---------------------------------------------------------------------------
describe("fs 探针:软链接 —— 本项目的核心场景", () => {
  test("链接指向仓库外:resolved 落在外面,symlink_target 也指外面", () => {
    const outside = tmp("zgate-outside-");
    mkdirSync(join(outside, "prod"), { recursive: true });
    mkdirp("repo");
    symlinkSync(join(outside, "prod"), join(root, "repo/build"));

    const [f] = fsFacts([res("build")], join(root, "repo"));
    expect(f?.is_symlink).toBe(true);
    expect(f?.exists).toBe(true);
    // ★ 这一条就是 §12 的 rm-symlink-out-of-repo:resolved 里必须出现 outside
    expect(f?.resolved).toContain("zgate-outside-");
    expect(f?.symlink_target).toContain("zgate-outside-");
    // 链接在 cwd 里,但**它指向的东西**在外面。规则层靠这个分辨。
    expect(f?.inside_cwd).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  test("链接指向 cwd 内:折叠后仍在里面", () => {
    mkdirp("repo/real");
    symlinkSync(join(root, "repo/real"), join(root, "repo/link"));
    const [f] = fsFacts([res("link")], join(root, "repo"));
    expect(f?.is_symlink).toBe(true);
    expect(f?.inside_cwd).toBe(true);
    expect(f?.is_dir).toBe(true);
  });

  test("相对软链接的 symlink_target 被解析成绝对路径", () => {
    mkdirp("repo/x");
    mkdirp("repo/y");
    symlinkSync("../y", join(root, "repo/x/rel"));
    const [f] = fsFacts([res("x/rel")], join(root, "repo"));
    expect(f?.is_symlink).toBe(true);
    expect(f?.symlink_target).toBe(join(root, "repo/y"));
  });

  test("悬空软链接:exists true,resolved null(链接在,目标不在)", () => {
    mkdirp("repo");
    symlinkSync(join(root, "repo/gone"), join(root, "repo/dangling"));
    const [f] = fsFacts([res("dangling")], join(root, "repo"));
    expect(f?.is_symlink).toBe(true);
    expect(f?.exists).toBe(true);
    expect(f?.resolved).toBeNull();
    // 解析不出来 ⇒ 一律 false。不许把"不知道在哪"当成"在里面"。
    expect(f?.inside_cwd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("fs 探针:跳过非文件目标", () => {
  test("url / unknown 不进结果数组(避免白拿一次 ENOENT)", () => {
    const out = fsFacts([res("https://example.com", "url"), res("?", "unknown")], root);
    expect(out).toEqual([]);
  });

  test("混合输入只留文件目标,顺序保持", () => {
    mk("a.txt");
    mk("b.txt");
    const out = fsFacts([res("a.txt"), res("https://x", "url"), res("b.txt")], root);
    expect(out.map((f) => f.raw)).toEqual(["a.txt", "b.txt"]);
  });

  test("空目标列表 ⇒ 一次 syscall 都不发", () => {
    expect(fsFacts([], root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("git 探针:不是仓库", () => {
  test("临时目录(无 .git) → is_repo false,其余全 null", () => {
    const bare = tmp("zgate-norepo-");
    const r = gitFacts(bare);
    expect(r.is_repo).toBe(false);
    expect(r.root).toBeNull();
    expect(r.branch).toBeNull();
    expect(r.default_branch).toBeNull();
    expect(r.is_dirty).toBeNull();
    rmSync(bare, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe("git 探针:普通仓库", () => {
  test("向上找到仓库根,分支名从 .git/HEAD 读", () => {
    const repo = tmp("zgate-repo-");
    mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    const deep = join(repo, "src", "deep");
    mkdirSync(deep, { recursive: true });

    const r = gitFacts(deep);
    expect(r.is_repo).toBe(true);
    expect(r.root).toBe(repo);
    expect(r.branch).toBe("feature/x");
    expect(r.is_dirty).toBeNull(); // §6:M1 恒为 null

    rmSync(repo, { recursive: true, force: true });
  });

  test("detached HEAD → branch null(不瞎猜分支名)", () => {
    const repo = tmp("zgate-detached-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "a".repeat(40) + "\n");
    expect(gitFacts(repo).branch).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  test("origin/HEAD 存在 → default_branch 解析出来", () => {
    const repo = tmp("zgate-defbr-");
    mkdirSync(join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/topic\n");
    writeFileSync(join(repo, ".git", "refs", "remotes", "origin", "HEAD"),
      "ref: refs/remotes/origin/main\n");
    expect(gitFacts(repo).default_branch).toBe("main");
    rmSync(repo, { recursive: true, force: true });
  });

  test("origin/HEAD 缺失 → null,不去猜 main/master(猜错会漏判)", () => {
    const repo = tmp("zgate-nodefbr-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(gitFacts(repo).default_branch).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  test("origin/HEAD 只存在于 packed-refs 里也能找到", () => {
    const repo = tmp("zgate-packed-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/x\n");
    writeFileSync(join(repo, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
      "aaa refs/remotes/origin/HEAD\n" +
      "bbb refs/remotes/origin/xy\n" + // ← 同名前缀,不许被误配
      "ccc refs/heads/x\n");
    // refs/remotes/origin/HEAD 是符号引用才会是 `ref:` 内容;真实 ref 存 sha。
    // 这里 sha 解析不出分支名 → null,但**不许**因为前缀匹配到 xy。
    const r = gitFacts(repo);
    expect(r.default_branch).not.toBe("xy");
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe("git 探针:worktree(.git 是文件)", () => {
  test(".git 文件里的 gitdir 指出去,root 仍是工作区", () => {
    const main = tmp("zgate-wt-main-");
    const gitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/wt-branch\n");
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    mkdirSync(join(main, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(main, ".git", "refs", "remotes", "origin", "HEAD"),
      "ref: refs/remotes/origin/main\n");

    const wt = tmp("zgate-wt-");
    const sub = join(wt, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);

    const r = gitFacts(sub);
    expect(r.is_repo).toBe(true);
    // ★ root 是**工作区**,不是 gitdir:inside_repo 靠它判断,
    //   而 worktree 的 gitdir 在完全不同的目录树里。
    expect(r.root).toBe(wt);
    expect(r.branch).toBe("wt-branch");
    // commondir 把 refs 指向了主仓库
    expect(r.default_branch).toBe("main");

    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe("git 探针:TTL 缓存", () => {
  test("同一 cwd 第二次调用命中缓存(改了 HEAD 也不重读)", () => {
    const repo = tmp("zgate-cache-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/first\n");
    expect(gitFacts(repo).branch).toBe("first");

    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/second\n");
    // 3 秒内仍是旧值 —— 这正是缓存该有的行为(§6 的 TTL 3 秒)
    expect(gitFacts(repo).branch).toBe("first");

    clearGitCache();
    expect(gitFacts(repo).branch).toBe("second");
    rmSync(repo, { recursive: true, force: true });
  });

  test("不同 cwd 各缓存各的", () => {
    const a = tmp("zgate-ca-");
    const b = tmp("zgate-cb-");
    mkdirSync(join(a, ".git"), { recursive: true });
    writeFileSync(join(a, ".git", "HEAD"), "ref: refs/heads/aaa\n");
    expect(gitFacts(a).branch).toBe("aaa");
    expect(gitFacts(b).is_repo).toBe(false); // b 没进缓存,真跑了一遍
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe("env_hints:白名单(§6 的硬约束)", () => {
  test("存在性三项是布尔字符串,不泄露值", () => {
    const h = envHints({ CI: "true", GIT_DIR: "/Users/someone/secret/path" });
    expect(h["CI"]).toBe("true");
    expect(h["GIT_DIR"]).toBe("true"); // ← 值不许出现
    expect(h["VIRTUAL_ENV"]).toBe("false");
  });

  test("空字符串算不存在", () => {
    expect(envHints({ CI: "" })["CI"]).toBe("false");
  });

  test("TERM_PROGRAM 取值", () => {
    expect(envHints({ TERM_PROGRAM: "iTerm.app" })["TERM_PROGRAM"]).toBe("iTerm.app");
  });

  test("★ 白名单之外的变量一个都不许出现", () => {
    const h = envHints({
      AWS_SECRET_ACCESS_KEY: "AKIA-SECRET",
      GITHUB_TOKEN: "ghp_secret",
      OPENAI_API_KEY: "sk-secret",
      DATABASE_URL: "postgres://u:p@host/db",
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      CI: "true",
    });
    const keys = Object.keys(h).sort();
    // TERM_PROGRAM 是**有才采**,这里没给,所以不该出现 —— 这条断言同时
    // 证明了白名单不是"永远输出四个键"。
    expect(keys).toEqual(["CI", "GIT_DIR", "VIRTUAL_ENV"]);
    expect(JSON.stringify(h)).not.toContain("SECRET");
    expect(JSON.stringify(h)).not.toContain("ghp_");
    expect(JSON.stringify(h)).not.toContain("/Users/someone");
  });
});

// ---------------------------------------------------------------------------
describe("enrich:组装 §2.2 的字段", () => {
  test("空目标 + 非仓库:仍然产出合法的 repo 与 env_hints", () => {
    const bare = tmp("zgate-e-");
    const r = enrich([], bare, {});
    expect(r.resources).toEqual([]);
    expect(r.repo.is_repo).toBe(false);
    expect(r.env_hints["CI"]).toBe("false");
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
    rmSync(bare, { recursive: true, force: true });
  });

  test("inside_repo:目标在仓库里 vs 在仓库外", () => {
    const repo = tmp("zgate-ir-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/main.ts"), "x");

    const inside = enrich([res("src/main.ts")], repo, {});
    expect(inside.resources[0]?.inside_repo).toBe(true);

    const outsideDir = tmp("zgate-out-");
    writeFileSync(join(outsideDir, "f.txt"), "x");
    const outside = enrich([res(join(outsideDir, "f.txt"))], repo, {});
    expect(outside.resources[0]?.inside_repo).toBe(false);

    rmSync(repo, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("★ 纯 network 目标不触发文件系统探测", () => {
    const bare = tmp("zgate-net-");
    const r = enrich([res("https://example.com", "url")], bare, {});
    expect(r.resources).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});
