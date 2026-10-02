// opencode 适配器:线格式解析与工具 → Action 的映射(参照 opencode 1.18.33 的工具 id 与参数名)。

import { describe, expect, test } from "bun:test";
import { ActionSchema } from "../src/core/action.ts";
import { opencodeHookDetails, parseOpencodeEvent, toActionsOpencode, type OpencodeBefore } from "../src/adapters/opencode.ts";

function before(tool: string, args: Record<string, unknown>, over: Partial<OpencodeBefore> = {}): OpencodeBefore {
  return { kind: "before", sessionId: "s1", callId: "call_1", tool, args, cwd: "/repo", version: "1.18.33", ...over };
}
const TURN = "turn-1";

describe("parseOpencodeEvent:三种事件", () => {
  test("before 带 tool / args / cwd / agent_version", () => {
    const ev = parseOpencodeEvent({ v: 1, event: "before", session_id: "s", call_id: "c", tool: "bash", args: { command: "ls" }, cwd: "/p", agent_version: "1.18.33" });
    expect(ev).toEqual({ kind: "before", sessionId: "s", callId: "c", tool: "bash", args: { command: "ls" }, cwd: "/p", version: "1.18.33" });
  });
  test("没写 event 的按 before;缺 tool → null;args 不是对象 → null", () => {
    expect(parseOpencodeEvent({ tool: "read", args: { path: "/a" } })?.kind).toBe("before");
    expect(parseOpencodeEvent({ event: "before" })).toBeNull();
    expect(parseOpencodeEvent({ event: "before", tool: "bash", args: "ls" })).toBeNull();
    expect(parseOpencodeEvent({ event: "before", tool: "bash", args: [1] })).toBeNull();
  });
  test("非对象 → null", () => {
    for (const bad of [null, undefined, 1, "x", [1]]) expect(parseOpencodeEvent(bad)).toBeNull();
  });
  test("replied / after 带 call_id;缺 call_id 归 other;reply 缺省为空串", () => {
    expect(parseOpencodeEvent({ event: "replied", session_id: "s", call_id: "c", reply: "reject" })).toEqual({ kind: "replied", sessionId: "s", callId: "c", reply: "reject" });
    expect(parseOpencodeEvent({ event: "replied", session_id: "s", call_id: "c" })).toEqual({ kind: "replied", sessionId: "s", callId: "c", reply: "" });
    expect(parseOpencodeEvent({ event: "after", session_id: "s", call_id: "c", tool: "bash" })).toEqual({ kind: "after", sessionId: "s", callId: "c" });
    expect(parseOpencodeEvent({ event: "after", session_id: "s" })).toEqual({ kind: "other", name: "after" });
    expect(parseOpencodeEvent({ event: "replied", session_id: "s" })).toEqual({ kind: "other", name: "replied" });
  });
  test("未知事件名 → other", () => {
    expect(parseOpencodeEvent({ event: "something", session_id: "s" })).toEqual({ kind: "other", name: "something" });
  });
});

