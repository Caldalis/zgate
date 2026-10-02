// 文件系统相关规则。
//
// pre 轮不看环境:`rm -rf /` 不管根目录是不是软链接结论都一样,为它去 lstat 是浪费(p50 预算 5ms)。
// 贯穿全文件的习惯是宁可问、不可放:看不出来的分支一律 SOFT,只有确定的危险才 HARD_DENY。

import type { Action } from "../core/action.ts";
import type { Context } from "../core/context.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { baseName, hasSegment, normalize, redirectDestinations, underHome } from "./match.ts";
import { commandLine, commandSegments, operandsOf, simpleCommandHead, simpleCommands } from "./cmdline.ts";

/** 文件系统根的各种写法:`rm -rf //` 和 `rm -rf /` 在内核眼里是一回事。 */
const ROOT_FORMS = new Set(["/", "//", "///", "/.", "/./", "/.."]);

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
 * 删除根目录或家目录。只要目标是根或家目录就命中,递归与否只影响 reason 的措辞。
 * 递归的痕迹可能是组合(`-rf`)、分开(`-r -f`)或长选项(`--recursive`),都认。
 */
const recursiveDeleteToRoot = defineRule({
  id: "fs.rm_root",
  stage: "pre",
  verdict: "HARD_DENY",
  match(action: Action): string | null {
    if (action.verb !== "delete") return null;
    for (const t of action.targets) {
      if (!isRoot(t.raw) && !isHome(t.raw)) continue;
      // 拿不到原文时 looksRecursive 为 false,照样命中,只是 reason 不说"递归"
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
 * fork bomb。没有任何文件或网络目标,别的规则都看不见它,所以单独在 pre 轮判。
 *
 * 形态 `:(){ :|:& };:`:定义一个函数,函数体里用管道接自己并放到后台,然后调用它。
 * 变体很多(函数名、空格、`&` 或 `;`),所以判据是组合特征:自引用的函数定义,且函数体里有管道或后台。
 * 单看函数定义会误伤(`function f() { echo; }` 是正常代码)。
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

    // 函数定义,函数体里引用了自己
    const selfRef = /([A-Za-z_:][A-Za-z0-9_]*)\s*\(\s*\)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = selfRef.exec(text)) !== null) {
      const name = m[1] ?? "";
      const body = m[2] ?? "";
      if (name !== "" && body.includes(name)) {
        // 再有管道或后台即算
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
 * 写入凭据目录。只拦写:读凭据有时是正当的(走 post 轮的敏感文件 SOFT),
 * 写几乎总是恶意或灾难性的(覆盖 SSH 授权公钥 = 直接拿走机器)。
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
    // write / delete 的 targets 就是写的对象;其余 verb 的参数与重定向目标混在一起,所以从命令原文
    // 重新提取重定向目的地,否则 `echo k >> ~/.ssh/authorized_keys`(verb 是 exec)会整个让路。
    const candidates: string[] =
      action.verb === "write" || action.verb === "delete"
        ? action.targets.map((t) => t.raw)
        : [];
    // 逐段扫:`bash -c 'echo k >> ~/.ssh/authorized_keys'` 的重定向在引号里,
    // 对整条原文扫会被当成字符串跳过。
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

/** 显式的 `--no-preserve-root`:GNU coreutils 专为"我就是要删根"设计的开关,正常脚本里不会出现。 */
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
 * 磁盘 / 设备级破坏(`dd if=/dev/zero of=/dev/sda`、`mkfs`):一句话毁掉整台机器,不可恢复。
 * 直接看原文里的设备节点路径与写类命令:`dd` 的 `of=/dev/sda` 是选项的一部分,shell 层解析不出目标。
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
    // 各分支要包在同一个组里:不分组时边界只作用于最后一个分支,`/dev/nvme0n1` 会漏判。
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

/**
 * 删 / 写目标里有未展开的变量或 `~`。解析层不展开变量,探针把 `$DIR` 当成 cwd 里的字面路径,`inside_cwd` 恒 true,
 * 于是 `rm -rf $DIR`、`rm -rf ~/Library/x`、`echo x > $OUT` 会一律 PASS,那是 fail-open。目标解析不出来一律 SOFT。
 * `~` / `$HOME` 本身归 fs.rm_root,`~/.ssh` 归 fs.credential_write,它们是 HARD_DENY,先赢。
 */
const unresolvedTarget = defineRule({
  id: "fs.unresolved_target",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    const candidates = action.verb === "write" || action.verb === "delete" ? action.targets.map((t) => t.raw) : [];
    for (const seg of commandSegments(action)) candidates.push(...redirectDestinations(seg));
    for (const raw of candidates) {
      if (raw.includes("$") || raw.startsWith("~")) return "目标含未展开的变量或 ~";
    }
    return null;
  },
});

/** rm 的目标不在命令行上(`xargs rm -rf < list.txt`、`… | xargs rm`):看不见要删什么。 */
const RM_FAMILY = new Set(["rm", "rmdir", "shred", "unlink"]);

const rmOperandHidden = defineRule({
  id: "fs.rm_operand_hidden",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const seg of simpleCommands(action)) {
      const c = simpleCommandHead(seg);
      if (c !== null && RM_FAMILY.has(c.head) && operandsOf(c.args).length === 0) return "删除目标不在命令行上";
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// post 轮 SOFT —— 结论取决于环境
// ---------------------------------------------------------------------------

/**
 * 删除 / 写入目标落在 cwd 子树之外。
 *
 * `rm -rf ./build` 本身完全正常,直到发现 `build` 是指向 `/srv/production` 的软链接。
 * 越界有两种方式:写绝对路径,或写一个指出去的链接;判据都是解析后的真实位置,是不是软链接只影响 reason。
 */
const escapesCwd = defineRule({
  id: "fs.outside_cwd",
  stage: "post",
  verdict: "SOFT",
  match(action: Action, ctx: Context | null): string | null {
    if (ctx === null) return null;

    // 哪些 resource 是这次写 / 删的对象:
    //   verb 是 write/delete  →  全部 targets
    //   其它 verb(exec/read)  →  只有重定向目的地是写(`echo x > out`),命令参数不是(`cat a > b` 里 a 是读)。
    //     过了适配器分不清两者,所以从命令原文重新提取,按 raw 和已探测的 resource 对号。
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
      // 删一个不存在的东西是空操作,跳过;写会创建它,不能跳:往 cwd 外写新文件正是该问的。
      if (action.verb === "delete" && !f.exists) continue;
      if (f.inside_cwd) continue;
      // resolved 为 null:悬空软链接,连预期落点都算不出,跳过。
      // 不存在的普通路径带预期落点(fs.ts 的 projectPath),resolved 非 null。
      if (f.resolved === null) continue;
      // inside_cwd 为 false 且 resolved 存在 —— 真实或预期落点已经在 cwd 之外了
      return f.is_symlink ? "目标软链接指向 cwd 之外" : "目标在 cwd 之外";
    }
    return null;
  },
});

/**
 * 写 / 删目标是指向仓库外的软链接。cwd 是仓库子目录时尤其有用:目标还在 cwd 里,链接却指到仓库外。
 * 与上一条分开,reason 才能告诉用户该看哪里。
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

// env 文件既有点号开头(.env、.env.local)也有后缀形式(prod.env、staging.env),两种都认
const SECRET_NAME_RE = /(^|\/)[^/]*\.env(\.[^/]*)?$|\.pem$|\.key$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.p12$|\.pfx$/;

/**
 * 读 / 写敏感文件。敏感按文件名判,网关不读文件内容。会有误报(`id_rsa.pub` 是公钥),
 * 这正是判 SOFT 而不是 DENY 的理由:问一下,让用户自己决定。
 */
const secretFile = defineRule({
  id: "fs.secret_file",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    // read / write / delete 的 targets 就是碰到的文件;其余 verb(`echo K=1 >> .env` 是 exec)只看重定向目的地,
    // 从原文逐段提取,与 credential_write 同一套做法。
    const fromTargets = action.verb === "read" || action.verb === "write" || action.verb === "delete";
    const candidates = fromTargets
      ? action.targets.map((t) => t.raw)
      : commandSegments(action).flatMap((seg) => redirectDestinations(seg));
    for (const raw of candidates) {
      const p = raw.toLowerCase();
      if (SECRET_NAME_RE.test(p)) {
        // `.env.example` 是给人看的模板,里面没有真值 —— 放行。
        if (/\.env\.(example|sample|template|dist)$/.test(p)) continue;
        return `涉及密钥文件 ${baseName(raw)}`;
      }
    }
    return null;
  },
});

/**
 * `verb === "unknown"` 或解析失败:未知即 SOFT,绝不 PASS。
 * 整个降级体系靠它兜底:没有它,解析器每漏一种写法,危险命令就直接放行。
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
 * 写 / 删且出现生产环境关键词。故意做得很粗:用了词边界,但 `prod.yaml` 这种照样命中。
 * 命中的代价是一次询问,漏掉的代价是删生产库。
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
 * cwd 不在仓库里时写 / 删绝对路径 ⇒ SOFT。冗余兜底:越界写(含不存在的目标)主要由 `fs.outside_cwd` 判,
 * 两条都命中时同为 SOFT,取最严不受影响。
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
// post 轮 PASS —— 显式白名单,用来压低误拦
// ---------------------------------------------------------------------------

/**
 * 只读命令。`git status` / `ls` 这类在一次 session 里出现频率极高,给它们一条明确的 PASS 路径。
 * PASS 不会跳过别的规则(取最严),只是在没有 SOFT 命中时给出明确的 allow 依据,而不是靠"什么都没命中"。
 */
const readOnlyFiles = defineRule({
  id: "fs.read_only",
  stage: "post",
  verdict: "PASS",
  match(action: Action, ctx: Context | null): string | null {
    if (action.verb !== "read") return null;
    // 有目标时,目标都在 cwd 内(或不存在)才算白名单
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
  unresolvedTarget,
  rmOperandHidden,
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
