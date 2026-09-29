// SPEC.md §4.5 —— git 相关规则。
//
// 这一层只有一条真正重要的规则:**在默认分支上重写历史**。
//
// 它同时是 §12 的第 2 个 golden case,也是「答案不在命令字符串里」的
// 最干净的例子:
//
//   git push --force          在 feature 分支 → 完全正常,团队日常操作
//   git push --force          在 main 分支   → 覆盖别人的提交,不可恢复
//
// 同一条命令。区别只在于**当前在哪个分支** —— 那是 Context 里的信息,
// 而 Context 来自 §6 的 git 探针(读 `.git/HEAD`,不起子进程)。
//
// 判据必须落在 pre 和 post 两轮:
//   pre  — 命令原文里就能看出的形态(`--no-verify` 跳过钩子、
//          `reset --hard` 丢工作区),不依赖分支
//   post — 依赖 `repo.branch` / `repo.default_branch` 的判断

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { hasWord, normalize } from "./match.ts";
import { commandLine, simpleCommands } from "./cmdline.ts";

/**
 * 从命令行原文里判断 git 子命令。
 *
 * 为什么不复用解析层:解析层已经给出 verb,但 git 的二级语义远不止
 * verb(§7 的表把 `push` 归 network、`reset --hard` 归 write),而
 * "是不是 force push" 这种判断需要看到 `--force` 这个**选项**,
 * 那是解析层不保留的信息。
 *
 * 所以这里重新扫一遍原文。冗余,但便宜(一个 regex),而且判据集中在
 * 一处,改起来不会漏掉另一份。
 */
