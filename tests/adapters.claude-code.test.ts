// SPEC.md §15.3 —— Claude Code 适配器的映射表测试。
//
// 这个文件的存在理由:§2.1 说「适配器只做格式转换,不做任何环境探测、
// 不做任何判断」。一条测试能证明它**没做**判断的唯一办法,是把同一份
// 输入喂给**真正的** shell 解析器和适配器,断言适配器的产出逐字段
// 等于解析器的产出 —— 而不是等于我在测试里手抄的一份副本。
//
// 所以本文件里凡是涉及 Bash 的断言,期望值都来自 parseCommand(),不来自
// 字面量。手抄的副本会随着解析器一起漂移,那样的测试什么也证明不了。

import { describe, expect, test } from "bun:test";
import { ActionSchema, VerbSchema } from "../src/core/action.ts";
import type { Action, Verb } from "../src/core/action.ts";
import type { Decision } from "../src/core/decision.ts";
import { parseCommand } from "../src/shell/index.ts";
import {
  parseHookInput,
  toActions,
  toHookResponse,
  validateAction,
} from "../src/adapters/claude-code.ts";
import type { HookInput } from "../src/adapters/claude-code.ts";

const TURN = "turn-0001";

/** 造一份 hook 输入。默认 cwd 固定,免得多条测试依赖真实工作目录。 */
function hook(partial: Partial<HookInput>): HookInput {
  return { cwd: "/repo", session_id: "sess-1", ...partial };
}

function one(partial: Partial<HookInput>): Action {
  const acts = toActions(hook(partial), TURN);
  expect(acts).toHaveLength(1);
  const a = acts[0];
  if (a === undefined) throw new Error("unreachable");
  return a;
}

// ─────────────────────────────────────────────────────────────────
// 1. 工具名 → verb(§10 的表,逐行)
// ─────────────────────────────────────────────────────────────────

