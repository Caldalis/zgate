// SPEC.md §5.2 C —— chain:本地先判,P(verdict) 低于阈值就升级云端,云端答案是终局。
//
// 云端失败不回退到本地答案(那个答案置信度已经不够了),抛出去让管线降级到 ask。
// 本地本身失败(超时 / 不可达)也升级到云端 —— chain 的意思就是"本地优先、云端兜底"。

import type { ChainConfig } from "../config.ts";
import {
  MODEL_TIMEOUT_CAP_MS,
  withDeadline,
  type ModelBackend,
  type ModelDecision,
  type ModelRequest,
} from "../core/model.ts";
import { CloudBackend } from "./cloud.ts";
import { LocalBackend } from "./local.ts";

export class ChainBackend implements ModelBackend {
  readonly name = "chain";
  readonly timeoutMs: number;
  readonly threshold: number;
  readonly local: ModelBackend;
  readonly cloud: ModelBackend;

  constructor(cfg: ChainConfig, env: Record<string, string | undefined> = process.env) {
    this.local = new LocalBackend(cfg.local);
    this.cloud = new CloudBackend(cfg.cloud, env);
    this.threshold = cfg.escalation_threshold;
    this.timeoutMs = Math.min(MODEL_TIMEOUT_CAP_MS, cfg.local.timeout_ms + cfg.cloud.timeout_ms);
  }

  async classify(req: ModelRequest, signal: AbortSignal): Promise<ModelDecision> {
    const started = performance.now();
    let local: ModelDecision | null = null;
    try {
      local = await withDeadline(signal, this.local.timeoutMs, (s) => this.local.classify(req, s));
    } catch (err) {
      if (signal.aborted) throw err;
    }

    const confident = local !== null && local.confidence !== null && local.confidence >= this.threshold;
    if (local !== null && confident) {
      return { ...local, details: { ...local.details, backend: "chain", escalated: false } };
    }

    const localMs = performance.now() - started;
    const remaining = Math.min(this.cloud.timeoutMs, this.timeoutMs - localMs);
    const cloud = await withDeadline(signal, Math.max(1, remaining), (s) => this.cloud.classify(req, s));
    return {
      verdict: cloud.verdict,
      confidence: null,
      latency_ms: performance.now() - started,
      details: {
        ...cloud.details,
        backend: "chain",
        escalated: true,
        local_latency_ms: localMs,
        ...(local === null
          ? {}
          : {
              local_verdict: local.verdict,
              ...(local.confidence === null ? {} : { local_confidence: local.confidence }),
            }),
      },
    };
  }
}
