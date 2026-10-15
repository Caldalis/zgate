// git 相关规则。
//
// 最重要的一条是在默认分支上重写历史,它也是「答案不在命令字符串里」最干净的例子:
//
//   git push --force          在 feature 分支 → 完全正常,团队日常操作
//   git push --force          在 main 分支   → 覆盖别人的提交,不可恢复
//
// 区别只在当前在哪个分支,那来自 git 探针(读 `.git/HEAD`,不起子进程)。所以判据分两轮:
//   pre  — 原文里就能看出的形态(`--no-verify` 跳过钩子、`reset --hard` 丢工作区),不依赖分支
//   post — 依赖 `repo.branch` / `repo.default_branch` 的判断

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { t } from "../i18n.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { hasWord, normalize } from "./match.ts";
import { commandLine, simpleCommands } from "./cmdline.ts";

/**
 * 从命令行原文里判断 git 子命令。不复用解析层的 verb:"是不是 force push" 要看 `--force` 这个选项,
 * 解析层不保留它。重扫一遍原文冗余但便宜,判据也集中在一处。
 */
function gitSubcommand(text: string): { sub: string; rest: string } | null {
  // 剥掉可能的包装词与前置赋值
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
 * 剥掉选项,只留位置参数。只按短横线剥,不吞后面的值:
 * `--force origin main` 里的 `origin` 若被当成选项值吞掉,"推 origin/main"就读成了"推当前分支"。
 */
function cleanFlags(rest: string): string[] {
  return rest
    .split(/\s+/)
    // 重定向(`2>&1`、`>log`)不是位置参数,否则 `git push --force 2>&1` 会被读成推一个叫 2>&1 的分支
    .filter((w) => w !== "" && !w.startsWith("-") && !/[<>]/.test(w));
}

/** 原文里的每一条 git 调用:跨 `&&` / `;` / `|`,并看穿 `bash -c '…'`(见 cmdline.ts 顶部)。 */
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
 * 解析 `git push` 的位置参数,给出这次推送的目的分支名列表:
 *
 *   git push --force             → 没有位置参数 ⇒ 推当前分支 ⇒ 返回 []
 *   git push origin main         → 第 2 个位置参数就是分支
 *   git push origin +main        → `+` 是强推标记,去掉才是分支名
 *   git push origin feature:main → refspec,右半边才是目的端
 *   git push origin HEAD:main    → 同上
 *
 * refspec 写法在 feature 分支上就能强推远端 main,只看当前分支的规则够不着,所以统一解析出目的端。
 * 返回值已剥掉 `refs/heads/` 前缀。
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
  // `--force` / `-f` / `--force-with-lease` / `--force-if-includes`;`-f` 按词边界匹配
  return (
    /(^|\s)--force(-with-lease|-if-includes)?(\s|$)/.test(rest) ||
    /(^|\s)-f(\s|$)/.test(rest) ||
    /(^|\s)\+[A-Za-z0-9_./-]+/.test(rest) // `git push origin +main` 的强推写法
  );
}

/**
 * 在默认分支上强推。post 轮,因为判据在 Context 里。
 *
 * `repo.branch` 和 `repo.default_branch` 缺一不可。默认分支取不到(null)时不命中:不知道默认分支是哪个,
 * 不等于不在默认分支上,但也不等于在;这一格交给 git.force_push_unknown 判 SOFT。
 * 也不用 "branch === main || master" 兜底:仓库可能是 trunk / develop,猜错的代价是漏判。
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

    // 不转小写:分支名大小写敏感
    for (const g of gitInvocations(action)) {
      if (g.sub !== "push" || !isForcePush(g.rest)) continue;
      // 没写位置参数 ⇒ 推当前分支(= 默认分支)⇒ 判死。
      // 写了就只在目的端确实是当前分支时判死。
      const dests = pushDestinations(g.rest);
      const reason = t(`在默认分支 ${branch} 上强推`, `force push on the default branch ${branch}`);
      if (dests.length === 0) return reason;
      for (const d of dests) {
        if (d === branch || d === "HEAD") return reason;
      }
    }
    return null;
  },
});

/**
 * 强推进默认分支,不管此刻在哪个分支:`git push --force origin feature:main`。
 * 本地在 feature 分支时上一条规则只比"当前分支 == 默认分支",会完全放过它,而后果相同。
 * 判据来自 refspec 的目的端:只要目的端是默认分支且带 force,就 HARD_DENY。
 */
