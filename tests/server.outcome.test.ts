// spec-m4 —— 结果信号(outcome)的端到端测试:起真的 daemon,按 Claude Code 2.1.284 的事件形状(D16.0 探针)打 /hook/claude-code,
// 断言 §9 的补丁行。核心论点:PreToolUse 的响应一个字节不变(§1 第 1 条);approved 只在工具真的执行了之后写(§1 第 3 条);
// Post 类事件永远回 {}(§1 第 4 条)。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, defaultConfig } from "../src/server.ts";
import { flushJournal, journalFileFor, replayFile, shutdownJournal } from "../src/core/journal.ts";
import { clearCache } from "../src/core/cache.ts";
import { clearCwdCache, clearGitCache } from "../src/enrichers/index.ts";
import { ActionSchema } from "../src/core/action.ts";

let journalDir: string;
let repo: string;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(() => {
  journalDir = realpathSync(mkdtempSync(join(tmpdir(), "zgate-outcome-journal-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "zgate-outcome-repo-")));
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, "README.md"), "# hi\n");
  process.env["ZGATE_JOURNAL_DIR"] = journalDir;
  server = createServer(defaultConfig({ port: 0 }));
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  shutdownJournal();
  void server.stop(true);
  delete process.env["ZGATE_JOURNAL_DIR"];
  rmSync(journalDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  clearCache();
  clearGitCache();
  clearCwdCache();
});

const SESSION = "5712aca3-3fb2-4afe-9ba4-0556d812fadc";
const ASK_CMD = "npm publish"; // exec.publish_deploy:pre SOFT,没配模型 ⇒ ask
const ALLOW_CMD = "git status";

type Body = Record<string, unknown>;

function pre(toolUseId: string, command: string, over: Body = {}): Body {
  return {
    session_id: SESSION, prompt_id: "a5a32a88", transcript_path: "/x.jsonl", cwd: repo, permission_mode: "default",
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "test" }, tool_use_id: toolUseId,
    effort: { level: "xhigh" }, ...over,
  };
}
function postOk(toolUseId: string, over: Body = {}): Body {
  return {
    session_id: SESSION, prompt_id: "a5a32a88", cwd: repo, permission_mode: "default", hook_event_name: "PostToolUse",
    tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: toolUseId,
    tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false }, duration_ms: 734, ...over,
  };
}
function postFail(toolUseId: string, over: Body = {}): Body {
  return {
    session_id: SESSION, cwd: repo, permission_mode: "default", hook_event_name: "PostToolUseFailure",
    tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: toolUseId,
    error: "Exit code 1\ncat: nope: No such file or directory", is_interrupt: false, duration_ms: 47, ...over,
  };
}
function batch(toolUseIds: string[], over: Body = {}): Body {
  return {
    session_id: SESSION, cwd: repo, permission_mode: "default", hook_event_name: "PostToolBatch",
    tool_calls: toolUseIds.map((id) => ({ tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: id, tool_response: "\"zgate: 请确认\"" })),
    ...over,
  };
}
function sessionEnd(over: Body = {}): Body {
  return { session_id: SESSION, prompt_id: "18cfa92e", cwd: repo, hook_event_name: "SessionEnd", reason: "prompt_input_exit", ...over };
}

async function hook(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/hook/claude-code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function lines(): Body[] {
  flushJournal();
  const file = journalFileFor(new Date());
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Body);
}
function rowsFor(toolUseId: string): Body[] {
  return lines().filter((r) => r["patch"] === undefined && (r["hook"] as Body | undefined)?.["tool_use_id"] === toolUseId);
}
function patchesFor(decisionId: string): Body[] {
  return lines().filter((r) => r["patch"] === "outcome" && r["decision_id"] === decisionId);
}
function decisionIdOf(row: Body): string {
  return (row["decision"] as Body)["decision_id"] as string;
}

let seq = 0;
function id(): string {
  seq += 1;
  return `toolu_01TEST${String(seq).padStart(4, "0")}`;
}

