// SPEC.md §9 —— 日志(journal)。
//
// 规格里的原话:"这是长期迭代的命脉。schema 现在写对,以后的训练数据
// 就是白捡的;现在写歪,三个月后重来。"
//
// 所以这个文件的取舍一律偏向**数据可用性**,而不是实现的省事:
//
//   1. 一行一条完整决策,不是增量 patch(除了 outcome)
//   2. `"v": 1` 必须存在,以后 schema 变了靠它分支
//   3. outcome 到了**追加一条 patch 行**,绝不原地改写
//   4. 写入**不得阻塞决策路径** —— 决策先返回,日志推进内存队列
//
// 关于第 3 点值得多说一句:原地改写需要读回整个文件、找到那一行、
// 重写整个文件 —— 那在并发下必然损坏数据,而且会让"日志"变成"数据库"。
// 追加一行是唯一在崩溃安全上站得住的做法:进程被 kill 时,最多丢最后
// 一行,前面的一律完整。

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ActionSchema, type Action } from "./action.ts";
import { ContextSchema, type Context } from "./context.ts";
import { DecisionSchema, type Decision } from "./decision.ts";
import type { AgentInfo } from "./action.ts";

/** §9:`"v": 1` 必须存在。读取端按版本分支。 */
export const JOURNAL_VERSION = 1;

