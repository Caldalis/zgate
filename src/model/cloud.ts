// 云端后端:Anthropic Messages API 或任何 OpenAI-compatible 服务。
//
// 密钥从环境变量读,配置文件只存变量名;变量缺失在构造时就报错,让 serve 拒绝启动,
// 而不是每次调用都 401 然后静默降级。
//
// 云端没有 grammar,所以用两家各自的结构化输出让服务端把回答约束成
// `{"verdict": "allow" | "ask"}`。解析是严格的:整段回复必须是这一个 JSON 对象。
// 格式不对就重新生成,最多 MAX_ATTEMPTS 次;超过按格式错误抛出,管线降级为 ask。
// 5xx / 网络错误重试一次,4xx / 429 不重试。置信度恒为 null。

import { ConfigError, type CloudConfig } from "../config.ts";
import {
  ModelFormatError,
  ModelHttpError,
  isAbortError,
  type ModelBackend,
  type ModelDecision,
  type ModelRequest,
  type ModelVerdict,
} from "../core/model.ts";
import { t } from "../i18n.ts";
import { chatMessages, parseVerdictJson, systemPrompt, userPrompt } from "./prompt.ts";

const DEFAULT_BASE_URL: Record<CloudConfig["provider"], string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** 格式不对时重新生成的上限(含第一次)。 */
export const MAX_ATTEMPTS = 5;

/** 两家共用的 JSON schema:一个对象,一个枚举字段,不许多余键。 */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["allow", "ask"] } },
  required: ["verdict"],
  additionalProperties: false,
} as const;

export class CloudBackend implements ModelBackend {
  readonly name = "cloud";
  readonly timeoutMs: number;
  readonly model: string;
  private readonly provider: CloudConfig["provider"];
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: CloudConfig, env: Record<string, string | undefined> = process.env) {
    const key = env[cfg.api_key_env];
    if (key === undefined || key === "") {
      const name = cfg.api_key_env;
      throw new ConfigError(t(`环境变量 ${name} 未设置(cloud.api_key_env 指向它)`, `environment variable ${name} is not set (cloud.api_key_env names it)`));
    }
    this.apiKey = key;
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.timeoutMs = cfg.timeout_ms;
    this.baseUrl = (cfg.base_url ?? DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, "");
  }

  async classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision> {
    const started = performance.now();
    let verdict: ModelVerdict | null = null;
    let lastFormat: ModelFormatError | null = null;
    let attempts = 0;

    while (verdict === null && attempts < MAX_ATTEMPTS && !signal.aborted) {
      attempts += 1;
      try {
        verdict = await this.once(req, signal);
      } catch (err) {
        if (err instanceof ModelFormatError) {
          lastFormat = err; // 格式不对:换一次生成
          continue;
        }
        if (!retryable(err) || signal.aborted) throw err;
        verdict = await this.once(req, signal); // 5xx / 网络错误:只多试这一次
      }
    }
    if (verdict === null) {
      throw lastFormat ?? new ModelFormatError(t(`云端 ${attempts} 次都没给出合法裁决`, `cloud model gave no valid verdict in ${attempts} attempts`));
    }

    const latency = performance.now() - started;
    return {
      verdict,
      confidence: null,
      latency_ms: latency,
      details: {
        backend: "cloud",
        model_name: this.model,
        cloud_latency_ms: latency,
        ...(attempts > 1 ? { attempts } : {}),
      },
    };
  }

  private async once(req: ModelRequest, signal: AbortSignal): Promise<ModelVerdict> {
    const text = this.provider === "anthropic" ? await this.anthropic(req, signal) : await this.openai(req, signal);
    const verdict = parseVerdictJson(text);
    if (verdict === null) {
      const got = JSON.stringify(text).slice(0, 80);
      throw new ModelFormatError(t(`云端模型输出不是 {"verdict": allow|ask}:${got}`, `cloud model output is not {"verdict": allow|ask}: ${got}`));
    }
    return verdict;
  }

  /** Messages API 的结构化输出:`output_config.format`,GA、无 beta 头,JSON 落在 text block 里。 */
  private async anthropic(req: ModelRequest, signal: AbortSignal): Promise<string> {
    const body = await this.post(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 64,
        system: systemPrompt(req),
        messages: [{ role: "user", content: userPrompt(req) }],
        output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      },
      signal,
    );
    const blocks = (body as { content?: { type?: string; text?: unknown }[] })?.content;
    const text = blocks?.find((b) => b.type === "text")?.text;
    if (typeof text !== "string") throw new ModelFormatError(t("Anthropic 响应里没有 text block", "Anthropic response has no text block"));
    return text;
  }

  /**
   * Chat Completions 的 `response_format: json_schema`;llama-server 等兼容实现也认这个形状。
   * `chat_template_kwargs` 是 llama-server 的扩展:不关 thinking 的话 Qwen3.5 会把 max_tokens
   * 全花在 reasoning_content 里,content 是空串。标准 OpenAI 忽略未知键。
   */
  private async openai(req: ModelRequest, signal: AbortSignal): Promise<string> {
    const body = await this.post(
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: 64,
        messages: chatMessages(req),
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA },
        },
      },
      signal,
    );
    const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new ModelFormatError(t("响应缺 choices[0].message.content", "response lacks choices[0].message.content"));
    }
    return text;
  }

  private async post(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      signal,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new ModelHttpError(res.status, t(`${this.provider} 回 ${res.status}`, `${this.provider} returned ${res.status}`));
    try {
      return await res.json();
    } catch {
      throw new ModelFormatError(t(`${this.provider} 回的不是 JSON`, `${this.provider} did not return JSON`));
    }
  }
}

/** 5xx 与网络错误重试一次;4xx / 429 / 超时 / 格式错误不走这条重试。 */
export function retryable(err: unknown): boolean {
  if (err instanceof ModelHttpError) return err.status >= 500;
  if (err instanceof ModelFormatError) return false;
  return !isAbortError(err);
}
