// CLI。
//
//   zgate serve             起 daemon
//   zgate journal replay    把 JSONL 还原成可评测的结构
//   zgate journal stats     问了多少、多少被点通过
//   zgate bench             跑 p50/p95/p99
//   zgate check             判一次,把结论打出来(调试与一分钟验证用)
//   zgate eval              拿人工标注的样本量模型
//
// 参数解析手写,不用库:依赖只有 zod,这里需要的(`argv.slice(2)` + 几个 `--key value`)不值一个依赖。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand } from "./shell/index.ts";
import { ActionSchema, type Action } from "./core/action.ts";
import { configureJournalDir, record, replayFile, flushJournal, journalDir, journalFileFor, shutdownJournal } from "./core/journal.ts";
import { outcomeStats } from "./core/stats.ts";
import type { ModelBackend } from "./core/model.ts";
import { decideAction, decideWithContextAsync, type Decided } from "./core/pipeline.ts";
import { clearCache } from "./core/cache.ts";
import { gitFacts } from "./enrichers/git.ts";
import { POLICY_FILENAME, loadPolicy } from "./policy.ts";
import { ConfigError, configPath, configWarnings, loadConfig, type Config } from "./config.ts";
import { createBackend } from "./model/index.ts";
import { loadEvalCases, runEvalCase, summarize as summarizeEval, type EvalCase, type EvalResult } from "./eval.ts";
import { toActions, type HookInput } from "./adapters/claude-code.ts";
import { createServer, defaultConfig, VERSION } from "./server.ts";

const USAGE = `zgate ${VERSION} — 本地 Agent 工具调用决策网关

用法:
  zgate serve [--port N] [--host H]
      起常驻服务(默认 127.0.0.1:8787)。Claude Code 通过 http 钩子调它。
      模型后端按 ~/.zgate/config.json(或 ZGATE_CONFIG)配置;没有配置文件就只跑规则层。

  zgate check <command>... [--cwd DIR] [--json] [--model]
      判一条命令,打印裁决与理由,以及仓库根 .zgatepolicy 的状态。不写日志。
      --model 时规则层判 SOFT 的会按配置文件走一次模型。
      例:zgate check "rm -rf ./build"

  zgate journal replay [file]
      把一天的 JSONL 还原成 {action, context, decision, outcome} 数组。
      不给文件名时用今天的。这是评测与训练数据的唯一入口。

  zgate journal stats [file] [--json]
      数一天的日志:问了多少次、多少被点通过(按 rule_id × source),看结果信号有没有接上。

  zgate eval [--cases FILE] [--json]
      拿 tests/eval/cases.yaml(21 条人工标注的 SOFT 样本)跑一遍配置里的模型,
      打印一致率、该问却放行、误打断与延迟。这是模型数字的复现入口;
      --cases tests/eval/policy.yaml 是 10 条策略用例。

  zgate bench [--n N] [--json] [--http]
      跑 N 次混合请求,打印 p50/p95/p99。默认量进程内管线;
      --http 起一个真的 daemon(端口 0),经 HTTP 打 /hook/claude-code,
      量的是 Claude Code 看到的端到端延迟。

  zgate --help / --version
`;

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagString(args: Args, name: string, fallback: string): string {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : fallback;
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

/** 读 ~/.zgate/config.json 并建后端。配置不合法拒绝启动:ConfigError 转成 stderr 一行 + null,调用方退出码 1。 */
function loadBackend(): { config: Config; backend: ModelBackend | null } | null {
  try {
    const config = loadConfig();
    for (const w of configWarnings(config)) process.stderr.write(`配置警告:${w}\n`);
    return { config, backend: createBackend(config.model) };
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`配置错误:${err.message}\n`);
      return null;
    }
    throw err;
  }
}

function describeBackend(backend: ModelBackend | null): string {
  if (backend === null) return "null(没配模型,SOFT 一律 ask)";
  return `${backend.name},超时 ${backend.timeoutMs}ms`;
}

