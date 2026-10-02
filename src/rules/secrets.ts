// 凭据相关规则。与 filesystem.ts 的 `fs.secret_file` 分工:
//
//   filesystem.ts  按文件名模式判(`.env`、`*.pem`、`id_rsa`)
//   secrets.ts     按凭据目录和内容形态判(`~/.config/gcloud`、命令行上出现的 `AKIA...`、`.git-credentials`)
//
// 凭据目录误报多(读 `~/.ssh/known_hosts` 完全正常),所以判据更宽,档位同样是 SOFT。

import type { Action } from "../core/action.ts";
import { defineRule } from "./index.ts";
import type { Rule } from "./index.ts";
import { normalize } from "./match.ts";
import { commandLine } from "./cmdline.ts";

/**
 * 云厂商密钥的形态。这类字符串出现在命令行上,说明有人把真密钥写进了命令,不管意图如何都值得问一次。
 * 各家前缀是公开的固定格式:
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
 * 读凭据存储目录 ⇒ SOFT。读凭据可能是正当的(迁移 key、检查 `known_hosts`),而网关不读文件内容,无从判断意图。
 * 写这些目录在 filesystem.ts 里是 HARD_DENY:写凭据目录没有正当场景。
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
 * 凭据文件被复制 / 打包。`cp ~/.ssh/id_rsa /tmp/` 比 `cat` 多留了一份副本,副本会被同步到任何地方。
 * shell 层对 `cp` 产出 write,目标是源和目的,所以逐个看目标,命中源或目的都值得问。
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