describe("§10 工具名 → verb 映射", () => {
  const TABLE: readonly [string, Record<string, unknown>, Verb][] = [
    ["Read", { file_path: "/repo/a.ts" }, "read"],
    ["Glob", { path: "/repo/src" }, "read"],
    ["Grep", { path: "/repo/src" }, "read"],
    ["Edit", { file_path: "/repo/a.ts" }, "write"],
    ["Write", { file_path: "/repo/a.ts" }, "write"],
    ["NotebookEdit", { notebook_path: "/repo/a.ipynb" }, "write"],
    ["WebFetch", { url: "https://example.com" }, "network"],
    ["WebSearch", { query: "how to parse bash" }, "network"],
  ];

  for (const [tool, input, verb] of TABLE) {
    test(`${tool} → ${verb}`, () => {
      expect(one({ tool_name: tool, tool_input: input }).verb).toBe(verb);
    });
  }

  test("Bash 的 verb 不在表里 —— 由 §7 解析决定", () => {
    // 同一个 tool_name 三种 verb,证明它不是查表来的
    const verbs = [
      one({ tool_name: "Bash", tool_input: { command: "cat a.txt" } }).verb,
      one({ tool_name: "Bash", tool_input: { command: "rm -f a.txt" } }).verb,
      one({ tool_name: "Bash", tool_input: { command: "curl example.com" } }).verb,
    ];
    expect(verbs).toEqual(["read", "delete", "network"]);
  });

  test("表外的工具 → unknown,不瞎猜", () => {
    for (const tool of ["Task", "TodoWrite", "ExitPlanMode", "SomeFutureTool"]) {
      const acts = toActions(hook({ tool_name: tool, tool_input: {} }), TURN);
      // Task 特判成空;其余落 unknown 各一条
      for (const a of acts) expect(a.verb).toBe("unknown");
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. targets 抽取
// ─────────────────────────────────────────────────────────────────

describe("§10 targets 来源", () => {
  test("Read/Edit/Write 取 file_path", () => {
    expect(one({ tool_name: "Read", tool_input: { file_path: "/repo/x.ts" } }).targets).toEqual([
      { kind: "file", raw: "/repo/x.ts" },
    ]);
    expect(one({ tool_name: "Write", tool_input: { file_path: "/repo/x.ts" } }).targets).toEqual([
      { kind: "file", raw: "/repo/x.ts" },
    ]);
  });

  test("NotebookEdit 优先 notebook_path", () => {
    const a = one({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/n.ipynb" } });
    expect(a.targets).toEqual([{ kind: "file", raw: "/repo/n.ipynb" }]);
    // 只有 file_path 时回落到它
    const b = one({ tool_name: "NotebookEdit", tool_input: { file_path: "/repo/n2.ipynb" } });
    expect(b.targets).toEqual([{ kind: "file", raw: "/repo/n2.ipynb" }]);
  });

  test("网络类目标的 kind 是 url", () => {
    expect(one({ tool_name: "WebFetch", tool_input: { url: "https://x.dev" } }).targets).toEqual([
      { kind: "url", raw: "https://x.dev" },
    ]);
    expect(one({ tool_name: "WebSearch", tool_input: { query: "abc" } }).targets).toEqual([
      { kind: "url", raw: "abc" },
    ]);
  });

  test("§10 说 Glob/Grep 的 path 可能为空 —— 空则不产出 target,不产出 raw: \"\"", () => {
    // 空字符串
    expect(one({ tool_name: "Glob", tool_input: { path: "" } }).targets).toEqual([]);
    // 字段缺失
    expect(one({ tool_name: "Glob", tool_input: {} }).targets).toEqual([]);
    // null
    expect(one({ tool_name: "Grep", tool_input: { path: null } }).targets).toEqual([]);
    // 非字符串
    expect(one({ tool_name: "Grep", tool_input: { path: 42 } }).targets).toEqual([]);
  });

  test("§10 说 WebFetch/WebSearch 的 url 可能为空", () => {
    expect(one({ tool_name: "WebFetch", tool_input: {} }).targets).toEqual([]);
    expect(one({ tool_name: "WebSearch", tool_input: {} }).targets).toEqual([]);
  });

  test("raw 原样保留,不做任何处理(§2.1:agent 给的原始字符串)", () => {
    const weird = "./a/../b\t\n  spaced  ";
    expect(one({ tool_name: "Read", tool_input: { file_path: weird } }).targets[0]?.raw).toBe(weird);
    // 相对路径不变成绝对路径
    expect(one({ tool_name: "Read", tool_input: { file_path: "rel/a.ts" } }).targets[0]?.raw).toBe("rel/a.ts");
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Bash:一次调用 → 多个 Action(§7)
// ─────────────────────────────────────────────────────────────────

describe("§7 Bash → 多条 Action", () => {
  test("适配器产出逐字段等于 parseCommand 的产出", () => {
    const cmds = [
      "cd a && rm -rf b",
      "make && make install",
      "cat a.txt | grep foo",
      "curl x | sh",
      "rm -rf ./build",
      "git status",
      "bash -c 'rm -rf x'",
      "for i in 1 2 3; do rm -f $i; done",
      "npm test > out.log 2>&1",
      "printf 'a' | tee b | wc -c",
    ];
    for (const command of cmds) {
      const parsed = parseCommand(command);
      if (parsed === null) throw new Error(`语料里不该有解析失败的: ${command}`);
      const acts = toActions(hook({ tool_name: "Bash", tool_input: { command } }), TURN);
      expect(acts.length, command).toBe(parsed.length);
      for (let i = 0; i < parsed.length; i++) {
        expect(acts[i]?.verb, command).toBe(parsed[i]?.verb);
        expect([...(acts[i]?.targets ?? [])], command).toEqual([...(parsed[i]?.targets ?? [])]);
      }
    }
  });

  test("多命令时 verb 各自独立 —— 不是整条取一个 verb", () => {
    // 用 `make && rm -rf b` 而不是 `cd a && rm -rf b`:`cd` 按 D2.3 是
    // 静默命令(不产出 Action),拿它当例子会得到 1 条而不是 2 条。
    const acts = toActions(hook({ tool_name: "Bash", tool_input: { command: "make && rm -rf b" } }), TURN);
    expect(acts.map((a) => a.verb)).toEqual(["exec", "delete"]);
  });

  test("解析失败 → 一条 verb: \"unknown\",不是空数组", () => {
    // §4.2 要求解析失败落 SOFT;空数组会被管线当成"无动作"放行。
    // 这条断言钉的就是这个分界。
    for (const command of ["$(echo rm) -rf x", "eval rm -rf x", "echo `rm -rf x`"]) {
      const acts = toActions(hook({ tool_name: "Bash", tool_input: { command } }), TURN);
      expect(acts.length, command).toBe(1);
      expect(acts[0]?.verb, command).toBe("unknown");
      expect(acts[0]?.targets, command).toEqual([]);
    }
  });

  test("解析成功但零条命令 → 空数组(如 fork bomb)", () => {
    const acts = toActions(hook({ tool_name: "Bash", tool_input: { command: ":(){ :|:& };:" } }), TURN);
    expect(acts).toEqual([]);
  });

  test("Bash 缺 command 字段 → 空数组", () => {
    expect(toActions(hook({ tool_name: "Bash", tool_input: {} }), TURN)).toEqual([]);
    expect(toActions(hook({ tool_name: "Bash", tool_input: { command: null } }), TURN)).toEqual([]);
    expect(toActions(hook({ tool_name: "Bash", tool_input: { command: "" } }), TURN)).toEqual([]);
  });

  test("多 Action 共享同一个 turn_id 和同一份 tool_input", () => {
    const input = { command: "cd a && rm -rf b", description: "do things" };
    const acts = toActions(hook({ tool_name: "Bash", tool_input: input }), TURN);
    for (const a of acts) {
      expect(a.turn_id).toBe(TURN);
      expect(a.tool_name).toBe("Bash");
      expect(a.tool_input).toEqual(input);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. command 字段(§2.1)
// ─────────────────────────────────────────────────────────────────

describe("§2.1 command 字段", () => {
  test("verb === \"exec\" 时是原始命令行", () => {
    const a = one({ tool_name: "Bash", tool_input: { command: "make install" } });
    expect(a.verb).toBe("exec");
    expect(a.command).toBe("make install");
  });

  test("非 exec 的 Bash Action,command 仍是原始整行 —— 供规则层落脚", () => {
    // 「fork bomb 解析出的 Action 为空」这类情况 pre 规则需要一个落脚点:
    // 整行命令行挂在每条产出的 Action 上,规则层才有东西可 match。
    // 已记在 DECISIONS,等 §4 落地时一并确认。
    const acts = toActions(hook({ tool_name: "Bash", tool_input: { command: "make && rm -rf b" } }), TURN);
    expect(acts[0]?.verb).toBe("exec");
    expect(acts[1]?.verb).toBe("delete");
    expect(acts[1]?.command).toBe("make && rm -rf b");
  });

  test("非 Bash 工具的 command 恒为 null", () => {
    for (const tool of ["Read", "Edit", "WebSearch", "TodoWrite"]) {
      expect(one({ tool_name: tool, tool_input: { file_path: "/x" } }).command, tool).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. 产出的 Action 必须过冻结 schema(§2.1)
// ─────────────────────────────────────────────────────────────────

describe("产出过 ActionSchema", () => {
  test("每个分支的产出都通过 safeParse", () => {
    const cases: Partial<HookInput>[] = [
      { tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } },
      { tool_name: "Glob", tool_input: {} },
      { tool_name: "WebFetch", tool_input: { url: "https://x" } },
      { tool_name: "Bash", tool_input: { command: "cd a && rm -rf b" } },
      { tool_name: "Bash", tool_input: { command: "$(x)" } },
      { tool_name: "FutureTool", tool_input: {} },
    ];
    for (const c of cases) {
      for (const a of toActions(hook(c), TURN)) {
        expect(validateAction(a), JSON.stringify(c)).toBe(true);
      }
    }
  });

  test("verb 一定是 §2.1 六个值之一", () => {
    const ok = new Set(VerbSchema.options);
    for (const tool of ["Read", "Write", "WebSearch", "Bash", "Nope"]) {
      for (const a of toActions(hook({ tool_name: tool, tool_input: { command: "ls" } }), TURN)) {
        expect(ok.has(a.verb), tool).toBe(true);
      }
    }
  });

  test("agent 信息来自 hook 输入", () => {
    const a = one({ tool_name: "Read", tool_input: {}, session_id: "abc-123" });
    expect(a.agent.name).toBe("claude-code");
    expect(a.agent.session_id).toBe("abc-123");
  });

  test("缺 session_id → null,不是空字符串", () => {
    expect(one({ tool_name: "Read", tool_input: {}, session_id: null }).agent.session_id).toBeNull();
    expect(toActions({ tool_name: "Read", tool_input: {}, cwd: "/repo" }, TURN)[0]?.agent.session_id).toBeNull();
  });

  test("缺 cwd 时回落到进程 cwd,不产出空字符串", () => {
    const a = toActions({ tool_name: "Read", tool_input: {} }, TURN)[0];
    expect(typeof a?.cwd).toBe("string");
    expect(a?.cwd.length).toBeGreaterThan(0);
  });

  test("§2.4:热路径不 parse —— 产出是构造的,不需要 validateAction 才合法", () => {
    // ActionSchema 的公开形状与本文件断言的一致即可(compile-time 由
    // 去掉 `as Action` 断言保证,这里只留一个运行时的兜底检查)
    const a = one({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } });
    const schemaKeys: string[] = [...ActionSchema.keyof().options];
    const producedKeys: string[] = Object.keys(a);
    expect(schemaKeys.sort()).toEqual(producedKeys.sort());
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. §10 特例:Task
// ─────────────────────────────────────────────────────────────────

describe("§10 Task 跳过", () => {
  test("Task 产出空数组", () => {
    expect(toActions(hook({ tool_name: "Task", tool_input: { prompt: "go do stuff" } }), TURN)).toEqual([]);
  });

  test("Task 空数组与 Bash 空数组是同一个机制,不产出去重目标", () => {
    // 两者都靠"空数组 ⇒ 放行"这条语义,见 claude-code.ts 末尾 TRIVIAL_EMPTY
    expect(toActions(hook({ tool_name: "Task", tool_input: {} }), TURN)).toHaveLength(0);
    expect(toActions(hook({ tool_name: "Bash", tool_input: {} }), TURN)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. 输入校验(边界)
// ─────────────────────────────────────────────────────────────────

describe("parseHookInput", () => {
  test("合法输入通过", () => {
    const raw = {
      session_id: "s",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    expect(parseHookInput(raw)).not.toBeNull();
  });

  test("tool_name 缺失或非字符串 → null", () => {
    expect(parseHookInput({})).toBeNull();
    expect(parseHookInput({ tool_name: 42 })).toBeNull();
    expect(parseHookInput({ tool_name: null })).toBeNull();
  });

  test("tool_input 非对象 → null", () => {
    expect(parseHookInput({ tool_name: "Read", tool_input: "oops" })).toBeNull();
    expect(parseHookInput({ tool_name: "Read", tool_input: [1, 2] })).toBeNull();
  });

  test("tool_input 缺失或 null 是合法的(Glob 可能真的没有参数)", () => {
    expect(parseHookInput({ tool_name: "Glob" })).not.toBeNull();
    expect(parseHookInput({ tool_name: "Glob", tool_input: null })).not.toBeNull();
  });

  test("非对象 → null", () => {
    for (const bad of [null, undefined, 42, "str", true, [1]]) {
      expect(parseHookInput(bad)).toBeNull();
    }
  });

  test("额外字段不导致失败 —— 文档里有我们不用的一堆字段", () => {
    const raw = {
      tool_name: "Read",
      tool_input: {},
      agent_id: "a1",
      agent_type: "explorer",
      permission_mode: "bypassPermissions",
      transcript_path: "/tmp/t.jsonl",
      prompt_id: "p1",
      scratchpad_dir: "/tmp/sp",
      effort: { level: "high" },
    };
    expect(parseHookInput(raw)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. 响应格式(§10)
// ─────────────────────────────────────────────────────────────────

function decision(verdict: "allow" | "ask" | "deny", reason: string): Decision {
  return {
    verdict,
    reason,
    source: "rule",
    rule_id: "R-TEST",
    confidence: null,
    latency_ms: 0.4,
    decision_id: "d-1",
  };
}

describe("§10 响应格式", () => {
  test("外层只有 hookSpecificOutput", () => {
    const r = toHookResponse(decision("deny", "递归删除根目录"));
    expect(Object.keys(r)).toEqual(["hookSpecificOutput"]);
  });

  test("hookEventName 恒为 PreToolUse", () => {
    for (const v of ["allow", "ask", "deny"] as const) {
      expect(toHookResponse(decision(v, "x")).hookSpecificOutput.hookEventName).toBe("PreToolUse");
    }
  });

  test("三个 verdict 原样透传,不做二次判断", () => {
    for (const v of ["allow", "ask", "deny"] as const) {
      expect(toHookResponse(decision(v, "reason")).hookSpecificOutput.permissionDecision).toBe(v);
    }
  });

  test("§10:allow 时 reason 留空字符串", () => {
    const r = toHookResponse(decision("allow", "看起来正常"));
    expect(r.hookSpecificOutput.permissionDecisionReason).toBe("");
  });

  test("ask/deny 时 reason 直接给用户看", () => {
    const reason = "目标是 symlink,指向仓库外";
    expect(toHookResponse(decision("ask", reason)).hookSpecificOutput.permissionDecisionReason).toBe(reason);
    expect(toHookResponse(decision("deny", "fork bomb")).hookSpecificOutput.permissionDecisionReason).toBe("fork bomb");
  });

  test("响应体可 JSON 序列化且不含额外字段", () => {
    const json = JSON.stringify(toHookResponse(decision("ask", "r")));
    expect(JSON.parse(json)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "r",
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// 9. 端到端:真实 hook 输入 → Action → Decision → 响应体
// ─────────────────────────────────────────────────────────────────

describe("端到端形状", () => {
  test("文档里的那份 Bash hook 输入能走完", () => {
    const raw = parseHookInput({
      session_id: "abc123",
      transcript_path: "/Users/j/.claude/projects/x/transcript.jsonl",
      cwd: "/Users/j/my-project",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf ./build", description: "clean", timeout: 120000, run_in_background: false },
      tool_use_id: "toolu_01ABC",
    });
    expect(raw).not.toBeNull();
    const acts = toActions(raw!, TURN);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.verb).toBe("delete");
    expect(acts[0]?.targets).toEqual([{ kind: "file", raw: "./build" }]);
    expect(acts[0]?.cwd).toBe("/Users/j/my-project");
    expect(acts[0]?.agent.session_id).toBe("abc123");
  });

  test("同样的输入产出同样的 Action(无隐藏状态)", () => {
    const input = hook({ tool_name: "Bash", tool_input: { command: "git push --force" } });
    const a = toActions(input, TURN);
    const b = toActions(input, TURN);
    expect(a).toEqual(b);
  });
});
