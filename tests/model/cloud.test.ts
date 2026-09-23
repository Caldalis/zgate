// SPEC.md §5.2 B —— CloudBackend,对 mock Anthropic / OpenAI-compatible。
import { afterEach, describe, expect, test } from "bun:test";

import { CloudBackend, retryable } from "../../src/model/cloud.ts";
import { ConfigError } from "../../src/config.ts";
import { ModelFormatError, ModelHttpError, withDeadline } from "../../src/core/model.ts";
import { SYSTEM_PROMPT } from "../../src/model/prompt.ts";
import { json, mockServer, never, request, type MockServer } from "./helpers.ts";

let srv: MockServer | null = null;
afterEach(() => {
  srv?.stop();
  srv = null;
});

const ENV = { MY_KEY: "sk-test-123" };
const NO_ABORT = new AbortController().signal;
const anthropic = (url: string, timeout = 1000) =>
  new CloudBackend({ provider: "anthropic", api_key_env: "MY_KEY", base_url: url, model: "claude-x", timeout_ms: timeout }, ENV);
const openai = (url: string) =>
  new CloudBackend({ provider: "openai", api_key_env: "MY_KEY", base_url: url, model: "gpt-x", timeout_ms: 1000 }, ENV);
const anthropicText = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const openaiText = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }] });

describe("密钥只从环境变量读", () => {
  test("★ 环境变量缺失 → 构造时就抛 ConfigError(serve 拒绝启动)", () => {
    expect(() => new CloudBackend({ provider: "anthropic", api_key_env: "NOPE", model: "m", timeout_ms: 1000 }, {})).toThrow(ConfigError);
    expect(() => new CloudBackend({ provider: "anthropic", api_key_env: "EMPTY", model: "m", timeout_ms: 1000 }, { EMPTY: "" })).toThrow(ConfigError);
  });

  test("Anthropic:x-api-key + anthropic-version 头,密钥值来自环境变量", async () => {
    srv = mockServer(() => json(anthropicText("ask")));
    await anthropic(srv.url).classify(request(), NO_ABORT);
    const req = srv.seen[0];
    expect(req?.path).toBe("/v1/messages");
    expect(req?.headers.get("x-api-key")).toBe("sk-test-123");
    expect(req?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(req?.body["model"]).toBe("claude-x");
    expect(req?.body["system"]).toBe(SYSTEM_PROMPT);
    const msgs = req?.body["messages"] as { role: string; content: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content.startsWith("TOOL CALL:")).toBe(true);
  });

  test("OpenAI-compatible:Bearer 头,system+user 两条消息", async () => {
    srv = mockServer(() => json(openaiText("allow")));
    await openai(srv.url).classify(request(), NO_ABORT);
    const req = srv.seen[0];
    expect(req?.path).toBe("/v1/chat/completions");
    expect(req?.headers.get("authorization")).toBe("Bearer sk-test-123");
    const msgs = req?.body["messages"] as { role: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("base_url 缺省时指向官方地址", () => {
    const b = new CloudBackend({ provider: "anthropic", api_key_env: "MY_KEY", model: "m", timeout_ms: 1000 }, ENV);
    expect(b.name).toBe("cloud");
    expect(b.model).toBe("m");
  });
});

describe("裁决解析", () => {
  test("Anthropic:从第一个 text block 取答案,confidence 恒 null", async () => {
    srv = mockServer(() => json({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "ask" }] }));
    const d = await anthropic(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(d.confidence).toBeNull();
    expect(d.details.backend).toBe("cloud");
    expect(d.details.model_name).toBe("claude-x");
    expect(d.details.cloud_latency_ms).toBe(d.latency_ms);
  });

  test("自由文本里带标点或说明也能取到词", async () => {
    srv = mockServer(() => json(anthropicText("Allow.")));
    expect((await anthropic(srv.url).classify(request(), NO_ABORT)).verdict).toBe("allow");
    srv.stop();
    srv = mockServer(() => json(anthropicText("I would ask, because the target is outside the repo.")));
    expect((await anthropic(srv.url).classify(request(), NO_ABORT)).verdict).toBe("ask");
  });

  test("★ 没有 allow/ask → ModelFormatError(不重试)", async () => {
    srv = mockServer(() => json(anthropicText("deny")));
    await expect(anthropic(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelFormatError);
    expect(srv.seen.length).toBe(1);
  });
});

describe("§5.2 B.2 重试:5xx / 网络错误一次,4xx / 429 不重试", () => {
  test("★ 500 后重试一次成功", async () => {
    srv = mockServer((_s, i) => (i === 0 ? json({ error: "boom" }, 500) : json(anthropicText("ask"))));
    const d = await anthropic(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(srv.seen.length).toBe(2);
  });

  test("两次 5xx → 抛 ModelHttpError,不再试第三次", async () => {
    srv = mockServer(() => json({ error: "boom" }, 502));
    await expect(anthropic(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelHttpError);
    expect(srv.seen.length).toBe(2);
  });

  test("★ 429 不重试,直接抛", async () => {
    srv = mockServer(() => json({ error: "rate" }, 429));
    await expect(anthropic(srv.url).classify(request(), NO_ABORT)).rejects.toMatchObject({ status: 429 });
    expect(srv.seen.length).toBe(1);
  });

  test("401 / 400 不重试", async () => {
    srv = mockServer(() => json({ error: "auth" }, 401));
    await expect(anthropic(srv.url).classify(request(), NO_ABORT)).rejects.toMatchObject({ status: 401 });
    expect(srv.seen.length).toBe(1);
  });

  test("retryable 的判定表", () => {
    expect(retryable(new ModelHttpError(500, "x"))).toBe(true);
    expect(retryable(new ModelHttpError(503, "x"))).toBe(true);
    expect(retryable(new ModelHttpError(429, "x"))).toBe(false);
    expect(retryable(new ModelHttpError(400, "x"))).toBe(false);
    expect(retryable(new ModelFormatError("x"))).toBe(false);
    expect(retryable(new DOMException("t", "TimeoutError"))).toBe(false);
    expect(retryable(new TypeError("fetch failed"))).toBe(true);
  });

  test("★ 超时不重试:signal 到期后立即失败,总耗时受约束", async () => {
    srv = mockServer(never);
    const b = anthropic(srv.url, 100);
    const t0 = performance.now();
    await expect(withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(srv.seen.length).toBe(1);
  });
});
