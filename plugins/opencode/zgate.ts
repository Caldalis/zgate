// zgate 的 opencode 插件。这个文件在 opencode 进程里跑,不是 zgate daemon 的一部分。
//
// 装法:复制到 ~/.config/opencode/plugins/zgate.ts(全局)或项目的 .opencode/plugins/zgate.ts;
// 或在 opencode.json 里 "plugin": [["./.opencode/plugins/zgate.ts", { "url": "http://127.0.0.1:8787" }]]。
// 网关地址:options.url > 环境变量 ZGATE_URL > http://127.0.0.1:8787。不依赖任何包,opencode 用 Bun 直接加载 .ts。
//
// 做三件事(参照 opencode 1.18.33):
//   1. tool.execute.before —— 把这次调用发给 zgate。deny 就抛错,工具不执行,模型看到理由;allow / ask 先记下来。
//   2. permission.asked 事件 —— opencode 自己的规则要弹确认框时,若 zgate 判了 allow,就替用户回 "once"(等价于跳过确认框);
//      判 ask 什么都不做,确认框照常弹。opencode 1.18.33 的 `permission.ask` 钩子在源码里没有触发点,所以只能走事件 + 回复这条路。
//   3. permission.replied / tool.execute.after —— 把用户的回答和"工具跑完了"转发给 zgate 记 outcome。自己替用户回的那次不算用户回答。
//
// zgate 不在时:before 拿不到结论就不干预,一切按 opencode 自己的权限配置走 —— 与 Claude Code 那条路的降级方向一致。
// 想让 zgate 减少打断,opencode.json 里要先让工具默认问:{ "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" } }。

type Verdict = "allow" | "ask" | "deny";

interface BeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}
interface AfterInput extends BeforeInput {
  readonly args: unknown;
}
interface BusEvent {
  readonly type: string;
  readonly properties?: unknown;
}
interface PluginInput {
  readonly client: unknown;
  readonly directory: string;
}
interface PluginOptions {
  readonly url?: unknown;
  readonly timeout_ms?: unknown;
}

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 5000;
const TTL_MS = 30 * 60 * 1000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const ZgatePlugin = async (input: PluginInput, options?: PluginOptions) => {
  const base = (str(options?.url) ?? str(process.env["ZGATE_URL"]) ?? DEFAULT_URL).replace(/\/+$/, "");
  const timeoutMs = typeof options?.timeout_ms === "number" ? options.timeout_ms : DEFAULT_TIMEOUT_MS;
  const debug = str(process.env["ZGATE_PLUGIN_DEBUG"]);

  /** session\0callID → zgate 的结论 */
  const verdicts = new Map<string, { verdict: Verdict; at: number }>();
  /** 权限请求 id → 它对应的调用 */
  const asked = new Map<string, { sessionID: string; callID: string | null }>();
  /** 我们替用户回过的权限请求 id */
  const autoReplied = new Set<string>();
  const key = (sessionID: string, callID: string): string => `${sessionID}\0${callID}`;

  async function log(line: unknown): Promise<void> {
    if (debug === null) return;
    try {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(debug, JSON.stringify(line) + "\n");
    } catch {}
  }

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/hook/opencode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, ...body }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const parsed: unknown = await res.json();
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function reply(sessionID: string, permissionID: string, response: "once" | "reject"): Promise<void> {
    const c = input.client as Record<string, unknown> | null;
    try {
      const v2 = obj(c?.["permission"])["reply"];
      if (typeof v2 === "function") {
        const r = await (v2 as (a: unknown) => Promise<unknown>)({ requestID: permissionID, reply: response });
        await log({ reply: response, permissionID, via: "v2", result: summarize(r) });
        return;
      }
      const v1 = c?.["postSessionIdPermissionsPermissionId"];
      if (typeof v1 === "function") {
        const r = await (v1 as (a: unknown) => Promise<unknown>).call(c, { path: { id: sessionID, permissionID }, body: { response } });
        await log({ reply: response, permissionID, via: "v1", result: summarize(r) });
        return;
      }
      await log({ reply: response, permissionID, via: "none", client_keys: c === null ? [] : Object.keys(c).slice(0, 20) });
    } catch (err) {
      await log({ reply: response, permissionID, error: String(err) });
    }
  }

  function summarize(r: unknown): unknown {
    const o = obj(r);
    return { error: o["error"] === undefined ? undefined : String(JSON.stringify(o["error"])).slice(0, 200), status: obj(o["response"])["status"], data: o["data"] };
  }

  function sweep(now: number): void {
    for (const [k, v] of verdicts) if (now - v.at >= TTL_MS) verdicts.delete(k);
  }

  return {
    "tool.execute.before": async (i: BeforeInput, o: { args: unknown }): Promise<void> => {
      const now = Date.now();
      sweep(now);
      const res = await post({ event: "before", session_id: i.sessionID, call_id: i.callID, tool: i.tool, args: obj(o.args), cwd: input.directory });
      const verdict = str(res?.["verdict"]);
      await log({ hook: "before", tool: i.tool, callID: i.callID, verdict });
      if (verdict !== "allow" && verdict !== "ask" && verdict !== "deny") return;
      verdicts.set(key(i.sessionID, i.callID), { verdict, at: now });
      if (verdict === "deny") throw new Error(`zgate 拦截:${str(res?.["reason"]) ?? "网关判定为拒绝"}`);
    },

    "tool.execute.after": async (i: AfterInput): Promise<void> => {
      verdicts.delete(key(i.sessionID, i.callID));
      await log({ hook: "after", tool: i.tool, callID: i.callID });
      await post({ event: "after", session_id: i.sessionID, call_id: i.callID, tool: i.tool });
    },

    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      if (!event.type.startsWith("permission.")) return;
      const p = obj(event.properties);

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        // 先回复再记日志:opencode run 的客户端会立刻自动拒绝,这里每多等一步都可能输给它
        const id = str(p["id"]);
        const sessionID = str(p["sessionID"]);
        if (id === null || sessionID === null) return;
        const callID = str(obj(p["tool"])["callID"]) ?? str(p["callID"]);
        asked.set(id, { sessionID, callID });
        const v = callID === null ? undefined : verdicts.get(key(sessionID, callID));
        if (v?.verdict === "allow") {
          autoReplied.add(id);
          await reply(sessionID, id, "once");
        } else if (v?.verdict === "deny") {
          autoReplied.add(id);
          await reply(sessionID, id, "reject");
        }
        await log({ event: event.type, properties: p, zgate: v?.verdict ?? null });
        return;
      }
      await log({ event: event.type, properties: p });

      if (event.type === "permission.replied") {
        const id = str(p["requestID"]) ?? str(p["permissionID"]);
        if (id === null) return;
        const a = asked.get(id);
        asked.delete(id);
        if (autoReplied.delete(id)) return;
        if (a === undefined || a.callID === null) return;
        const replyValue = str(p["reply"]) ?? str(p["response"]) ?? "";
        await post({ event: "replied", session_id: str(p["sessionID"]) ?? a.sessionID, call_id: a.callID, reply: replyValue });
      }
    },
  };
};

export default ZgatePlugin;
