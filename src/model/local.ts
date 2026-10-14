// 本地 GGUF 后端:只是 llama-server 的一个 HTTP 客户端。不启动、不停止、不检查健康。
//
// api 分两种:
// - chat(默认):走 /v1/chat/completions 让服务器渲染模型自己的 chat template,关 thinking,
//   grammar 约束只许输出 allow / ask。
// - systemone:llama.cpp 的决策模型,一次 /v1/systemone 给 allow / ask 两个选项打分,不生成文字。
//
// chat 的置信度:llama.cpp 报的 logprob 是采样前的原始分布,所以自由生成那次开 logprobs
// 读到的两个词的 logprob 与强制续写相同。先读 top_logprobs;两个词不全在里面
// (多 token 词、别的 tokenizer)才退回强制续写,多花两次往返。

import type { LocalConfig } from "../config.ts";
import {
  ModelFormatError,
  ModelHttpError,
  type ModelBackend,
  type ModelDecision,
  type ModelRequest,
  type ModelVerdict,
} from "../core/model.ts";
import { chatMessages, decisionQuestion, parseExactVerdict, userPrompt, type ChatMessage } from "./prompt.ts";

const GRAMMAR_FREE = 'root ::= ("allow" | "ask")';
const grammarForce = (w: ModelVerdict): string => `root ::= "${w}"`;

interface TopLogprob {
  readonly token?: string;
  readonly logprob?: number;
}
interface LogprobEntry extends TopLogprob {
  readonly top_logprobs?: readonly TopLogprob[];
}
interface Completion {
  readonly content: string;
  /** 第一个非空 token 及其候选;服务器没给 logprobs 时为 null */
  readonly first: LogprobEntry | null;
}
interface Judged {
  readonly verdict: ModelVerdict;
  readonly confidence: number | null;
}

/** P(verdict):两个 logprob 做 softmax,取裁决对应的那个。 */
export function confidenceOf(verdict: ModelVerdict, lpAllow: number, lpAsk: number): number {
  const pAllow = 1 / (1 + Math.exp(lpAsk - lpAllow));
  return verdict === "allow" ? pAllow : 1 - pAllow;
}

export class LocalBackend implements ModelBackend {
  readonly name = "local";
  readonly timeoutMs: number;
  readonly api: "chat" | "systemone";
  private readonly baseUrl: string;
  private readonly modelName: string | undefined;

  constructor(cfg: LocalConfig) {
    this.baseUrl = cfg.base_url.replace(/\/+$/, "");
    this.timeoutMs = cfg.timeout_ms;
    this.modelName = cfg.model_name;
    this.api = cfg.api ?? "chat";
  }

  async classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision> {
    const started = performance.now();
    const { verdict, confidence } = this.api === "systemone" ? await this.decide(req, signal) : await this.chat(req, signal);
    const latency = performance.now() - started;
    return {
      verdict,
      confidence,
      latency_ms: latency,
      details: {
        backend: "local",
        ...(this.modelName === undefined ? {} : { model_name: this.modelName }),
        local_latency_ms: latency,
      },
    };
  }

  private async chat(req: ModelRequest, signal: AbortSignal): Promise<Judged> {
    const messages = chatMessages(req);
    const free = await this.complete(messages, GRAMMAR_FREE, 10, signal);
    const verdict = parseExactVerdict(free.content);
    if (verdict === null) {
      throw new ModelFormatError(`本地模型输出不是 allow/ask:${JSON.stringify(free.content).slice(0, 80)}`);
    }

    let lp = wordLogprobs(free.first);
    if (lp.allow === undefined || lp.ask === undefined) {
      lp = await this.forced(messages, signal);
    }
    const confidence =
      lp.allow === undefined || lp.ask === undefined ? null : confidenceOf(verdict, lp.allow, lp.ask);
    return { verdict, confidence };
  }

  /** 决策模型:两个选项的概率和为 1,choice 那个的概率就是 P(verdict)。 */
  private async decide(req: ModelRequest, signal: AbortSignal): Promise<Judged> {
    const body = await this.post(
      "/v1/systemone",
      { state: userPrompt(req), questions: { verdict: decisionQuestion(req) } },
      signal,
    );
    const answer = (body as { answers?: { verdict?: { choice?: unknown; probabilities?: Record<string, unknown> } } })
      ?.answers?.verdict;
    const verdict = answer?.choice;
    if (verdict !== "allow" && verdict !== "ask") {
      throw new ModelFormatError(`决策模型的 choice 不是 allow/ask:${JSON.stringify(verdict ?? null).slice(0, 80)}`);
    }
    const p = answer?.probabilities?.[verdict];
    return { verdict, confidence: typeof p === "number" && p >= 0 && p <= 1 ? p : null };
  }

  /** 强制续写:allow / ask 各强制一次,读被强制 token 的 logprob。 */
  private async forced(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): Promise<{ allow?: number; ask?: number }> {
    const out: { allow?: number; ask?: number } = {};
    for (const w of ["allow", "ask"] as const) {
      const r = await this.complete(messages, grammarForce(w), 1, signal);
      const lp = r.first?.logprob;
      if (typeof lp === "number") out[w] = lp;
    }
    return out;
  }

  private async complete(
    messages: readonly ChatMessage[],
    grammar: string,
    topLogprobs: number,
    signal: AbortSignal,
  ): Promise<Completion> {
    const body = await this.post(
      "/v1/chat/completions",
      {
        messages,
        chat_template_kwargs: { enable_thinking: false },
        grammar,
        max_tokens: 4,
        temperature: 0,
        cache_prompt: true,
        logprobs: true,
        top_logprobs: topLogprobs,
      },
      signal,
    );
    const choice = (body as { choices?: unknown[] })?.choices?.[0] as
      | { message?: { content?: unknown }; logprobs?: { content?: LogprobEntry[] } | null }
      | undefined;
    const content = choice?.message?.content;
    if (typeof content !== "string") throw new ModelFormatError("llama-server 响应缺 choices[0].message.content");
    const first = choice?.logprobs?.content?.find((e) => (e.token ?? "").trim() !== "") ?? null;
    return { content, first };
  }

  private async post(path: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new ModelHttpError(res.status, `llama-server 回 ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ModelFormatError("llama-server 回的不是 JSON");
    }
  }
}

/** 从第一个 token 及其候选里取 allow / ask 各自的 logprob(按去空白后精确匹配)。 */
function wordLogprobs(first: LogprobEntry | null): { allow?: number; ask?: number } {
  const out: { allow?: number; ask?: number } = {};
  if (first === null) return out;
  const take = (t: TopLogprob): void => {
    const w = (t.token ?? "").trim();
    if ((w === "allow" || w === "ask") && typeof t.logprob === "number" && out[w] === undefined) out[w] = t.logprob;
  };
  take(first);
  for (const t of first.top_logprobs ?? []) take(t);
  return out;
}
