// 决策日志(journal):每天一个 JSONL 文件,离线评测与训练数据的来源。
//
// 取舍一律偏向数据可用性,而不是实现的省事:
//
//   1. 一行一条完整决策,不是增量 patch(除了 outcome)
//   2. 每行带 `"v": 1`,以后 schema 变了靠它分支
//   3. outcome 到了追加一条 patch 行,绝不原地改写:原地改写在并发下会损坏数据,
//      追加时进程被 kill 最多丢最后一行
//   4. 写入不阻塞决策路径:决策先返回,日志推进内存队列

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ActionSchema, type Action } from "./action.ts";
import { ContextSchema, type Context } from "./context.ts";
import { DecisionSchema, type Decision } from "./decision.ts";
import { ModelDetailsSchema, type ModelDetails } from "./model.ts";
import type { AgentInfo } from "./action.ts";
import { PolicyDetailsSchema, type PolicyDetails } from "../policy.ts";

/** 每行必带。读取端按版本分支。 */
export const JOURNAL_VERSION = 1;

export const OutcomeSchema = z.object({
  user_action: z.enum(["approved", "rejected", "unknown"]),
  tool_succeeded: z.boolean().nullable(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * 读取端对 model_details 放宽:后端名、错误码、本地裁决当开放集合。新增可选字段不升 v,
 * 老读取端遇到新值只能不认识,不能丢整行。写入端仍用 model.ts 里的严格枚举。
 */
export const ReplayModelDetailsSchema = ModelDetailsSchema.extend({
  backend: z.string(),
  local_verdict: z.string().optional(),
  error: z.string().optional(),
});
export type ReplayedModelDetails = z.infer<typeof ReplayModelDetailsSchema>;

/** 读取端对 policy 同样放宽:truncated 收任意布尔,未知键由 zod 剥掉。 */
export const ReplayPolicySchema = PolicyDetailsSchema.extend({
  truncated: z.boolean().optional(),
});
export type ReplayedPolicy = z.infer<typeof ReplayPolicySchema>;

/**
 * 从 Claude Code 的 hook 输入里抄下来的对账字段。
 * `tool_use_id` 把 PreToolUse 的 ask 与之后的 PostToolUse / PostToolUseFailure 对上;
 * `permission_mode` 让离线分析分得开"用户点了"与 bypassPermissions / dontAsk 下的自动放行。
 * 两者都当不透明字符串:id 的形状随后端变,模式名 Claude Code 还会加。
 */
export const HookDetailsSchema = z.object({
  tool_use_id: z.string().min(1),
  permission_mode: z.string().optional(),
  prompt_id: z.string().optional(),
});
export type HookDetails = z.infer<typeof HookDetailsSchema>;

/**
 * 一条完整的决策行。它是 TS 与 Python 评测 / 训练工具链之间的接缝,
 * 字段一路 snake_case,Python 那边读到的就是这里写下的。
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
  // 只在 pre 轮 HARD_DENY 时为 null:那条路不做环境探测,写一个空壳是造假数据。
  // SOFT / PASS / 缓存命中一律是完整 Context。
  context: ContextSchema.nullable(),
  decision: DecisionSchema,
  outcome: OutcomeSchema.nullable(),
  // 模型参与过的决策才有。可选字段,v 仍是 1;读取端放宽枚举
  model_details: ReplayModelDetailsSchema.optional(),
  // 仓库策略在场的决策才有(不管 PASS 还是 SOFT)。同一做法,v 仍是 1
  policy: ReplayPolicySchema.optional(),
  // 经 /hook/claude-code 进来且输入带 tool_use_id 的决策才有;/decide 进来的没有。同一做法,v 仍是 1
  hook: HookDetailsSchema.optional(),
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
 * 默认路径 `~/.zgate/journal/YYYY-MM-DD.jsonl`。
 * 按天分文件,不按会话、不按大小轮转:评测和训练按时间区间取数据最自然。
 */
let configuredDir: string | null = null;

/** 配置文件的 journal_path。环境变量 ZGATE_JOURNAL_DIR 仍优先于它。 */
export function configureJournalDir(dir: string | null): void {
  configuredDir = dir;
}

export function journalDir(): string {
  return process.env["ZGATE_JOURNAL_DIR"] ?? configuredDir ?? join(homedir(), ".zgate", "journal");
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
 * 内存队列。决策路径只做一次 `push`,不做任何 IO;flush 由定时器或显式调用触发。
 *
 * flush 用同步 `appendFileSync` 而不是 `Bun.file().writer()`:
 *   - flush 不在请求路径上,同步的开销不影响 p50
 *   - 队列里可能跨天(23:59:59 的决策 00:00:01 才 flush),所以每条自带目标文件路径
 *   - 进程退出时同步写完更容易保证(SIGINT 里不能 await)
 */
const queue: QueueItem[] = [];

/** 队列长度上限,超过就丢最旧的。 */
const MAX_QUEUE = 5000;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let dropped = 0;

/** 后台批量 flush 的间隔。1 秒是延迟与批量的折中。 */
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
 * 停掉定时器并把剩余队列写完,进程退出时调用。
 * 同步实现,可以安全地挂在 `process.on("SIGINT"|"SIGTERM")` 里(信号处理器里 await 不可靠)。
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
  // 出口序列化直接 JSON.stringify,不走 zod
  const text = JSON.stringify(line) + "\n";
  if (queue.length >= MAX_QUEUE) {
    // 丢最旧的:新数据比旧数据值钱
    queue.shift();
    dropped += 1;
  }
  queue.push({ file: journalFileFor(now), text });
}

/**
 * 记一条决策。热路径上唯一会碰日志的函数,只做一次 push。
 * 不返回任何东西:决策路径不该等日志,也不该知道写没写成。
 */
export function record(
  action: Action,
  context: Context | null,
  decision: Decision,
  now = new Date(),
  modelDetails: ModelDetails | null = null,
  policy: PolicyDetails | null = null,
  hook: HookDetails | null = null,
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
      ...(modelDetails === null ? {} : { model_details: modelDetails }),
      ...(policy === null ? {} : { policy }),
      ...(hook === null ? {} : { hook }),
    },
    now,
  );
}

/**
 * 追加一条 outcome 补丁。
 * 找不到对应 decision 也照写,读取端会丢掉拼不上的补丁;在这里查找校验就得读回整个日志文件。
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
// 读取 / 回放(`zgate journal replay`)
// ---------------------------------------------------------------------------

export interface ReplayedDecision {
  readonly action: Action;
  readonly context: Context | null;
  readonly decision: Decision;
  readonly outcome: Outcome | null;
  readonly ts: string;
  /** 模型参与过才有,否则 null。后端名等按读取端的放宽类型 */
  readonly model_details: ReplayedModelDetails | null;
  /** 仓库策略在场才有,否则 null */
  readonly policy: ReplayedPolicy | null;
  /** 经 Claude Code hook 进来且带 tool_use_id 才有,否则 null */
  readonly hook: HookDetails | null;
}

/**
 * 把 JSONL 还原成 `{action, context, decision, outcome}` 数组,评测与训练数据的唯一入口。
 *
 * 尽量不丢:坏行跳过并计数,而不是整个文件失败 —— 进程崩在写一半留下的截断行,
 * 不该让整份数据不可用。outcome 补丁行在这里按 decision_id 归位。
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
      // 拼不上的补丁直接丢:它的 decision 不在这份文件里(跨天,或日志被截断),
      // 记成坏行会让"坏行数"失去意义。
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
      model_details: d.model_details ?? null,
      policy: d.policy ?? null,
      hook: d.hook ?? null,
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
 * 读一个日志文件并回放。CLI 命令,不在热路径上,同步读即可。
 * 文件不存在返回空结果而不是抛:全新安装跑 `zgate journal replay` 应该打印"0 条",不是报错。
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
