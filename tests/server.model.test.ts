// SPEC.md §5 / §8 / §9 —— daemon 接上模型后端后的端到端:mock 后端 → hook 请求 → 日志。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCache } from "../src/core/cache.ts";
import { flushJournal, journalFileFor, replayFile, shutdownJournal } from "../src/core/journal.ts";
import type { ModelBackend, ModelDecision, ModelRequest } from "../src/core/model.ts";
import { clearGitCache, clearCwdCache } from "../src/enrichers/index.ts";
import { createServer, defaultConfig } from "../src/server.ts";

/** 可编程的后端:按 command 决定行为,记录被问了什么。 */
class ScriptedBackend implements ModelBackend {
  readonly name = "local";
  readonly timeoutMs = 150;
  readonly asked: ModelRequest[] = [];
  mode: "allow" | "ask" | "hang" | "throw" = "allow";
  async classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision> {
    this.asked.push(req);
    if (this.mode === "throw") throw new Error("down");
    if (this.mode === "hang") {
      return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return { verdict: this.mode, confidence: 0.88, latency_ms: 2, details: { backend: "local", model_name: "scripted", local_latency_ms: 2 } };
  }
}

let journalDir: string;
let repo: string;
let server: ReturnType<typeof createServer>;
let base: string;
const backend = new ScriptedBackend();

beforeAll(() => {
  journalDir = realpathSync(mkdtempSync(join(tmpdir(), "zgate-srvm-journal-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "zgate-srvm-repo-")));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".env"), "S=1\n");
  mkdirSync(join(repo, "build"), { recursive: true });
  process.env["ZGATE_JOURNAL_DIR"] = journalDir;
  server = createServer(defaultConfig({ port: 0, backend }));
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
  backend.asked.length = 0;
  backend.mode = "allow";
});

async function hook(toolName: string, toolInput: Record<string, unknown>) {
  const res = await fetch(`${base}/hook/claude-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: repo, session_id: "s" }),
  });
  const body = (await res.json()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return body.hookSpecificOutput;
}

function lastLines(n: number): Record<string, any>[] {
  flushJournal();
  const lines = readFileSync(journalFileFor(new Date()), "utf8").split("\n").filter((l) => l !== "");
  return lines.slice(-n).map((l) => JSON.parse(l));
}

describe("模型段接进 daemon", () => {
  test("/healthz 报后端名", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(body["backend"]).toBe("local");
  });

  test("★ SOFT 走模型:模型说 allow → hook 回 allow,日志 source=model 且带 model_details", async () => {
    const out = await hook("Read", { file_path: ".env" });
    expect(out.permissionDecision).toBe("allow");
    expect(out.permissionDecisionReason).toBe("");
    expect(backend.asked.length).toBe(1);
    expect(backend.asked[0]?.flaggedRule).toBe("fs.secret_file");

    const [rec] = lastLines(1);
    expect(rec?.["decision"]["source"]).toBe("model");
    expect(rec?.["decision"]["confidence"]).toBe(0.88);
    expect(rec?.["decision"]["rule_id"]).toBe("fs.secret_file");
    expect(rec?.["model_details"]).toEqual({ backend: "local", model_name: "scripted", local_latency_ms: 2 });
    expect(rec?.["context"]["resources"][0]["raw"]).toBe(".env");
  });

  test("模型说 ask → hook 回 ask,理由是规则那句", async () => {
    backend.mode = "ask";
    const out = await hook("Read", { file_path: ".env" });
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toContain(".env");
    expect(lastLines(1)[0]?.["decision"]["source"]).toBe("model");
  });

  test("★ PASS / HARD_DENY 不问模型,日志没有 model_details", async () => {
    expect((await hook("Bash", { command: "rm -rf ./build" })).permissionDecision).toBe("allow");
    expect((await hook("Bash", { command: "rm -rf /" })).permissionDecision).toBe("deny");
    expect(backend.asked.length).toBe(0);
    for (const rec of lastLines(2)) expect(rec["model_details"]).toBeUndefined();
  });

  test("★ 模型超时 → ask + source fallback,daemon 不被卡住,日志记 error: timeout", async () => {
    backend.mode = "hang";
    const t0 = performance.now();
    const [slow, fast] = await Promise.all([hook("Read", { file_path: ".env" }), hook("Bash", { command: "git status" })]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(slow?.permissionDecision).toBe("ask");
    expect(slow?.permissionDecisionReason).toContain("模型超时");
    expect(fast?.permissionDecision).toBe("allow");
    const rec = lastLines(2).find((r) => r["action"]["tool_name"] === "Read");
    expect(rec?.["decision"]["source"]).toBe("fallback");
    expect(rec?.["decision"]["confidence"]).toBe(0);
    expect(rec?.["model_details"]).toEqual({ backend: "local", error: "timeout" });
  });

  test("模型抛异常 → ask + fallback,日志 error: unreachable", async () => {
    backend.mode = "throw";
    expect((await hook("Read", { file_path: ".env" })).permissionDecision).toBe("ask");
    const [rec] = lastLines(1);
    expect(rec?.["decision"]["source"]).toBe("fallback");
    expect(rec?.["model_details"]["error"]).toBe("unreachable");
  });

  test("★ 复合语句:有一条 HARD_DENY 整批 deny,谁都不问模型", async () => {
    expect((await hook("Bash", { command: "cat .env && rm -rf /" })).permissionDecision).toBe("deny");
    expect(backend.asked.length).toBe(0);
  });

  test("复合语句:两条 SOFT,第一条模型说 ask 后第二条不再问", async () => {
    backend.mode = "ask";
    const out = await hook("Bash", { command: "cat .env; cat .env.local" });
    expect(out.permissionDecision).toBe("ask");
    expect(backend.asked.length).toBe(1);
    const recs = lastLines(2);
    expect(recs.map((r) => r["decision"]["source"]).sort()).toEqual(["fallback", "model"]);
  });

  test("★ 复合语句里逐字相同的两段:模型只问一次,两行都是 model,decision_id 不同(D14.19)", async () => {
    const out = await hook("Bash", { command: "cat .env && cat .env" });
    expect(out.permissionDecision).toBe("allow");
    expect(backend.asked.length).toBe(1);
    const recs = lastLines(2);
    expect(recs.map((r) => r["decision"]["source"])).toEqual(["model", "model"]);
    expect(new Set(recs.map((r) => r["decision"]["decision_id"])).size).toBe(2);
  });

  test("★ 模型结论进缓存:同一 SOFT 第二次 source=cache,模型只问一次", async () => {
    await hook("Read", { file_path: ".env" });
    const out = await hook("Read", { file_path: ".env" });
    expect(out.permissionDecision).toBe("allow");
    expect(backend.asked.length).toBe(1);
    const [rec] = lastLines(1);
    expect(rec?.["decision"]["source"]).toBe("cache");
    expect(rec?.["model_details"]["model_name"]).toBe("scripted");
  });

  test("★ 日志能回放,model_details 原样带回;没有模型的行是 null", async () => {
    await hook("Read", { file_path: ".env" });
    await hook("Bash", { command: "git status" });
    flushJournal();
    const { entries, badLines } = replayFile(journalFileFor(new Date()));
    expect(badLines).toBe(0);
    const withModel = entries.filter((e) => e.model_details !== null);
    expect(withModel.length).toBeGreaterThan(0);
    expect(withModel.at(-1)?.model_details?.backend).toBe("local");
    expect(entries.at(-1)?.model_details).toBeNull();
  });

  test("/decide 也走模型,且日志带 model_details", async () => {
    const res = await fetch(`${base}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: {
          verb: "read", targets: [{ kind: "file", raw: ".env" }], command: null, tool_name: "Read",
          tool_input: { file_path: ".env" }, agent: { name: "t", version: null, session_id: null }, cwd: repo, turn_id: "t",
        },
      }),
    });
    const d = (await res.json()) as Record<string, unknown>;
    expect(d["source"]).toBe("model");
    expect(d["confidence"]).toBe(0.88);
    const [rec] = lastLines(1);
    expect(rec?.["decision_id"]).toBe(d["decision_id"]);
    expect(rec?.["model_details"]["backend"]).toBe("local");
  });
});
