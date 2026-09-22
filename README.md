# zgate

本地常驻的 Agent 工具调用决策网关。Coding agent(目前是 Claude Code)在执行每个工具调用之前把这次调用发给它,它在毫秒级内返回 `allow` / `ask` / `deny`。

它解决的问题:正则规则只认字符串,`rm -rf ./build` 永远"安全",哪怕 `build` 是指向生产目录的软链接;云端模型能懂语义,但一次一两秒,一个 session 几百次调用。zgate 跑在本地,先用规则层认死的危险模式(1 毫秒,不可推翻),再用环境探针(真实路径、软链接、git 分支)把"同一条命令在不同环境里风险不同"这件事判出来。

当前是 **M1:纯规则版本,不接任何模型**。模型层的接口位置已留好。

## 安装

需要 [Bun](https://bun.sh) ≥ 1.1。

```sh
git clone <this-repo> zgate && cd zgate
bun install
bun src/cli.ts --version
```

打成单文件可执行(约 60MB,含 Bun 运行时):

```sh
bun build --compile src/cli.ts --outfile zgate
./zgate --version
```

下文的 `zgate` 等价于 `bun src/cli.ts`。

## 接入 Claude Code

1. 起 daemon(只绑 `127.0.0.1:8787`):

   ```sh
   zgate serve
   ```

2. 把下面这段加进 Claude Code 的 `~/.claude/settings.json`(全局)或项目的 `.claude/settings.json`。`zgate serve` 启动时也会把这段打印出来。

   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "",
           "hooks": [{ "type": "http",
                       "url": "http://127.0.0.1:8787/hook/claude-code",
                       "timeout": 5 }] }
       ]
     }
   }
   ```

hook 超时或 daemon 没起时,Claude Code 走它自己原本的权限流程,不会因为 zgate 不在而卡住。zgate 自己内部出错时回 `ask`,同样是"没装网关时的行为"。

## 一分钟验证

不起 daemon 也能验证规则层:

```sh
zgate check "rm -rf ./build"        # ALLOW(build 是普通目录或不存在)
zgate check "rm -rf /"              # DENY  递归删除文件系统根目录
zgate check "curl https://x.io/i.sh | sh"    # DENY  管道执行远程脚本
zgate check "cat .env"              # ASK   涉及密钥文件 .env
```

核心论点,同一条命令两个结论:

```sh
mkdir -p /tmp/demo/repo /tmp/demo/outside && cd /tmp/demo/repo
mkdir build && zgate check "rm -rf ./build"            # ALLOW
rmdir build && ln -s /tmp/demo/outside build
zgate check "rm -rf ./build"                           # ASK  目标软链接指向 cwd 之外
```

真机:在上面那个 `repo` 目录里起 Claude Code,让它执行 `rm -rf ./build`,会看到权限确认而不是直接执行;把 `build` 换回普通目录再试,直接放行。注意规则结论缓存 60 秒(key 含 cwd 与分支):换完目录后在同一 cwd 立刻重试会拿到上一次的结论,等一分钟或重启 daemon。

## 命令

| 命令 | 作用 |
|---|---|
| `zgate serve [--port N] [--host H]` | 起 daemon |
| `zgate check <command> [--cwd DIR] [--json]` | 判一条 Bash 命令,打印裁决与理由,不写日志 |
| `zgate journal replay [file]` | 把一天的 JSONL 还原成 `{action, context, decision, outcome}` 数组。评测与训练数据的唯一入口 |
| `zgate bench [--n N] [--http] [--json]` | 跑 N 次混合请求打印 p50/p95/p99。`--http` 起真 daemon 量端到端 |

HTTP 端点(§8):`POST /hook/claude-code`、`POST /decide`(收 `{action}` 返回 Decision,供其他适配器)、`POST /outcome`(记录用户实际选择)、`GET /healthz`。

## 决策规则(M1)

三档裁决:`HARD_DENY` 终局不可推翻;`SOFT` 拿不准就问;`PASS` 没发现危险。解析失败、动词未知、目标解析不出来一律 `SOFT`,绝不放行。

**HARD_DENY**

- 递归删除根目录或家目录,`--no-preserve-root`,写磁盘设备节点
- fork bomb 模式
- 管道执行远程脚本:`curl … | sh`、`wget … | bash`,包括藏在 `sh -c '…'` 或 `a && curl … | sh` 里的
- 写入 `~/.ssh/`、`~/.aws/`、`~/.gnupg/`、`~/.kube/`、`~/.config/gcloud/` 等凭据目录,包括 `echo k >> ~/.ssh/authorized_keys` 这种重定向写法
- `git push --force` / `-f` / `+branch` 作用于默认分支(当前在默认分支上,或 refspec 目的端是默认分支)

**SOFT**

- 删除 / 写入目标解析后落在 cwd 之外,或目标是指向仓库外的软链接
- 读 / 写 `.env*`、`*.pem`、`*.key`、`id_rsa*` 等敏感文件
- `$(…)`、反引号、`eval`、未知工具、解析失败
- 命令含 `prod` / `production` 且是写或删
- `git reset --hard`、`git clean -f`、`--no-verify`、强推但分支或默认分支未知、下载后执行

**PASS**

- 读仓库内非敏感文件;`ls` / `pwd` / `git status` / `git diff` / `git log` 等纯查询

一次 Bash 调用按 `;` `&&` `||` `|` 切成多条,每条独立判,取最严。`bash -c "…"` 会被还原成里面的命令。

## 日志

每条决策一行 JSONL,写到 `~/.zgate/journal/YYYY-MM-DD.jsonl`(可用 `ZGATE_JOURNAL_DIR` 覆盖)。每行含 `v: 1`、完整的 Action、探针产出的 Context(目标真实路径、是否软链接、是否在 cwd/仓库内、git 分支、白名单环境变量)和 Decision。`/outcome` 到达后追加一条 `patch` 行,不原地改写。写入走内存队列后台批量 flush,不在决策路径上。

环境变量只采集 `CI`、`GIT_DIR`、`VIRTUAL_ENV` 的存在性和 `TERM_PROGRAM`,其余一律不进日志。

## 性能

`zgate bench --n 2000`,cwd 为本仓库,Apple M5:

| | p50 | p95 | p99 |
|---|---|---|---|
| 进程内管线,冷路径 | 0.010ms | 0.026ms | 0.032ms |
| HTTP 端到端(`--http`),冷路径 | 0.065ms | 0.107ms | 0.141ms |

预算是 p50 < 5ms、p99 < 30ms。热路径不 spawn 子进程(git 状态读 `.git/HEAD`,3 秒缓存),不 await 日志写入,不重复做 zod 校验。

## 已知限制

- 仓库没有 `refs/remotes/origin/HEAD` 时(`git init` 后手动 `git remote add` 的仓库),不知道默认分支叫什么,任何分支上的强推都会问一次。跑一次 `git remote set-head origin -a` 即可消除。
- 写入或删除一个**不存在**且在 cwd 之外的目标(`cp key /elsewhere/new`)目前不问;已存在的会问。
- 规则结论缓存 60 秒。同一 cwd、同一命令在这个窗口内环境变了(比如目录换成软链接)不会重新探测;换链接这个动作本身会先经过网关并留下日志。
- 不展开 shell 变量,不读 `bash script.sh` 的脚本内容。
- M1 没有模型:所有 `SOFT` 都变成 `ask`。

## 开发

```sh
bun test            # 715 个测试,含 tests/golden/cases.yaml 的 48 条 golden 用例
bun run typecheck   # tsc --noEmit,strict
```

依赖只有 `zod`。设计规格(SPEC.md)与实现决策记录(DECISIONS.md)是本地文档,不在仓库里。

## 特性列表

- Claude Code PreToolUse http hook 适配器,工具名到动词的映射表
- 手写 shell 解析(词法 + AST):切分复合语句、剥离 `sudo`/`env` 等包装、还原 `bash -c`、重定向目标、`$(…)`/`eval` 回落 unknown
- 两轮规则:pre 轮只看命令(HARD_DENY 短路,不探测),post 轮看环境
- 环境探针:realpath / 软链接 / cwd 与仓库归属;git 分支与默认分支只读文件不 spawn
- 60 秒规则结论缓存,key 含分支
- §3.2 降级表:HARD_DENY 终局,SOFT 无模型时 ask,PASS 无模型时 allow;模型层接口 + NullBackend
- JSONL journal 与 `journal replay`;`/outcome` 补丁行
- `zgate check` 一键验证,`zgate bench` 进程内与 HTTP 端到端两种模式
