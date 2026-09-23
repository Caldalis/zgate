// SPEC.md §4.5 —— 文件系统相关规则。
//
// 分两轮的理由在 §4.3:**第一轮不看环境**。`rm -rf /` 用不用得上文件系统?
// 用不上 —— 根目录是不是软链接都不改变结论。为它去 lstat 是纯浪费,
// 而 §13 的预算是 5ms。
//
// 判据上有个贯穿全文件的习惯:**宁可问,不可放**。§4.2 说未知即 SOFT。
// 所以这里凡是"看不出来"的分支一律返 SOFT,只有黑纸白字的危险才 HARD_DENY。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { baseName, hasSegment, normalize, redirectDestinations, underHome } from "./match.ts";
import { commandLine, commandSegments } from "./cmdline.ts";

/**
 * 「整个文件系统的根」的所有写法。
 *
 * 这几种都必须认:用户敲命令行时手会抖,而 `rm -rf //` 和 `rm -rf /`
 * 在内核眼里是一样的东西。
 */
const ROOT_FORMS = new Set(["/", "//", "///", "/.", "/./", "/.."]);

/** 家目录的写法。`~` 归一到空串,再由调用方拼。 */
function isRoot(raw: string): boolean {
  const p = raw.replace(/\/+$/g, "");
  if (p === "") return raw.startsWith("/"); // "/" 去尾斜杠后是空串
  return ROOT_FORMS.has(p) || p === "/";
}

function isHome(raw: string): boolean {
  const u = underHome(raw);
  return u === ""; // `~` / `$HOME` / `${HOME}` 本身
}

// ---------------------------------------------------------------------------
// pre 轮 HARD_DENY
// ---------------------------------------------------------------------------

/**
 * §4.5 第一条:递归删除根目录或家目录。
 *
 * 关键词是**递归**。`rm -d /tmp/foo` 删一个空目录不是灾难,`rm -rf /` 是。
 * 但这里有个不对称:判断"是否递归"要读选项,而选项可能写在组合里
 * (`-rf`)、分开写(`-r -f`)、用长选项(`--recursive`)、或者干脆藏在
 * `sudo rm -rf` 的包装后面。
 *
 * 所以判据是:**目标是根或家目录,且命令里有任何 r/R 的痕迹**。
 * 漏掉 `--recursive` 的代价太大,多认几个组合的代价只是多问一次。
 */
const recursiveDeleteToRoot = defineRule({
  id: "fs.rm_root",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    if (action.verb !== "delete") return null;
    for (const t of action.targets) {
      if (!isRoot(t.raw) && !isHome(t.raw)) continue;
      // 命令原文里有没有递归的含义。**拿不到原文时按"有"算** ——
      // 这条规则的命中条件是"目标是根/家目录",那已经够危险了,
      // 递归与否只影响 reason 的措辞,不该影响判不判。
      const cmd = normalize(commandLine(action)).toLowerCase();
      const looksRecursive = /(^|\s)-[a-z]*r|--recursive|--no-preserve-root/.test(cmd);
      if (looksRecursive) {
        return isRoot(t.raw) ? "递归删除文件系统根目录" : "递归删除家目录";
      }
      return "删除根目录或家目录";
    }
    return null;
  },
});

/**
 * §4.5 第二条:fork bomb 模式。
 *
 * 为什么这条规则必须存在、且必须在 pre 轮:fork bomb **没有任何文件目标**,
 * 也没有网络目标。它是纯 CPU/进程资源攻击 —— 文件系统和网络规则全都
 * 看不见它,git 规则也看不见。漏掉它,网关就完全失效。
 *
 * 形态:`:(){ :|:& };:` —— 定义一个函数,函数体里把它自己用管道接到自己
 * 并放到后台,然后调用它。变体很多(函数名不同、空格不同、用 `&` 或
 * `;`),所以判据是**组合特征**而不是字面串。
 *
 * 三个特征同时具备才算:(1) 自引用函数定义,(2) 管道接自己,(3) 后台执行。
 * 单看任何一个都会误伤(`function f() { echo; }` 是正常代码)。
 */
