// 核心类型(schema + 派生类型)的序列化测试:
//   1. 字段名必须是 snake_case(线格式 = journal 格式,下游是 Python)
//   2. 序列化 / 反序列化往返不丢信息
//   3. 类型层面的只读约束真的生效

import { describe, expect, test } from "bun:test";
import { ActionSchema, type Action } from "../src/core/action.ts";
import { ContextSchema, type Context } from "../src/core/context.ts";
import { DecisionSchema, type Decision } from "../src/core/decision.ts";

function makeAction(): Action {
  return ActionSchema.parse({
    verb: "delete",
    targets: [{ kind: "file", raw: "./build" }],
    command: "rm -rf ./build",
    tool_name: "Bash",
    tool_input: { command: "rm -rf ./build", timeout: 120000, nested: { a: [1, 2, { b: null }] } },
    agent: { name: "claude-code", version: null, session_id: "sess-1" },
    cwd: "/tmp/repo",
    turn_id: "turn-1",
  });
}

function makeContext(): Context {
  return ContextSchema.parse({
    resources: [
      {
        raw: "./build",
        resolved: "/tmp/outside/build",
        exists: true,
        is_symlink: true,
        symlink_target: "/tmp/outside",
        is_dir: true,
        inside_cwd: false,
        inside_repo: false,
        gitignored: null,
      },
    ],
    repo: {
      is_repo: true,
      root: "/tmp/repo",
      branch: "main",
      is_dirty: null,
      default_branch: "main",
    },
    env_hints: { CI: "true", TERM_PROGRAM: "iTerm.app" },
    elapsed_ms: 0.42,
  });
}

function makeDecision(): Decision {
  return DecisionSchema.parse({
    verdict: "ask",
    reason: "目标在 cwd 之外",
    source: "rule",
    rule_id: "post.outside-cwd",
    confidence: null,
    latency_ms: 0.31,
    decision_id: "dec-1",
  });
}

describe("core types: parse + round-trip", () => {
  test("Action round-trips through JSON with no loss", () => {
    const action = makeAction();
    const wire = JSON.stringify(action);
    const back = ActionSchema.parse(JSON.parse(wire));
    expect(back).toEqual(action);
    expect(wire).toBe(JSON.stringify(back));
  });

  test("Context round-trips through JSON with no loss", () => {
    const ctx = makeContext();
    const wire = JSON.stringify(ctx);
    const back = ContextSchema.parse(JSON.parse(wire));
    expect(back).toEqual(ctx);
    // null 必须保留为 null,不能被 JSON 丢掉或变成 undefined
    expect(wire).toContain('"gitignored":null');
    expect(wire).toContain('"is_dirty":null');
  });

  test("Decision round-trips through JSON with no loss", () => {
    const decision = makeDecision();
    const wire = JSON.stringify(decision);
    const back = DecisionSchema.parse(JSON.parse(wire));
    expect(back).toEqual(decision);
    expect(wire).toContain('"confidence":null');
    expect(wire).toContain('"rule_id":"post.outside-cwd"');
  });

  test("tool_input is preserved verbatim, including nested non-string values", () => {
    const action = makeAction();
    expect(action.tool_input["timeout"]).toBe(120000);
    expect(action.tool_input["nested"]).toEqual({ a: [1, 2, { b: null }] });
    expect(ActionSchema.parse(JSON.parse(JSON.stringify(action))).tool_input).toEqual(
      action.tool_input,
    );
  });

  test("command is null for non-exec verbs and survives round-trip", () => {
    const read = ActionSchema.parse({
      ...makeAction(),
      verb: "read",
      command: null,
      targets: [{ kind: "file", raw: "README.md" }],
    });
    expect(read.command).toBeNull();
    expect(JSON.stringify(read)).toContain('"command":null');
  });
});

