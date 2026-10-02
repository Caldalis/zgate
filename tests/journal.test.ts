// journal 的测试。重点不在"能不能写进去",而在数据能不能用:
// 顺序、追加语义、坏行容错、跨天、不阻塞 —— 按"三个月后从这份数据里训模型"的标准来写。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActionSchema } from "../src/core/action.ts";
import type { Action } from "../src/core/action.ts";
import { ContextSchema } from "../src/core/context.ts";
import type { Context } from "../src/core/context.ts";
import { DecisionSchema } from "../src/core/decision.ts";
import type { Decision } from "../src/core/decision.ts";
import {
  FLUSH_INTERVAL_MS,
  JOURNAL_VERSION,
  JournalLineSchema,
  OutcomePatchSchema,
  journalFileFor,
  record,
  recordOutcome,
  replay,
  replayFile,
  flushJournal,
  shutdownJournal,
  startJournal,
  journalStats,
  type Outcome,
} from "../src/core/journal.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zgate-journal-")));
  process.env["ZGATE_JOURNAL_DIR"] = dir;
  shutdownJournal(); // 清掉可能残留的定时器与队列
});

afterEach(() => {
  shutdownJournal();
  delete process.env["ZGATE_JOURNAL_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

function action(over: Partial<Action> = {}): Action {
  return ActionSchema.parse({
    verb: "delete",
    targets: [{ kind: "file", raw: "./build" }],
    command: "rm -rf ./build",
    tool_name: "Bash",
    tool_input: { command: "rm -rf ./build" },
    agent: { name: "claude-code", version: "2.1.268", session_id: "sess-1" },
    cwd: "/repo",
    turn_id: "turn-1",
    ...over,
  });
}

function context(): Context {
  return ContextSchema.parse({
    resources: [
      {
        raw: "./build",
        resolved: "/repo/build",
        exists: true,
        is_symlink: false,
        symlink_target: null,
        is_dir: true,
        inside_cwd: true,
        inside_repo: true,
        gitignored: null,
      },
    ],
    repo: {
      is_repo: true,
      root: "/repo",
      branch: "main",
      is_dirty: null,
      default_branch: "main",
    },
    env_hints: { CI: "false" },
    elapsed_ms: 0.3,
  });
}

function decision(over: Partial<Decision> = {}): Decision {
  return DecisionSchema.parse({
    verdict: "allow",
    reason: "",
    source: "fallback",
    rule_id: null,
    confidence: null,
    latency_ms: 0.4,
    decision_id: "d-1",
    ...over,
  });
}

function readAll(): string {
  const file = journalFileFor(new Date());
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ===========================================================================
describe("日志行 schema", () => {
  test("必填字段齐全,`v` 是 1", () => {
    record(action(), context(), decision());
    flushJournal();
    const line = readAll().trim();
    const obj = JSON.parse(line);
    expect(obj["v"]).toBe(1);
    expect(obj["decision_id"]).toBe("d-1");
    expect(typeof obj["ts"]).toBe("string");
    expect(obj["outcome"]).toBeNull();
    expect(obj["action"]).toBeDefined();
    expect(obj["context"]).toBeDefined();
    expect(obj["decision"]).toBeDefined();
  });

  test("写出来的行能通过 schema 校验(自洽性)", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    const parsed = JournalLineSchema.safeParse(obj);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.success).toBe(true);
  });

  test("★ 字段名全是 snake_case(零映射层)", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());

    // 顶层与嵌套都不许出现 camelCase。例外:env_hints 的键是环境变量名本身(CI、GIT_DIR),
    // 不是我们的字段名,别"为了统一"把它改成小写。
    const check = (o: unknown, path: string): void => {
      if (o === null || typeof o !== "object") return;
      if (Array.isArray(o)) {
        o.forEach((v, i) => check(v, `${path}[${i}]`));
        return;
      }
      const isEnvHints = path.endsWith(".env_hints");
      for (const [k, v] of Object.entries(o)) {
        if (!isEnvHints) {
          expect(/[A-Z]/.test(k), `${path}.${k} 含大写字母,不是 snake_case`).toBe(false);
        }
        check(v, `${path}.${k}`);
      }
    };
    check(obj, "$");
  });

  test("agent / turn_id 逐字段落盘,不丢", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["agent"]).toEqual({
      name: "claude-code",
      version: "2.1.268",
      session_id: "sess-1",
    });
    expect(obj["turn_id"]).toBe("turn-1");
  });

  test("context 为 null 时也能落盘(pre 轮判死时没有 Context)", () => {
    record(action(), null, decision({ verdict: "deny", reason: "递归删除根目录" }));
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["context"]).toBeNull();
    expect(JournalLineSchema.safeParse(obj).success).toBe(true);
  });
});

