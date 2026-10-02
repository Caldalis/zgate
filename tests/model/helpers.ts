// 模型层测试共用:mock HTTP server 与最小 ModelRequest。
import { ActionSchema, type Action } from "../../src/core/action.ts";
import type { Context } from "../../src/core/context.ts";
import type { ModelRequest } from "../../src/core/model.ts";

export function request(over: Partial<Action> = {}): ModelRequest {
  const action = ActionSchema.parse({
    verb: "delete",
    targets: [{ kind: "file", raw: "./build" }],
    command: null,
    tool_name: "Bash",
    tool_input: { command: "rm -rf ./build" },
    agent: { name: "claude-code", version: null, session_id: null },
    cwd: "/repo",
    turn_id: "t",
    ...over,
  }) as Action;
  const context: Context = {
    resources: [{ raw: "./build", resolved: "/outside", exists: true, is_symlink: true, symlink_target: "/outside", is_dir: true, inside_cwd: false, inside_repo: false, gitignored: null }],
    repo: { is_repo: true, root: "/repo", branch: "main", is_dirty: null, default_branch: "main" },
    env_hints: {},
    elapsed_ms: 0.1,
  };
  return { action, context, flaggedRule: "fs.outside_cwd", policy: null };
}

export interface Seen {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface MockServer {
  readonly url: string;
  readonly seen: Seen[];
  stop(): void;
}

/** 起一个只认 POST 的 mock,handler 决定响应;每次请求都记下来供断言。 */
export function mockServer(
  handler: (seen: Seen, index: number) => Response | Promise<Response>,
): MockServer {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const s: Seen = { path: new URL(req.url).pathname, headers: req.headers, body };
      seen.push(s);
      return handler(s, seen.length - 1);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => void server.stop(true),
  };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** llama-server /v1/chat/completions 的响应形状(实测 llama.cpp b10964)。 */
export function llamaResponse(
  content: string,
  logprobs: { allow?: number; ask?: number } | null,
): unknown {
  const first = content.trim();
  const top = Object.entries(logprobs ?? {})
    .filter(([w]) => w !== first)
    .map(([token, logprob]) => ({ id: 1, token, bytes: [], logprob }));
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { role: "assistant", content },
        ...(logprobs === null
          ? {}
          : {
              logprobs: {
                content: [
                  { id: 0, token: first, bytes: [], logprob: logprobs[first as "allow" | "ask"] ?? -99, top_logprobs: top },
                  { id: 2, token: "", bytes: [], logprob: -0.00001, top_logprobs: [] },
                ],
              },
            }),
      },
    ],
    usage: { prompt_tokens: 400, completion_tokens: 2, total_tokens: 402 },
  };
}

export const never = (): Promise<Response> => new Promise(() => {});