function cmdServe(args: Args): number {
  const loaded = loadBackend();
  if (loaded === null) return 1;
  if (loaded.config.journal_path !== undefined) configureJournalDir(loaded.config.journal_path);

  const config = defaultConfig({
    port: Number(flagString(args, "port", String(defaultConfig().port))),
    host: flagString(args, "host", defaultConfig().host),
    backend: loaded.backend,
  });

  const server = createServer(config);
  console.log(`zgate ${VERSION} 监听 http://${config.host}:${server.port}`);
  console.log(`journal 目录:${journalDir()}`);
  console.log(`配置文件:${configPath()}`);
  console.log(`backend:${describeBackend(config.backend)}`);
  console.log("");
  console.log("把这段加进 Claude Code 的 settings.json 即可接入(五段同一个 URL;只配 PreToolUse 也能拦,但没有结果信号):");
  console.log(JSON.stringify(hookSettingsSnippet(config.host, server.port ?? config.port), null, 2));
  console.log("");
  console.log(`opencode:把仓库里的 plugins/opencode/zgate.ts 复制到 ~/.config/opencode/plugins/,设 ZGATE_URL=http://${config.host}:${server.port ?? config.port}(默认 8787 可不设),见 README。`);
  return 0;
}

/**
 * Claude Code settings 片段。五种事件同一个 URL,server 按 hook_event_name 分派。
 * 工具类事件带 `matcher: ""`(每个工具都过);PostToolBatch 不支持 matcher,SessionEnd 不需要。
 * timeout 5:PreToolUse 超时不拦截(走 Claude Code 自己的权限流程);SessionEnd 默认预算只有 1.5 秒,写了 5 会把预算提到 5 秒。
 */
export function hookSettingsSnippet(host: string, port: number): Record<string, unknown> {
  const hook = { type: "http", url: `http://${host}:${port}/hook/claude-code`, timeout: 5 };
  const matched = [{ matcher: "", hooks: [hook] }];
  const unmatched = [{ hooks: [hook] }];
  return {
    hooks: {
      PreToolUse: matched,
      PostToolUse: matched,
      PostToolUseFailure: matched,
      PostToolBatch: unmatched,
      SessionEnd: unmatched,
    },
  };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** 把一条命令行变成 Action[] —— 复用适配器,不另写一套。 */
function actionsFor(command: string, cwd: string): readonly Action[] {
  const hook: HookInput = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  };
  return toActions(hook, crypto.randomUUID());
}

async function cmdCheck(args: Args): Promise<number> {
  const words = args.positional.slice(1);
  if (words.length === 0) {
    process.stderr.write("zgate check 需要一条命令\n");
    return 2;
  }
  // 不带引号的 `zgate check rm -rf ./build` 已被 shell 切成多个 argv,拼回去比要求用户加引号友好。
  const command = words.join(" ");
  const cwd = flagString(args, "cwd", process.cwd());
  const asJson = args.flags.get("json") === true;

  // --model:按配置文件接模型,SOFT 走一次真实的模型段。默认只跑规则层。
  let backend: ModelBackend | null = null;
  if (args.flags.get("model") === true) {
    const loaded = loadBackend();
    if (loaded === null) return 1;
    backend = loaded.backend;
    if (backend === null) process.stderr.write(`配置文件 ${configPath()} 没配 model,只跑规则层\n`);
  }

  const actions = actionsFor(command, cwd);
  const results: { action: Action; decided: Decided }[] = [];
  for (const a of actions) {
    results.push({ action: a, decided: await decideWithContextAsync(a, { noCache: true, backend }) });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(results.map((r) => r.decided.decision), null, 2) + "\n");
    return 0;
  }

  const parsed = parseCommand(command);
  process.stdout.write(`命令:${command}\n`);
  process.stdout.write(`cwd:${cwd}\n`);
  process.stdout.write(`策略:${describePolicy(cwd)}\n`);
  if (parsed === null) {
    process.stdout.write("解析:失败(⇒ verb unknown ⇒ 未知即 SOFT)\n");
  } else if (parsed.length === 0) {
    process.stdout.write("解析:成功,零条命令(⇒ 适配器兜成 unknown)\n");
  } else {
    process.stdout.write(`解析:${parsed.length} 条\n`);
    for (const c of parsed) {
      const targets = c.targets.map((t) => t.raw).join(", ");
      process.stdout.write(`  - ${c.verb}${targets === "" ? "" : ` → ${targets}`}\n`);
    }
  }

  process.stdout.write("\n");
  for (const { decided } of results) {
    const { decision, policy } = decided;
    process.stdout.write(`${decision.verdict.toUpperCase()}`);
    if (decision.reason !== "") process.stdout.write(`  ${decision.reason}`);
    process.stdout.write(`\n  (source=${decision.source}`);
    if (decision.rule_id !== null) process.stdout.write(`, rule=${decision.rule_id}`);
    if (decision.confidence !== null) process.stdout.write(`, confidence=${decision.confidence.toFixed(3)}`);
    process.stdout.write(`, ${decision.latency_ms.toFixed(3)}ms)\n`);
    if (policy?.scope_hit !== undefined) process.stdout.write(`  命中 scope:${policy.scope_hit.join(", ")}\n`);
  }
  return 0;
}

