// spec-m3 §2 —— 策略加载器。真实文件系统(D7.10),不 mock。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_POLICY_BYTES, POLICY_FILENAME, clearPolicyCache, loadPolicy, parseScope, resetPolicyWarnings } from "../src/policy.ts";

let root: string;
let stderr: ReturnType<typeof spyOn>;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zgate-policy-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  clearPolicyCache();
  resetPolicyWarnings();
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => stderr.mockRestore());

let n = 0;
function repo(content?: string): string {
  const dir = join(root, `r${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  if (content !== undefined) writeFileSync(join(dir, POLICY_FILENAME), content);
  return dir;
}
const warningsPrinted = (): string[] => stderr.mock.calls.map((c: readonly unknown[]) => String(c[0]));
const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

const SAMPLE = "# 边界\n- 不要动 migrations/ 下的任何文件。\n\nscope: migrations/\nscope: ./config/production/\n  scope: infra\nscope: prod-db.internal\n";

describe("发现", () => {
  test("root 为 null → null;没有文件 → null,都不打警告", () => {
    expect(loadPolicy(null)).toBeNull();
    expect(loadPolicy(repo())).toBeNull();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("普通文件:path / text 原样 / bytes / sha256 / 不截断", () => {
    const dir = repo(SAMPLE);
    const p = loadPolicy(dir);
    expect(p).not.toBeNull();
    expect(p!.path).toBe(join(dir, POLICY_FILENAME));
    expect(p!.text).toBe(SAMPLE);
    expect(p!.bytes).toBe(Buffer.byteLength(SAMPLE));
    expect(p!.truncated).toBe(false);
    expect(p!.sha256).toBe(sha(SAMPLE));
    expect(p!.warnings).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  test("★ 软链接 → 当不存在,stderr 警告一次", () => {
    const dir = repo();
    writeFileSync(join(dir, "real.txt"), "scope: .\n");
    symlinkSync(join(dir, "real.txt"), join(dir, POLICY_FILENAME));
    expect(loadPolicy(dir)).toBeNull();
    expect(warningsPrinted()).toHaveLength(1);
    expect(warningsPrinted()[0]).toContain("软链接");
  });

  test("目录叫 .zgatepolicy → 当不存在并警告", () => {
    const dir = repo();
    mkdirSync(join(dir, POLICY_FILENAME));
    expect(loadPolicy(dir)).toBeNull();
    expect(warningsPrinted()[0]).toContain("不是普通文件");
  });
});

describe("大小上限", () => {
  test("超过 4096 字节:只读前 4096、truncated、bytes 是实际大小、sha 是截断后文本的、警告", () => {
    const head = "scope: a/\n";
    const body = head + "x".repeat(MAX_POLICY_BYTES * 3);
    const p = loadPolicy(repo(body))!;
    expect(p.truncated).toBe(true);
    expect(p.bytes).toBe(body.length);
    expect(Buffer.byteLength(p.text)).toBe(MAX_POLICY_BYTES);
    expect(p.text).toBe(body.slice(0, MAX_POLICY_BYTES));
    expect(p.sha256).toBe(sha(p.text));
    expect(p.scope.map((s) => s.entry)).toEqual(["a"]);
    expect(p.warnings.some((w) => w.includes("超过"))).toBe(true);
    expect(warningsPrinted()).toHaveLength(1);
  });

  test("截断落在多字节字符中间:不出现替换字符,长度略小于上限", () => {
    const body = "x".repeat(MAX_POLICY_BYTES - 1) + "中文";
    const p = loadPolicy(repo(body))!;
    expect(p.truncated).toBe(true);
    expect(p.text.includes("�")).toBe(false);
    expect(p.text).toBe("x".repeat(MAX_POLICY_BYTES - 1));
  });

  test("刚好 4096 字节不算截断", () => {
    const p = loadPolicy(repo("y".repeat(MAX_POLICY_BYTES)))!;
    expect(p.truncated).toBe(false);
    expect(p.text.length).toBe(MAX_POLICY_BYTES);
  });
});

describe("scope 解析(§2.2)", () => {
  test("前导空白、./ 与尾 / 归一化,按出现顺序,重复去掉", () => {
    const { scope, warnings } = parseScope(SAMPLE + "scope: migrations\n", "/r");
    expect(scope.map((s) => s.entry)).toEqual(["migrations", "config/production", "infra", "prod-db.internal"]);
    expect(scope[0]!.paths).toEqual(["/r/migrations"]);
    expect(warnings).toEqual([]);
  });

  test("`.` 与 `./` 表示整个仓库,paths 就是 root", () => {
    expect(parseScope("scope: .\n", "/r").scope).toEqual([{ entry: ".", paths: ["/r"] }]);
    expect(parseScope("scope: ./\n", "/r").scope).toEqual([{ entry: ".", paths: ["/r"] }]);
  });

  test("非法条目忽略并各警告一句:绝对路径、含 ..、通配符、空", () => {
    const { scope, warnings } = parseScope("scope: /etc\nscope: ../x\nscope: **/*.tfstate\nscope: a?b\nscope:\nscope: ok/\n", "/r");
    expect(scope.map((s) => s.entry)).toEqual(["ok"]);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain("绝对路径");
    expect(warnings[1]).toContain("..");
    expect(warnings[2]).toContain("通配符");
    expect(warnings[4]).toContain("为空");
  });

  test("只认小写顶格 `scope:`:`Scope:`、行中间的 `scope:`、`# scope:` 都是普通文字", () => {
    const { scope } = parseScope("Scope: a\nsee scope: b\n# scope: c\nscope:d\n", "/r");
    expect(scope.map((s) => s.entry)).toEqual(["d"]);
  });

  test("scope: 行留在 text 里不剥", () => {
    const p = loadPolicy(repo(SAMPLE))!;
    expect(p.text).toContain("scope: migrations/");
  });

  test("条目本身是软链接目录时 paths 多一个 realpath", () => {
    const dir = repo();
    mkdirSync(join(dir, "releases", "v2"), { recursive: true });
    symlinkSync(join(dir, "releases", "v2"), join(dir, "current"));
    const { scope } = parseScope("scope: current/\n", dir);
    expect(scope[0]!.paths).toEqual([join(dir, "current"), join(dir, "releases", "v2")]);
  });

  test("非法条目的警告从 loadPolicy 打到 stderr,且随 Policy.warnings 返回", () => {
    const p = loadPolicy(repo("scope: /abs\nscope: ok\n"))!;
    expect(p.scope.map((s) => s.entry)).toEqual(["ok"]);
    expect(p.warnings).toHaveLength(1);
    expect(warningsPrinted()).toHaveLength(1);
  });
});

