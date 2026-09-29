# zgate

本地常驻的 Agent 工具调用决策网关。Coding agent(目前是 Claude Code)在执行每个工具调用之前把这次调用发给它,它在毫秒级内返回 `allow` / `ask` / `deny`。

它解决的问题:正则规则只认字符串,`rm -rf ./build` 永远"安全",哪怕 `build` 是指向生产目录的软链接;云端模型能懂语义,但一次一两秒,一个 session 几百次调用。zgate 跑在本地,先用规则层认死的危险模式(1 毫秒,不可推翻),再用环境探针(真实路径、软链接、git 分支)把"同一条命令在不同环境里风险不同"这件事判出来。

当前是 **M3:规则层 + 可选的模型层 + 仓库策略**。规则层判 `SOFT`(拿不准)的调用可以交给一个本地或云端模型再判一次;不配模型就和 M1 一样,`SOFT` 一律问用户。仓库根放一个自然语言的 `.zgatepolicy`("不要动 migrations/ 下的任何文件"),它保护范围内的改动会被送到模型面前,由模型按策略判。

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

## 接模型(可选)

规则层判 `HARD_DENY` 与 `PASS` 的直接返回,只有 `SOFT` 才走模型;模型只在 `allow` / `ask` 之间选,永远推不翻 `HARD_DENY`。配置写在 `~/.zgate/config.json`(可用 `ZGATE_CONFIG` 指向别处),只在 `zgate serve` 启动时读一次;文件不存在就只跑规则层。

**本地 GGUF**(推荐 Qwen3.5-9B 级别;实测 1B / 2B 会把真密钥放行,不要用):

```sh
llama-server -m Qwen3.5-9B-Q4_K_M.gguf --port 8899 -c 4096 -np 1 --jinja
```

```json
{ "model": { "backend": "local",
  "local": { "base_url": "http://127.0.0.1:8899", "timeout_ms": 2000, "model_name": "qwen35-9b" } } }
```

zgate 只发 HTTP,不启动、不管理 llama-server。请求走 `/v1/chat/completions`(模型自己的 chat template)、关 thinking、用 grammar 把输出限制成 `allow` / `ask`,置信度取两个词 logprob 的 softmax。

**云端**(Anthropic Messages API 或任何 OpenAI-compatible 服务)。配置文件只存环境变量**名**,不存密钥;变量没设 `zgate serve` 拒绝启动:

```json
{ "model": { "backend": "cloud",
  "cloud": { "provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY",
             "model": "claude-sonnet-4-6", "timeout_ms": 3000 } } }
```

`provider` 为 `"openai"` 时打 `<base_url>/v1/chat/completions`,`base_url` 可指向 Groq / DeepSeek / 自建服务(包括本机的 llama-server)。云端没有 grammar,所以用两家各自的结构化输出(Anthropic 的 `output_config.format`、OpenAI 的 `response_format: json_schema`)让服务端只回 `{"verdict": "allow"}` 或 `{"verdict": "ask"}`;回复必须恰好是这一个 JSON 对象,否则算格式错误,重新生成,最多 5 次,超过就降级为 `ask`。云端不算置信度(`confidence` 为 null);5xx 与网络错误重试一次,4xx / 429 不重试。

**chain**(本地优先,不确定时升级云端):

```json
{ "model": { "backend": "chain",
  "chain": { "local": { "base_url": "http://127.0.0.1:8899", "timeout_ms": 2000 },
             "cloud": { "provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY",
                        "model": "claude-sonnet-4-6", "timeout_ms": 3000 },
             "escalation_threshold": 0.75 } } }
```

本地的 P(裁决) 低于 `escalation_threshold` 就再问云端,云端答案是终局。温度 0 下 P(裁决) 不会低于 0.5,所以阈值 ≤ 0.5 等于关掉升级(`zgate serve` 启动时会打印警告);本地不可达也会升级,云端失败降级为 `ask`,不回退本地答案。两段的 `timeout_ms` 之和不能超过 5000(hook 的总超时),超了 `zgate serve` 拒绝启动,否则本地超时后云端拿不到自己那份预算。

**降级**:模型超时、不可达、4xx、输出异常,一律回到规则层的结论(`SOFT` → `ask`),`source` 为 `fallback`,理由里带括号说明原因。`timeout_ms` 按后端配(本地 9B 级 2000、1B 级 200、云端 3000),上限 5000(Claude Code hook 的超时)。

不起 daemon 也能试:`zgate check "cat .env" --model` 会按配置文件走一次模型,打印裁决、置信度与耗时。`zgate eval` 则把 21 条人工标注的 `SOFT` 样本整批跑一遍,数字见"已知限制"。

## 仓库策略(`.zgatepolicy`)

