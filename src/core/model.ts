// 模型层接口。管线只认 ModelBackend:拿到就问,拿到 null 就只用规则层的结论。
// 后端选哪个、怎么配,全在 src/model/index.ts 的工厂里,管线代码里不出现具体后端的名字。

import { z } from "zod";

import type { Action } from "./action.ts";
import type { Context } from "./context.ts";
import { t } from "../i18n.ts";
import type { Policy } from "../policy.ts";

export const BACKEND_NAMES = ["local", "cloud", "chain"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** 统一封顶 5000ms(Claude Code hook 的超时)。 */
export const MODEL_TIMEOUT_CAP_MS = 5000;

/** 模型只在这两者间选,不返回 deny。 */
export type ModelVerdict = "allow" | "ask";

/** journal 顶层的可选字段 `model_details`(snake_case)。 */
export const ModelDetailsSchema = z.object({
  backend: z.enum(BACKEND_NAMES),
  model_name: z.string().optional(),
  local_latency_ms: z.number().optional(),
  cloud_latency_ms: z.number().optional(),
  escalated: z.boolean().optional(),
  // chain 升级后最终裁决是云端的,本地那次的答案单独留着,事后才能算"云端推翻了本地多少次"
  local_verdict: z.enum(["allow", "ask"]).optional(),
  local_confidence: z.number().optional(),
  /** 模型段失败的原因;有它就说明这条是降级。rejected = HTTP 4xx(含 429) */
  error: z.enum(["timeout", "unreachable", "rejected", "format"]).optional(),
  http_status: z.number().optional(),
  /** 云端为拿到合法格式实际生成的次数;只在 > 1 时写 */
  attempts: z.number().optional(),
});
export type ModelDetails = Readonly<z.infer<typeof ModelDetailsSchema>>;

/** 随请求附上的仓库策略:文本进 system 前缀,命中的 scope 条目进 user JSON。 */
export interface PolicyAttachment {
  readonly policy: Policy;
  readonly scopeHit: readonly string[];
}

export interface ModelRequest {
  readonly action: Action;
  readonly context: Context;
  /** 规则层命中的 rule_id,进 prompt 的 flagged_rule */
  readonly flaggedRule: string | null;
  /**
   * 由管线决定:只在 flaggedRule === "policy.scope"(这条调用是 SOFT 仅仅因为策略)时非 null。
   * 其余 SOFT 的策略文本不进模型输入,prompt 与无策略时逐字节相同。
   */
  readonly policy: PolicyAttachment | null;
}

export interface ModelDecision {
  readonly verdict: ModelVerdict;
  /** P(verdict),0–1。云端不算,为 null */
  readonly confidence: number | null;
  readonly latency_ms: number;
  readonly details: ModelDetails;
}

export interface ModelBackend {
  readonly name: BackendName;
  /** 管线给这次 classify 的总预算(ms),从配置来 */
  readonly timeoutMs: number;
  /** 超时 / 不可达 / 格式错误一律抛异常,由管线降级 */
  classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision>;
}

/** 模型返回的东西不是 allow / ask,或缺少必需字段。 */
export class ModelFormatError extends Error {
  override readonly name = "ModelFormatError";
}

/** HTTP 非 2xx。status 决定重不重试。 */
export class ModelHttpError extends Error {
  override readonly name = "ModelHttpError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * 在 parent 之上再加一个 ms 的期限。用 AbortController 而不是 Promise.race:
 * fn 拿到的 signal 到期就 abort,fetch 会真的断开,不泄漏请求。
 */
export async function withDeadline<T>(
  parent: AbortSignal | null,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent !== null) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException(t(`模型超时(${ms}ms)`, `model timed out (${ms}ms)`), "TimeoutError")),
    ms,
  );
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
