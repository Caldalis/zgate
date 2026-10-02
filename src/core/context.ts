// Context:探针取到的环境事实。字段命名理由见 action.ts 顶部。

import { z } from "zod";

export const ResourceFactsSchema = z.object({
  raw: z.string(),
  resolved: z.string().nullable(), // realpath 之后
  exists: z.boolean(),
  is_symlink: z.boolean(),
  symlink_target: z.string().nullable(),
  is_dir: z.boolean(),
  inside_cwd: z.boolean(), // resolved 是否在 cwd 子树内
  inside_repo: z.boolean(), // resolved 是否在 git 工作区内
  gitignored: z.boolean().nullable(), // null = 未知/不适用
});
export type ResourceFacts = Readonly<z.infer<typeof ResourceFactsSchema>>;

export const RepoFactsSchema = z.object({
  is_repo: z.boolean(),
  root: z.string().nullable(),
  branch: z.string().nullable(),
  is_dirty: z.boolean().nullable(),
  default_branch: z.string().nullable(), // 尽力而为,取不到就 null
});
export type RepoFacts = Readonly<z.infer<typeof RepoFactsSchema>>;

export const ContextSchema = z.object({
  resources: z.array(ResourceFactsSchema),
  repo: RepoFactsSchema,
  env_hints: z.record(z.string(), z.string()), // 白名单,见 enrichers/index.ts
  elapsed_ms: z.number(),
});
export type Context = Readonly<z.infer<typeof ContextSchema>>;