const forkBombPattern = defineRule({
  id: "fs.fork_bomb",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    // 这东西解析出来往往是 [] 或 exec,两种都不带完整信息,直接看原文。
    const raw = commandLine(action);
    if (raw === "") return null;
    const text = raw.replace(/\s+/g, " ");

    // (1) 函数定义,函数体里引用了自己
    const selfRef = /([A-Za-z_:][A-Za-z0-9_]*)\s*\(\s*\)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = selfRef.exec(text)) !== null) {
      const name = m[1] ?? "";
      const body = m[2] ?? "";
      if (name !== "" && body.includes(name)) {
        // (2) 管道 (3) 后台 —— 两者取其一即算,不必都齐
        if (/[|&]/.test(body)) return "fork bomb 模式";
      }
    }

    // 更短的写法:直接递归调用自己,不看函数体
    if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(text)) {
      return "fork bomb 模式";
    }
    return null;
  },
});

/**
 * §4.5 第四条:写入凭据目录。
 *
 * 只拦**写**。读 `~/.aws/credentials` 走 post 轮的敏感文件 SOFT ——
 * 读和写的危害差一个数量级,而且读凭据有时是正当的(比如把 key 导出到
 * 别处),写几乎总是恶意或灾难性的(覆盖掉 SSH 公钥 = 直接拿走机器)。
 */
const SENSITIVE_WRITE_DIRS = [
  { seg: ".ssh", what: "SSH 目录" },
  { seg: ".aws", what: "AWS 凭据目录" },
  { seg: ".gnupg", what: "GnuPG 目录" },
  { seg: ".kube", what: "Kubernetes 配置目录" },
] as const;

/** 相对家目录的敏感路径;以及绝对路径里要按段匹配的目录。 */
const SENSITIVE_WRITE_SUBPATHS = [
  { sub: ".config/gcloud", what: "gcloud 配置目录" },
  { sub: ".config/gh", what: "GitHub CLI 凭据" },
  { sub: ".docker/config.json", what: "Docker 凭据" },
  { sub: ".netrc", what: "netrc 凭据" },
  { sub: ".git-credentials", what: "git 凭据" },
] as const;

const credentialWrite = defineRule({
  id: "fs.credential_write",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    // verb 为 write/delete 时 targets 就是写的对象。其余 verb(exec / read /
    // network)的 targets 里参数与重定向目标混在一起,而 `from: "redirect"`
    // 过了适配器就没了(§2.1 只留 kind/raw),所以从命令原文重新提取重定向
    // 目的地。不这样做,`echo k >> ~/.ssh/authorized_keys` 的 verb 是 exec
    // (D2.5),这条规则整个让路 —— 这个漏判真的出现过,见 D12.2。
    const candidates: string[] =
      action.verb === "write" || action.verb === "delete"
        ? action.targets.map((t) => t.raw)
        : [];
    // 逐段扫:`bash -c 'echo k >> ~/.ssh/authorized_keys'` 的重定向在引号里,
    // 对整条原文扫会被当成字符串跳过(D12.10)。
    for (const seg of commandSegments(action)) candidates.push(...redirectDestinations(seg));
    for (const raw of candidates) {
      const p = raw.toLowerCase();

      const homeRel = underHome(p);
      if (homeRel !== null) {
        for (const d of SENSITIVE_WRITE_DIRS) {
          if (homeRel === d.seg || homeRel.startsWith(d.seg + "/")) {
            return `写入 ${d.what}`;
          }
        }
        for (const s of SENSITIVE_WRITE_SUBPATHS) {
          if (homeRel === s.sub || homeRel.startsWith(s.sub + "/")) {
            return `写入 ${s.what}`;
          }
        }
      }

      // 绝对路径(`/root/.ssh/...`、容器里的 `/home/x/.ssh/...`)按段认
      for (const d of SENSITIVE_WRITE_DIRS) {
        if (hasSegment(p, d.seg)) return `写入 ${d.what}`;
      }
      for (const s of SENSITIVE_WRITE_SUBPATHS) {
        if (p.includes(s.sub)) return `写入 ${s.what}`;
      }
    }
    return null;
  },
});