describe("core types: snake_case is load-bearing", () => {
  test("serialized keys are snake_case, never camelCase", () => {
    const wire = JSON.stringify({
      action: makeAction(),
      context: makeContext(),
      decision: makeDecision(),
    });
    for (const key of [
      "tool_name",
      "tool_input",
      "turn_id",
      "session_id",
      "symlink_target",
      "inside_cwd",
      "inside_repo",
      "gitignored",
      "is_symlink",
      "is_dir",
      "is_repo",
      "is_dirty",
      "default_branch",
      "env_hints",
      "elapsed_ms",
      "rule_id",
      "latency_ms",
      "decision_id",
    ]) {
      expect(wire).toContain(`"${key}"`);
    }
    for (const bad of [
      "toolName",
      "toolInput",
      "turnId",
      "sessionId",
      "symlinkTarget",
      "insideCwd",
      "insideRepo",
      "isSymlink",
      "isDir",
      "isRepo",
      "isDirty",
      "defaultBranch",
      "envHints",
      "elapsedMs",
      "ruleId",
      "latencyMs",
      "decisionId",
    ]) {
      expect(wire).not.toContain(`"${bad}"`);
    }
  });
});

describe("core types: rejection at the boundary", () => {
  test("unknown verb is rejected", () => {
    expect(ActionSchema.safeParse({ ...makeAction(), verb: "DROP" }).success).toBe(false);
  });

  test("unknown verdict is rejected", () => {
    expect(DecisionSchema.safeParse({ ...makeDecision(), verdict: "maybe" }).success).toBe(false);
  });

  test("unknown source is rejected", () => {
    expect(DecisionSchema.safeParse({ ...makeDecision(), source: "vibes" }).success).toBe(false);
  });

  test("missing required key is rejected", () => {
    const { cwd: _cwd, ...withoutCwd } = makeAction();
    expect(ActionSchema.safeParse(withoutCwd).success).toBe(false);
  });

  test("null is accepted where the contract says nullable", () => {
    const parsed = ActionSchema.parse({
      ...makeAction(),
      agent: { name: "claude-code", version: null, session_id: null },
    });
    expect(parsed.agent.version).toBeNull();
    expect(parsed.agent.session_id).toBeNull();
  });

  test("a missing nullable key is NOT the same as null — it is rejected", () => {
    // version / session_id 是 nullable 而非 optional:适配器必须显式给 null,不允许省略。
    expect(
      ActionSchema.safeParse({
        ...makeAction(),
        agent: { name: "claude-code" },
      }).success,
    ).toBe(false);
  });

  test("context with gitignored null vs false are distinct", () => {
    const ctx = makeContext();
    const falsified = ContextSchema.parse({
      ...ctx,
      resources: [{ ...ctx.resources[0], gitignored: false }],
    });
    expect(falsified.resources[0]?.gitignored).toBe(false);
    expect(ctx.resources[0]?.gitignored).toBeNull();
  });
});

describe("core types: compile-time immutability", () => {
  // 只读是编译期约束,运行时故意不加 Object.freeze(热路径开销),所以这里测的是编译器拒绝哪些写入。
  // Readonly<T> 是浅的:顶层字段被拦;c.repo.branch 这类嵌套字段可以写,z.array 推出的数组也可以 push。
  // 兜底靠约定:已构造出的 Action / Context / Decision 不得被原地修改。
  function assertTopLevelReadonly(a: Action, c: Context, d: Decision): void {
    // @ts-expect-error Action 顶层字段是只读的
    a.verb = "read";
    // @ts-expect-error Context 顶层字段是只读的
    c.resources = [];
    // @ts-expect-error Context 顶层字段是只读的
    c.repo = { is_repo: false, root: null, branch: null, is_dirty: null, default_branch: null };
    // @ts-expect-error Decision 顶层字段是只读的
    d.verdict = "allow";

    // 这些写入编译器放行 —— 浅只读的缺口,不是笔误。
    c.repo.branch = "other";
    a.targets.push({ kind: "file", raw: "extra" });
  }

  test("top-level fields are write-protected", () => {
    const action = makeAction();
    const ctx = makeContext();
    const decision = makeDecision();
    assertTopLevelReadonly(action, ctx, decision);

    // 上面的写入被编译器拒绝,但运行时照样执行:不可变性靠调用方守约,不靠运行时。
    expect(action.verb).toBe("read");
    expect(ctx.resources.length).toBe(0);
    expect(ctx.repo.branch).toBe("other");
    expect(decision.verdict).toBe("allow");
  });

  test("nested element fields are NOT write-protected (documented gap)", () => {
    const action = makeAction();
    action.targets[0]!.raw = "other"; // 编译器不报错,这就是缺口
    action.targets.push({ kind: "file", raw: "extra" });
    action.agent.session_id = "other";
    expect(action.targets[0]?.raw).toBe("other");
    expect(action.targets.length).toBe(2);
  });
});
