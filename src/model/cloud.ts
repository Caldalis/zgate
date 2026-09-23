// SPEC.md §5.2 B —— 云端后端:Anthropic Messages API 或任何 OpenAI-compatible 服务。
//
// 密钥从环境变量读,配置文件只存变量名;变量缺失在构造时就报错,让 serve 拒绝启动,
// 而不是每次调用都 401 然后静默降级。
// 5xx / 网络错误重试一次,4xx / 429 不重试(§5.2 B.2)。置信度恒 null(§5.2 B.3)。

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
import { SYSTEM_PROMPT, chatMessages, parseVerdictWord, userPrompt } from "./prompt.ts";

const DEFAULT_BASE_URL: Record<CloudConfig["provider"], string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

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
      throw new ConfigError(`环境变量 ${cfg.api_key_env} 未设置(cloud.api_key_env 指向它)`);
    }
    this.apiKey = key;
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.timeoutMs = cfg.timeout_ms;
    this.baseUrl = (cfg.base_url ?? DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, "");
  }

  async classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision> {
    const started = performance.now();
    let verdict: ModelVerdict;
    try {
      verdict = await this.once(req, signal);
    } catch (err) {
      if (!retryable(err) || signal.aborted) throw err;
      verdict = await this.once(req, signal);
    }
    const latency = performance.now() - started;
    return {
      verdict,
      confidence: null,
      latency_ms: latency,
      details: { backend: "cloud", model_name: this.model, cloud_latency_ms: latency },
    };
  }

  private async once(req: ModelRequest, signal: AbortSignal): Promise<ModelVerdict> {
    const text = this.provider === "anthropic" ? await this.anthropic(req, signal) : await this.openai(req, signal);
    const verdict = parseVerdictWord(text);
    if (verdict === null) throw new ModelFormatError(`云端模型输出里没有 allow/ask:${JSON.stringify(text).slice(0, 80)}`);
    return verdict;
  }

  private async anthropic(req: ModelRequest, signal: AbortSignal): Promise<string> {
    const body = await this.post(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 16,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(req) }],
        thinking: { type: "disabled" },
      },
      signal,
    );
    const blocks = (body as { content?: { type?: string; text?: unknown }[] })?.content;
    const text = blocks?.find((b) => b.type === "text")?.text;
    if (typeof text !== "string") throw new ModelFormatError("Anthropic 响应里没有 text block");
    return text;
  }

  private async openai(req: ModelRequest, signal: AbortSignal): Promise<string> {
    const body = await this.post(
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, messages: chatMessages(req) },
      signal,
    );
    const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new ModelFormatError("响应缺 choices[0].message.content");
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
    if (!res.ok) throw new ModelHttpError(res.status, `${this.provider} 回 ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ModelFormatError(`${this.provider} 回的不是 JSON`);
    }
  }
}

/** §5.2 B.2:5xx 与网络错误重试一次;4xx / 429 / 超时 / 格式错误不重试。 */
export function retryable(err: unknown): boolean {
  if (err instanceof ModelHttpError) return err.status >= 500;
  if (err instanceof ModelFormatError) return false;
  return !isAbortError(err);
}