/**
 * §4.5 第五条的**前半**:显式拒绝 `--no-preserve-root`。
 *
 * 这是 GNU coreutils 专门为"我就是要删根"设计的开关。看到它就不用再
 * 分析别的了 —— 正常人的脚本里不会出现这个字符串。
 */
const noPreserveRoot = defineRule({
  id: "fs.no_preserve_root",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    const cmd = commandLine(action);
    if (cmd === "") return null;
    return normalize(cmd).toLowerCase().includes("--no-preserve-root")
      ? "显式要求删除根目录"
      : null;
  },
});

/**
 * 磁盘/设备级破坏。
 *
 * §4.5 没点名,但 `dd if=/dev/zero of=/dev/sda` 和 `mkfs` 属于同一类:
 * 一句话毁掉整台机器,而且是**不可恢复**的。规则层如果放过它,用户看到
 * 的网关就是坏的。
 *
 * 判据只看目标是不是设备节点,不看命令 —— 因为 `dd` 的参数文法里
 * `of=/dev/sda` 是选项的一部分,shell 层解析不出目标(实测 targets 为空)。
 */
const deviceDestroy = defineRule({
  id: "fs.device_write",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    const cmd = commandLine(action);
    if (cmd === "") return null;
    const text = normalize(cmd).toLowerCase();
    // 设备节点路径模式:/dev/sdX、/dev/nvme*、/dev/disk*、/dev/hd*
    // ★ 注意别把 `hd[a-z]` 和 `sd[a-z]` 写在一起却不分组 —— 那样 `\b` 只
    // 作用在最后一个分支上,`/dev/nvme0n1` 会因为后面没有词边界而漏判。
    const device =
      /\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d|vd[a-z]|xvd[a-z]|loop\d|mapper\/)/;
    if (!device.test(text)) return null;
    // 单纯的 `ls /dev/sda` 不能算 —— 只有写类命令才算
    if (/\bdd\b|\bmkfs|\bfdisk|\bparted|\bwipefs|\bshred\b|\bblkdiscard\b/.test(text)) {
      return "写入磁盘设备节点";
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// post 轮 SOFT —— 这里才是本项目的核心论点所在
// ---------------------------------------------------------------------------

/**
 * §4.5 post 轮第一条:删除/写入目标落在 cwd 子树之外。
 *
 * 这是「答案不在命令里」的第一个例子。`rm -rf ./build` 本身完全正常 ——
 * 直到你发现 `build` 是个软链接,指向 `/srv/production`。
 *
 * 判据分两半:① 目标解析后的真实位置;② 目标本身是不是软链接。
 * 两者都要看,因为有两种越界方式:写绝对路径,或者写一个指出去的链接。
 */
const escapesCwd = defineRule({
  id: "fs.outside_cwd",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null) return null;

    // 哪些 resource 是这次"写 / 删"的对象?
    //   verb 是 write/delete  →  全部 targets 都是
    //   其它 verb(exec/read)  →  只有**重定向目的地**是写(`echo x > out`),
    //     命令参数不是(`cat a > b` 里 a 是读)。重定向的 from 标记过了适配器
    //     就没了(§2.1 / D8.1),所以从命令原文重新提取,按 raw 和已探测的
    //     resource 对号 —— 不然 `echo x > /外部` 的 verb 是 exec,整条规则让路,
    //     和 D12.2 是同一类漏判。
    const writeAll = action.verb === "write" || action.verb === "delete";
    let redirects: Set<string> | null = null;
    if (!writeAll) {
      redirects = new Set<string>();
      for (const seg of commandSegments(action)) {
        for (const d of redirectDestinations(seg)) redirects.add(d);
      }
      if (redirects.size === 0) return null; // 没有写目标 —— 交给别的规则
    }

    for (const f of ctx.resources) {
      if (redirects !== null && !redirects.has(f.raw)) continue; // 是参数,不是写目标
      // 删一个不存在的东西是空操作,无害 —— 跳过。写会**创建**它,不能跳:
      // 往 cwd 外写新文件正是该问的(D12.11)。
      if (action.verb === "delete" && !f.exists) continue;
      if (f.inside_cwd) continue;
      // resolved 为 null = 连预期落点都算不出(悬空软链接),确实不知道在哪,跳过。
      // 不存在的普通路径现在带预期落点(fs.ts 的 projectPath),resolved 非 null。
      if (f.resolved === null) continue;
      // inside_cwd 为 false 且 resolved 存在 —— 真实或预期落点已经在 cwd 之外了
      return f.is_symlink ? "目标软链接指向 cwd 之外" : "目标在 cwd 之外";
    }
    return null;
  },
});

