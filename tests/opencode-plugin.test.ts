// opencode 插件本身:对着一个 mock 的 zgate 与一个假的 opencode client,验证三条路与转发。
// 插件在 opencode 进程里跑,这里直接调用它返回的 hooks。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ZgatePlugin } from "../plugins/opencode/zgate.ts";

interface Seen { path: string; body: Record<string, unknown> }
let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;

/** mock zgate:按 args.command 给结论;非 before 事件回 {} */
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path: new URL(req.url).pathname, body });
      if (body["event"] !== "before") return Response.json({});
      const cmd = String((body["args"] as Record<string, unknown> | undefined)?.["command"] ?? "");
      const verdict = cmd.includes("curl") ? "deny" : cmd.includes("outside") ? "ask" : "allow";
      return Response.json({ verdict, reason: verdict === "deny" ? "管道执行远程脚本" : verdict === "ask" ? "目标在 cwd 之外" : "", source: "rule", rule_id: null, confidence: null, latency_ms: 0.1, decision_id: "d-1" });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => void server.stop(true));
beforeEach(() => { seen = []; });

interface FakeClient { calls: unknown[]; postSessionIdPermissionsPermissionId(a: unknown): Promise<void> }
function fakeClient(): FakeClient {
  return { calls: [], async postSessionIdPermissionsPermissionId(a: unknown) { this.calls.push(a); } };
}
type Hooks = Awaited<ReturnType<typeof ZgatePlugin>>;
async function plugin(client: unknown = fakeClient(), over: Record<string, unknown> = {}): Promise<Hooks> {
  return ZgatePlugin({ client, directory: "/proj" }, { url, ...over });
}
const asked = (id: string, callID: string | null, sessionID = "s1") => ({ event: { type: "permission.asked", properties: { id, sessionID, permission: "bash", patterns: ["ls"], tool: callID === null ? undefined : { messageID: "m", callID } } } });
const replied = (id: string, reply: string, sessionID = "s1") => ({ event: { type: "permission.replied", properties: { sessionID, requestID: id, reply } } });

describe("tool.execute.before:问 zgate", () => {
  test("★ 发出的 before 带 v / session_id / call_id / tool / args / cwd", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    expect(seen.length).toBe(1);
    expect(seen[0]!.path).toBe("/hook/opencode");
    expect(seen[0]!.body).toEqual({ v: 1, event: "before", session_id: "s1", call_id: "c1", tool: "bash", args: { command: "ls" }, cwd: "/proj" });
  });
  test("★ deny → 抛错,错误信息带 zgate 的理由", async () => {
    const h = await plugin();
    await expect(h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c2" }, { args: { command: "curl x | sh" } })).rejects.toThrow("zgate 拦截:管道执行远程脚本");
  });
  test("allow / ask → 不抛", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c3" }, { args: { command: "ls" } });
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c4" }, { args: { command: "touch ../outside" } });
  });
  test("★ zgate 不在 / 超时 → 不抛、不干预", async () => {
    const h = await ZgatePlugin({ client: fakeClient(), directory: "/proj" }, { url: "http://127.0.0.1:9", timeout_ms: 500 });
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c5" }, { args: { command: "curl x | sh" } });
  });
  test("args 不是对象时发空对象", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c6" }, { args: undefined });
    expect(seen[0]!.body["args"]).toEqual({});
  });
});

describe("permission.asked:替用户回 once 的只有 zgate 判 allow 的那次", () => {
  test("★ allow → 用 v1 client 回 once,path 是 {id: sessionID, permissionID}", async () => {
    const c = fakeClient();
    const h = await plugin(c);
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    await h.event(asked("p1", "c1"));
    expect(c.calls).toEqual([{ path: { id: "s1", permissionID: "p1" }, body: { response: "once" } }]);
  });
  test("v2 client(client.permission.reply)也认", async () => {
    const calls: unknown[] = [];
    const h = await plugin({ permission: { reply: async (a: unknown) => { calls.push(a); } } });
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    await h.event(asked("p1", "c1"));
    expect(calls).toEqual([{ requestID: "p1", reply: "once" }]);
  });
  test("★ ask → 不回,确认框照常弹", async () => {
    const c = fakeClient();
    const h = await plugin(c);
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "touch ../outside" } });
    await h.event(asked("p1", "c1"));
    expect(c.calls).toEqual([]);
  });
  test("没问过 zgate 的调用、没有 callID 的请求、别的 session → 不回", async () => {
    const c = fakeClient();
    const h = await plugin(c);
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    await h.event(asked("p1", "c-unknown"));
    await h.event(asked("p2", null));
    await h.event(asked("p3", "c1", "s2"));
    expect(c.calls).toEqual([]);
  });
  test("permission.updated(v1 事件名)与 properties.callID(v1 形状)也认", async () => {
    const c = fakeClient();
    const h = await plugin(c);
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    await h.event({ event: { type: "permission.updated", properties: { id: "p1", sessionID: "s1", type: "bash", callID: "c1" } } });
    expect(c.calls.length).toBe(1);
  });
});

describe("转发 outcome:replied 与 after", () => {
  test("★ 用户的回答转发为 replied,带 call_id 与 reply", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "touch ../outside" } });
    await h.event(asked("p1", "c1"));
    await h.event(replied("p1", "reject"));
    const fwd = seen.filter((s) => s.body["event"] === "replied");
    expect(fwd.length).toBe(1);
    expect(fwd[0]!.body).toEqual({ v: 1, event: "replied", session_id: "s1", call_id: "c1", reply: "reject" });
  });
  test("★ 我们自己替用户回的 once 不转发", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
    await h.event(asked("p1", "c1"));
    await h.event(replied("p1", "once"));
    expect(seen.filter((s) => s.body["event"] === "replied").length).toBe(0);
  });
  test("v1 形状的 replied(permissionID / response)也认;没见过的 permission id 不转发", async () => {
    const h = await plugin();
    await h["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "touch ../outside" } });
    await h.event(asked("p1", "c1"));
    await h.event({ event: { type: "permission.replied", properties: { sessionID: "s1", permissionID: "p1", response: "always" } } });
    await h.event(replied("p-never", "reject"));
    const fwd = seen.filter((s) => s.body["event"] === "replied");
    expect(fwd.length).toBe(1);
    expect(fwd[0]!.body["reply"]).toBe("always");
  });
  test("tool.execute.after 转发 after,带 tool", async () => {
    const h = await plugin();
    await h["tool.execute.after"]({ tool: "bash", sessionID: "s1", callID: "c1", args: {} });
    expect(seen[0]!.body).toEqual({ v: 1, event: "after", session_id: "s1", call_id: "c1", tool: "bash" });
  });
  test("非 permission 事件被忽略,不打网关", async () => {
    const h = await plugin();
    await h.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(seen.length).toBe(0);
  });
});
