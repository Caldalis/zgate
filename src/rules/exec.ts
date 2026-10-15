// 命令本身就是对外部系统的破坏或外发:数据库、云、k8s、docker、发布、远程 shell、系统级操作。
//
// 这些命令没有文件 / git / 网络形态,没有这组规则就整段 PASS,而 PASS 不问模型。
// 这里全是 pre 轮 SOFT 文本规则:让这类调用到达模型。判据刻意粗,多问一次的代价远低于放过一次 terraform destroy。

import type { Action } from "../core/action.ts";
import { t } from "../i18n.ts";
import { commandSegments, pipelineStages, simpleCommandHead, simpleCommands, type SimpleCommand } from "./cmdline.ts";
import { defineRule, type Rule } from "./index.ts";

interface Cmd extends SimpleCommand {
  /** 小写的 `head args…`,引号已剥 */
  readonly text: string;
  readonly argText: string;
}

function commandsOf(action: Action): Cmd[] {
  const out: Cmd[] = [];
  for (const seg of simpleCommands(action)) {
    const c = simpleCommandHead(seg);
    if (c === null) continue;
    const argText = c.args.join(" ").toLowerCase();
    out.push({ ...c, head: c.head.toLowerCase(), argText, text: `${c.head.toLowerCase()} ${argText}`.trim() });
  }
  return out;
}

const clip = (s: string, max = 24): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------

