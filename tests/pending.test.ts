// spec-m4 §0 第 5 项 —— 悬着的 ask 表。
//
// 这张表决定 outcome 补丁落在哪几行上,所以测的是**对得上、串不了、丢得对**:
// 同 session 同 id 才对得上;不同 session 的同一个 id 串不了;TTL 与上限丢的是该丢的。

import { describe, expect, test } from "bun:test";

import { PENDING_MAX, PENDING_TTL_MS, PendingAsks } from "../src/core/pending.ts";

function clock(start = 1_000_000): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

describe("spec-m4 §0.5 悬着表:记与取", () => {
  test("put 之后 take 拿回同一批 decision_id,并从表里移出", () => {
    const p = new PendingAsks();
    p.put("s1", "toolu_1", ["d1", "d2"]);
    expect(p.size).toBe(1);
    expect(p.take("s1", "toolu_1")).toEqual(["d1", "d2"]);
    expect(p.size).toBe(0);
    expect(p.take("s1", "toolu_1")).toBeNull();
  });

  test("没记过的 id → null(allow 的调用也会来 Post 事件,那是正常的 miss)", () => {
    const p = new PendingAsks();
    expect(p.take("s1", "toolu_x")).toBeNull();
  });

  test("★ 不同 session 的同一个 tool_use_id 不串", () => {
    const p = new PendingAsks();
    p.put("s1", "toolu_1", ["a"]);
    p.put("s2", "toolu_1", ["b"]);
    expect(p.take("s2", "toolu_1")).toEqual(["b"]);
    expect(p.take("s1", "toolu_1")).toEqual(["a"]);
  });

  test("同一个键再 put 是覆盖,不是叠加", () => {
    const p = new PendingAsks();
    p.put("s1", "toolu_1", ["a"]);
    p.put("s1", "toolu_1", ["b"]);
    expect(p.size).toBe(1);
    expect(p.take("s1", "toolu_1")).toEqual(["b"]);
  });

  test("记进去的是副本:调用方之后改自己的数组不影响表", () => {
    const p = new PendingAsks();
    const ids = ["a"];
    p.put("s1", "toolu_1", ids);
    ids.push("b");
    expect(p.take("s1", "toolu_1")).toEqual(["a"]);
  });

  test("tool_use_id 是不透明字符串:toolu_… 与 chatcmpl-tool-… 一样对得上(D16.0)", () => {
    const p = new PendingAsks();
    p.put("s1", "chatcmpl-tool-8f3d87991157ed19", ["a"]);
    expect(p.take("s1", "chatcmpl-tool-8f3d87991157ed19")).toEqual(["a"]);
  });
});

describe("spec-m4 §0.5 悬着表:TTL", () => {
  test("默认 TTL 是 30 分钟,上限 10000", () => {
    expect(PENDING_TTL_MS).toBe(30 * 60 * 1000);
    expect(PENDING_MAX).toBe(10_000);
  });

  test("★ 过期的条目 take 回 null,并被清掉", () => {
    const c = clock();
    const p = new PendingAsks(1000, 100, c.now);
    p.put("s1", "toolu_1", ["a"]);
    c.tick(999);
    expect(p.take("s1", "toolu_1")).toEqual(["a"]);
    p.put("s1", "toolu_2", ["b"]);
    c.tick(1000);
    expect(p.take("s1", "toolu_2")).toBeNull();
    expect(p.size).toBe(0);
  });

  test("覆盖写会刷新年龄", () => {
    const c = clock();
    const p = new PendingAsks(1000, 100, c.now);
    p.put("s1", "toolu_1", ["a"]);
    c.tick(900);
    p.put("s1", "toolu_1", ["a2"]);
    c.tick(900);
    expect(p.take("s1", "toolu_1")).toEqual(["a2"]);
  });

  test("sweep 只扫过期的,返回条数", () => {
    const c = clock();
    const p = new PendingAsks(1000, 100, c.now);
    p.put("s1", "old", ["a"]);
    c.tick(600);
    p.put("s1", "new", ["b"]);
    c.tick(500);
    expect(p.sweep()).toBe(1);
    expect(p.size).toBe(1);
    expect(p.take("s1", "new")).toEqual(["b"]);
  });
});

describe("spec-m4 §0.5 悬着表:上限", () => {
  test("★ 满了丢最旧的,新的一定进得去", () => {
    const p = new PendingAsks(PENDING_TTL_MS, 3);
    p.put("s", "t1", ["1"]);
    p.put("s", "t2", ["2"]);
    p.put("s", "t3", ["3"]);
    p.put("s", "t4", ["4"]);
    expect(p.size).toBe(3);
    expect(p.take("s", "t1")).toBeNull();
    expect(p.take("s", "t2")).toEqual(["2"]);
    expect(p.take("s", "t4")).toEqual(["4"]);
  });

  test("上限为 1 时表里永远只有最后一条", () => {
    const p = new PendingAsks(PENDING_TTL_MS, 1);
    p.put("s", "t1", ["1"]);
    p.put("s", "t2", ["2"]);
    expect(p.size).toBe(1);
    expect(p.take("s", "t2")).toEqual(["2"]);
  });
});

describe("spec-m4 §0.5 悬着表:按 session 清空(SessionEnd)", () => {
  test("★ drain 返回该 session 全部悬着的 decision_id 并移出;别的 session 不动", () => {
    const p = new PendingAsks();
    p.put("s1", "t1", ["a", "b"]);
    p.put("s2", "t1", ["c"]);
    p.put("s1", "t2", ["d"]);
    expect(p.drain("s1")).toEqual(["a", "b", "d"]);
    expect(p.size).toBe(1);
    expect(p.take("s2", "t1")).toEqual(["c"]);
  });

  test("drain 不返回已过期的,但把它们清掉", () => {
    const c = clock();
    const p = new PendingAsks(1000, 100, c.now);
    p.put("s1", "old", ["a"]);
    c.tick(1000);
    p.put("s1", "new", ["b"]);
    expect(p.drain("s1")).toEqual(["b"]);
    expect(p.size).toBe(0);
  });

  test("没有任何悬着的 session → 空数组", () => {
    const p = new PendingAsks();
    expect(p.drain("nobody")).toEqual([]);
  });
});
