// SPEC.md §5.5 —— createBackend 工厂。管线只拿 ModelBackend,后端名只在这里出现。

import { ConfigError, type ModelConfig } from "../config.ts";
import type { ModelBackend } from "../core/model.ts";
import { ChainBackend } from "./chain.ts";
import { CloudBackend } from "./cloud.ts";
import { LocalBackend } from "./local.ts";

export function createBackend(
  config: ModelConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ModelBackend | null {
  if (config === undefined) return null;
  switch (config.backend) {
    case "local":
      if (config.local === undefined) throw new ConfigError("backend 是 local,缺 local 字段");
      return new LocalBackend(config.local);
    case "cloud":
      if (config.cloud === undefined) throw new ConfigError("backend 是 cloud,缺 cloud 字段");
      return new CloudBackend(config.cloud, env);
    case "chain":
      if (config.chain === undefined) throw new ConfigError("backend 是 chain,缺 chain 字段");
      return new ChainBackend(config.chain, env);
  }
}

export { LocalBackend, CloudBackend, ChainBackend };
