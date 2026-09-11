// SPEC.md §4.5 —— 凭据相关规则。
//
// 和 filesystem.ts 的 `fs.secret_file` 有重叠,但分界很清楚:
//
//   filesystem.ts  按**文件名模式**判(`.env`、`*.pem`、`id_rsa`)
//   secrets.ts     按**凭据目录和内容形态**判(`~/.config/gcloud`、
//                  命令行上出现的 `AKIA...`、`.git-credentials`)
//
// 拆开是因为两者误报特性不同:文件名模式误报少(名字就是证据),
// 凭据目录误报多(`~/.ssh/known_hosts` 读它完全正常),所以后者的
// 判据要更宽但档位一样是 SOFT。

import type { Action } from "../core/action.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { normalize } from "./match.ts";
import { commandLine } from "./cmdline.ts";

/**
 * 云厂商密钥的**形态**识别。
 *
 * 为什么值得单列:这类字符串出现在命令行上只有一种解释 —— 有人把手里的
 * 真密钥写进了命令里。它可能是无害的(在测自己的 key 能不能用),也可能
 * 是在把 key 传给攻击者,但两种都值得问一次。
 *
 * 各家的前缀都是公开的固定格式,所以这是形态匹配而不是猜:
 *   AWS 访问键  AKIA / ASIA + 16 位
 *   GitHub      ghp_ / gho_ / ghs_ / ghr_ / github_pat_
 *   Slack       xox[baprs]-
 *   Google      AIza + 35 位
 *   私钥头      -----BEGIN ... PRIVATE KEY-----
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(akia|asia)[0-9a-z]{16}\b/,
  /\bgh[pousr]_[a-z0-9]{16,}/,
  /\bgithub_pat_[a-z0-9_]{20,}/,
  /\bxox[abprs]-[a-z0-9-]{10,}/,
  /\baiza[0-9a-z_-]{35}\b/,
  /\bsk-[a-z0-9]{20,}/,
  /-----begin [a-z ]*private key-----/,
  /\bglpat-[a-z0-9_-]{20,}/,
  /\bsk_live_[a-z0-9]{20,}/,
];

const credentialInCommand = defineRule({
  id: "secret.in_command",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    const cmd = commandLine(action);
    if (cmd === "") return null;
    const text = normalize(cmd).toLowerCase();
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(text)) return "命令行中包含凭据";
    }
    return null;
  },
});

/**
 * 凭据存储目录的**读取**。
 *
 * 只读,档位 SOFT。理由:读凭据很可能是正当的(把 key 从旧目录迁到新
 * 目录、检查 `known_hosts`),而网关不读文件内容(§6),无从判断意图。
 * 问一次是对的。
 *
 * 写入这些目录已经在 filesystem.ts 里 HARD_DENY 了 —— **写**凭据目录
 * 没有正当场景。
 */
const CREDENTIAL_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".config/sops",
  ".password-store",
] as const;

const credentialRead = defineRule({
  id: "secret.dir_read",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    if (action.verb !== "read") return null;
    for (const t of action.targets) {
      const p = t.raw.toLowerCase();
      // 去掉 `~` / `$HOME` / 前导斜杠,只留相对段
      const rel = p.replace(/^~\/?/, "").replace(/^\$\{?home\}?\/?/, "").replace(/^\/+/, "");
      for (const d of CREDENTIAL_DIRS) {
        if (rel === d || rel.startsWith(d + "/")) return `读取凭据目录 ${d}`;
      }
      // 绝对路径下也按段认
      if (/(^|\/)\.(ssh|aws|gnupg|kube)\//.test(p)) return "读取凭据目录";
    }
    return null;
  },
});

/**
 * 凭据文件被**移动/复制出去**。
 *
 * `cp ~/.ssh/id_rsa /tmp/` 和 `cat ~/.ssh/id_rsa` 危害不同:后者只是读了,
 * 前者在磁盘上留了一份副本,而副本会被同步到任何地方。所以这条判 write
 * 动词里的敏感**源**。
 *
 * shell 层对 `cp` 的产出是 write,目标是「源 + 目的」两个,所以这里
 * 按目标列表逐个看 —— 命中的可能是源也可能是目的,两种都值得问。
 */
const credentialCopyOut = defineRule({
  id: "secret.copy_out",
  stage: "post",
  verdict: "SOFT",
  match(action: Action): string | null {
    if (action.verb !== "write") return null;
    const cmd = normalize(commandLine(action)).toLowerCase();
    // 只在真的搬了东西的命令上判 —— `sed -i` 改文件不算
    if (!/\bcp\b|\bmv\b|\brsync\b|\btar\b|\bzip\b|\bscp\b|\bcat\b|\bbase64\b/.test(cmd)) {
      return null;
    }
    for (const t of action.targets) {
      const p = t.raw.toLowerCase();
      const rel = p.replace(/^~\/?/, "").replace(/^\$\{?home\}?\/?/, "").replace(/^\/+/, "");
      for (const d of CREDENTIAL_DIRS) {
        if (rel === d || rel.startsWith(d + "/")) return "凭据文件被复制或打包";
      }
    }
    return null;
  },
});

export const SECRET_RULES: readonly Rule[] = [
  credentialInCommand,
  credentialRead,
  credentialCopyOut,
];