export const OutcomeSchema = z.object({
  user_action: z.enum(["approved", "rejected", "unknown"]),
  tool_succeeded: z.boolean().nullable(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * 一条完整的决策行。
 *
 * 字段名一路 snake_case —— 这个 schema 是 §16 说的那道缝:左边是 TS,
 * 右边是 Python 评测/训练工具链。零映射层意味着 Python 那边读到的就是
 * 这里写下的。
 */
export const JournalLineSchema = z.object({
  v: z.literal(JOURNAL_VERSION),
  decision_id: z.string(),
  ts: z.string(),
  agent: z.object({
    name: z.string(),
    version: z.string().nullable(),
    session_id: z.string().nullable(),
  }),
  turn_id: z.string(),
  action: ActionSchema,
  context: ContextSchema.nullable(),
  decision: DecisionSchema,
  outcome: OutcomeSchema.nullable(),
});
export type JournalLine = z.infer<typeof JournalLineSchema>;

/**
 * outcome 的补丁行。
 *
 * 单独一个 schema,因为它的形状不同(`patch` 字段是判别式)。
 * 读取端看到 `patch: "outcome"` 就知道这是给前面某条 decision 的补充。
 */
export const OutcomePatchSchema = z.object({
  v: z.literal(JOURNAL_VERSION),
  patch: z.literal("outcome"),
  decision_id: z.string(),
  ts: z.string(),
  outcome: OutcomeSchema,
});
export type OutcomePatch = z.infer<typeof OutcomePatchSchema>;

export const JournalEntrySchema = z.union([JournalLineSchema, OutcomePatchSchema]);
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/**
 * 默认路径 `~/.zgate/journal/YYYY-MM-DD.jsonl`(§9)。
 *
 * 按**天**分文件,不按会话、不按大小轮转。理由:评测和训练按时间区间
 * 取数据是最自然的切法(`读 9 月 1 日到 7 日`),而按其他维度切都要
 * 先扫全部文件再过滤。
 */
export function journalDir(): string {
  return process.env["ZGATE_JOURNAL_DIR"] ?? join(homedir(), ".zgate", "journal");
}

/** 本地日期,不是 UTC —— 用户看的"今天"是自己的今天。 */
export function journalFileFor(d: Date, dir = journalDir()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(dir, `${y}-${m}-${day}.jsonl`);
}

// ---------------------------------------------------------------------------
// 写入队列
// ---------------------------------------------------------------------------

interface QueueItem {
  readonly file: string;
  readonly text: string;
}

/**
 * 内存队列。
 *
 * **决策路径只做一次 `push`,绝不做 IO。** §9 的原话是"绝不 await 在
 * 请求路径上",这里连同步 `appendFileSync` 都不在请求路径上 ——
 * flush 由定时器或显式调用触发。
 *
 * 用同步 `appendFileSync` 而不是 `Bun.file().writer()` 写,理由:
 *   - flush 不在请求路径上,同步的开销不影响 p50
 *   - 队列里可能跨天(一条 23:59:59 的决策,flush 在 00:00:01),
 *     所以每条自带目标文件路径,不能假设"一个 writer 对一个文件"
 *   - 进程退出时同步写完更容易保证(SIGINT 里不能 await)
 */
const queue: QueueItem[] = [];

/** 队列长度上限。超过就丢**最旧**的 —— 见 D10.2。 */
const MAX_QUEUE = 5000;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let dropped = 0;

/** flush 间隔。§9 说"后台定时批量 flush",没给数字。1 秒是延迟与批量的折中。 */
export const FLUSH_INTERVAL_MS = 1000;

function flushOnce(): void {
  if (queue.length === 0) return;
  // 按文件分组,每组一次 append —— 减少 syscall,也保证同一天的记录顺序不乱
  const byFile = new Map<string, string[]>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const lines = byFile.get(item.file);
    if (lines === undefined) byFile.set(item.file, [item.text]);
    else lines.push(item.text);
  }
  for (const [file, lines] of byFile) {
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      appendFileSync(file, lines.join(""));
    } catch {
      // 磁盘满 / 权限错:丢这一批,但不能让 daemon 崩。
      // 决策路径已经返回了,日志失败不该反过来影响它。
      dropped += lines.length;
    }
  }
}

/** 启动后台定时 flush。`server.ts` 在 serve 之前调一次。 */
export function startJournal(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(flushOnce, FLUSH_INTERVAL_MS);
  // 定时器不该拖住进程退出 —— 退出路径由 shutdownJournal 显式负责。
  if (typeof flushTimer === "object" && "unref" in flushTimer) flushTimer.unref();
}

/**
 * 停掉定时器并把剩余队列写完。§9 要求进程退出时 flush。
 *
 * **同步的**,所以可以安全地挂在 `process.on("SIGINT"|"SIGTERM")` 里
 * —— 信号处理器里 await 是不可靠的。
 */
export function shutdownJournal(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushOnce();
}

/** 测试用:立刻 flush,不依赖定时器。 */
export function flushJournal(): void {
  flushOnce();
}

export function journalStats(): { queued: number; dropped: number } {
  return { queued: queue.length, dropped };
}

function enqueue(line: unknown, now: Date): void {
  // 出口序列化直接 JSON.stringify,不走 zod(§2.4)
  const text = JSON.stringify(line) + "\n";
  if (queue.length >= MAX_QUEUE) {
    // 丢最旧的:新数据比旧数据值钱(旧的那条已经在别的渠道留下痕迹了,
    // 而新的这条如果再丢就彻底没了)。见 D10.2。
    queue.shift();
    dropped += 1;
  }
  queue.push({ file: journalFileFor(now), text });
}

/**
 * 记一条决策。**这是热路径上唯一会碰日志的函数**,它只做一次 push。
 *
 * 不返回任何东西 —— 决策路径不该等日志,也不该知道写没写成。
 */
export function record(
  action: Action,
  context: Context | null,
  decision: Decision,
  now = new Date(),
): void {
  enqueue(
    {
      v: JOURNAL_VERSION,
      decision_id: decision.decision_id,
      ts: now.toISOString(),
      agent: action.agent,
      turn_id: action.turn_id,
      action,
      context,
      decision,
      outcome: null,
    },
    now,
  );
}

/**
 * 追加一条 outcome 补丁(§8 的 `/outcome`)。
 *
 * 找不到对应 decision 也照写 —— 读取端自己会把拼不上的补丁丢掉。
 * 在这里做"查找并校验"意味着要读回整个日志文件,那正是 §9 禁止的
 * 原地改写思路。
 */
export function recordOutcome(
  decisionId: string,
  outcome: Outcome,
  now = new Date(),
): void {
  const patch: OutcomePatch = {
    v: JOURNAL_VERSION,
    patch: "outcome",
    decision_id: decisionId,
    ts: now.toISOString(),
    outcome,
  };
  enqueue(patch, now);
}

// ---------------------------------------------------------------------------
// 读取 / 回放(§9 的 `zgate journal replay`)
// ---------------------------------------------------------------------------

export interface ReplayedDecision {
  readonly action: Action;
  readonly context: Context | null;
  readonly decision: Decision;
  readonly outcome: Outcome | null;
  readonly ts: string;
}

/**
 * 把 JSONL 还原成 `{action, context, decision, outcome}` 数组。
 *
 * §9 说这个命令**是 M2 评测和 M4 训练数据的唯一入口,必须现在就能跑**。
 * 所以它的错误处理策略是"尽量不丢":坏行跳过并计数,而不是整个文件失败
 * —— 一份 10 万行的日志里有一行被截断(进程崩在写一半),不该让整份
 * 数据不可用。
 *
 * outcome 的拼接放在这里做:补丁行按 decision_id 归位。这就是 §9 说的
 * "读取端按版本分支"的落点。
 */
export function replay(text: string): { entries: ReplayedDecision[]; badLines: number } {
  const byId = new Map<string, ReplayedDecision>();
  const order: string[] = [];
  let badLines = 0;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }

    const asPatch = OutcomePatchSchema.safeParse(parsed);
    if (asPatch.success) {
      const found = byId.get(asPatch.data.decision_id);
      if (found !== undefined) {
        byId.set(asPatch.data.decision_id, { ...found, outcome: asPatch.data.outcome });
      }
      // 拼不上的补丁直接丢 —— 它的 decision 不在这份文件里
      // (跨天边界,或者日志被截断)。记成坏行会让"坏行数"失去意义。
      continue;
    }

    const asLine = JournalLineSchema.safeParse(parsed);
    if (!asLine.success) {
      badLines += 1;
      continue;
    }

    const d = asLine.data;
    byId.set(d.decision_id, {
      action: d.action as Action,
      context: d.context as Context | null,
      decision: d.decision as Decision,
      outcome: d.outcome,
      ts: d.ts,
    });
    order.push(d.decision_id);
  }

  const entries: ReplayedDecision[] = [];
  for (const id of order) {
    const e = byId.get(id);
    if (e !== undefined) entries.push(e);
  }
  return { entries, badLines };
}

/**
 * 读一个日志文件并回放。
 *
 * 同步读 —— replay 是 CLI 命令,不在热路径上(§13 的约束只作用于
 * 决策路径)。文件不存在返回空结果而不是抛:一个还没写过日志的
 * 全新安装,跑 `zgate journal replay` 应该打印"0 条",不是报错。
 */
export function replayFile(path: string): { entries: ReplayedDecision[]; badLines: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: [], badLines: 0 };
  }
  return replay(text);
}

export type { Action, Context, Decision, AgentInfo };