const DB_CLIS = new Set(["psql", "mysql", "mysqlsh", "mariadb", "sqlite3", "sqlite", "mongo", "mongosh", "redis-cli", "cqlsh", "clickhouse-client", "usql", "sqlcmd", "duckdb"]);
/** DDL 与整表删除。INSERT / UPDATE 不算:那是日常写入,留给仓库策略去圈。 */
const SQL_DESTRUCTIVE = /\bdrop\s+(table|database|schema|index|collection|user|role|view)\b|\btruncate\b|\bdelete\s+from\b|\balter\s+table\b|\bflushall\b|\bflushdb\b|\bdropdatabase\b|\.drop\(/;
/** 框架 / 平台的"重置数据库":没有 SQL 字样,效果就是清库。 */
const DB_RESET = /^(heroku pg:reset|prisma migrate reset|supabase db reset|flyway clean|php artisan (migrate:fresh|migrate:reset|db:wipe)|rails db:(drop|reset|schema:load)|(bundle exec )?rake db:(drop|reset)|alembic downgrade|knex migrate:rollback --all|drizzle-kit drop)\b/;

const dbDestructive = defineRule({
  id: "exec.db_destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      if (DB_CLIS.has(c.head)) {
        const m = SQL_DESTRUCTIVE.exec(c.argText);
        if (m !== null) {
          const stmt = clip(m[0].replace(/[.(]/g, "").split(/\s+/)[0] ?? "");
          return t(`数据库破坏性语句 ${stmt}`, `destructive database statement ${stmt}`);
        }
      }
      if (DB_RESET.test(c.text)) return t("重置数据库", "database reset");
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// 基础设施 / 云
// ---------------------------------------------------------------------------

const INFRA: readonly { readonly head: RegExp; readonly args: RegExp }[] = [
  { head: /^(terraform|tofu|terragrunt)$/, args: /(^|\s)(destroy|state rm|workspace delete)(?=\s|$)|(^|\s)apply(?=\s|$).*-auto-approve|-auto-approve.*(^|\s)apply(?=\s|$)/ },
  { head: /^pulumi$/, args: /(^|\s)destroy(?=\s|$)|(^|\s)up(?=\s|$).*\s(--yes|-y)(?=\s|$)/ },
  { head: /^kubectl$/, args: /^(delete|drain)(\s|$)/ },
  { head: /^helm$/, args: /^(uninstall|delete)(\s|$)/ },
  { head: /^docker$/, args: /^(system prune|volume (prune|rm)|container prune|image prune|network prune|builder prune|rm|rmi)(?=\s|$)|^compose(?=\s).*\s(down|rm)(?=\s|$).*\s(-v|--volumes|-f)(?=\s|$)/ },
  { head: /^docker-compose$/, args: /^(down|rm)(?=\s|$).*\s(-v|--volumes|-f)(?=\s|$)/ },
  { head: /^aws$/, args: /^s3 (rm|rb)(?=\s|$)|^s3 sync(?=\s).*\s--delete(?=\s|$)|(^|\s)(delete|terminate|deregister|purge|remove)[a-z-]*(?=\s|$)/ },
  { head: /^(gcloud|az|doctl|linode-cli|hcloud)$/, args: /(^|\s)(delete|destroy)(\s|$)/ },
  { head: /^gh$/, args: /^repo (delete|archive)(?=\s|$)|^release delete(?=\s|$)|^api(?=\s).*\s(-x|--method) delete(?=\s|$)/ },
  { head: /^heroku$/, args: /^(apps:destroy|addons:destroy|pg:reset|releases:rollback)(\s|$)/ },
  { head: /^(fly|flyctl)$/, args: /^(apps destroy|destroy|volumes destroy)(\s|$)/ },
  { head: /^vercel$/, args: /^(rm|remove)(\s|$)/ },
  { head: /^netlify$/, args: /^sites:delete(\s|$)/ },
  { head: /^wrangler$/, args: /(^|\s)delete(\s|$)/ },
];

const infraDestructive = defineRule({
  id: "exec.infra_destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      for (const r of INFRA) {
        if (r.head.test(c.head) && r.args.test(c.argText)) {
          return t(`基础设施破坏性操作(${c.head})`, `destructive infrastructure operation (${c.head})`);
        }
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// 发布 / 部署
// ---------------------------------------------------------------------------

const PUBLISH: readonly { readonly head: RegExp; readonly args: RegExp }[] = [
  { head: /^(npm|pnpm|yarn|bun)$/, args: /^publish(\s|$)/ },
  { head: /^cargo$/, args: /^publish(\s|$)/ },
  { head: /^gem$/, args: /^push(\s|$)/ },
  { head: /^twine$/, args: /^upload(\s|$)/ },
  { head: /^docker$/, args: /^push(?=\s|$)|^buildx build(?=\s).*\s--push(?=\s|$)/ },
  { head: /^(vercel|netlify)$/, args: /(^|\s)--prod(\s|$)/ },
  { head: /^(fly|flyctl|sam|serverless|sls|railway|cdk|amplify)$/, args: /^deploy(\s|$)/ },
  { head: /^gcloud$/, args: /^(app|run|functions) deploy(\s|$)/ },
  { head: /^kubectl$/, args: /^(apply|rollout restart|set image)(\s|$)/ },
  { head: /^helm$/, args: /^(install|upgrade)(\s|$)/ },
  { head: /^(terraform|tofu|terragrunt)$/, args: /^(apply|import)(\s|$)/ },
];

const publishDeploy = defineRule({
  id: "exec.publish_deploy",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      for (const r of PUBLISH) {
        if (r.head.test(c.head) && r.args.test(c.argText)) return t(`发布或部署到外部(${c.head})`, `publish or deploy (${c.head})`);
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// 远程执行 / 传输
// ---------------------------------------------------------------------------

/** 远端命令里的破坏形态。远端的文件系统我们探测不到,只能看字面。 */
const REMOTE_DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\bdrop\s+(table|database)\b|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\btruncate\b|\bkill\s+-9\b|\bsystemctl\s+(stop|disable)\b|\breset\s+--hard\b|\bclean\s+-[a-z]*f/;

const remoteDestructive = defineRule({
  id: "exec.remote_destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      if (c.head === "ssh" && REMOTE_DESTRUCTIVE.test(c.argText)) return t("远程执行破坏性命令", "destructive command over ssh");
      if (c.head === "rsync" && /(^|\s)--delete/.test(c.argText)) {
        return t("rsync --delete 会删目的地文件", "rsync --delete removes files at the destination");
      }
    }
    return null;
  },
});

/** 文件名像密钥的东西被传出去。curl -d @.env 已由 net.exfil 管;这里是 scp / rsync / 对象存储。 */
const SECRET_LIKE = /(^|\/)\.env(\.[a-z0-9_-]+)?$|[^/]\.env$|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.(pem|key|p12|pfx)$|credentials|\.kube\/config|\.netrc|secret|\.git-credentials/;

const secretTransfer = defineRule({
  id: "exec.secret_transfer",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      const transfers =
        c.head === "scp" || c.head === "rsync" || c.head === "sftp" ||
        (c.head === "aws" && /^s3 (cp|sync|mv)(\s|$)/.test(c.argText)) ||
        (c.head === "gsutil" && /^(cp|rsync|mv)(\s|$)/.test(c.argText)) ||
        (c.head === "az" && /^storage blob upload/.test(c.argText));
      if (!transfers) continue;
      for (const a of c.args) {
        if (!a.startsWith("-") && SECRET_LIKE.test(a.toLowerCase())) return t(`传输密钥类文件 ${clip(a)}`, `transfers a secrets file ${clip(a)}`);
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// 系统级
// ---------------------------------------------------------------------------

const SYSTEM: readonly { readonly head: RegExp; readonly args: RegExp | null; readonly zh: string; readonly en: string }[] = [
  { head: /^crontab$/, args: /(^|\s)-r(\s|$)/, zh: "crontab -r", en: "crontab -r" },
  { head: /^kill$/, args: /(^|\s)-1(\s|$)/, zh: "kill -1", en: "kill -1" },
  { head: /^(shutdown|reboot|halt|poweroff)$/, args: null, zh: "关机重启", en: "shutdown or reboot" },
  { head: /^init$/, args: /^[06](\s|$)/, zh: "init 0/6", en: "init 0/6" },
  { head: /^launchctl$/, args: /^(bootout|unload|remove)(\s|$)/, zh: "launchctl 卸载服务", en: "launchctl unloads a service" },
  { head: /^diskutil$/, args: /^(erase|partition|apfs delete|reformat|secureerase)/, zh: "diskutil 抹盘", en: "diskutil erases a disk" },
  { head: /^csrutil$/, args: /^disable(\s|$)/, zh: "关闭 SIP", en: "disables SIP" },
  { head: /^nvram$/, args: /(^|\s)-c(\s|$)/, zh: "清 NVRAM", en: "clears NVRAM" },
  { head: /^(userdel|groupdel|deluser)$/, args: null, zh: "删用户", en: "deletes a user" },
  { head: /^dscl$/, args: /(^|\s)-delete(\s|$)/, zh: "删目录服务记录", en: "deletes a directory service record" },
  { head: /^(iptables|nft)$/, args: /(^|\s)(-f|flush)(\s|$)/, zh: "清空防火墙规则", en: "flushes firewall rules" },
  { head: /^ufw$/, args: /^disable(\s|$)/, zh: "关闭防火墙", en: "disables the firewall" },
];

const systemDestructive = defineRule({
  id: "exec.system_destructive",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    for (const c of commandsOf(action)) {
      for (const r of SYSTEM) {
        if (r.head.test(c.head) && (r.args === null || r.args.test(c.argText))) {
          return t(`系统级破坏性操作(${r.zh})`, `destructive system operation (${r.en})`);
        }
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// 把凭据读进上下文
// ---------------------------------------------------------------------------

const DUMP_ALL = new Set(["printenv", "env", "set", "export"]);
const SECRET_VAR = /secret|token|passw|credential|api_?key|private|_key$|^key$/i;

/** 整份环境变量进 agent 上下文,或 echo 一个名字像凭据的变量。`curl -H "… $TOKEN"` 这种正当使用不算。 */
const envDump = defineRule({
  id: "exec.env_dump",
  stage: "pre",
  verdict: "SOFT",
  match(action: Action): string | null {
    // 只有管道最后一级的输出会回到 agent 的上下文:`env | grep PATH` 不算整份导出
    for (const seg of commandSegments(action)) {
      const last = pipelineStages(seg).at(-1) ?? "";
      if (DUMP_ALL.has(last.trim().toLowerCase())) return t("导出全部环境变量", "dumps all environment variables");
    }
    for (const seg of simpleCommands(action)) {
      const c = simpleCommandHead(seg);
      if (c === null) continue;
      if (c.head === "cat" && c.args.some((a) => /\/proc\/[^/]+\/environ$/.test(a))) {
        return t("读取进程环境变量", "reads a process's environment");
      }
      if (c.head === "printenv" || c.head === "echo" || c.head === "printf") {
        for (const a of c.args) {
          const name = c.head === "printenv" ? a : /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(a)?.[1];
          if (name !== undefined && name !== "" && !name.startsWith("-") && SECRET_VAR.test(name)) {
            return t(`读取环境变量里的凭据 ${clip(name, 20)}`, `reads a credential from env var ${clip(name, 20)}`);
          }
        }
      }
    }
    return null;
  },
});

export const EXEC_RULES: readonly Rule[] = [
  dbDestructive,
  infraDestructive,
  publishDeploy,
  remoteDestructive,
  secretTransfer,
  systemDestructive,
  envDump,
];
