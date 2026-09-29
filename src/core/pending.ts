// spec-m4 §0 第 5 项 —— 悬着的 ask 表。
//
// PreToolUse 判了 ask 之后,用户点了什么 Claude Code 不回传;能等到的只有工具真的执行之后的
// PostToolUse / PostToolUseFailure,它们带同一个 tool_use_id(D16.0)。这张表把
// (session_id, tool_use_id) → 那批里判 ask 的 decision_id 悬着,等 Post 事件来对。
//
// 纯数据结构,不做 IO、不起定时器:TTL 在读取时判,上限在写入时判(满了丢最旧,
// Map 的插入序就是年龄序)。不落盘、不做 daemon 重启恢复:用户把确认框放着去吃饭是
// 30 分钟量级的事,不是跨重启的事。

export const PENDING_TTL_MS = 30 * 60 * 1000;
export const PENDING_MAX = 10_000;

interface Entry {
  readonly sessionId: string;
  readonly decisionIds: readonly string[];
  readonly at: number;
}

function keyOf(sessionId: string, toolUseId: string): string {
  return `${sessionId}\0${toolUseId}`;
}

export class PendingAsks {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = PENDING_TTL_MS,
    private readonly max: number = PENDING_MAX,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记一次 ask。同一 (session, tool_use_id) 再来就覆盖并回到队尾:年龄以最后一次写为准。 */
  put(sessionId: string, toolUseId: string, decisionIds: readonly string[]): void {
    const key = keyOf(sessionId, toolUseId);
    this.entries.delete(key);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { sessionId, decisionIds: [...decisionIds], at: this.now() });
  }

  /** 取走并删除。不存在或已过期返回 null(过期的顺手删掉)。 */
  take(sessionId: string, toolUseId: string): readonly string[] | null {
    const key = keyOf(sessionId, toolUseId);
    const e = this.entries.get(key);
    if (e === undefined) return null;
    this.entries.delete(key);
    return this.expired(e) ? null : e.decisionIds;
  }

  /** 清空一个 session 悬着的全部条目,返回其中未过期的 decision_id(按记入先后)。其它 session 不动。 */
  drain(sessionId: string): readonly string[] {
    const out: string[] = [];
    for (const [key, e] of this.entries) {
      if (e.sessionId !== sessionId) continue;
      this.entries.delete(key);
      if (!this.expired(e)) out.push(...e.decisionIds);
    }
    return out;
  }

  /** 扫掉过期条目,返回条数。不在热路径上。 */
  sweep(): number {
    let n = 0;
    for (const [key, e] of this.entries) {
      if (!this.expired(e)) continue;
      this.entries.delete(key);
      n += 1;
    }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }

  private expired(e: Entry): boolean {
    return this.now() - e.at >= this.ttlMs;
  }
}
