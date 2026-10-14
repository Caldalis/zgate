// 配置文件 `~/.zgate/config.json`。
//
// 只在守护进程启动时读一次;parse 失败拒绝启动。不存密钥,只存环境变量名。
// 文件不存在 = 空配置 = 不走模型(规则层判 SOFT 的直接 ask)。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { BACKEND_NAMES, MODEL_TIMEOUT_CAP_MS } from "./core/model.ts";

const TimeoutSchema = z.number().min(100).max(5000);

export const LocalConfigSchema = z.object({
  base_url: z.string(),
  timeout_ms: TimeoutSchema,
  model_name: z.string().optional(),
  // chat(默认):通用模型走 /v1/chat/completions;systemone:llama.cpp 的决策模型走 /v1/systemone
  api: z.enum(["chat", "systemone"]).optional(),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export const CloudConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  api_key_env: z.string(),
  base_url: z.string().optional(),
  model: z.string(),
  timeout_ms: TimeoutSchema,
});
export type CloudConfig = z.infer<typeof CloudConfigSchema>;

export const ChainConfigSchema = z
  .object({
    local: LocalConfigSchema,
    cloud: CloudConfigSchema,
    // P(verdict) < 阈值就升级云端。温度 0 下 P(verdict) ≥ 0.5,所以 ≤ 0.5 等于关掉升级
    escalation_threshold: z.number().min(0).max(1).default(0.75),
  })
  .superRefine((c, ctx) => {
    // chain 的总预算是两段之和且封顶 5000;超了云端就拿不到自己那份
    const sum = c.local.timeout_ms + c.cloud.timeout_ms;
    if (sum > MODEL_TIMEOUT_CAP_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["cloud", "timeout_ms"],
        message: `local.timeout_ms + cloud.timeout_ms = ${sum},超过 ${MODEL_TIMEOUT_CAP_MS}(hook 总超时),云端拿不到配置里写的预算`,
      });
    }
  });
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export const ModelConfigSchema = z
  .object({
    backend: z.enum(BACKEND_NAMES),
    local: LocalConfigSchema.optional(),
    cloud: CloudConfigSchema.optional(),
    chain: ChainConfigSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (m[m.backend] === undefined) {
      ctx.addIssue({ code: "custom", path: [m.backend], message: `backend 是 ${m.backend},但缺少 ${m.backend} 字段` });
    }
  });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ConfigSchema = z.object({
  model: ModelConfigSchema.optional(),
  /** journal 目录(按天分文件)。环境变量 ZGATE_JOURNAL_DIR 优先于它 */
  journal_path: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** `ZGATE_CONFIG` 覆盖,给测试和多份配置用。 */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env["ZGATE_CONFIG"] ?? join(homedir(), ".zgate", "config.json");
}

export function parseConfig(text: string, path = "config.json"): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} 不是合法 JSON(不支持注释)`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(顶层)"}: ${i.message}`);
    throw new ConfigError(`${path} 不符合配置 schema:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** 文件不存在返回空配置;读不了、不是 JSON、不符合 schema 一律抛 ConfigError。 */
export function loadConfig(path = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`无法读取 ${path}:${(err as Error).message}`);
  }
  return parseConfig(text, path);
}

/** 合法但可疑的配置。启动时打到 stderr,不拒绝。 */
export function configWarnings(config: Config): string[] {
  const out: string[] = [];
  const chain = config.model?.backend === "chain" ? config.model.chain : undefined;
  if (chain !== undefined && chain.escalation_threshold <= 0.5) {
    out.push(
      `chain.escalation_threshold = ${chain.escalation_threshold} 不高于 0.5:本地 P(裁决) 在温度 0 下恒 ≥ 0.5,` +
        `云端升级永远不会触发,行为等同 backend "local"。要升级请设 0.5 以上(默认 0.75)`,
    );
  }
  return out;
}
