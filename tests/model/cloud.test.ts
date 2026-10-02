// CloudBackend,对 mock Anthropic / OpenAI-compatible。
import { afterEach, describe, expect, test } from "bun:test";

import { CloudBackend, MAX_ATTEMPTS, VERDICT_SCHEMA, retryable } from "../../src/model/cloud.ts";
import { ConfigError } from "../../src/config.ts";
import { ModelFormatError, ModelHttpError, withDeadline } from "../../src/core/model.ts";
import { SYSTEM_PROMPT, parseVerdictJson } from "../../src/model/prompt.ts";
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
/** 结构化输出下服务端会回的那一个 JSON 对象。 */
const verdictJson = (v: "allow" | "ask") => JSON.stringify({ verdict: v });

describe("密钥只从环境变量读", () => {
  test("★ 环境变量缺失 → 构造时就抛 ConfigError(serve 拒绝启动)", () => {
    expect(() => new CloudBackend({ provider: "anthropic", api_key_env: "NOPE", model: "m", timeout_ms: 1000 }, {})).toThrow(ConfigError);
    expect(() => new CloudBackend({ provider: "anthropic", api_key_env: "EMPTY", model: "m", timeout_ms: 1000 }, { EMPTY: "" })).toThrow(ConfigError);
  });

  test("Anthropic:x-api-key + anthropic-version 头,密钥值来自环境变量;结构化输出走 output_config.format", async () => {
    srv = mockServer(() => json(anthropicText(verdictJson("ask"))));
    await anthropic(srv.url).classify(request(), NO_ABORT);
    const req = srv.seen[0];
    expect(req?.path).toBe("/v1/messages");
    expect(req?.headers.get("x-api-key")).toBe("sk-test-123");
    expect(req?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(req?.headers.get("anthropic-beta")).toBeNull(); // GA,不需要 beta 头
    expect(req?.body["model"]).toBe("claude-x");
    expect(req?.body["system"]).toBe(SYSTEM_PROMPT);
    expect(req?.body["max_tokens"]).toBe(64);
    expect(req?.body["output_config"]).toEqual({ format: { type: "json_schema", schema: VERDICT_SCHEMA } });
    const msgs = req?.body["messages"] as { role: string; content: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content.startsWith("TOOL CALL:")).toBe(true);
  });

  test("OpenAI-compatible:Bearer 头,system+user 两条消息,response_format 是 strict json_schema,带 max_tokens", async () => {
    srv = mockServer(() => json(openaiText(verdictJson("allow"))));
    await openai(srv.url).classify(request(), NO_ABORT);
    const req = srv.seen[0];
    expect(req?.path).toBe("/v1/chat/completions");
    expect(req?.headers.get("authorization")).toBe("Bearer sk-test-123");
    expect(req?.body["max_tokens"]).toBe(64);
    // llama-server 的扩展:不关 thinking,Qwen3.5 会把 token 全花在 reasoning 里,content 空
    expect(req?.body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(req?.body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA },
    });
    const msgs = req?.body["messages"] as { role: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("★ 两家用的是同一份 schema:一个对象、一个枚举字段、不许多余键", () => {
    expect(VERDICT_SCHEMA.type).toBe("object");
    expect(VERDICT_SCHEMA.properties.verdict.enum).toEqual(["allow", "ask"]);
    expect(VERDICT_SCHEMA.required).toEqual(["verdict"]);
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
  });

  test("base_url 缺省时指向官方地址", () => {
    const b = new CloudBackend({ provider: "anthropic", api_key_env: "MY_KEY", model: "m", timeout_ms: 1000 }, ENV);
    expect(b.name).toBe("cloud");
    expect(b.model).toBe("m");
  });
});

describe("裁决解析:整段必须是 {\"verdict\": allow|ask},绝不在文本里找词", () => {
  test("Anthropic:从第一个 text block 取 JSON,confidence 恒 null", async () => {
    srv = mockServer(() => json({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text: verdictJson("ask") }] }));
    const d = await anthropic(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(d.confidence).toBeNull();
    expect(d.details.backend).toBe("cloud");
    expect(d.details.model_name).toBe("claude-x");
    expect(d.details.cloud_latency_ms).toBe(d.latency_ms);
    expect(d.details.attempts).toBeUndefined(); // 一次就对,不写 attempts
  });

  test("OpenAI-compatible:从 choices[0].message.content 取 JSON", async () => {
    srv = mockServer(() => json(openaiText(verdictJson("allow"))));
    expect((await openai(srv.url).classify(request(), NO_ABORT)).verdict).toBe("allow");
  });

  test("首尾空白容忍(服务端有时带换行)", async () => {
    srv = mockServer(() => json(anthropicText(`\n  ${verdictJson("ask")}\n`)));
    expect((await anthropic(srv.url).classify(request(), NO_ABORT)).verdict).toBe("ask");
  });

  test("★ 带否定的散文一律不算合法格式:找词会读反的四种形状", () => {
    for (const text of [
      "I cannot allow this — it touches a file outside the project. Ask the user.",
      "Not routine. I would not allow it. Ask.",
      "This is not something I can allow. ask",
      "the rule layer would ask. But this is routine, so: allow",
    ]) {
      expect(parseVerdictJson(text), text).toBeNull();
    }
  });

  test("★ 裸词、别的键、多余键、枚举外的值、数组、外层包字,全部 null", () => {
    for (const text of [
      "allow",
      "ask",
      "Allow.",
      '{"decision": "allow"}',
      '{"verdict": "allow", "reason": "fine"}',
      '{"verdict": "deny"}',
      '{"verdict": "ALLOW"}',
      '["allow"]',
      'Sure! {"verdict": "allow"}',
      '{"verdict": "allow"} — routine build dir',
      "",
      "null",
    ]) {
      expect(parseVerdictJson(text), text).toBeNull();
    }
    expect(parseVerdictJson('{"verdict":"allow"}')).toBe("allow");
    expect(parseVerdictJson('{ "verdict" : "ask" }')).toBe("ask");
  });
});

describe("格式不对就重新生成,最多 5 次,超过降级", () => {
  test("★ 前两次散文、第三次合法 → 用第三次,attempts=3", async () => {
    const replies = ["I cannot allow this. Ask.", "allow", verdictJson("ask")];
    srv = mockServer((_s, i) => json(anthropicText(replies[i] ?? verdictJson("ask"))));
    const d = await anthropic(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(srv.seen.length).toBe(3);
    expect(d.details.attempts).toBe(3);
  });

  test("★ 5 次全是坏格式 → ModelFormatError(管线降级 ask),恰好 5 次请求", async () => {
    srv = mockServer(() => json(anthropicText("I cannot allow this. Ask.")));
    await expect(anthropic(srv.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelFormatError);
    expect(srv.seen.length).toBe(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  test("★ 坏格式期间 signal 到期 → 立刻停,不把 5 次打满", async () => {
    srv = mockServer(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return json(anthropicText("nope"));
    });
    const b = anthropic(srv.url, 150);
    await expect(withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s))).rejects.toBeInstanceOf(Error);
    expect(srv.seen.length).toBeLessThan(MAX_ATTEMPTS);
  });

  test("响应不是 JSON / 缺 text block 也算一次坏格式,会重生成", async () => {
    srv = mockServer((_s, i) => (i === 0 ? json({ content: [] }) : json(anthropicText(verdictJson("allow")))));
    const d = await anthropic(srv.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("allow");
    expect(srv.seen.length).toBe(2);
  });
});

describe("重试:5xx / 网络错误一次,4xx / 429 不重试", () => {
  test("★ 500 后重试一次成功", async () => {
    srv = mockServer((_s, i) => (i === 0 ? json({ error: "boom" }, 500) : json(anthropicText(verdictJson("ask")))));
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