/** 一行策略状态:check 打印一行就够,不另做 `zgate policy` 子命令。加载器的警告自己走 stderr。 */
function describePolicy(cwd: string): string {
  const root = gitFacts(cwd).root;
  if (root === null) return `cwd 不在 git 仓库里,不找 ${POLICY_FILENAME}`;
  const p = loadPolicy(root);
  if (p === null) return `无(${join(root, POLICY_FILENAME)} 不存在,或是软链接)`;
  const scope = p.scope.length === 0 ? "没有 scope 条目,策略对裁决不起作用" : `scope ${p.scope.map((s) => s.entry).join(", ")}`;
  return `${p.path}(${p.bytes} 字节${p.truncated ? ",已截断到 4096" : ""},sha256 ${p.sha256.slice(0, 12)};${scope})`;
}

// ---------------------------------------------------------------------------
// journal replay
// ---------------------------------------------------------------------------

function cmdReplay(args: Args): number {
  const file = args.positional[2] ?? journalFileFor(new Date());
  const { entries, badLines } = replayFile(file);
  process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  process.stderr.write(`\n${entries.length} 条记录`);
  if (badLines > 0) process.stderr.write(`,${badLines} 行无法解析(已跳过)`);
  process.stderr.write(`\n文件:${file}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// journal stats
// ---------------------------------------------------------------------------

function cmdStats(args: Args): number {
  const file = args.positional[2] ?? journalFileFor(new Date());
  const { entries, badLines } = replayFile(file);
  const st = outcomeStats(entries);

  if (args.flags.get("json") === true) {
    process.stdout.write(JSON.stringify({ file, bad_lines: badLines, ...st }, null, 2) + "\n");
    return 0;
  }

  const w = process.stdout.write.bind(process.stdout);
  w(`zgate journal stats  文件:${file}\n`);
  w(`决策 ${st.total} 行:allow ${st.by_verdict.allow} / ask ${st.by_verdict.ask} / deny ${st.by_verdict.deny};带 hook 的 ${st.with_hook} 行`);
  if (badLines > 0) w(`;${badLines} 行无法解析(已跳过)`);
  w("\n\n");
  if (st.asked === 0) {
    w("还没有问过用户的记录。\n");
    return 0;
  }
  w(`问了 ${st.asked} 次:通过 ${st.approved}(其中工具失败 ${st.approved_failed})、拒绝 ${st.rejected}、unknown ${st.unknown}、没有结果 ${st.pending}\n\n`);
  w(`${"rule_id".padEnd(30)} ${"source".padEnd(9)} ${"问了".padStart(5)} ${"通过".padStart(5)} ${"工具失败".padStart(6)} ${"拒绝".padStart(5)} ${"unknown".padStart(8)} ${"无结果".padStart(6)}\n`);
  for (const r of st.rows) {
    w(
      `${r.rule_id.padEnd(30)} ${r.source.padEnd(9)} ${String(r.asked).padStart(6)} ${String(r.approved).padStart(6)} ${String(r.approved_failed).padStart(9)}` +
        ` ${String(r.rejected).padStart(6)} ${String(r.unknown).padStart(8)} ${String(r.pending).padStart(8)}\n`,
    );
  }
  w("\n没有结果 = 悬着的 ask 没等到会话结束(daemon 重启、超过 30 分钟、老版本 Claude Code 没有 tool_use_id)。unknown = 会话结束或调用落定时仍没通过;拒绝 v1 不推断。\n");
  return 0;
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

/** 命令集固定:不读外部文件,不依赖 cwd 里有什么(只要它真实存在),结果才能一键复现。 */
const BENCH_COMMANDS: readonly string[] = [
  "rm -rf ./build",
  "git status",
  "bun test",
  "cat README.md",
  "rm -rf ./node_modules",
  "grep -r TODO src",
  "git diff HEAD",
  "ls -la src",
  "curl https://example.com -o f.txt",
  "npm run build",
];

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx] ?? 0;
}

interface Summary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function summarize(xs: number[]): Summary {
  xs.sort((a, b) => a - b);
  return {
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    max: xs[xs.length - 1] ?? 0,
  };
}

/** 两种模式共用的输出。返回值是退出码:冷路径 p50 < 5ms、p99 < 30ms 任一不达即 1。 */
function reportBench(
  mode: "pipeline" | "http",
  n: number,
  cwd: string,
  c: Summary,
  w: Summary,
  asJson: boolean,
): number {
  const ok = c.p50 < 5 && c.p99 < 30;
  if (asJson) {
    process.stdout.write(JSON.stringify({ mode, n, cold: c, warm: w, budget_ok: ok }, null, 2) + "\n");
    return ok ? 0 : 1;
  }
  const f = (x: number) => x.toFixed(3).padStart(8);
  const title = mode === "http" ? "HTTP 端到端(含 body 解析与 hook 响应)" : "进程内管线";
  process.stdout.write(`zgate bench  mode=${title}  n=${n}  cwd=${cwd}\n\n`);
  process.stdout.write(`               p50      p95      p99      max\n`);
  process.stdout.write(`冷(无缓存) ${f(c.p50)} ${f(c.p95)} ${f(c.p99)} ${f(c.max)}   ms\n`);
  process.stdout.write(`热(带缓存) ${f(w.p50)} ${f(w.p95)} ${f(w.p99)} ${f(w.max)}   ms\n\n`);
  process.stdout.write(`预算:      p50 < 5ms   p99 < 30ms\n`);
  process.stdout.write(`冷路径:    p50 ${c.p50 < 5 ? "✓" : "✗"}   p99 ${c.p99 < 30 ? "✓" : "✗"}\n`);
  if (mode === "pipeline") {
    process.stdout.write(`\n这是**进程内**管线耗时,不含 HTTP 与 body 解析;加 --http 量端到端。\n`);
  } else {
    process.stdout.write(`\n这是 loopback 上 fetch 往返的耗时,Claude Code 看到的延迟不会低于它。\n`);
  }
  return ok ? 0 : 1;
}

/** 进程内:直接调管线。量的是规则 + 探测本身。 */
function benchPipeline(n: number, cwd: string): { cold: Summary; warm: Summary } {
  // 先跑一遍预热(填充 git 探针缓存、让 JIT 稳定),再计时。
  for (let i = 0; i < 50; i += 1) {
    clearCache();
    const command = BENCH_COMMANDS[i % BENCH_COMMANDS.length] ?? "git status";
    for (const a of actionsFor(command, cwd)) decideAction(a, { noCache: true });
  }

  const cold: number[] = [];
  const warm: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const command = BENCH_COMMANDS[i % BENCH_COMMANDS.length] ?? "git status";
    const actions = actionsFor(command, cwd);

    // 冷:每次清缓存,走完整规则 + 探测
    clearCache();
    let t0 = performance.now();
    for (const a of actions) decideAction(a, { noCache: true });
    cold.push(performance.now() - t0);

    // 热:共享缓存,模拟真实 session 里的重复命令
    t0 = performance.now();
    for (const a of actions) decideAction(a);
    warm.push(performance.now() - t0);
  }
  return { cold: summarize(cold), warm: summarize(warm) };
}

/**
 * 端到端:在本进程起一个真的 daemon(端口 0),用 fetch 打 `/hook/claude-code`,body 就是 Claude Code 会发的那份。
 * 日志写到临时目录:bench 的几千条决策不该混进 ~/.zgate/journal。server 与 bench 同进程,"冷"仍靠 `clearCache()` 实现。
 */
async function benchHttp(n: number, cwd: string): Promise<{ cold: Summary; warm: Summary }> {
  const dir = mkdtempSync(join(tmpdir(), "zgate-bench-journal-"));
  const prevJournal = process.env["ZGATE_JOURNAL_DIR"];
  process.env["ZGATE_JOURNAL_DIR"] = dir;
  const server = createServer(defaultConfig({ port: 0 }));
  const url = `http://127.0.0.1:${server.port}/hook/claude-code`;

  const fire = async (command: string): Promise<void> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "bench",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd,
      }),
    });
    await res.json();
  };

  try {
    for (let i = 0; i < 50; i += 1) {
      await fire(BENCH_COMMANDS[i % BENCH_COMMANDS.length] ?? "git status");
    }
    const cold: number[] = [];
    const warm: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const command = BENCH_COMMANDS[i % BENCH_COMMANDS.length] ?? "git status";
      clearCache();
      let t0 = performance.now();
      await fire(command);
      cold.push(performance.now() - t0);

      t0 = performance.now();
      await fire(command);
      warm.push(performance.now() - t0);
    }
    return { cold: summarize(cold), warm: summarize(warm) };
  } finally {
    shutdownJournal();
    void server.stop(true);
    if (prevJournal === undefined) delete process.env["ZGATE_JOURNAL_DIR"];
    else process.env["ZGATE_JOURNAL_DIR"] = prevJournal;
    rmSync(dir, { recursive: true, force: true });
  }
}