const forcePushIntoDefault = defineRule({
  id: "git.force_push_into_default",
  stage: "post",
  verdict: "HARD_DENY",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null || !ctx.repo.is_repo) return null;
    const def = ctx.repo.default_branch;
    if (def === null) return null; // 不知道默认分支叫什么,不猜

    for (const g of gitInvocations(action)) {
      if (g.sub !== "push" || !isForcePush(g.rest)) continue;
      for (const dst of pushDestinations(g.rest)) {
        if (dst === def) return t(`强推覆盖远端默认分支 ${def}`, `force push overwrites the remote default branch ${def}`);
      }
    }
    return null;
  },
});

/**
 * 强推但判据不全 ⇒ SOFT,上面两条的兜底。
 *
 * 上面两条要 `repo.branch` 和 `repo.default_branch` 都在才判;缺任何一个(不是仓库、detached HEAD、
 * cwd 在仓库外,或者没有 `refs/remotes/origin/HEAD` —— `git init` 加 `git remote add` 建出来的仓库全是这样)
 * 它们都不命中,而强推仍然值得问。拿不准 → SOFT → ask,绝不 PASS。
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
      return branchKnown
        ? t("强制推送,默认分支未知", "force push, default branch unknown")
        : t("强制推送,分支未知", "force push, branch unknown");
    }
    return null;
  },
});

/**
 * 历史重写与工作区丢弃,pre 轮,不依赖分支:`git reset --hard` 丢未提交的改动,`git clean -fdx` 删所有未跟踪文件,
 * 在哪个分支上都不可恢复。档位是 SOFT:`reset --hard` 在 CI 脚本里是常规操作,判死会破坏正常工作流。
 */
const destructiveGit = defineRule({
  id: "git.destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const g of gitInvocations(action)) {
      if (g.sub === "reset" && /(^|\s)--hard(\s|$)/.test(g.rest)) {
        return t("丢弃工作区改动", "discards working tree changes");
      }
      if (g.sub === "clean" && /(^|\s)-[a-z]*f/.test(g.rest)) {
        return t("删除未跟踪文件", "deletes untracked files");
      }
      if (g.sub === "checkout" && /(^|\s)--(\s|$)/.test(g.text)) {
        return t("丢弃工作区改动", "discards working tree changes");
      }
      if (g.sub === "restore" && /(^|\s)--(source|worktree|staged)(\s|$)/.test(g.rest)) {
        return t("丢弃工作区改动", "discards working tree changes");
      }
      if (g.sub === "filter-branch" || g.sub === "filter-repo") {
        return t("重写仓库历史", "rewrites repository history");
      }
      if (g.sub === "push" && /(^|\s)--(delete|mirror)(\s|$)/.test(g.rest)) {
        return t("删除远程分支或镜像推送", "deletes a remote branch or mirror-pushes");
      }
      if (g.sub === "branch" && /(^|\s)-D(\s|$)/.test(g.rest)) {
        return t("强制删除本地分支", "force-deletes a local branch");
      }
      // stash 里的改动、reflog 与不可达对象、引用,丢了都找不回来
      if (g.sub === "stash" && /(^|\s)(drop|clear)(\s|$)/.test(g.rest)) {
        return t("丢弃 stash 里的改动", "drops stashed changes");
      }
      if (g.sub === "reflog" && /(^|\s)(expire|delete)(\s|$)/.test(g.rest)) {
        return t("清理 reflog", "prunes the reflog");
      }
      if (g.sub === "gc" && /(^|\s)--prune(=|\s|$)/.test(g.rest)) {
        return t("gc --prune 清理不可达对象", "gc --prune removes unreachable objects");
      }
      if (g.sub === "update-ref" && /(^|\s)-d(\s|$)/.test(g.rest)) {
        return t("删除 git 引用", "deletes a git ref");
      }
    }
    return null;
  },
});

/**
 * 跳过 git 钩子:`--no-verify` 绕过 pre-commit / pre-push 里团队加的检查(格式化、lint、测试)。
 * 单列一条:危害在团队约定层面而不是数据层面,reason 要说清是哪种。
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
    if (/(^|\s)--no-verify(\s|$)/.test(text)) return t("跳过 git 钩子检查", "skips git hooks (--no-verify)");
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