// ===========================================================================
describe("可选字段 model_details(v 仍是 1)", () => {
  test("不传 model_details 时行里没有这个键(不是 null,也不是 undefined 字面量)", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect("model_details" in obj).toBe(false);
    expect(obj["v"]).toBe(1);
  });

  test("传了就原样落盘,能过 schema,字段全 snake_case", () => {
    const details = { backend: "chain" as const, model_name: "qwen35-9b", local_latency_ms: 800.5, cloud_latency_ms: 1200, escalated: true, local_verdict: "ask" as const, local_confidence: 0.6 };
    record(action(), context(), decision({ source: "model", confidence: 0.6 }), new Date(), details);
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["model_details"]).toEqual(details);
    expect(JournalLineSchema.safeParse(obj).success).toBe(true);
  });

  test("没有 model_details 的老行仍能过 schema", () => {
    record(action(), context(), decision());
    flushJournal();
    expect(JournalLineSchema.safeParse(JSON.parse(readAll().trim())).success).toBe(true);
  });

  test("★ 未知的后端名 / 错误码 / 本地裁决不丢行:老读取端读新日志只是多个不认识的值", () => {
    record(action(), context(), decision({ decision_id: "new-backend" }), new Date(), { backend: "ollama", error: "quota", local_verdict: "maybe" } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0]!.model_details).toEqual({ backend: "ollama", error: "quota", local_verdict: "maybe" });
  });

  test("未知的键也不丢行(zod 对象默认剥掉未知键)", () => {
    record(action(), context(), decision({ decision_id: "new-key" }), new Date(), { backend: "local", brand_new_field: 42 } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.model_details).toEqual({ backend: "local" });
  });

  test("model_details 结构坏了(backend 不是字符串)→ 这一行仍算坏行,那是升 v 的事", () => {
    record(action(), context(), decision({ decision_id: "bad-md" }), new Date(), { backend: 42 } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(1);
    expect(entries.length).toBe(0);
  });
});

describe("一行一条 + 追加语义", () => {
  test("★ 多条决策写多行,顺序与写入顺序一致", () => {
    for (let i = 0; i < 5; i += 1) {
      record(action({ turn_id: `turn-${i}` }), context(), decision({ decision_id: `d-${i}` }));
    }
    flushJournal();
    const ids = readAll()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l)["decision_id"]);
    expect(ids).toEqual(["d-0", "d-1", "d-2", "d-3", "d-4"]);
  });

  test("★ outcome 是**追加一行**,不原地改写", () => {
    record(action(), context(), decision());
    flushJournal();
    const before = readAll().split("\n").filter((l) => l !== "").length;
    expect(before).toBe(1);

    recordOutcome("d-1", { user_action: "approved", tool_succeeded: true });
    flushJournal();

    const lines = readAll().split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2); // ← 多了一行,不是改了第一行
    const patch = JSON.parse(lines[1]!);
    expect(patch["patch"]).toBe("outcome");
    expect(patch["decision_id"]).toBe("d-1");
    // 第一行原封不动
    const first = JSON.parse(lines[0]!);
    expect(first["patch"]).toBeUndefined();
    expect(first["outcome"]).toBeNull();
  });

  test("补丁行的形状单独可校验", () => {
    recordOutcome("d-9", { user_action: "rejected", tool_succeeded: null });
    flushJournal();
    const patch = JSON.parse(readAll().trim());
    expect(OutcomePatchSchema.safeParse(patch).success).toBe(true);
  });

  test("多次 flush 是追加而不是覆盖", () => {
    record(action(), context(), decision({ decision_id: "a" }));
    flushJournal();
    record(action(), context(), decision({ decision_id: "b" }));
    flushJournal();
    const ids = readAll().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)["decision_id"]);
    expect(ids).toEqual(["a", "b"]);
  });
});