describe("缓存与警告去重(§2.4)", () => {
  test("3 秒内同 root 复用:改了文件立刻再读还是旧 sha;clearPolicyCache 后是新的", () => {
    const dir = repo("scope: a\n");
    const first = loadPolicy(dir)!;
    writeFileSync(join(dir, POLICY_FILENAME), "scope: b\n");
    expect(loadPolicy(dir)!.sha256).toBe(first.sha256);
    clearPolicyCache();
    const second = loadPolicy(dir)!;
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.scope.map((s) => s.entry)).toEqual(["b"]);
  });

  test("不同 root 各自缓存,互不串味", () => {
    const a = repo("scope: a\n");
    const b = repo("scope: b\n");
    expect(loadPolicy(a)!.scope[0]!.entry).toBe("a");
    expect(loadPolicy(b)!.scope[0]!.entry).toBe("b");
    expect(loadPolicy(a)!.scope[0]!.entry).toBe("a");
  });

  test("同一份文件的警告只打一次:缓存过期重读不再打;文件内容变了(新 sha)才再打", () => {
    const dir = repo("scope: /abs\n");
    loadPolicy(dir);
    clearPolicyCache();
    loadPolicy(dir);
    expect(warningsPrinted()).toHaveLength(1);
    writeFileSync(join(dir, POLICY_FILENAME), "scope: ../up\n");
    clearPolicyCache();
    loadPolicy(dir);
    expect(warningsPrinted()).toHaveLength(2);
  });

  test("sha256 对同一内容稳定", () => {
    const a = loadPolicy(repo(SAMPLE))!;
    const b = loadPolicy(repo(SAMPLE))!;
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
