// 仓库根的 `.zgatepolicy`:发现、读取、scope 解析、缓存。
//
// 整个文件是给模型看的自然语言,唯一的结构是 `scope: <仓库相对路径>` 行,不是 DSL。
// 只认 git 仓库根,不找 cwd、父目录或 ~/.zgate/;软链接当不存在(恶意仓库可以把它
// 链到 ~/.ssh/id_rsa,文件内容会进 prompt);只读前 4096 字节。

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

export const POLICY_FILENAME = ".zgatepolicy";
export const MAX_POLICY_BYTES = 4096;
/** 与 git 探针一致。 */
const CACHE_TTL_MS = 3000;
const CACHE_MAX = 256;

export interface ScopeEntry {
  /** 归一化后的条目(去掉开头 `./` 与结尾 `/`),进 reason 与 journal */
  readonly entry: string;
  /** 比路径用的绝对位置:join(root, entry);条目本身是软链接时再加它的 realpath */
  readonly paths: readonly string[];
}

export interface Policy {
  readonly path: string;
  /** 截断后的文本,原样进 prompt */
  readonly text: string;
  readonly scope: readonly ScopeEntry[];
  /** 截断后文本的 sha256 */
  readonly sha256: string;
  /** 文件实际大小 */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/**
 * journal 顶层的可选字段 `policy`:策略在场时写,不管最后是 PASS 还是 SOFT。
 * 策略文本不进日志:sha256 足以对回仓库里那个版本。字段 snake_case。
 */
export const PolicyDetailsSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  truncated: z.literal(true).optional(),
  scope_hit: z.array(z.string()).optional(),
});
export type PolicyDetails = Readonly<z.infer<typeof PolicyDetailsSchema>>;

export function policyDetails(policy: Policy, scopeHit: readonly string[]): PolicyDetails {
  return {
    path: policy.path,
    sha256: policy.sha256,
    bytes: policy.bytes,
    ...(policy.truncated ? { truncated: true } : {}),
    ...(scopeHit.length > 0 ? { scope_hit: [...scopeHit] } : {}),
  };
}

/** `scope:` 顶格(允许前导空白)、小写;`Scope:` 或行中间的 `scope:` 只是文字。 */
const SCOPE_LINE = /^\s*scope:(.*)$/;

function invalidReason(raw: string): string | null {
  if (raw === "") return "为空";
  if (isAbsolute(raw) || raw.startsWith("/")) return "绝对路径";
  if (raw.includes("..")) return "含 ..";
  if (/[*?[{]/.test(raw)) return "含通配符(v1 不做 glob,写目录)";
  return null;
}

function normalizeEntry(raw: string): string {
  let e = raw.replace(/\/+$/, "");
  while (e.startsWith("./")) e = e.slice(2);
  return e === "" ? "." : e;
}

export function parseScope(text: string, root: string): { scope: ScopeEntry[]; warnings: string[] } {
  const scope: ScopeEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = SCOPE_LINE.exec(line);
    if (m === null) continue;
    const raw = (m[1] ?? "").trim();
    const why = invalidReason(raw);
    if (why !== null) {
      warnings.push(`忽略 scope 条目 "${raw}":${why}`);
      continue;
    }
    const entry = normalizeEntry(raw);
    if (seen.has(entry)) continue;
    seen.add(entry);
    const abs = join(root, entry);
    const paths = [abs];
    try {
      const real = realpathSync(abs);
      if (real !== abs) paths.push(real);
    } catch {
      // 还不存在:按预期落点和 abs 比
    }
    scope.push({ entry, paths });
  }
  return { scope, warnings };
}

function readPolicyFile(path: string, root: string): { policy: Policy | null; warnings: string[] } {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { policy: null, warnings: [] };
  }
  if (st.isSymbolicLink()) return { policy: null, warnings: [`策略文件 ${path} 是软链接,按不存在处理`] };
  if (!st.isFile()) return { policy: null, warnings: [`策略文件 ${path} 不是普通文件,按不存在处理`] };

  let bytes: number;
  let chunk: Buffer;
  const fd = openSync(path, "r");
  try {
    bytes = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(MAX_POLICY_BYTES);
    const n = readSync(fd, buf, 0, MAX_POLICY_BYTES, 0);
    chunk = buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
  const truncated = bytes > MAX_POLICY_BYTES;
  // stream: true 会吞掉末尾不完整的多字节序列,截断处不出现替换字符
  const text = new TextDecoder("utf-8").decode(chunk, { stream: truncated });
  const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const parsed = parseScope(text, root);
  const warnings = [...parsed.warnings];
  if (truncated) warnings.push(`策略文件超过 ${MAX_POLICY_BYTES} 字节(共 ${bytes}),只读前 ${MAX_POLICY_BYTES} 字节`);
  return { policy: { path, text, scope: parsed.scope, sha256, bytes, truncated, warnings }, warnings };
}

interface Entry {
  readonly at: number;
  readonly policy: Policy | null;
}

const cache = new Map<string, Entry>();
const warned = new Set<string>();

/**
 * 仓库根的策略。root 为 null(不在仓库里)→ null。按 root 缓存 3 秒,热路径是一次 Map 查找。
 * 警告(软链接、截断、非法条目)每个 path+sha 只打一次 stderr。
 */
export function loadPolicy(root: string | null): Policy | null {
  if (root === null) return null;
  const now = Date.now();
  const hit = cache.get(root);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.policy;

  const path = join(root, POLICY_FILENAME);
  const { policy, warnings } = readPolicyFile(path, root);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(root, { at: now, policy });

  const key = `${path}\0${policy?.sha256 ?? "-"}`;
  if (warnings.length > 0 && !warned.has(key)) {
    warned.add(key);
    for (const w of warnings) process.stderr.write(`策略警告:${w}\n`);
  }
  return policy;
}

/** 测试用。 */
export function clearPolicyCache(): void {
  cache.clear();
}

/** 测试用:让警告可以再打一次。 */
export function resetPolicyWarnings(): void {
  warned.clear();
}