// ===========================================================================
describe("写入不得阻塞决策路径", () => {
  test("★ record 不返回 Promise,也不做 IO(队列为空时文件不存在)", () => {
    record(action(), context(), decision());
    // 还没 flush:文件不该存在
    expect(existsSync(journalFileFor(new Date()))).toBe(false);
    expect(journalStats().queued).toBe(1);
    // 说明 record 只是入队。如果它偷偷写了,上面这条会红。
    flushJournal();
    expect(existsSync(journalFileFor(new Date()))).toBe(true);
  });

  test("★ record 的返回值不是 thenable(决策路径上没人能 await 它)", () => {
    const r = record(action(), context(), decision());
    expect(r).toBeUndefined();
  });

  test("startJournal 起定时器,shutdownJournal 停掉并写完", () => {
    startJournal();
    record(action(), context(), decision());
    shutdownJournal();
    expect(readAll()).not.toBe("");
    expect(journalStats().queued).toBe(0);
  });

  test("flush 间隔是个正数", () => {
    expect(FLUSH_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("跨天与路径", () => {
  test("文件名是 YYYY-MM-DD.jsonl", () => {
    const f = journalFileFor(new Date(2026, 8, 11)); // 9 月 11 日
    expect(f.endsWith("2026-09-11.jsonl")).toBe(true);
    expect(f.startsWith(dir)).toBe(true);
  });

  test("月份和日期补零(不是 2026-9-1)", () => {
    expect(journalFileFor(new Date(2026, 0, 5)).endsWith("2026-01-05.jsonl")).toBe(true);
  });

  test("★ 队列里跨天的条目各自写进自己的文件", () => {
    // 直接构造两条不同日期的记录:record 用 now 参数决定目标文件
    const day1 = new Date(2026, 8, 10, 23, 59, 59);
    const day2 = new Date(2026, 8, 11, 0, 0, 1);
    record(action(), context(), decision({ decision_id: "x" }), day1);
    record(action(), context(), decision({ decision_id: "y" }), day2);
    flushJournal();

    const f1 = journalFileFor(day1);
    const f2 = journalFileFor(day2);
    expect(existsSync(f1)).toBe(true);
    expect(existsSync(f2)).toBe(true);
    expect(readFileSync(f1, "utf8")).toContain('"x"');
    expect(readFileSync(f2, "utf8")).toContain('"y"');
    // 不许串味
    expect(readFileSync(f1, "utf8")).not.toContain('"y"');
    expect(readFileSync(f2, "utf8")).not.toContain('"x"');
  });

  test("目录不存在时自动建", () => {
    const nested = join(dir, "a", "b", "journal");
    process.env["ZGATE_JOURNAL_DIR"] = nested;
    record(action(), context(), decision());
    flushJournal();
    expect(existsSync(nested)).toBe(true);
  });
});

// ===========================================================================
describe("回放:评测与训练数据的唯一入口", () => {
  test("写进去再读出来,四个部分都在", () => {
    record(action(), context(), decision({ decision_id: "r-1" }));
    recordOutcome("r-1", { user_action: "approved", tool_succeeded: true });
    flushJournal();

    const { entries, badLines } = replayFile(journalFileFor(new Date()));
    expect(badLines).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0]?.action.verb).toBe("delete");
    expect(entries[0]?.context?.repo.branch).toBe("main");
    expect(entries[0]?.decision.verdict).toBe("allow");
    // ★ outcome 被拼回来了 —— 这就是"每次 override 都是免费标注"的落地
    expect(entries[0]?.outcome).toEqual({ user_action: "approved", tool_succeeded: true });
  });

  test("没有 outcome 的记录,outcome 是 null", () => {
    record(action(), context(), decision({ decision_id: "r-2" }));
    flushJournal();
    const { entries } = replayFile(journalFileFor(new Date()));
    expect(entries[0]?.outcome).toBeNull();
  });

  test("ctx 为 null 的记录能回放", () => {
    record(action(), null, decision({ decision_id: "r-3", verdict: "deny" }));
    flushJournal();
    const { entries } = replayFile(journalFileFor(new Date()));
    expect(entries[0]?.context).toBeNull();
  });

  test("★ 坏行跳过并计数,不整份失败", () => {
    const good = JSON.stringify({
      v: 1, decision_id: "ok", ts: "2026-09-11T00:00:00.000Z",
      agent: { name: "x", version: null, session_id: null }, turn_id: "t",
      action: action(), context: null,
      decision: decision({ decision_id: "ok" }), outcome: null,
    });
    const text = [
      good,
      "{ 这不是 json",
      '{"v": 1, "decision_id": "缺字段"}',
      "", // 空行不该算坏行
      JSON.stringify({
        v: 1, decision_id: "ok2", ts: "2026-09-11T00:00:02.000Z",
        agent: { name: "x", version: null, session_id: null }, turn_id: "t",
        action: action(), context: null,
        decision: decision({ decision_id: "ok2" }), outcome: null,
      }),
    ].join("\n");

    const { entries, badLines } = replay(text);
    expect(entries.length).toBe(2);
    expect(badLines).toBe(2);
    expect(entries.map((e) => e.decision.decision_id)).toEqual(["ok", "ok2"]);
  });

  test("★ 版本号不是 1 的行被当成坏行(以后升版本靠这个分支)", () => {
    const future = JSON.stringify({
      v: 2, decision_id: "future", ts: "2026-09-11T00:00:00.000Z",
      agent: { name: "x", version: null, session_id: null }, turn_id: "t",
      action: action(), context: null, decision: decision(), outcome: null,
    });
    expect(replay(future).badLines).toBe(1);
    expect(replay(future).entries).toEqual([]);
  });

  test("拼不上的 outcome 补丁被丢掉,不算坏行", () => {
    recordOutcome("不存在的-decision", { user_action: "unknown", tool_succeeded: null });
    flushJournal();
    const { entries, badLines } = replayFile(journalFileFor(new Date()));
    expect(entries).toEqual([]);
    expect(badLines).toBe(0);
  });

  test("★ 补丁行在原行之前:拼不上,也不报错(已知边界)", () => {
    // 构造:patch 在前,decision 在后(理论上不会发生,但读取端必须容错)
    const dec = JSON.stringify({
      v: 1, decision_id: "z", ts: "2026-09-11T00:00:00.000Z",
      agent: { name: "x", version: null, session_id: null }, turn_id: "t",
      action: action(), context: null, decision: decision(), outcome: null,
    });
    const patch = JSON.stringify({
      v: 1, patch: "outcome", decision_id: "z",
      ts: "2026-09-11T00:00:01.000Z",
      outcome: { user_action: "rejected", tool_succeeded: false },
    });
    const { entries } = replay([patch, dec].join("\n"));
    // 单趟扫描,补丁在前拼不上 —— 已知边界,不是 bug:真实日志里补丁总在原行之后(后到的 /outcome 写的),
    // 不为不可能的顺序做两趟扫描。断言留着,哪天真遇到了有据可查。
    expect(entries.length).toBe(1);
    expect(entries[0]?.outcome).toBeNull();
  });

  test("文件不存在返回空,不抛", () => {
    const { entries, badLines } = replayFile(join(dir, "不存在.jsonl"));
    expect(entries).toEqual([]);
    expect(badLines).toBe(0);
  });

  test("空文件返回空", () => {
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    expect(replayFile(p).entries).toEqual([]);
  });
});

// ===========================================================================
describe("队列上限", () => {
  test("超过上限丢最旧的,并计数", () => {
    // 不 flush,一直灌到超过上限
    for (let i = 0; i < 5200; i += 1) {
      record(action(), context(), decision({ decision_id: `q-${i}` }));
    }
    const stats = journalStats();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.queued).toBeLessThanOrEqual(5000);

    flushJournal();
    const { entries } = replayFile(journalFileFor(new Date()));
    // 最新的那些一定还在
    expect(entries.at(-1)?.decision.decision_id).toBe("q-5199");
    // 最旧的被丢了
    expect(entries[0]?.decision.decision_id).not.toBe("q-0");
  });
});

// ===========================================================================
describe("常量与导出", () => {
  test("版本号是 1", () => {
    expect(JOURNAL_VERSION).toBe(1);
  });

  test("Outcome 的三种 user_action 都被接受", () => {
    const actions: Outcome["user_action"][] = ["approved", "rejected", "unknown"];
    for (const a of actions) {
      recordOutcome("d", { user_action: a, tool_succeeded: null });
    }
    flushJournal();
    expect(readAll().trim().split("\n").length).toBe(3);
  });
});

describe("可选字段 policy(v 仍是 1)", () => {
  const details = { path: "/repo/.zgatepolicy", sha256: "ab".repeat(32), bytes: 818, scope_hit: ["migrations"] };

  test("不传 policy 时行里没有这个键", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect("policy" in obj).toBe(false);
  });

  test("传了就原样落盘,能过 schema;策略文本不进日志,只有 sha", () => {
    record(action(), context(), decision({ decision_id: "with-policy" }), new Date(), null, details);
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["policy"]).toEqual(details);
    expect(obj["v"]).toBe(1);
    expect(JSON.stringify(obj)).not.toContain("scope:");
    expect(JournalLineSchema.safeParse(obj).success).toBe(true);
  });

  test("truncated 与 scope_hit 只在有值时出现;PASS 的行也可以带 policy(策略在场但没命中)", () => {
    record(action(), context(), decision({ verdict: "allow", source: "rule", rule_id: null, reason: "" }), new Date(), null, { path: "/repo/.zgatepolicy", sha256: "x", bytes: 10 });
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["policy"]).toEqual({ path: "/repo/.zgatepolicy", sha256: "x", bytes: 10 });
  });

  test("replay 把 policy 带回;没有策略的行是 null", () => {
    record(action(), context(), decision({ decision_id: "p1" }), new Date(), null, details);
    record(action(), context(), decision({ decision_id: "p2" }));
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.policy).toEqual(details);
    expect(entries[1]!.policy).toBeNull();
  });

  test("policy 里的未知键不丢行,被剥掉", () => {
    record(action(), context(), decision({ decision_id: "new-key" }), new Date(), null, { ...details, brand_new: 1 } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.policy).toEqual(details);
  });

  test("policy 结构坏了(sha256 不是字符串)→ 坏行,那是升 v 的事", () => {
    record(action(), context(), decision({ decision_id: "bad-policy" }), new Date(), null, { path: "/p", sha256: 42, bytes: 1 } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(1);
    expect(entries.length).toBe(0);
  });
});

