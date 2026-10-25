// K1-B §4.6：节点代理主进程。出站长轮询领活（服务端不连节点、节点不监听），
// 租约心跳与被包裹执行进程的存活探针绑定（S6：进程一死立即停发 Run 心跳）。
//
// 配置只来自环境变量，绝不写进仓库文件：
//   XUXING_SERVER_URL     服务端 base URL（如 http://127.0.0.1:8787）
//   XUXING_NODE_TOKEN     节点令牌（与用户令牌分离，K1-C 双令牌）
//   XUXING_NODE_TOKEN_FILE 可选：令牌文件路径，每次重试重读（401 恢复用）
//   XUXING_NODE_NAME      节点显示名
//   XUXING_NODE_ID_FILE   node_id 持久化文件（缺省 ~/.xuxing-node/node-id）
//   XUXING_RECORDS_DIR    本地执行记录目录（缺省 ~/.xuxing-node/records）
//   XUXING_HANDS_TRANSPORT docker | local（缺省 docker）
//   XUXING_HANDS_CONTAINER 目标容器（缺省 ah1）
//   XUXING_NODE_MAX_LEVEL 节点副作用上限（缺省 L1；L2+ 的 Run 不会被派给它）
//   XUXING_AGENT_MODEL / XUXING_AGENT_TIMEOUT_MS / XUXING_AGENT_RUNS_DIR /
//   XUXING_HANDS_USER  见 src/agent-executor.mjs 与 README。
//
// 多执行器（K0-Q25）：注册 kinds = shell ∪ agent；executeRun 按
// envelope.executor_kind 选执行器，未知 kind → nack 后结束（不 ack）。
// isAlive / cancel / probe 优先按 run_id → executor 映射路由；probe 无映射时
// 先查 agent records、再查 shell records（节点重启后的对账路径）。records 的
// started.json 带 executor_kind 标记，hasRecord 只认领同 kind 的记录，跨执行器
// 不误归属；无标记的历史记录按存在处理（向后兼容）。
//
// 401 行为（K1C-AC-09，写死）：记一条含 401 的日志（带时间戳）→ 暂停轮询、
// 指数退避（5s 起、倍增、上限 60s）→ 令牌更新后自动恢复，进程不退出。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAgentHandsShellExecutor } from './executors.mjs';
import { createAgentHandsAgentExecutor } from './agent-executor.mjs';

const env = process.env;
const SERVER_URL = (env.XUXING_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const NODE_NAME = env.XUXING_NODE_NAME ?? 'agent-hands-node';
const NODE_HOME = join(homedir(), '.xuxing-node');
const NODE_ID_FILE = env.XUXING_NODE_ID_FILE ?? join(NODE_HOME, 'node-id');
const RECORDS_DIR = env.XUXING_RECORDS_DIR ?? join(NODE_HOME, 'records');
const POLL_WAIT_SEC = Number(env.XUXING_POLL_WAIT_SEC ?? '20');
const NODE_HEARTBEAT_MS = Number(env.XUXING_NODE_HEARTBEAT_MS ?? '10000');
const RUN_HEARTBEAT_MS = Number(env.XUXING_RUN_HEARTBEAT_MS ?? '15000');

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

function currentToken() {
  if (env.XUXING_NODE_TOKEN_FILE && existsSync(env.XUXING_NODE_TOKEN_FILE)) {
    return readFileSync(env.XUXING_NODE_TOKEN_FILE, 'utf8').trim();
  }
  return env.XUXING_NODE_TOKEN ?? '';
}

class Unauthorized extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${currentToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Unauthorized(`401 from ${method} ${path}`);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 响应按失败处理 */
  }
  if (!response.ok || parsed === null || parsed.ok !== true) {
    const message = parsed?.error?.message ?? `HTTP ${response.status}`;
    const error = new Error(`${method} ${path}: ${message}`);
    error.status = response.status;
    error.detail = parsed?.error?.detail ?? null;
    throw error;
  }
  return parsed.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withAuthBackoff(fn, label) {
  let backoffMs = 5000;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Unauthorized) {
        // K1C-AC-09：记录（含 401 与时间戳）→ 退避 → 自动重试，进程不退出。
        log('auth_unauthorized', { label, status: 401, backoff_ms: backoffMs, action: 'pause_and_retry' });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
        continue;
      }
      throw error;
    }
  }
}

function loadNodeId() {
  if (existsSync(NODE_ID_FILE)) return readFileSync(NODE_ID_FILE, 'utf8').trim() || null;
  return null;
}

function saveNodeId(nodeId) {
  mkdirSync(dirname(NODE_ID_FILE), { recursive: true });
  writeFileSync(NODE_ID_FILE, nodeId);
}