function gitSubcommand(text: string): { sub: string; rest: string } | null {
  // 剥掉可能的包装词与全局选项
  const words = text.split(/\s+/).filter((w) => w !== "");
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "sudo" || w === "env" || w === "nohup" || w === "time" || w === "command") {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return null;

  const head = (words[i] ?? "").replace(/^.*\//, "");
  if (head !== "git") return null;
  i += 1;

  // 跳过 git 的全局选项:`-C path`、`-c k=v`、`--no-pager` …
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree") {
      i += 2;
      continue;
    }
    if (w.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return null;

  const sub = words[i] ?? "";
  return { sub, rest: words.slice(i + 1).join(" ") };
}

/**
 * 剥掉选项,只留位置参数。**只按短横线剥,不吞后面的值。**
 *
 * 为什么不用 `replace(/--?\S+(\s+\S+)?/g, "")`:那个正则会把
 * `--force origin main` 里的 `origin` 也当成选项的值一起吞掉,于是
 * "推 origin/main"被读成"推当前分支" —— 判据直接反了。见 D8.4。
 */
function cleanFlags(rest: string): string[] {
  return rest
    .split(/\s+/)
    // 重定向(`2>&1`、`>log`)不是位置参数 —— 否则 `git push --force 2>&1`
    // 会被读成"推一个叫 2>&1 的分支",于是"推当前分支"的判据失效(D12.10)
    .filter((w) => w !== "" && !w.startsWith("-") && !/[<>]/.test(w));
}

/**
 * 原文里的**每一条** git 调用。
 *
 * 跨 `&&` / `;` / `|`,并且看穿 `bash -c '…'`(见 cmdline.ts 的 D12.10)。
 * 第一版只对整条原文调一次 `gitSubcommand`,于是 `git status && git push
 * --force` 看到的是 `status`,`bash -c 'git push --force'` 看到的是 `bash`
 * —— 两种写法都静默放行。
 */
function gitInvocations(action: Action): { sub: string; rest: string; text: string }[] {
  const out: { sub: string; rest: string; text: string }[] = [];
  for (const seg of simpleCommands(action)) {
    const text = normalize(seg);
    const parsed = gitSubcommand(text);
    if (parsed !== null) out.push({ ...parsed, text });
  }
  return out;
}

/**
 * 解析 `git push` 的位置参数,给出这次推送的**目的分支名**列表。
 *
 * 三种写法都要认(这是踩过的坑,一条条列出来):
 *
 *   git push --force             → 没有位置参数 ⇒ 推当前分支 ⇒ 返回 []
 *   git push origin main         → 第 2 个位置参数就是分支
 *   git push origin +main        → `+` 是强推标记,去掉才是分支名
 *   git push origin feature:main → refspec,**右半边**才是目的端
 *   git push origin HEAD:main    → 同上
 *
 * 最后一种最阴:本地在 feature 分支,强推的却是远端 main。只看"当前
 * 分支"的规则完全够不着它,所以这里统一解析出目的端,交给调用方判决。
 *
 * 返回值已剥掉 `refs/heads/` 前缀。空数组表示"没写,推当前分支"。
 */
function pushDestinations(rest: string): string[] {
  const words = cleanFlags(rest).filter((w) => w !== "origin" && w !== "upstream");
  const out: string[] = [];
  for (const w of words) {
    const refspec = w.startsWith("+") ? w.slice(1) : w;
    const colon = refspec.indexOf(":");
    const dst = colon === -1 ? refspec : refspec.slice(colon + 1);
    out.push(dst.replace(/^refs\/heads\//, ""));
  }
  return out;
}

/** 命令原文里是否出现了 force 系列选项。 */
function isForcePush(rest: string): boolean {
  // `--force` / `-f` / `--force-with-lease` / `--force-if-includes`
  // 注意 `-f` 必须按词边界,否则 `--force-with-lease` 会被 `-f` 误吞
  // (结果一样是 force,但判据要准确,不然 reason 会写错)。
  return (
    /(^|\s)--force(-with-lease|-if-includes)?(\s|$)/.test(rest) ||
    /(^|\s)-f(\s|$)/.test(rest) ||
    /(^|\s)\+[A-Za-z0-9_./-]+/.test(rest) // `git push origin +main` 的强推写法
  );
}

/**
 * 在默认分支上强推 —— **post 轮**,因为判据在 Context 里。
 *
 * 两个字段缺一不可:`repo.branch`(现在在哪)和 `repo.default_branch`
 * (默认分支叫什么)。§6 说 `default_branch` 取不到就是 `null`,那时
 * 这条规则**不命中** —— 因为"不知道默认分支是哪个"不等于"不在默认分支上",
 * 但也不等于在。这里的选择是不命中(交给别的规则判),而不是命中。
 *
 * 为什么不用"branch === main || branch === master"兜底:那不是判据,
 * 是猜测。仓库可能是 `trunk` / `develop` / `release`。猜的代价是漏判。
 */
const forcePushDefaultBranch = defineRule({
  id: "git.force_push_default",
  stage: "post",
  verdict: "HARD_DENY",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null || !ctx.repo.is_repo) return null;
    const branch = ctx.repo.branch;
    const def = ctx.repo.default_branch;
    if (branch === null || def === null) return null;
    if (branch !== def) return null;

    // 注意:这里**不**转小写。分支名和 `-D` 都是大小写敏感的,
    // 而 `--force` / `-f` 在 isForcePush 里各自按需处理。
    for (const g of gitInvocations(action)) {
      if (g.sub !== "push" || !isForcePush(g.rest)) continue;
      // 没写位置参数 ⇒ 推当前分支(= 默认分支)⇒ 判死。
      // 写了就只在目的端确实是当前分支时判死。
      const dests = pushDestinations(g.rest);
      if (dests.length === 0) return `在默认分支 ${branch} 上强推`;
      for (const d of dests) {
        if (d === branch || d === "HEAD") return `在默认分支 ${branch} 上强推`;
      }
    }
    return null;
  },
});

/**
 * 强推**进**默认分支 —— 不管此刻在哪个分支。
 *
 * 这是上一条规则够不着的一格,而且是更阴的一格:
 *
 *   git push --force origin feature:main
 *
 * 本地在 `feature` 分支(`repo.branch === "feature/x"`),强推的目标却是
 * 远端 `main`。上一条规则只比"当前分支 == 默认分支",于是完全放过它,
 * 而后果和"在 main 上强推"完全相同 —— 远端默认分支的历史被覆盖。
 *
 * 判据来自命令行本身(`refspec` 的目的端),不需要额外的 Context 字段,
 * 所以它比上一条更硬:只要目的端是默认分支且带 force,就是 HARD_DENY。
 */
const forcePushIntoDefault = defineRule({
  id: "git.force_push_into_default",
  stage: "post",
  verdict: "HARD_DENY",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null || !ctx.repo.is_repo) return null;
    const def = ctx.repo.default_branch;
    if (def === null) return null; // 不知道默认分支叫什么,不猜(D7.7)

    for (const g of gitInvocations(action)) {
      if (g.sub !== "push" || !isForcePush(g.rest)) continue;
      for (const dst of pushDestinations(g.rest)) {
        if (dst === def) return `强推覆盖远端默认分支 ${def}`;
      }
    }
    return null;
  },
});