// ===========================================================================
describe("spec-m4 §1 第 1 条:PreToolUse 路径不变,只多记 hook", () => {
  test("★ 带 tool_use_id 的 ask 响应形状与 M3 完全相同:外层只有 hookSpecificOutput,内层恰好三个键", async () => {
    const { status, json } = await hook(pre(id(), ASK_CMD));
    expect(status).toBe(200);
    expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
    const inner = json["hookSpecificOutput"] as Body;
    expect(Object.keys(inner).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    expect(inner["permissionDecision"]).toBe("ask");
  });

  test("★ journal 行带 hook {tool_use_id, permission_mode, prompt_id},outcome 仍是 null", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    const rows = rowsFor(t);
    expect(rows.length).toBe(1);
    expect(rows[0]!["hook"]).toEqual({ tool_use_id: t, permission_mode: "default", prompt_id: "a5a32a88" });
    expect(rows[0]!["outcome"]).toBeNull();
  });

  test("allow 的行也带 hook(Python 侧要靠 permission_mode 过滤)", async () => {
    const t = id();
    await hook(pre(t, ALLOW_CMD));
    const rows = rowsFor(t);
    expect(rows.length).toBe(1);
    expect((rows[0]!["decision"] as Body)["verdict"]).toBe("allow");
    expect((rows[0]!["hook"] as Body)["tool_use_id"]).toBe(t);
  });

  test("老版本 Claude Code 没有 tool_use_id → 行里没有 hook 键,照常裁决", async () => {
    const before = lines().length;
    const { json } = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ASK_CMD }, cwd: repo, session_id: SESSION });
    expect((json["hookSpecificOutput"] as Body)["permissionDecision"]).toBe("ask");
    const all = lines();
    expect(all.length).toBe(before + 1);
    expect("hook" in all[all.length - 1]!).toBe(false);
  });

  test("/decide 进来的行没有 hook 键", async () => {
    const action = ActionSchema.parse({
      verb: "exec", targets: [], command: ASK_CMD, tool_name: "Bash", tool_input: { command: ASK_CMD },
      agent: { name: "test", version: null, session_id: null }, cwd: repo, turn_id: "t-decide",
    });
    const res = await fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const d = (await res.json()) as Body;
    const row = lines().find((r) => r["patch"] === undefined && decisionIdOf(r) === d["decision_id"]);
    expect(row).toBeDefined();
    expect("hook" in row!).toBe(false);
  });
});

// ===========================================================================
describe("spec-m4 §2 approved:只在工具真的执行了之后写", () => {
  test("★ ask → 同 session 同 id 的 PostToolUse → 补丁 approved / true;响应是 {}", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    const did = decisionIdOf(rowsFor(t)[0]!);
    expect(patchesFor(did).length).toBe(0);

    const { status, json } = await hook(postOk(t));
    expect(status).toBe(200);
    expect(json).toEqual({});
    const patches = patchesFor(did);
    expect(patches.length).toBe(1);
    expect(patches[0]!["v"]).toBe(1);
    expect(patches[0]!["outcome"]).toEqual({ user_action: "approved", tool_succeeded: true });
  });

  test("ask → PostToolUseFailure → approved / false(用户点了通过,工具自己失败)", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    await hook(postFail(t));
    const patches = patchesFor(decisionIdOf(rowsFor(t)[0]!));
    expect(patches.length).toBe(1);
    expect(patches[0]!["outcome"]).toEqual({ user_action: "approved", tool_succeeded: false });
  });

  test("同一个 id 的 Post 事件来两次,只补一次(取走即移出)", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    await hook(postOk(t));
    await hook(postOk(t));
    expect(patchesFor(decisionIdOf(rowsFor(t)[0]!)).length).toBe(1);
  });

  test("★ allow 的调用收到 PostToolUse → 不写补丁(表里没有,本来就没问)", async () => {
    const t = id();
    await hook(pre(t, ALLOW_CMD));
    const before = lines().length;
    const { json } = await hook(postOk(t));
    expect(json).toEqual({});
    expect(lines().length).toBe(before);
    expect(patchesFor(decisionIdOf(rowsFor(t)[0]!)).length).toBe(0);
  });

  test("没见过的 id 的 Post 事件 → {},日志一行不加", async () => {
    const before = lines().length;
    expect((await hook(postOk("toolu_never_seen"))).json).toEqual({});
    expect((await hook(postFail("toolu_never_seen"))).json).toEqual({});
    expect(lines().length).toBe(before);
  });

  test("★ 不同 session 的同一个 tool_use_id 不串", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    const did = decisionIdOf(rowsFor(t)[0]!);
    await hook(postOk(t, { session_id: "another-session" }));
    expect(patchesFor(did).length).toBe(0);
    await hook(postOk(t));
    expect(patchesFor(did).length).toBe(1);
  });

  test("id 是不透明字符串:chatcmpl-tool-… 也对得上(D16.0)", async () => {
    const t = "chatcmpl-tool-8f3d87991157ed19";
    await hook(pre(t, ASK_CMD));
    await hook(postOk(t));
    expect(patchesFor(decisionIdOf(rowsFor(t)[0]!))[0]!["outcome"]).toEqual({ user_action: "approved", tool_succeeded: true });
  });
});

