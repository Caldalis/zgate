// SPEC.md §11 / §13 / §14 —— CLI。
//
//   zgate serve             起 daemon
//   zgate journal replay    把 JSONL 还原成可评测的结构
//   zgate bench             跑 p50/p95/p99
//   zgate check             判一次,把结论打出来(调试与一分钟验证用)
//
// `check` 不在 §11 的清单里,但 §14 要求 README 有"一分钟验证步骤",
// 而验证的核心是"让网关判一条 `rm -rf ./build` 看看它说什么"。
// 让用户为此写一个 curl 是可笑的,所以加这一个 —— 它是 §14 第 5 条
// 的实现,不是范围扩大(见 D11.2)。
//
// 参数解析手写,不用库:§1 说依赖只允许 zod,而这里需要的东西
// (`argv.slice(2)` + 几个 `--key value`)不值一个依赖。

import { parseCommand } from "./shell/index.ts";
import { ActionSchema, type Action } from "./core/action.ts";
import { record, replayFile, flushJournal, journalDir, journalFileFor } from "./core/journal.ts";
import { decideAction, DEFAULT_MODEL_TIMEOUT_MS } from "./core/pipeline.ts";
import { clearCache } from "./core/cache.ts";
import { toActions, type HookInput } from "./adapters/claude-code.ts";
import { createServer, defaultConfig, VERSION } from "./server.ts";

const USAGE = `zgate ${VERSION} — 本地 Agent 工具调用决策网关

用法:
  zgate serve [--port N] [--host H] [--backend NAME]
      起常驻服务(默认 127.0.0.1:8787)。Claude Code 通过 http 钩子调它。

  zgate check <command>... [--cwd DIR] [--json]
      判一条命令,打印裁决与理由。不写日志。
      例:zgate check "rm -rf ./build"

  zgate journal replay <file>
      把一天的 JSONL 还原成 {action, context, decision, outcome} 数组。
      不给文件名时用今天的。这是 M2 评测与 M4 训练数据的唯一入口。

  zgate bench [--n N] [--json]
      跑 N 次混合请求,打印 p50/p95/p99。

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

function cmdServe(args: Args): number {
  const config = defaultConfig({
    port: Number(flagString(args, "port", String(defaultConfig().port))),
    host: flagString(args, "host", defaultConfig().host),
    backend: flagString(args, "backend", defaultConfig().backend),
    modelTimeoutMs: Number(flagString(args, "model-timeout", String(DEFAULT_MODEL_TIMEOUT_MS))),
  });

  const server = createServer(config);
  console.log(`zgate ${VERSION} 监听 http://${config.host}:${server.port}`);
  console.log(`journal 目录:${journalDir()}`);
  console.log(`backend:${config.backend}(M1 只有 null)`);
  console.log("");
  console.log("把这段加进 Claude Code 的 settings.json 即可接入:");
  console.log(
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                {
                  type: "http",
                  url: `http://${config.host}:${server.port}/hook/claude-code`,
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return 0;
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

function cmdCheck(args: Args): number {
  const words = args.positional.slice(1);
  if (words.length === 0) {
    process.stderr.write("zgate check 需要一条命令\n");
    return 2;
  }
  // 用户可能写成 `zgate check rm -rf ./build`(不带引号),那时 shell 已经把
  // 它切成多个 argv。拼回去比要求用户加引号友好。
  const command = words.join(" ");
  const cwd = flagString(args, "cwd", process.cwd());
  const asJson = args.flags.get("json") === true;

  const actions = actionsFor(command, cwd);
  const results = actions.map((a) => ({ action: a, decision: decideAction(a, { noCache: true }) }));

  if (asJson) {
    process.stdout.write(JSON.stringify(results.map((r) => r.decision), null, 2) + "\n");
    return 0;
  }

  const parsed = parseCommand(command);
  process.stdout.write(`命令:${command}\n`);
  process.stdout.write(`cwd:${cwd}\n`);
  if (parsed === null) {
    process.stdout.write("解析:失败(⇒ verb unknown ⇒ §4.2 兜底)\n");
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
  for (const { action, decision } of results) {
    process.stdout.write(`${decision.verdict.toUpperCase()}`);
    if (decision.reason !== "") process.stdout.write(`  ${decision.reason}`);
    process.stdout.write(`\n  (source=${decision.source}`);
    if (decision.rule_id !== null) process.stdout.write(`, rule=${decision.rule_id}`);
    process.stdout.write(`, ${decision.latency_ms.toFixed(3)}ms)\n`);
    void action;
  }
  return 0;
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
// bench
// ---------------------------------------------------------------------------

/**
 * §13 的核心指标。**必须能一键复现** —— 所以这里的命令集是固定的,
 * 不读外部文件,不依赖当前目录的内容(除了一个真实存在的 cwd)。
 */
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

function cmdBench(args: Args): number {
  const n = Number(flagString(args, "n", "1000"));
  const asJson = args.flags.get("json") === true;
  const cwd = flagString(args, "cwd", process.cwd());

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

  cold.sort((a, b) => a - b);
  warm.sort((a, b) => a - b);

  const summary = (xs: readonly number[]) => ({
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    max: xs[xs.length - 1] ?? 0,
  });
  const c = summary(cold);
  const w = summary(warm);

  if (asJson) {
    process.stdout.write(JSON.stringify({ n, cold: c, warm: w }, null, 2) + "\n");
    return 0;
  }

  const f = (x: number) => x.toFixed(3).padStart(8);
  process.stdout.write(`zgate bench  n=${n}  cwd=${cwd}\n\n`);
  process.stdout.write(`               p50      p95      p99      max\n`);
  process.stdout.write(`冷(无缓存) ${f(c.p50)} ${f(c.p95)} ${f(c.p99)} ${f(c.max)}   ms\n`);
  process.stdout.write(`热(带缓存) ${f(w.p50)} ${f(w.p95)} ${f(w.p99)} ${f(w.max)}   ms\n\n`);
  process.stdout.write(`§13 预算:  p50 < 5ms   p99 < 30ms\n`);
  const ok = c.p50 < 5 && c.p99 < 30;
  process.stdout.write(`冷路径:    p50 ${ok ? "✓" : "✗"}   p99 ${c.p99 < 30 ? "✓" : "✗"}\n`);
  process.stdout.write(`\n注意这是**进程内**管线耗时,不含 HTTP 与 body 解析。\n`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const cmd = args.positional[0];

  // ★ 版本/帮助的判定必须在子命令**之前**:`zgate --version` 的
  //   positional[0] 是 undefined,而 `zgate version` 的 flag 是空的 ——
  //   两个入口都要能到得了这里。写反了会掉进 USAGE 分支(踩过)。
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
      if (sub !== "replay") {
        process.stderr.write(`未知的 journal 子命令:${sub ?? "(空)"}\n`);
        process.stderr.write("用法:zgate journal replay <file>\n");
        return 2;
      }
      return cmdReplay(args);
    }
    case "bench":
      return cmdBench(args);
    default:
      process.stderr.write(`未知命令:${cmd}\n\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

// 直接执行时跑 main;被 import 时不跑(测试要 import 这里的函数)。
if (import.meta.main) {
  const code = main(process.argv.slice(2));
  // serve 不返回;其余命令结束前把日志写完。
  flushJournal();
  if (code !== 0) process.exit(code);
}

export { actionsFor, BENCH_COMMANDS, percentile };
export { ActionSchema, record };