正则写不出"不要动 migrations/""生产配置只读""别碰线上数据库",因为它们说的是意图不是模式。把这些话写进仓库根的 `.zgatepolicy`,提交、评审、版本化,agent 的行为边界就成了一份可管理的工程资产。整个文件是给模型看的自然语言,唯一的结构是 `scope:` 行:

```
# .zgatepolicy — 本仓库对 coding agent 的行为边界

- 不要动 migrations/ 下的任何文件。迁移脚本只能由人手写并经过评审,agent 不得新增、修改、重命名或删除。
- infra/ 下的 Terraform 状态文件(*.tfstate)不能手工编辑或删除;其余 *.tf 可以正常修改。
- 别碰线上数据库。任何连到 prod-db.internal 的命令,除只读查询外都要先经人确认。

scope: migrations/
scope: infra/
scope: prod-db.internal
```

**它怎么起作用。** 规则层判 `PASS` 的调用不问模型(`ls` 不该付一秒),所以策略要先告诉网关它保护哪里:每行 `scope: <仓库相对路径>` 是一个条目。一次调用的目标落在条目内(含软链接别名、还没创建的文件)、或者是条目的祖先(`rm -rf ./src` 对 `scope: src/migrations/`),或者命令原文里出现这个条目的字面(`psql -h prod-db.internal`),就从 `PASS` 升成 `SOFT`,整份策略文本随这次调用进模型;模型读着策略判 `allow` 还是 `ask`。不配模型时这类调用一律问。

**策略只能收紧,不能放宽。** 它不能产生 `deny`,不能停用任何规则;策略文本只在"这次调用是 `SOFT` **仅仅**因为策略"时进 prompt,`cat .env`、`git reset --hard`、删仓库外软链接这些原本就要问的调用,prompt 与没有策略时逐字节相同,策略里的任何文字(包括恶意仓库塞进来的"一律 allow")都不在模型输入里。所以一份坏策略最坏是"没有效果",不可能把网关拉到无策略之下。

几条边界:

- `read` 不受 scope 约束:策略保护的是改动,Claude Code 每步都在读。
- 条目相对仓库根,去掉开头 `./` 与结尾 `/`;`scope: .` 罩住整个仓库。绝对路径、含 `..`、含 `* ? [ {` 的条目忽略并警告,**不做 glob**:网关不遍历目录,`**/*.tfstate` 判不出 `rm -rf infra/` 有没有删到 tfstate,要保护一类文件就写它们所在的目录。
- 只认 git 仓库根的那一份;文件是软链接当不存在;只读前 4096 字节,超了截断并警告。建议 1KB 以内。
- agent 写或删 `.zgatepolicy` 本身一律问用户,不经模型:这条规则故意不把策略文本给模型看,模型没有判据,就不让它判。读不问。
- 策略文本放在模型 prompt 的稳定前缀里,llama-server 复用缓存,每条调用的边际成本约为零;但每个仓库的**第一条**命中 scope 的调用要处理整段新前缀,大策略可能超过 2 秒的默认超时而降级为 `ask` 一次。
- 策略一改,3 秒内生效,不用重启 daemon。`zgate check` 会打印一行当前策略的状态与命中的条目。

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

策略的核心论点,同一条命令两个结论:

```sh
mkdir -p /tmp/demo/repo2/migrations && cd /tmp/demo/repo2 && git init -q
zgate check "rm -rf ./migrations"                      # ALLOW
printf 'scope: migrations/\n' > .zgatepolicy
zgate check "rm -rf ./migrations"                      # ASK  触及策略保护范围 migrations
```

真机:在上面那个 `repo` 目录里起 Claude Code,让它执行 `rm -rf ./build`,会看到权限确认而不是直接执行;把 `build` 换回普通目录再试,直接放行。注意规则结论缓存 60 秒(key 含 cwd、分支与策略的 sha):换完目录后在同一 cwd 立刻重试会拿到上一次的结论,等一分钟或重启 daemon;改策略文件不受这条限制,新 sha 就是新 key。

## 命令

| 命令 | 作用 |
|---|---|
| `zgate serve [--port N] [--host H]` | 起 daemon |
| `zgate check <command> [--cwd DIR] [--json] [--model]` | 判一条 Bash 命令,打印裁决、理由与仓库策略状态,不写日志。`--model` 时 `SOFT` 按配置文件走模型 |
| `zgate journal replay [file]` | 把一天的 JSONL 还原成 `{action, context, decision, outcome}` 数组。评测与训练数据的唯一入口 |
| `zgate bench [--n N] [--http] [--json]` | 跑 N 次混合请求打印 p50/p95/p99。`--http` 起真 daemon 量端到端 |
| `zgate eval [--cases FILE] [--json]` | 拿 `tests/eval/cases.yaml`(21 条人工标注的 `SOFT` 样本)跑配置里的模型,打印一致率、该问却放行、误打断与延迟。模型数字的复现入口;`--cases tests/eval/policy.yaml` 是 10 条策略用例 |