// ===========================================================================
describe("spec-m4 §2 unknown:PostToolBatch 与 SessionEnd", () => {
  test("★ ask → PostToolBatch 带着仍悬着的 id(之前没来 Post 事件)→ unknown / null(`-p` 自动拒绝的路)", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    const { json } = await hook(batch([t]));
    expect(json).toEqual({});
    const patches = patchesFor(decisionIdOf(rowsFor(t)[0]!));
    expect(patches.length).toBe(1);
    expect(patches[0]!["outcome"]).toEqual({ user_action: "unknown", tool_succeeded: null });
  });

  test("★ ask → PostToolUse → PostToolBatch:批到时 id 已被取走,只有那一条 approved(正常通过的路)", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    await hook(postOk(t));
    await hook(batch([t]));
    const patches = patchesFor(decisionIdOf(rowsFor(t)[0]!));
    expect(patches.length).toBe(1);
    expect((patches[0]!["outcome"] as Body)["user_action"]).toBe("approved");
  });

  test("PostToolBatch 里既有悬着的也有没见过的 id → 只补悬着的那条", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    const before = lines().length;
    await hook(batch(["toolu_stranger", t, "toolu_stranger2"]));
    expect(lines().length).toBe(before + 1);
  });

  test("★ SessionEnd → 该 session 悬着的全部 unknown;别的 session 不动;再来一次 SessionEnd 不再写", async () => {
    const a1 = id();
    const a2 = id();
    const b = id();
    await hook(pre(a1, ASK_CMD));
    await hook(pre(a2, ASK_CMD));
    await hook(pre(b, ASK_CMD, { session_id: "session-B" }));
    const [dA1, dA2, dB] = [a1, a2, b].map((t) => decisionIdOf(rowsFor(t)[0]!));

    const { status, json } = await hook(sessionEnd());
    expect(status).toBe(200);
    expect(json).toEqual({});
    for (const d of [dA1, dA2]) {
      const p = patchesFor(d!);
      expect(p.length).toBe(1);
      expect(p[0]!["outcome"]).toEqual({ user_action: "unknown", tool_succeeded: null });
    }
    expect(patchesFor(dB!).length).toBe(0);

    const before = lines().length;
    await hook(sessionEnd());
    expect(lines().length).toBe(before);

    // B 的会话结束时轮到它
    await hook(sessionEnd({ session_id: "session-B" }));
    expect(patchesFor(dB!).length).toBe(1);
  });

  test("SessionEnd 之后同 id 的 PostToolUse 再来 → 已不在表里,不再补(先到先得,不改写)", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    await hook(sessionEnd());
    await hook(postOk(t));
    const patches = patchesFor(decisionIdOf(rowsFor(t)[0]!));
    expect(patches.length).toBe(1);
    expect((patches[0]!["outcome"] as Body)["user_action"]).toBe("unknown");
  });
});