/**
 * 强推,但**判据不全** —— SOFT。
 *
 * 这条规则是上面两条的兜底。上面两条 HARD_DENY 要 `repo.branch` 和
 * `repo.default_branch` **都在**才有判据;缺任何一个它们都主动不命中
 * (不是仓库、detached HEAD、cwd 在仓库外,或者仓库没有
 * `refs/remotes/origin/HEAD` —— `git init` 加 `git remote add` 建出来的
 * 仓库全是这样)。而强推本身仍然是个值得问的操作。
 *
 * ★ 第一版只检查 `branch === null`。于是"分支已知、默认分支未知"这一格
 *   三条规则全部让路,`git push --force` 静默 PASS —— 本项目自己的仓库
 *   就命中这一格。见 D12.1。
 *
 * 这就是 §4.2 的落地:拿不准 → SOFT → ask,绝不 PASS。
 */
const forcePushUnknown = defineRule({
  id: "git.force_push_unknown",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    const branchKnown = ctx !== null && ctx.repo.branch !== null;
    const defaultKnown = ctx !== null && ctx.repo.default_branch !== null;
    if (branchKnown && defaultKnown) return null; // 判据齐了,交给上面两条
    for (const g of gitInvocations(action)) {
      if (g.sub !== "push" || !isForcePush(g.rest)) continue;
      return branchKnown ? "强制推送,默认分支未知" : "强制推送,分支未知";
    }
    return null;
  },
});

/**
 * 历史重写与工作区丢弃 —— pre 轮,不依赖分支。
 *
 * `git reset --hard` 会丢掉未提交的改动,`git clean -fdx` 会删掉所有
 * 未跟踪文件(包括用户忘了加进 gitignore 的构建产物)。这两个不管在哪个
 * 分支上都是不可恢复的操作,所以不需要 Context。
 *
 * 档位是 SOFT 而不是 HARD_DENY:`git reset --hard` 在 CI 脚本里是常规
 * 操作,判死会破坏正常工作流。问一次是合适的。
 */
const destructiveGit = defineRule({
  id: "git.destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const g of gitInvocations(action)) {
      if (g.sub === "reset" && /(^|\s)--hard(\s|$)/.test(g.rest)) {
        return "丢弃工作区改动";
      }
      if (g.sub === "clean" && /(^|\s)-[a-z]*f/.test(g.rest)) {
        return "删除未跟踪文件";
      }
      if (g.sub === "checkout" && /(^|\s)--(\s|$)/.test(g.text)) {
        return "丢弃工作区改动";
      }
      if (g.sub === "restore" && /(^|\s)--(source|worktree|staged)(\s|$)/.test(g.rest)) {
        return "丢弃工作区改动";
      }
      if (g.sub === "filter-branch" || g.sub === "filter-repo") {
        return "重写仓库历史";
      }
      if (g.sub === "push" && /(^|\s)--(delete|mirror)(\s|$)/.test(g.rest)) {
        return "删除远程分支或镜像推送";
      }
      if (g.sub === "branch" && /(^|\s)-D(\s|$)/.test(g.rest)) {
        return "强制删除本地分支";
      }
      // 下面四条是 D15.10 补的:stash 里的改动、reflog 与不可达对象、引用,丢了都找不回来
      if (g.sub === "stash" && /(^|\s)(drop|clear)(\s|$)/.test(g.rest)) {
        return "丢弃 stash 里的改动";
      }
      if (g.sub === "reflog" && /(^|\s)(expire|delete)(\s|$)/.test(g.rest)) {
        return "清理 reflog";
      }
      if (g.sub === "gc" && /(^|\s)--prune(=|\s|$)/.test(g.rest)) {
        return "gc --prune 清理不可达对象";
      }
      if (g.sub === "update-ref" && /(^|\s)-d(\s|$)/.test(g.rest)) {
        return "删除 git 引用";
      }
    }
    return null;
  },
});

/**
 * 跳过 git 钩子。
 *
 * `--no-verify` 绕过 pre-commit / pre-push 钩子。钩子是团队加在仓库里的
 * 检查(格式化、lint、测试),跳过它意味着把没检查的代码推进去。
 *
 * 单列一条而不是并进上一条:它的危害是**团队约定**层面的,而不是数据
 * 层面的,所以 reason 该说清楚是哪种,用户才知道该不该点。
 */
const skipHooks = defineRule({
  id: "git.no_verify",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    const cmd = commandLine(action);
    if (cmd === "") return null;
    const text = normalize(cmd);
    if (!hasWord(text, "git") && !text.startsWith("git ")) {
      // 也允许 `commit --no-verify` 这种在 wrapper 里的写法,但要有 git 字样
      if (!text.includes("git")) return null;
    }
    if (/(^|\s)--no-verify(\s|$)/.test(text)) return "跳过 git 钩子检查";
    return null;
  },
});

export const GIT_RULES: readonly Rule[] = [
  destructiveGit,
  skipHooks,
  forcePushDefaultBranch,
  forcePushIntoDefault,
  forcePushUnknown,
];