// ===========================================================================
describe("可选字段 hook(v 仍是 1)", () => {
  const hook = { tool_use_id: "toolu_01DBfa9trram4VTT8pV5fkNQ", permission_mode: "default", prompt_id: "a5a32a88-83a1-466e-8530-4f66c985a858" };

  test("不传 hook 时行里没有这个键(/decide 进来的行)", () => {
    record(action(), context(), decision());
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect("hook" in obj).toBe(false);
    expect(obj["v"]).toBe(1);
  });

  test("传了就原样落盘,能过 schema,字段全 snake_case", () => {
    record(action(), context(), decision({ verdict: "ask", reason: "目标在 cwd 之外", rule_id: "fs.outside_cwd" }), new Date(), null, null, hook);
    flushJournal();
    const obj = JSON.parse(readAll().trim());
    expect(obj["hook"]).toEqual(hook);
    expect(JournalLineSchema.safeParse(obj).success).toBe(true);
    for (const k of Object.keys(obj["hook"])) expect(k).toMatch(/^[a-z_]+$/);
  });

  test("replay 把 hook 带回;没有的行是 null", () => {
    record(action(), context(), decision({ decision_id: "with-hook" }), new Date(), null, null, hook);
    record(action(), context(), decision({ decision_id: "no-hook" }));
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.hook).toEqual(hook);
    expect(entries[1]!.hook).toBeNull();
  });

  test("只有 tool_use_id 也合法(老版本没有 permission_mode / prompt_id)", () => {
    record(action(), context(), decision({ decision_id: "id-only" }), new Date(), null, null, { tool_use_id: "t1" });
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.hook).toEqual({ tool_use_id: "t1" });
  });

  test("★ permission_mode 是开放字符串:Claude Code 加新模式不丢行", () => {
    record(action(), context(), decision({ decision_id: "new-mode" }), new Date(), null, null, { tool_use_id: "t1", permission_mode: "brandNewMode" });
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.hook?.permission_mode).toBe("brandNewMode");
  });

  test("hook 里的未知键不丢行,被剥掉", () => {
    record(action(), context(), decision({ decision_id: "extra-key" }), new Date(), null, null, { ...hook, effort: { level: "xhigh" } } as never);
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(0);
    expect(entries[0]!.hook).toEqual(hook);
  });

  test("hook 结构坏了(tool_use_id 不是字符串 / 空串)→ 坏行,那是升 v 的事", () => {
    record(action(), context(), decision({ decision_id: "bad-hook-1" }), new Date(), null, null, { tool_use_id: 42 } as never);
    record(action(), context(), decision({ decision_id: "bad-hook-2" }), new Date(), null, null, { tool_use_id: "" });
    flushJournal();
    const { entries, badLines } = replay(readAll());
    expect(badLines).toBe(2);
    expect(entries.length).toBe(0);
  });

  test("带 hook 的行,outcome 补丁照旧按 decision_id 拼上", () => {
    record(action(), context(), decision({ verdict: "ask", decision_id: "m3-row" }), new Date(), null, null, hook);
    recordOutcome("m3-row", { user_action: "approved", tool_succeeded: true });
    flushJournal();
    const { entries } = replay(readAll());
    expect(entries[0]!.outcome).toEqual({ user_action: "approved", tool_succeeded: true });
    expect(entries[0]!.hook).toEqual(hook);
  });
});
