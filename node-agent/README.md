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
dispatch / cancel / probe）。首个执行器 `agent_hands_shell`：执行
`input_snapshot.command`，`input_snapshot.note_side_effect` 存在时在执行
开始先回报一条副作用记录；Run 心跳与被包裹进程存活探针绑定（进程退出
即刻停发）。大产物不回传，只回摘要（raw-result 的 summary）。