/**
 * §4.5 post 轮第二条:目标是软链接且指向仓库外。
 *
 * 单列一条(而不是并进上一条)的理由:这条在 `cwd` 是仓库子目录时特别有用 ——
 * 目标可能还在 cwd 里,但链接指到了仓库之外的生产目录。两个"在外面"不是
 * 一回事,reason 也该分开,用户才知道该看哪里。
 */
const symlinkOutOfRepo = defineRule({
  id: "fs.symlink_outside_repo",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    if (action.verb !== "delete" && action.verb !== "write") return null;
    if (ctx === null || !ctx.repo.is_repo) return null;
    for (const f of ctx.resources) {
      if (!f.is_symlink || f.resolved === null) continue;
      if (!f.inside_repo) return "写目标是指向仓库外的软链接";
    }
    return null;
  },
});

/**
 * §4.5 post 轮第三条:读/写敏感文件。
 *
 * 这一条的「敏感」是**名字**上的,不是内容上的 —— 网关不读文件内容(§6)。
 * 所以判据是文件名模式。代价是可能误报(`id_rsa.pub` 是公钥,读它没事),
 * 但那正是 SOFT 而不是 DENY 的理由:问一下,让用户自己决定。
 */
const SECRET_NAME_RE = /(^|\/)\.env(\.[^/]*)?$|\.pem$|\.key$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.p12$|\.pfx$/;

const secretFile = defineRule({
  id: "fs.secret_file",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    if (action.verb !== "read" && action.verb !== "write" && action.verb !== "delete") {
      return null;
    }
    for (const t of action.targets) {
      const p = t.raw.toLowerCase();
      if (SECRET_NAME_RE.test(p)) {
        // `.env.example` 是给人看的模板,里面没有真值 —— 放行。
        if (/\.env\.(example|sample|template|dist)$/.test(p)) continue;
        return `涉及密钥文件 ${baseName(t.raw)}`;
      }
    }
    return null;
  },
});

/**
 * §4.5 post 轮第四条:`verb === "unknown"` 或解析失败。
 *
 * 这是 §4.2 的直接实现:**未知即 SOFT,绝不 PASS**。这条规则看起来
 * 平淡无奇,但它承担了整个降级体系 —— 没有它,解析器每漏一种写法,
 * 危险命令就直接放行了。
 */
const unknownAction = defineRule({
  id: "fs.unknown",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    return action.verb === "unknown" ? "命令语义无法判定" : null;
  },
});

/**
 * §4.5 post 轮第五条:命令里出现生产环境关键词且是写/删。
 *
 * 一个提醒:这条规则**故意做得很粗**。`prod` 出现在 `reproduce.ts` 里
 * 也会命中(用了词边界,能挡掉一部分)。为什么接受:命中的代价是一次
 * 询问,漏掉的代价是删生产库。见 D8.6。
 */
const PROD_WORDS = ["prod", "production", "live", "staging", "prd"] as const;