describe("toActionsOpencode:工具映射", () => {
  test("bash 走 shell 解析:复合语句切多条,exec 带 command,agent 是 opencode", () => {
    const acts = toActionsOpencode(before("bash", { command: "git status && rm -rf ./build" }), TURN);
    expect(acts.length).toBe(2);
    expect(acts.map((a) => a.verb)).toEqual(["read", "delete"]);
    expect(acts[1]!.targets).toEqual([{ kind: "file", raw: "./build" }]);
    expect(acts[0]!.agent).toEqual({ name: "opencode", version: "1.18.33", session_id: "s1" });
    expect(acts[0]!.tool_name).toBe("bash");
    expect(acts[0]!.turn_id).toBe(TURN);
    for (const a of acts) expect(ActionSchema.safeParse(a).success).toBe(true);
  });
  test("★ bash 的 workdir 改变相对路径基准:Action.cwd 是 cwd/workdir", () => {
    const acts = toActionsOpencode(before("bash", { command: "rm -rf ./build", workdir: "packages/web" }), TURN);
    expect(acts[0]!.cwd).toBe("/repo/packages/web");
    expect(toActionsOpencode(before("bash", { command: "ls" }), TURN)[0]!.cwd).toBe("/repo");
  });
  test("bash 解析失败 / 零条命令 → 一条 unknown;缺 command → 空数组", () => {
    expect(toActionsOpencode(before("bash", { command: "rm -rf $(cat list)" }), TURN).map((a) => a.verb)).toEqual(["unknown"]);
    expect(toActionsOpencode(before("bash", { command: ":(){ :|:& };:" }), TURN).map((a) => a.verb)).toEqual(["unknown"]);
    expect(toActionsOpencode(before("bash", {}), TURN)).toEqual([]);
  });
  test("read / glob / grep / list → read,目标字段是 path", () => {
    expect(toActionsOpencode(before("read", { path: "/repo/.env" }), TURN)[0]).toMatchObject({ verb: "read", targets: [{ kind: "file", raw: "/repo/.env" }] });
    expect(toActionsOpencode(before("glob", { pattern: "**/*.ts", path: "src" }), TURN)[0]).toMatchObject({ verb: "read", targets: [{ kind: "file", raw: "src" }] });
    expect(toActionsOpencode(before("grep", { pattern: "TODO" }), TURN)[0]).toMatchObject({ verb: "read", targets: [] });
    expect(toActionsOpencode(before("list", { path: "/repo" }), TURN)[0]!.verb).toBe("read");
  });
  test("edit / write → write,目标 path", () => {
    expect(toActionsOpencode(before("edit", { path: "/repo/a.ts", oldString: "x", newString: "y" }), TURN)[0]).toMatchObject({ verb: "write", targets: [{ kind: "file", raw: "/repo/a.ts" }], command: null });
    expect(toActionsOpencode(before("write", { path: "/repo/b.ts", content: "" }), TURN)[0]!.verb).toBe("write");
  });
  test("webfetch → network url;websearch → network query", () => {
    expect(toActionsOpencode(before("webfetch", { url: "https://x.y" }), TURN)[0]).toMatchObject({ verb: "network", targets: [{ kind: "url", raw: "https://x.y" }] });
    expect(toActionsOpencode(before("websearch", { query: "zgate" }), TURN)[0]).toMatchObject({ verb: "network", targets: [{ kind: "url", raw: "zgate" }] });
  });
  test("★ apply_patch:每个文件一条 Action,Add / Update / Move to 是 write,Delete 是 delete", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const x = 1",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    const acts = toActionsOpencode(before("apply_patch", { patchText }), TURN);
    expect(acts.map((a) => [a.verb, a.targets[0]!.raw])).toEqual([
      ["write", "src/new.ts"],
      ["write", "src/old.ts"],
      ["write", "src/renamed.ts"],
      ["delete", "src/gone.ts"],
    ]);
    expect(acts[0]!.tool_input).toEqual({ patchText });
  });
  test("apply_patch 认不出任何文件 → 一条 unknown(保守);缺 patchText → 空数组", () => {
    expect(toActionsOpencode(before("apply_patch", { patchText: "garbage" }), TURN).map((a) => a.verb)).toEqual(["unknown"]);
    expect(toActionsOpencode(before("apply_patch", {}), TURN)).toEqual([]);
  });
  test("无动作可判的工具 → 空数组;不认识的工具 → unknown", () => {
    for (const t of ["task", "todowrite", "todoread", "question", "skill"]) expect(toActionsOpencode(before(t, { x: 1 }), TURN)).toEqual([]);
    const u = toActionsOpencode(before("mcp_something", { a: 1 }), TURN);
    expect(u.length).toBe(1);
    expect(u[0]!.verb).toBe("unknown");
    expect(u[0]!.targets).toEqual([]);
  });
  test("缺 cwd 时回落到进程 cwd;缺 session / version 是 null", () => {
    const a = toActionsOpencode(before("read", { path: "x" }, { cwd: null, sessionId: null, version: null }), TURN)[0]!;
    expect(a.cwd).toBe(process.cwd());
    expect(a.agent).toEqual({ name: "opencode", version: null, session_id: null });
  });
});

describe("opencodeHookDetails", () => {
  test("callID 落在 tool_use_id 上;没有 callID → null;不带 permission_mode", () => {
    const d = opencodeHookDetails(before("bash", { command: "ls" }));
    expect(d).toEqual({ tool_use_id: "call_1" });
    expect(d !== null && "permission_mode" in d).toBe(false);
    expect(opencodeHookDetails(before("bash", { command: "ls" }, { callId: null }))).toBeNull();
  });
});
