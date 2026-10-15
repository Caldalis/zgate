// createBackend 工厂。管线只拿 ModelBackend,后端名只在这里出现。

import { ConfigError, type ModelConfig } from "../config.ts";
import type { ModelBackend } from "../core/model.ts";
import { t } from "../i18n.ts";
import { ChainBackend } from "./chain.ts";
import { CloudBackend } from "./cloud.ts";
import { LocalBackend } from "./local.ts";

function missing(name: string): ConfigError {
  return new ConfigError(t(`backend 是 ${name},缺 ${name} 字段`, `backend is ${name} but the ${name} field is missing`));
}

export function createBackend(
  config: ModelConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ModelBackend | null {
  if (config === undefined) return null;
  switch (config.backend) {
    case "local":
      if (config.local === undefined) throw missing("local");
      return new LocalBackend(config.local);
    case "cloud":
      if (config.cloud === undefined) throw missing("cloud");
      return new CloudBackend(config.cloud, env);
    case "chain":
      if (config.chain === undefined) throw missing("chain");
      return new ChainBackend(config.chain, env);
  }
}

export { LocalBackend, CloudBackend, ChainBackend };
