// SPEC.md §5.2 A —— LocalBackend,对 mock llama-server。
import { afterEach, describe, expect, test } from "bun:test";

import { LocalBackend, confidenceOf } from "../../src/model/local.ts";
import { ModelFormatError, ModelHttpError, withDeadline } from "../../src/core/model.ts";
import { SYSTEM_PROMPT } from "../../src/model/prompt.ts";
import { json, llamaResponse, mockServer, never, request, type MockServer } from "./helpers.ts";

let srv: MockServer | null = null;
afterEach(() => {
  srv?.stop();
  srv = null;
});

const backend = (url: string, timeout = 1000) => new LocalBackend({ base_url: url, timeout_ms: timeout, model_name: "test-9b" });
const NO_ABORT = new AbortController().signal;

describe("请求形状(§5.2 A 的七条要点)", () => {
  test("走 /v1/chat/completions,system+user 两条消息,关 thinking,grammar 约束,cache_prompt", async () => {
    srv = mockServer(() => json(llamaResponse("ask", { allow: -2.9, ask: -0.06 })));
    await backend(srv.url).classify(request(), NO_ABORT);
    const [req] = srv.seen;
    expect(req?.path).toBe("/v1/chat/completions");
    const msgs = req?.body["messages"] as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[0]?.content).toBe(SYSTEM_PROMPT);
    expect(msgs[1]?.content.startsWith("TOOL CALL:\n{")).toBe(true);
    expect(req?.body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(req?.body["grammar"]).toBe('root ::= ("allow" | "ask")');
    expect(req?.body["cache_prompt"]).toBe(true);
    expect(req?.body["temperature"]).toBe(0);
    expect(req?.body["logprobs"]).toBe(true);
  });

  test("prompt 的 JSON 含 verb / command / tool_name / cwd / targets / resources / repo / flagged_rule", async () => {
    srv = mockServer(() => json(llamaResponse("ask", { allow: -2.9, ask: -0.06 })));
    await backend(srv.url).classify(request(), NO_ABORT);
    const user = (srv.seen[0]?.body["messages"] as { content: string }[])[1]?.content ?? "";
    const obj = JSON.parse(user.slice("TOOL CALL:\n".length));
    expect(Object.keys(obj)).toEqual(["verb", "command", "tool_name", "cwd", "targets", "resources", "repo", "flagged_rule"]);
    expect(obj.flagged_rule).toBe("fs.outside_cwd");
    expect(obj.resources[0].is_symlink).toBe(true);
    // 不进 prompt 的:tool_input 原样、agent、turn_id、env_hints
    expect(user).not.toContain("turn_id");
    expect(user).not.toContain("env_hints");
  });

  test("base_url 末尾的斜杠不会拼出双斜杠", async () => {
    srv = mockServer(() => json(llamaResponse("ask", { allow: -2.9, ask: -0.06 })));
    await backend(srv.url + "/").classify(request(), NO_ABORT);
    expect(srv.seen[0]?.path).toBe("/v1/chat/completions");
  });
});

describe("裁决与置信度", () => {
  test("★ 一次调用:top_logprobs 里两个词都在 → 直接 softmax,不再强制续写", async () => {
    srv = mockServer(() => json(llamaResponse("ask", { allow: -2.9148, ask: -0.0573 })));
    const d = await backend(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(d.confidence).toBeCloseTo(1 - 1 / (1 + Math.exp(-0.0573 + 2.9148)), 6);
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(srv.seen.length).toBe(1);
    expect(d.details).toEqual({ backend: "local", model_name: "test-9b", local_latency_ms: d.latency_ms });
  });

  test("allow 的置信度是 P(allow)", async () => {
    srv = mockServer(() => json(llamaResponse("allow", { allow: -0.38, ask: -1.15 })));
    const d = await backend(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("allow");
    expect(d.confidence).toBeCloseTo(1 / (1 + Math.exp(-1.15 + 0.38)), 6);
  });

  test("★ 另一个词不在 top_logprobs 里 → 回落 §5.2 A.4 的强制续写(共 3 次调用)", async () => {
    srv = mockServer((seen, i) => {
      if (i === 0) return json(llamaResponse("ask", { ask: -0.06 })); // 只有自己
      const g = seen.body["grammar"];
      if (g === 'root ::= "allow"') return json(llamaResponse("allow", { allow: -2.9 }));
      if (g === 'root ::= "ask"') return json(llamaResponse("ask", { ask: -0.06 }));
      return json({ error: "unexpected" }, 500);
    });
    const d = await backend(srv.url).classify(request(), NO_ABORT);
    expect(srv.seen.length).toBe(3);
    expect(srv.seen.map((s) => s.body["grammar"])).toEqual(['root ::= ("allow" | "ask")', 'root ::= "allow"', 'root ::= "ask"']);
    expect(d.verdict).toBe("ask");
    expect(d.confidence).toBeCloseTo(confidenceOf("ask", -2.9, -0.06), 6);
  });

  test("服务器不给 logprobs 且强制续写也没有 → confidence null,verdict 照用", async () => {
    srv = mockServer(() => json(llamaResponse("allow", null)));
    const d = await backend(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("allow");
    expect(d.confidence).toBeNull();
  });

  test("首尾空白与大小写不影响裁决解析", async () => {
    srv = mockServer(() => json(llamaResponse(" Allow", { allow: -0.1, ask: -2 })));
    expect((await backend(srv.url).classify(request(), NO_ABORT)).verdict).toBe("allow");
  });

  test("confidenceOf:softmax 对称、和为 1", () => {
    expect(confidenceOf("allow", -1, -1)).toBeCloseTo(0.5, 9);
    expect(confidenceOf("allow", -0.06, -2.9) + confidenceOf("ask", -0.06, -2.9)).toBeCloseTo(1, 9);
    expect(confidenceOf("ask", -5, -0.01)).toBeGreaterThan(0.99);
  });
});

describe("§3.2 的降级场景都以异常上报", () => {
  test("★ 超时:signal 到期 fetch 被 abort,抛 TimeoutError", async () => {
    srv = mockServer(never);
    const b = backend(srv.url, 100);
    const t0 = performance.now();
    await expect(withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("不可达:连接失败抛异常", async () => {
    const b = backend("http://127.0.0.1:1");
    await expect(b.classify(request(), NO_ABORT)).rejects.toBeInstanceOf(Error);
  });

  test("5xx → ModelHttpError 带状态码", async () => {
    srv = mockServer(() => json({ error: "slot busy" }, 503));
    await expect(backend(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelHttpError);
  });

  test("★ 输出不是 allow/ask → ModelFormatError", async () => {
    srv = mockServer(() => json(llamaResponse("deny", null)));
    await expect(backend(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelFormatError);
  });

  test("响应不是 JSON / 缺 choices → ModelFormatError", async () => {
    srv = mockServer(() => new Response("<html>", { status: 200 }));
    await expect(backend(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelFormatError);
    srv.stop();
    srv = mockServer(() => json({ choices: [] }));
    await expect(backend(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelFormatError);
  });

  test("外部 signal 已 abort → 立刻失败,不发请求", async () => {
    srv = mockServer(() => json(llamaResponse("ask", { allow: -2.9, ask: -0.06 })));
    const c = new AbortController();
    c.abort();
    await expect(backend(srv.url).classify(request(), c.signal)).rejects.toBeInstanceOf(Error);
    expect(srv.seen.length).toBe(0);
  });
});