HTTP 端点(§8):`POST /hook/claude-code`、`POST /decide`(收 `{action}` 返回 Decision,供其他适配器)、`POST /outcome`(记录用户实际选择)、`GET /healthz`。

## 决策规则

三档裁决:`HARD_DENY` 终局不可推翻;`SOFT` 拿不准就问;`PASS` 没发现危险。解析失败、动词未知、目标解析不出来一律 `SOFT`,绝不放行。

**HARD_DENY**

- 递归删除根目录或家目录,`--no-preserve-root`,写磁盘设备节点
- fork bomb 模式
- 管道执行远程脚本:`curl … | sh`、`wget … | bash`,包括藏在 `sh -c '…'` 或 `a && curl … | sh` 里的
- 写入 `~/.ssh/`、`~/.aws/`、`~/.gnupg/`、`~/.kube/`、`~/.config/gcloud/` 等凭据目录,包括 `echo k >> ~/.ssh/authorized_keys` 这种重定向写法
- `git push --force` / `-f` / `+branch` 作用于默认分支(当前在默认分支上,或 refspec 目的端是默认分支)

**SOFT**

- 删除 / 写入目标解析后落在 cwd 之外,或目标是指向仓库外的软链接
- 读 / 写 `.env*`、`*.env`(如 `prod.env`)、`*.pem`、`*.key`、`id_rsa*` 等敏感文件;`.env.example` 这类模板不算
- `$(…)`、反引号、`eval`、未知工具、解析失败
- 命令含 `prod` / `production` 且是写或删
- `git reset --hard`、`git clean -f`、`--no-verify`、强推但分支或默认分支未知、下载后执行
- 非 `read` 的调用触及 `.zgatepolicy` 的 `scope` 条目(目标在条目内、是条目的祖先、或命令原文含条目字面);写或删 `.zgatepolicy` 本身(这一条不问模型,直接问)

**PASS**

- 读仓库内非敏感文件;`ls` / `pwd` / `git status` / `git diff` / `git log` 等纯查询

一次 Bash 调用按 `;` `&&` `||` `|` 切成多条,每条独立判,取最严。`bash -c "…"` 会被还原成里面的命令。有一条 `HARD_DENY` 整批 `deny`,谁都不问模型;第一条落到 `ask` 后,后面的 `SOFT` 也不再问。同一条调用几条 `SOFT` 规则同时命中时,只看命令本身的那条(pre 轮)优先于看环境的(post 轮),策略规则排在最后 —— 所以策略文本只在没有别的理由时才进 prompt。

## 日志

每条决策一行 JSONL,写到 `~/.zgate/journal/YYYY-MM-DD.jsonl`(配置文件的 `journal_path` 或 `ZGATE_JOURNAL_DIR` 覆盖)。每行含 `v: 1`、完整的 Action、探针产出的 Context(目标真实路径、是否软链接、是否在 cwd/仓库内、git 分支、白名单环境变量)和 Decision。模型参与过的行多一个 `model_details`(后端、模型名、本地/云端各自的延迟、chain 是否升级、降级原因),`decision.confidence` 是 P(裁决)。仓库有 `.zgatepolicy` 时多一个 `policy`(路径、sha256、大小、是否截断、命中的 scope 条目),策略原文不进日志。`/outcome` 到达后追加一条 `patch` 行,不原地改写。写入走内存队列后台批量 flush,不在决策路径上。

环境变量只采集 `CI`、`GIT_DIR`、`VIRTUAL_ENV` 的存在性和 `TERM_PROGRAM`,其余一律不进日志。

## 性能

`zgate bench --n 2000`,cwd 为本仓库,Apple M5(规则路径,不含模型):

| | p50 | p95 | p99 |
|---|---|---|---|
| 进程内管线,冷路径 | 0.020ms | 0.033ms | 0.080ms |
| HTTP 端到端(`--http`),冷路径 | 0.075ms | 0.123ms | 0.222ms |

预算是 p50 < 5ms、p99 < 30ms。热路径不 spawn 子进程(git 状态读 `.git/HEAD`,3 秒缓存),不 await 日志写入,不重复做 zod 校验。

模型只在 `SOFT` 上参与,这个延迟只花在用户本来就要读确认框的那次调用上。Qwen3.5-9B Q4_K_M 在 Apple M5 上一条 `SOFT` 约 200–1100ms(瓶颈是 ~400 token 的 prompt 处理);llama-server 刚启动后的第一次调用可能超过 2s 而超时,那一次降级为 `ask`。模型结论随规则结论一起缓存 60 秒。