const productionWord = defineRule({
  id: "fs.production_target",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    if (action.verb !== "write" && action.verb !== "delete") return null;
    const haystack = [
      ...action.targets.map((t) => t.raw),
      commandLine(action),
    ].join(" ").toLowerCase();
    if (haystack === "") return null;

    for (const w of PROD_WORDS) {
      // 词边界匹配:reproduce / productive 不算
      const re = new RegExp(`(^|[^a-z0-9_])${w}([^a-z0-9_]|$)`);
      if (re.test(haystack)) return `操作涉及生产环境(${w})`;
    }
    return null;
  },
});

/**
 * 越界写入但目标**不存在**的情况(冗余兜底)。
 *
 * D12.11 之前,`fs.outside_cwd` 对不存在的目标一律 `!f.exists` 就 continue,
 * 于是 `echo x > /etc/cron.d/evil` 这种"写仓库外的新文件"漏判。这条规则当时
 * 是唯一的补丁,但只在 cwd **不是**仓库时生效,仓库内仍漏。
 *
 * D12.11 修好之后,不存在的目标带上了预期落点,`fs.outside_cwd` 已经覆盖
 * 主路径(含仓库内)。这条留作非仓库场景的冗余:目标不存在 + 绝对路径 +
 * cwd 之外 ⇒ SOFT。两条都命中时同为 SOFT,取最严不受影响。
 */
const absoluteWriteOutside = defineRule({
  id: "fs.absolute_outside",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    if (action.verb !== "write" && action.verb !== "delete") return null;
    if (ctx === null || ctx.repo.is_repo) return null; // 仓库内的情况交给上面几条
    for (const t of action.targets) {
      if (t.raw.startsWith("/") && !t.raw.startsWith("//")) return "写入仓库外的绝对路径";
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// post 轮 PASS —— 显式白名单,用来压低误拦(§4.5 最后一段)
// ---------------------------------------------------------------------------

/**
 * 纯查询命令。
 *
 * `git status` / `ls` / `pwd` 这类命令产生的是**只读**效果,而它们在一次
 * session 里出现频率极高(Claude Code 每步都在 `git status`)。给它们
 * 一条明确的 PASS 路径,是 §4.5 说的"压低误拦"最直接的落点。
 *
 * 注意 PASS 不是"跳过后面的规则" —— 规则层取最严,一条 PASS 规则命中
 * 不会阻止别的规则判 SOFT。它的作用是**在没有任何 SOFT 命中时**给出
 * 一个明确的 allow 依据(而不是靠"什么都没命中"这种沉默的默认)。
 */
const readOnlyFiles = defineRule({
  id: "fs.read_only",
  stage: "post",
  verdict: "PASS",
  match(action: Action, ctx: Context | null): string | null {
    if (action.verb !== "read") return null;
    // 有目标且目标可解析:必须在仓库内才算白名单
    if (action.targets.length === 0) return "纯查询命令";
    if (ctx === null) return null;
    const files = ctx.resources;
    if (files.length === 0) return "纯查询命令";
    if (files.every((f) => f.inside_cwd || !f.exists)) return "读取仓库内文件";
    return null;
  },
});

/** `ls` / `pwd` / `git status` 等:没有目标或目标就是当前目录。 */
const TRIVIAL_QUERY_CMDS = new Set(["ls", "pwd", "git status", "git diff", "git log", "git branch"]);

const trivialQuery = defineRule({
  id: "fs.trivial_query",
  stage: "post",
  verdict: "PASS",
  match(action: Action, _ctx: Context | null): string | null {
    const cmd = normalize(commandLine(action)).toLowerCase().trim();
    return cmd !== "" && TRIVIAL_QUERY_CMDS.has(cmd) ? "无副作用的查询命令" : null;
  },
});

export const FILESYSTEM_RULES: readonly Rule[] = [
  // pre
  recursiveDeleteToRoot,
  forkBombPattern,
  noPreserveRoot,
  credentialWrite,
  deviceDestroy,
  // post
  unknownAction,
  escapesCwd,
  symlinkOutOfRepo,
  secretFile,
  productionWord,
  absoluteWriteOutside,
  readOnlyFiles,
  trivialQuery,
];