// ===========================================================================
describe("spec-m4 §3 复合语句:只补判 ask 的行(D16.1)", () => {
  test("★ `git status && touch ../outside.txt` 两行同一个 tool_use_id;PostToolUse 只给 ask 的那行补 approved", async () => {
    // 不用 `&& npm publish`:exec.* 文本规则看的是整条命令原文,会让 git status 那行也变 ask(D12.10 / D15.10);
    // fs.outside_cwd 是按目标判的,两行才分得开
    const t = id();
    const { json } = await hook(pre(t, `${ALLOW_CMD} && touch ../outside.txt`));
    expect((json["hookSpecificOutput"] as Body)["permissionDecision"]).toBe("ask");
    const rows = rowsFor(t);
    expect(rows.length).toBe(2);
    const askRow = rows.find((r) => (r["decision"] as Body)["verdict"] === "ask")!;
    const allowRow = rows.find((r) => (r["decision"] as Body)["verdict"] === "allow")!;
    expect(askRow).toBeDefined();
    expect(allowRow).toBeDefined();

    await hook(postOk(t));
    expect(patchesFor(decisionIdOf(askRow)).length).toBe(1);
    expect(patchesFor(decisionIdOf(allowRow)).length).toBe(0);
  });
});

// ===========================================================================
describe("spec-m4 §1 第 4 条:旁观的事件一律 {},不写日志", () => {
  test("PermissionRequest / PermissionDenied / Notification / Stop / UserPromptSubmit / 未来的事件 → 200 {}", async () => {
    const before = lines().length;
    for (const name of ["PermissionRequest", "PermissionDenied", "Notification", "Stop", "UserPromptSubmit", "SubagentStop", "BrandNewEvent"]) {
      const { status, json } = await hook({ session_id: SESSION, cwd: repo, hook_event_name: name, tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: id() });
      expect(status).toBe(200);
      expect(json).toEqual({});
    }
    expect(lines().length).toBe(before);
  });

  test("Post 事件缺 tool_use_id / tool_calls 是垃圾 / SessionEnd 没有 session_id → 仍是 {}", async () => {
    expect((await hook({ hook_event_name: "PostToolUse", tool_name: "Bash" })).json).toEqual({});
    expect((await hook({ hook_event_name: "PostToolBatch", tool_calls: "garbage" })).json).toEqual({});
    expect((await hook({ hook_event_name: "PostToolBatch", tool_calls: [null, 1, { tool_use_id: 5 }] })).json).toEqual({});
    expect((await hook({ hook_event_name: "SessionEnd", reason: "other" })).json).toEqual({});
  });

  test("★ 旁观事件绝不带 hookSpecificOutput(带了会被 Claude Code 当成 schema 不符的错误)", async () => {
    const { json } = await hook(postOk("toolu_whatever"));
    expect("hookSpecificOutput" in json).toBe(false);
  });
});

// ===========================================================================
describe("spec-m4 §4 replay 端到端", () => {
  test("★ replay 把 hook 与钩子推出来的 outcome 一起带回", async () => {
    const t = id();
    await hook(pre(t, ASK_CMD));
    await hook(postFail(t));
    flushJournal();
    const { entries, badLines } = replayFile(journalFileFor(new Date()));
    expect(badLines).toBe(0);
    const e = entries.find((x) => x.hook?.tool_use_id === t);
    expect(e).toBeDefined();
    expect(e!.decision.verdict).toBe("ask");
    expect(e!.outcome).toEqual({ user_action: "approved", tool_succeeded: false });
    expect(e!.hook).toEqual({ tool_use_id: t, permission_mode: "default", prompt_id: "a5a32a88" });
  });
});