## 已知限制

- 仓库没有 `refs/remotes/origin/HEAD` 时(`git init` 后手动 `git remote add` 的仓库),不知道默认分支叫什么,任何分支上的强推都会问一次。跑一次 `git remote set-head origin -a` 即可消除。
- 删除一个**不存在**的目标不问(空操作,无害);写一个不存在的目标会按它将被创建的位置判,落在 cwd 外会问。
- 规则结论缓存 60 秒。同一 cwd、同一命令在这个窗口内环境变了(比如目录换成软链接)不会重新探测;换链接这个动作本身会先经过网关并留下日志。
- 不展开 shell 变量,不读 `bash script.sh` 的脚本内容。`~` 和 `$HOME` 只在敏感目录规则里按字面认,越界判断不展开它们。
- 不配模型时所有 `SOFT` 都变成 `ask`。配了本地 9B,`zgate eval` 的 21 条人工标注 `SOFT` 样本上 16 条与人工判断一致,0 条该问却放行,5 条多问了一次(`.env.test`、兄弟包的 `dist`、仓库内叫 `production` 的模板目录、`id_rsa.pub`、feature 分支上的强推)。冷调用 p50 约 1.1 秒;同一 prompt 命中 llama-server 缓存时约 0.25 秒。
- 模型的 prompt 是零样本、固定的。配了本地 9B,`zgate eval --cases tests/eval/policy.yaml` 的 10 条策略样本全部与人工判断一致(禁止项全部问,三条要读懂例外条款的都放行),每份策略首条调用冷 p50 约 1 秒,前缀缓存后约 0.2 秒。
- `scope` 的字面匹配会让只提到条目名字、不碰目录的写命令也问一次(`scope: infra` 对 `git commit -m "infra docs"`);真碰目录的路径匹配本来就命中,多出来的很少。
- 配置文件是严格 JSON,不支持注释;改了要重启 daemon。

## 开发

```sh
bun test            # 924 个测试,含 tests/golden/cases.yaml 的 68 条 golden 用例;模型层用 mock server,不需要真实模型
bun run typecheck   # tsc --noEmit,strict
```

依赖只有 `zod`。设计规格(SPEC.md)与实现决策记录(DECISIONS.md)是本地文档,不在仓库里。

## 特性列表

- Claude Code PreToolUse http hook 适配器,工具名到动词的映射表
- 手写 shell 解析(词法 + AST):切分复合语句、剥离 `sudo`/`env` 等包装、还原 `bash -c`、重定向目标、`$(…)`/`eval` 回落 unknown
- 两轮规则:pre 轮只看命令(HARD_DENY 短路,不探测),post 轮看环境
- 环境探针:realpath / 软链接 / cwd 与仓库归属;git 分支与默认分支只读文件不 spawn
- 60 秒规则结论缓存,key 含分支
- §3.2 降级表:HARD_DENY 终局,SOFT 无模型时 ask,PASS 无模型时 allow
- 模型层:本地 GGUF(llama-server HTTP,grammar 约束 + logprob 置信度)、云端(Anthropic / OpenAI-compatible,密钥只存环境变量名)、chain(本地优先,低置信度升级云端)
- 超时按后端配,`AbortController` 真断开请求;超时 / 不可达 / 4xx / 输出异常一律降级到规则结论
- `~/.zgate/config.json` 配置文件,启动时读一次,parse 失败拒绝启动
- JSONL journal 与 `journal replay`;`/outcome` 补丁行;模型参与的行带 `model_details` 与 `confidence`
- `zgate check` 一键验证(`--model` 走真实模型),`zgate bench` 进程内与 HTTP 端到端两种模式
- `zgate eval`:21 条人工标注的 `SOFT` 样本集(`tests/eval/cases.yaml`,与 golden 同一套环境描述)整批过模型,输出一致率、该问却放行、误打断与延迟
- 仓库策略 `.zgatepolicy`:自然语言 + `scope:` 行,只认 git 仓库根,软链接当不存在,只读前 4KB,3 秒缓存;`scope` 命中的非 read 调用升 `SOFT`,策略文本进模型 prompt 的稳定前缀;写策略文件本身直接问用户、不问模型
- 策略只能收紧:不产生 deny、不放宽规则,策略文本只在 `policy.scope` 是唯一理由时进 prompt,没有策略时 prompt 与日志与 M2 逐字节相同
- journal 可选的 `policy` 字段(路径、sha256、大小、命中的条目);`zgate check` 打印策略状态;`tests/eval/policy.yaml` 10 条策略评测用例