async function main() {
  mkdirSync(RECORDS_DIR, { recursive: true });
  const shellExecutor = createAgentHandsShellExecutor({
    transport: env.XUXING_HANDS_TRANSPORT ?? 'docker',
    container: env.XUXING_HANDS_CONTAINER ?? 'ah1',
    recordsDir: RECORDS_DIR,
    maxSideEffectLevel: env.XUXING_NODE_MAX_LEVEL ?? 'L1',
  });
  const agentExecutor = createAgentHandsAgentExecutor({
    transport: env.XUXING_HANDS_TRANSPORT ?? 'docker',
    container: env.XUXING_HANDS_CONTAINER ?? 'ah1',
    recordsDir: RECORDS_DIR,
    maxSideEffectLevel: env.XUXING_NODE_MAX_LEVEL ?? 'L1',
  });
  const executors = [shellExecutor, agentExecutor];
  const byKind = new Map(executors.map((executor) => [executor.kind, executor]));
  const nodeCapabilities = {
    executor_kinds: [...new Set(executors.flatMap((executor) => executor.capabilities().executor_kinds))],
    max_side_effect_level: env.XUXING_NODE_MAX_LEVEL ?? 'L1',
  };

  const registration = await withAuthBackoff(
    () =>
      api('/api/nodes/register', {
        method: 'POST',
        body: {
          node_id: loadNodeId() ?? undefined,
          display_name: NODE_NAME,
          executor_kinds: nodeCapabilities.executor_kinds,
          max_side_effect_level: nodeCapabilities.max_side_effect_level,
          agent_version: 'xuxing-node-agent/0.2.0',
        },
      }),
    'register',
  );
  const nodeId = registration.node_id;
  saveNodeId(nodeId);
  log('registered', {
    node_id: nodeId,
    server: SERVER_URL,
    transport: env.XUXING_HANDS_TRANSPORT ?? 'docker',
    executor_kinds: nodeCapabilities.executor_kinds,
  });

  const heartbeatTimer = setInterval(() => {
    void withAuthBackoff(() => api(`/api/nodes/${nodeId}/heartbeat`, { method: 'POST', body: {} }), 'heartbeat').catch((e) =>
      log('heartbeat_failed', { message: String(e) }),
    );
  }, NODE_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  const running = new Map(); // run_id -> Promise（执行中）
  const runExecutors = new Map(); // run_id -> executor（存活/取消/对账路由）
  const canceling = new Set(); // 已收到 cancel 请求、等待 cancel-confirmed 的 run_id

  /** probe 路由口径：有 run_id 映射用映射；否则先 agent records、再 shell records。 */
  function executorForRun(runId, idempotencyKey) {
    const mapped = runExecutors.get(runId);
    if (mapped) return mapped;
    for (const executor of [agentExecutor, shellExecutor]) {
      if (typeof executor.hasRecord === 'function' && executor.hasRecord(idempotencyKey)) return executor;
    }
    return shellExecutor;
  }

  async function executeRun(envelope) {
    const runId = envelope.run_id;
    const executor = byKind.get(envelope.executor_kind);
    if (!executor) {
      // 未知执行器：本节点不 ack（把单子放回队列），只回报原因。
      log('executor_kind_not_supported', { run_id: runId, executor_kind: envelope.executor_kind ?? null });
      await api(`/api/nodes/${nodeId}/runs/${runId}/nack`, {
        method: 'POST',
        body: { reason: 'executor_kind_not_supported' },
      }).catch((e) => log('nack_failed', { run_id: runId, message: String(e) }));
      return;
    }
    // F3 修复：try/finally 覆盖从 ack 起的全流程（含 ack/started 阶段与 runExecutors.set），
    // 任何异常路径都回收 runExecutors / running / canceling 与心跳计时器。
    let acked = false;
    let heartbeatTimer2 = null;
    try {
      await api(`/api/nodes/${nodeId}/runs/${runId}/ack`, { method: 'POST', body: {} });
      acked = true;
      runExecutors.set(runId, executor);
      const dispatchPromise = executor.dispatch(envelope, {
        sideEffectNote: (note) => api(`/api/nodes/${nodeId}/runs/${runId}/side-effect-note`, { method: 'POST', body: note }),
      });
      await api(`/api/nodes/${nodeId}/runs/${runId}/started`, { method: 'POST', body: {} });
      log('run_started', { run_id: runId, executor_kind: executor.kind });

      // S6：Run 心跳与执行进程存活探针绑定——进程退出即刻停发。
      heartbeatTimer2 = setInterval(() => {
        if (!executor.isAlive(runId)) {
          clearInterval(heartbeatTimer2);
          return;
        }
        void api(`/api/nodes/${nodeId}/runs/${runId}/heartbeat`, { method: 'POST', body: {} }).catch((e) =>
          log('run_heartbeat_failed', { run_id: runId, message: String(e) }),
        );
      }, RUN_HEARTBEAT_MS);
      heartbeatTimer2.unref?.();

      const result = await dispatchPromise;
      if (canceling.has(runId)) {
        // 取消路径由 cancel-confirmed 落终态；这里不再 raw-result（避免 RunFailed
        // 抢先于 RunCanceled 的竞态）。
        log('run_result_skipped_after_cancel', { run_id: runId });
        return;
      }
      const receipt = await api(`/api/nodes/${nodeId}/runs/${runId}/raw-result`, {
        method: 'POST',
        body: {
          client_result_id: `res:${envelope.idempotency_key}`,
          outcome_hint: result.outcome_hint,
          summary: result.summary,
          ...(typeof result.raw_result_ref === 'string' ? { raw_result_ref: result.raw_result_ref } : {}),
        },
      });
      log('run_result_reported', { run_id: runId, run_state: receipt.run_state });
    } catch (error) {
      log('run_execution_error', { run_id: runId, message: String(error) });
      // 执行框架自身出错（非命令失败）：以 failed 回报，避免 Run 悬挂到租约过期。
      // ack 未成功时不回报（该 Run 尚未被本节点认领，交给租约过期重派）。
      if (acked) {
        await api(`/api/nodes/${nodeId}/runs/${runId}/raw-result`, {
          method: 'POST',
          body: { client_result_id: `res:${envelope.idempotency_key}`, outcome_hint: 'failed', summary: `agent error: ${String(error)}` },
        }).catch(() => undefined);
      }
    } finally {
      if (heartbeatTimer2 !== null) clearInterval(heartbeatTimer2);
      canceling.delete(runId);
      runExecutors.delete(runId);
      running.delete(runId);
    }
  }

  log('polling', { node_id: nodeId, wait_sec: POLL_WAIT_SEC });
  for (;;) {
    try {
      const poll = await withAuthBackoff(
        () => api(`/api/nodes/${nodeId}/dispatch-poll?wait=${POLL_WAIT_SEC}`),
        'dispatch-poll',
      );
      for (const runId of poll.cancel_requests ?? []) {
        log('cancel_requested', { run_id: runId });
        canceling.add(runId);
        const target = runExecutors.get(runId);
        if (target) {
          await target.cancel(runId);
        } else {
          // 节点重启后映射丢失：两个执行器都尝试取消（幂等，找不到即 no-op）。
          await Promise.all(executors.map((executor) => executor.cancel(runId)));
        }
        // 给进程一点退出时间再确认；进程已不在也照常确认（幂等口径在服务端）。
        await sleep(300);
        await api(`/api/nodes/${nodeId}/runs/${runId}/cancel-confirmed`, { method: 'POST', body: {} }).catch((e) =>
          log('cancel_confirm_failed', { run_id: runId, message: String(e) }),
        );
        // F2 修复：非运行中的 Run 不会被 executeRun 的 finally 清理，取消处理完毕
        // （已确认）后自行摘除 canceling 标记，避免 Set 残留。
        // 仍在 running 里（如 ack 阶段、runExecutors 尚未写入）时不摘除，等 executeRun
        // 的 finally 处理，避免丢掉抢先到达的取消意图。
        if (!runExecutors.has(runId) && !running.has(runId)) canceling.delete(runId);
      }
      for (const probe of poll.probe_requests ?? []) {
        // records 以信封幂等键 `run:<run_id>` 落盘（不是服务端 probe 幂等键）。
        const recordKey = `run:${probe.run_id}`;
        const executor = executorForRun(probe.run_id, recordKey);
        const result = await executor.probe(probe.run_id, recordKey);
        log('probe_answered', { run_id: probe.run_id, result, executor_kind: executor.kind });
        await api(`/api/nodes/${nodeId}/runs/${probe.run_id}/probe-result`, {
          method: 'POST',
          body: { idempotency_key: probe.idempotency_key, result },
        }).catch((e) => log('probe_report_failed', { run_id: probe.run_id, message: String(e) }));
      }
      if (poll.dispatch && !running.has(poll.dispatch.run_id)) {
        const promise = executeRun(poll.dispatch).catch((e) => log('run_pipeline_failed', { message: String(e) }));
        running.set(poll.dispatch.run_id, promise);
      }
    } catch (error) {
      log('poll_loop_error', { message: String(error) });
      await sleep(2000);
    }
  }
}

main().catch((error) => {
  log('fatal', { message: String(error) });
  process.exit(1);
});
