// ChainBackend:本地判,低置信度升级云端;云端失败降级。
import { afterEach, describe, expect, test } from "bun:test";

import { ChainBackend } from "../../src/model/chain.ts";
import { ModelHttpError, withDeadline } from "../../src/core/model.ts";
import { json, llamaResponse, mockServer, never, request, type MockServer } from "./helpers.ts";

const servers: MockServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});
const track = (s: MockServer): MockServer => (servers.push(s), s);
const ENV = { KEY: "k" };
const NO_ABORT = new AbortController().signal;

function chain(local: string, cloud: string, threshold = 0.75, localTimeout = 1000, cloudTimeout = 1000): ChainBackend {
  return new ChainBackend(
    {
      local: { base_url: local, timeout_ms: localTimeout },
      cloud: { provider: "anthropic", api_key_env: "KEY", base_url: cloud, model: "claude-x", timeout_ms: cloudTimeout },
      escalation_threshold: threshold,
    },
    ENV,
  );
}
const cloudText = (v: "allow" | "ask") => ({ content: [{ type: "text", text: JSON.stringify({ verdict: v }) }] });

describe("置信度路由", () => {
  test("★ 本地置信度 ≥ 阈值 → 不升级,云端一次都不调", async () => {
    const local = track(mockServer(() => json(llamaResponse("ask", { allow: -2.9, ask: -0.06 })))); // P(ask)≈0.95
    const cloud = track(mockServer(() => json(cloudText("allow"))));
    const d = await chain(local.url, cloud.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(cloud.seen.length).toBe(0);
    expect(d.details.backend).toBe("chain");
    expect(d.details.escalated).toBe(false);
    expect(d.details.local_latency_ms).toBeGreaterThan(0);
    expect(d.details.cloud_latency_ms).toBeUndefined();
  });

  test("★ 本地置信度 < 阈值 → 升级,云端答案覆盖本地", async () => {
    const local = track(mockServer(() => json(llamaResponse("ask", { allow: -0.97, ask: -0.48 })))); // P(ask)≈0.62
    const cloud = track(mockServer(() => json(cloudText("allow"))));
    const d = await chain(local.url, cloud.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("allow");
    expect(d.confidence).toBeNull();
    expect(cloud.seen.length).toBe(1);
    expect(d.details.escalated).toBe(true);
    expect(d.details.local_verdict).toBe("ask");
    expect(d.details.local_confidence).toBeCloseTo(0.62, 1);
    expect(d.details.local_latency_ms).toBeGreaterThan(0);
    expect(d.details.cloud_latency_ms).toBeGreaterThan(0);
    expect(d.details.model_name).toBe("claude-x");
  });

  test("阈值 ≤ 0.5 等于关掉升级(温度 0 下 P(verdict) ≥ 0.5)", async () => {
    const local = track(mockServer(() => json(llamaResponse("ask", { allow: -0.7, ask: -0.69 })))); // ≈0.50
    const cloud = track(mockServer(() => json(cloudText("allow"))));
    const d = await chain(local.url, cloud.url, 0.5).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(cloud.seen.length).toBe(0);
  });

  test("本地算不出置信度(null)→ 升级", async () => {
    const local = track(mockServer(() => json(llamaResponse("ask", null))));
    const cloud = track(mockServer(() => json(cloudText("ask"))));
    const d = await chain(local.url, cloud.url).classify(request(), NO_ABORT);
    expect(cloud.seen.length).toBe(1);
    expect(d.details.escalated).toBe(true);
    expect(d.details.local_verdict).toBe("ask");
    expect(d.details.local_confidence).toBeUndefined();
  });
});

describe("失败路径", () => {
  test("★ 本地不可达 → 升级云端(本地优先、云端兜底)", async () => {
    const cloud = track(mockServer(() => json(cloudText("ask"))));
    const d = await chain("http://127.0.0.1:1", cloud.url).classify(request(), NO_ABORT);
    expect(d.verdict).toBe("ask");
    expect(d.details.escalated).toBe(true);
    expect(d.details.local_verdict).toBeUndefined();
  });

  test("★ 本地超时 → 不等满全局预算,升级云端", async () => {
    const local = track(mockServer(never));
    const cloud = track(mockServer(() => json(cloudText("allow"))));
    const b = chain(local.url, cloud.url, 0.75, 100, 1000);
    const t0 = performance.now();
    const d = await withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(d.verdict).toBe("allow");
    expect(d.details.escalated).toBe(true);
  });

  test("★ 云端失败 → 抛出去(管线降级 ask),不回退到本地答案", async () => {
    const local = track(mockServer(() => json(llamaResponse("allow", { allow: -0.97, ask: -0.48 })))); // 低置信 allow
    const cloud = track(mockServer(() => json({ error: "rate" }, 429)));
    await expect(chain(local.url, cloud.url).classify(request(), NO_ABORT)).rejects.toBeInstanceOf(ModelHttpError);
  });

  test("★ 云端超时 → 抛出去,总耗时不超过 local+cloud 预算", async () => {
    const local = track(mockServer(() => json(llamaResponse("allow", { allow: -0.97, ask: -0.48 }))));
    const cloud = track(mockServer(never));
    const b = chain(local.url, cloud.url, 0.75, 1000, 100);
    const t0 = performance.now();
    await expect(withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("chain 的总预算是 local+cloud(两段之和超过 5000 的配置在 schema 就被拒,见 config.test)", () => {
    expect(chain("http://x", "http://y", 0.75, 2000, 3000).timeoutMs).toBe(5000);
    expect(chain("http://x", "http://y", 0.75, 200, 1000).timeoutMs).toBe(1200);
  });

  test("★ 本地耗满自己的预算后,云端仍拿到配置里的完整预算,不是被挤剩的零头", async () => {
    const local = track(mockServer(never));
    let arrived = 0;
    const cloud = track(
      mockServer(() => {
        arrived = performance.now();
        return never();
      }),
    );
    const b = chain(local.url, cloud.url, 0.75, 200, 400);
    const t0 = performance.now();
    await expect(withDeadline(null, b.timeoutMs, (s) => b.classify(request(), s))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(arrived).toBeGreaterThan(t0);
    expect(performance.now() - arrived).toBeGreaterThan(350);
  });
});
