# xuxing node-agent（K1-B 本地执行节点）

续行 K1 的本地执行节点代理：独立进程，只出站长轮询服务端领活，不监听任何
端口。注册/心跳/派发/回报端点与协议见 K1-SPEC §4 与
`docs/interaction-contract.md` K1 附则。

## 运行

```bash
XUXING_SERVER_URL=http://127.0.0.1:8787 \
XUXING_NODE_TOKEN=<节点令牌> \
XUXING_NODE_NAME=agent-hands-1 \
XUXING_HANDS_TRANSPORT=docker \
XUXING_HANDS_CONTAINER=ah1 \
node src/agent.mjs
```

- 配置只来自环境变量，令牌绝不写进仓库文件；可用
  `XUXING_NODE_TOKEN_FILE` 指向令牌文件（401 退避重试时每次重读，
  换令牌后自动恢复，进程不退出）。
- `XUXING_HANDS_TRANSPORT=local` 时在本机 bash 直接执行（CI/无 Docker
  环境）；`docker` 时经 `docker exec <容器>` 在 agent-hands 容器内执行。
- node_id 持久化在 `XUXING_NODE_ID_FILE`（缺省 `~/.xuxing-node/node-id`），
  重启复用同一身份；执行记录在 `XUXING_RECORDS_DIR`（缺省
  `~/.xuxing-node/records`），按 Run 幂等键落盘供 probe 对账判定。

## 执行器

`src/executors.mjs` 的 ExecutorAdapter 接口（kind / capabilities /
dispatch / cancel / probe / readRecord）。节点注册的 `executor_kinds` 是
各执行器的并集（`agent_hands_shell` + `agent_hands_agent`），上限 L1。
`src/agent.mjs` 按 `envelope.executor_kind` 路由；未知 kind → POST nack
（`reason=executor_kind_not_supported`）后结束，不 ack。`isAlive` / `cancel`
按 run_id → executor 映射路由；probe 无映射时先查 agent records、再查
shell records（节点重启后的对账路径）。

### `agent_hands_shell`

执行 `input_snapshot.command`，`input_snapshot.note_side_effect` 存在时在
执行开始先回报一条副作用记录；Run 心跳与被包裹进程存活探针绑定（进程退出
即刻停发）。大产物不回传，只回摘要（raw-result 的 summary）。

### `agent_hands_agent`（K0-Q25）

`src/agent-executor.mjs`：把一条 Run 变成 ah1 容器内的一次性 opencode
任务。records 口径与 shell 完全同构（`recordsDir/<sanitized idempotency_key>/
{started.json,result.json}`）。

流程：登记 `opencode` 副作用事实 → 组装 `PROMPT.md`（base64 传入容器）→
按 `input_snapshot.workspace` 准备 git worktree（`medivhc/xuxing` / `xuxing`
从 `/home/dev/xuxing` fetch 后 `git worktree add`；`null` 用空目录；其他 repo
直接 failed）→ `tmux new-session` 跑 `opencode run` → node 侧 watcher 等
tmux 会话结束（`isAlive` 绑定 watcher）→ 采集 `output.log` 尾部与
git log/diff/branch → 写 `result.json`。成功回报
`raw_result_ref=agent-run://<idempotency_key>`；超时/非 0 退出/框架错误一律
`outcome_hint=failed`，超时 summary 以 `TIMEOUT ` 开头。

配置（env）：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `XUXING_AGENT_MODEL` | `opencode-go/deepseek-v4.1-flash` | opencode 模型路由（禁止 magpie workbuddy-ai） |
| `XUXING_AGENT_TIMEOUT_MS` | `1800000` | 单 Run 超时（`snapshot.timeout_ms` 优先，服务端限定 5s–1h） |
| `XUXING_AGENT_RUNS_DIR` | `/home/dev/xuxing-runs` | 容器内每 Run 工作区根目录 |
| `XUXING_HANDS_USER` | `dev` | 容器内执行用户（worktree/records 属主） |
| `XUXING_AGENT_AUTH_FILE` | `/home/<HANDS_USER>/.local/share/opencode/auth.json` | 容器内 opencode 凭据文件；启动时只抽 `opencode-go` 键注入 `OPENCODE_API_KEY`，不落配置、不打印 |
| `XUXING_AGENT_OPENCODE_BIN` | `/home/<HANDS_USER>/.opencode/bin/opencode` | 容器内 opencode 可执行文件（安装脚本不改进 PATH，故用绝对路径） |

并发口径：不做 executor 内串行化；每 Run 独立 tmux session + git worktree，
并发 N 条即 N 个 worktree 与 N 个 opencode 进程，资源占用线性增长。worktree
只留在 ah1 的 runs 目录，`xu-agent/*` 分支只在 ah1 clone 内，不 push。

ah1 一次性准备（opencode、模型配置、令牌最小化拷贝、runs 目录、冒烟）见
`node-agent/provision-ah1.sh`；脚本幂等，令牌只做机对机搬运、不打印值。

