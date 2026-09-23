// SPEC.md §5.3 —— 配置文件与 createBackend 工厂。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, ConfigSchema, configPath, loadConfig, parseConfig } from "../src/config.ts";
import { ChainBackend, CloudBackend, LocalBackend, createBackend } from "../src/model/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpFile(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), "zgate-cfg-"));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}

describe("§5.3 schema", () => {
  test("三种后端的示例配置都合法", () => {
    expect(ConfigSchema.safeParse({ model: { backend: "local", local: { base_url: "http://127.0.0.1:8899", timeout_ms: 2000, model_name: "qwen35-9b" } } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ model: { backend: "cloud", cloud: { provider: "anthropic", api_key_env: "ANTHROPIC_API_KEY", model: "claude-x", timeout_ms: 3000 } } }).success).toBe(true);
    expect(
      ConfigSchema.safeParse({
        model: {
          backend: "chain",
          chain: {
            local: { base_url: "http://127.0.0.1:8899", timeout_ms: 2000 },
            cloud: { provider: "openai", api_key_env: "OPENAI_API_KEY", model: "gpt-x", timeout_ms: 3000 },
            escalation_threshold: 0.75,
          },
        },
      }).success,
    ).toBe(true);
  });

  test("空对象合法(= M1 行为)", () => {
    expect(ConfigSchema.safeParse({}).success).toBe(true);
    expect(parseConfig("{}").model).toBeUndefined();
  });

  test("★ timeout_ms 必须在 100–5000 之间(§3.2 的 5000 封顶)", () => {
    const mk = (t: number) => ({ model: { backend: "local", local: { base_url: "http://x", timeout_ms: t } } });
    expect(ConfigSchema.safeParse(mk(99)).success).toBe(false);
    expect(ConfigSchema.safeParse(mk(5001)).success).toBe(false);
    expect(ConfigSchema.safeParse(mk(100)).success).toBe(true);
    expect(ConfigSchema.safeParse(mk(5000)).success).toBe(true);
  });

  test("★ backend 指向的字段必须存在", () => {
    expect(ConfigSchema.safeParse({ model: { backend: "cloud" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ model: { backend: "local", cloud: { provider: "openai", api_key_env: "K", model: "m", timeout_ms: 1000 } } }).success).toBe(false);
  });

  test("escalation_threshold 缺省 0.75,范围 0–1", () => {
    const base = { local: { base_url: "http://x", timeout_ms: 1000 }, cloud: { provider: "openai", api_key_env: "K", model: "m", timeout_ms: 1000 } };
    const parsed = ConfigSchema.parse({ model: { backend: "chain", chain: base } });
    expect(parsed.model?.chain?.escalation_threshold).toBe(0.75);
    expect(ConfigSchema.safeParse({ model: { backend: "chain", chain: { ...base, escalation_threshold: 1.5 } } }).success).toBe(false);
  });

  test("provider 只认 anthropic / openai;backend 只认三种", () => {
    expect(ConfigSchema.safeParse({ model: { backend: "cloud", cloud: { provider: "gemini", api_key_env: "K", model: "m", timeout_ms: 1000 } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ model: { backend: "llama" } }).success).toBe(false);
  });

  test("★ 配置里不该出现密钥字段,只有变量名(schema 没有 api_key)", () => {
    const parsed = ConfigSchema.parse({ model: { backend: "cloud", cloud: { provider: "anthropic", api_key_env: "K", model: "m", timeout_ms: 1000, api_key: "sk-leak" } } });
    expect((parsed.model?.cloud as Record<string, unknown>)["api_key"]).toBeUndefined();
  });
});

describe("读取", () => {
  test("文件不存在 → 空配置,不抛", () => {
    expect(loadConfig("/definitely/not/here/config.json")).toEqual({});
  });

  test("★ 不是 JSON → ConfigError,信息里带路径", () => {
    const p = tmpFile("config.json", "{ backend: local }");
    expect(() => loadConfig(p)).toThrow(ConfigError);
    expect(() => loadConfig(p)).toThrow(p);
  });

  test("★ 不符合 schema → ConfigError,信息里指出字段", () => {
    const p = tmpFile("config.json", JSON.stringify({ model: { backend: "local", local: { base_url: "http://x", timeout_ms: 9999 } } }));
    expect(() => loadConfig(p)).toThrow(/timeout_ms/);
  });

  test("合法文件读出来与 schema 一致", () => {
    const p = tmpFile("config.json", JSON.stringify({ model: { backend: "local", local: { base_url: "http://x", timeout_ms: 2000 } }, journal_path: "/tmp/j" }));
    const c = loadConfig(p);
    expect(c.model?.backend).toBe("local");
    expect(c.journal_path).toBe("/tmp/j");
  });

  test("路径:ZGATE_CONFIG 覆盖,默认 ~/.zgate/config.json", () => {
    expect(configPath({ ZGATE_CONFIG: "/x/c.json" })).toBe("/x/c.json");
    expect(configPath({})).toMatch(/\.zgate\/config\.json$/);
  });
});

describe("createBackend 工厂", () => {
  test("没配 model → null", () => {
    expect(createBackend(undefined)).toBeNull();
  });

  test("按 backend 字段建对应实例,超时从各自配置读", () => {
    const local = createBackend({ backend: "local", local: { base_url: "http://x", timeout_ms: 1234 } });
    expect(local).toBeInstanceOf(LocalBackend);
    expect(local?.timeoutMs).toBe(1234);

    const cloud = createBackend({ backend: "cloud", cloud: { provider: "anthropic", api_key_env: "K", model: "m", timeout_ms: 3000 } }, { K: "sk" });
    expect(cloud).toBeInstanceOf(CloudBackend);
    expect(cloud?.timeoutMs).toBe(3000);

    const chain = createBackend(
      { backend: "chain", chain: { local: { base_url: "http://x", timeout_ms: 2000 }, cloud: { provider: "openai", api_key_env: "K", model: "m", timeout_ms: 3000 }, escalation_threshold: 0.75 } },
      { K: "sk" },
    );
    expect(chain).toBeInstanceOf(ChainBackend);
    expect(chain?.timeoutMs).toBe(5000);
  });

  test("★ cloud 的环境变量缺失 → ConfigError(启动即失败,不是运行时静默降级)", () => {
    expect(() => createBackend({ backend: "cloud", cloud: { provider: "anthropic", api_key_env: "NOPE", model: "m", timeout_ms: 3000 } }, {})).toThrow(ConfigError);
  });
});