function cmdBench(args: Args): number | Promise<number> {
  const n = Number(flagString(args, "n", "1000"));
  const asJson = args.flags.get("json") === true;
  const cwd = flagString(args, "cwd", process.cwd());

  if (args.flags.get("http") === true) {
    return benchHttp(n, cwd).then(({ cold, warm }) => reportBench("http", n, cwd, cold, warm, asJson));
  }
  const { cold, warm } = benchPipeline(n, cwd);
  return reportBench("pipeline", n, cwd, cold, warm, asJson);
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

/** 默认用例集随源码走;编译成单文件时用 --cases 指定。 */
const DEFAULT_EVAL_CASES = new URL("../tests/eval/cases.yaml", import.meta.url).pathname;

async function cmdEval(args: Args): Promise<number> {
  const file = flagString(args, "cases", DEFAULT_EVAL_CASES);
  const asJson = args.flags.get("json") === true;
  let cases: EvalCase[];
  try {
    cases = loadEvalCases(readFileSync(file, "utf8"));
  } catch (err) {
    process.stderr.write(`读不了用例文件 ${file}:${(err as Error).message}\n`);
    return 2;
  }
  const loaded = loadBackend();
  if (loaded === null) return 1;
  const backend = loaded.backend;
  if (backend === null) {
    process.stderr.write(`配置文件 ${configPath()} 没配 model,只跑规则层:所有 SOFT 都是 ask,只能检查用例是否都是 SOFT\n`);
  }

  // 固定目录:同一台机器上两次运行的 prompt 逐字相同,数字才可复现
  const scratch = join(tmpdir(), "zgate-eval");
  rmSync(scratch, { recursive: true, force: true });
  try {
    // 预热一次不计入:llama-server 刚起或换 slot 时首次调用常超时
    const first = cases[0];
    if (backend !== null && first !== undefined) await runEvalCase(first, backend, scratch);
    const results: EvalResult[] = [];
    for (const c of cases) results.push(await runEvalCase(c, backend, scratch));
    const summary = summarizeEval(results);

    if (asJson) {
      process.stdout.write(JSON.stringify({ backend: describeBackend(backend), cases: file, results, summary }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(`zgate eval  backend=${describeBackend(backend)}  用例=${file}  n=${cases.length}\n`);
    if (backend !== null) process.stdout.write("(先预热 1 次,不计入)\n");
    process.stdout.write("\n");
    process.stdout.write(`${"id".padEnd(36)} ${"标签".padEnd(6)} ${"规则".padEnd(10)} ${"结论".padEnd(6)} ${"P(裁决)".padEnd(8)} ${"延迟".padStart(8)}  判定\n`);
    for (const r of results) {
      const mark =
        r.rule_verdict !== "SOFT" ? "非 SOFT,模型没参与"
        : r.error !== undefined ? `降级(${r.error})`
        : r.verdict === r.label ? "✓"
        : r.label === "ask" ? "✗ 该问却放行"
        : "✗ 误打断";
      const conf = r.confidence === null ? "-" : r.confidence.toFixed(3);
      process.stdout.write(
        `${r.id.padEnd(36)} ${r.label.padEnd(6)} ${r.rule_verdict.padEnd(10)} ${r.verdict.padEnd(6)} ${conf.padEnd(8)} ${`${r.latency_ms.toFixed(0)}ms`.padStart(8)}  ${mark}\n`,
      );
    }
    const p = (x: number | null): string => (x === null ? "-" : `${x.toFixed(0)}ms`);
    process.stdout.write("\n");
    process.stdout.write(
      `一致 ${summary.agree}/${summary.soft}   该问却放行 ${summary.missed}/${summary.missed_of}   误打断 ${summary.over_asked}/${summary.over_asked_of}` +
        `   降级 ${summary.degraded}   延迟 p50 ${p(summary.p50_ms)} p95 ${p(summary.p95_ms)}\n`,
    );
    if (summary.non_soft.length > 0) process.stdout.write(`非 SOFT 用例(规则直接定性,模型没参与):${summary.non_soft.join(", ")}\n`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** `check`、`eval` 与 `bench --http` 是异步的(要 await 模型 / fetch);其余命令同步返回退出码。 */
export function main(argv: readonly string[]): number | Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.positional[0];

  // 版本要在帮助之前判:`zgate --version` 的 positional[0] 是 undefined,先判帮助就会掉进 USAGE 分支。
  if (args.flags.has("version") || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === undefined || args.flags.has("help") || cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (cmd) {
    case "serve":
      return cmdServe(args);
    case "check":
      return cmdCheck(args);
    case "journal": {
      const sub = args.positional[1];
      if (sub === "replay") return cmdReplay(args);
      if (sub === "stats") return cmdStats(args);
      process.stderr.write(`未知的 journal 子命令:${sub ?? "(空)"}\n`);
      process.stderr.write("用法:zgate journal replay [file] | zgate journal stats [file] [--json]\n");
      return 2;
    }
    case "bench":
      return cmdBench(args);
    case "eval":
      return cmdEval(args);
    default:
      process.stderr.write(`未知命令:${cmd}\n\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

// 直接执行时跑 main;被 import 时不跑(测试要 import 这里的函数)。
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // serve 不返回;其余命令结束前把日志写完。
  flushJournal();
  if (code !== 0) process.exit(code);
}

export { actionsFor, BENCH_COMMANDS, percentile };
export { ActionSchema, record };
