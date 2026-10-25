// K1-B §4.6：ExecutorAdapter 与首个执行器 agent_hands_shell。
//
// Adapter 接口（进程内抽象，K1 只实现一个）：
//   kind: string
//   capabilities(): { executor_kinds: string[], max_side_effect_level: string }
//   dispatch(envelope, hooks): Promise<{ outcome_hint?: 'failed', summary: string }>
//     hooks: { sideEffectNote({tool_name, note, client_note_id}), heartbeat() }
//     —— Run 心跳由 agent 主循环按进程存活探针驱动（见 agent.mjs），
//        dispatch 只负责真正执行并在进程退出后返回。
//   cancel(runId): Promise<void>
//   probe(runId): Promise<'executed' | 'not_executed' | 'unknown'>
//
// agent_hands_shell 传输：
//   XUXING_HANDS_TRANSPORT=docker（缺省）：docker exec 到 agent-hands 容器执行；
//   XUXING_HANDS_TRANSPORT=local：本机 bash 直接执行（CI / 无容器环境）。
// 本地执行记录按 envelope.idempotency_key 落盘（recordsDir），供 probe 判定：
//   有 result.json ⇒ executed；从未出现 started 标记 ⇒ not_executed；
//   有 started 无 result 且进程已死 ⇒ unknown。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function recordDirOf(recordsDir, idempotencyKey) {
  return join(recordsDir, idempotencyKey.replaceAll(/[^a-zA-Z0-9_.-]/g, '_'));
}

export function createAgentHandsShellExecutor(options) {
  const transport = options.transport ?? 'docker';
  const container = options.container ?? 'ah1';
  const recordsDir = options.recordsDir;
  const active = new Map(); // run_id -> { child, recordDir }

  function spawnCommand(command) {
    if (transport === 'local') {
      return spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return spawn('docker', ['exec', container, 'bash', '-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  return {
    kind: 'agent_hands_shell',

    capabilities() {
      return { executor_kinds: ['agent_hands_shell'], max_side_effect_level: options.maxSideEffectLevel ?? 'L1' };
    },

    async dispatch(envelope, hooks) {
      const dir = recordDirOf(recordsDir, envelope.idempotency_key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'started.json'), JSON.stringify({ run_id: envelope.run_id, started_at: new Date().toISOString() }));

      const snapshot = envelope.input_snapshot ?? {};
      if (typeof snapshot.note_side_effect === 'string' && snapshot.note_side_effect !== '') {
        await hooks.sideEffectNote({
          tool_name: 'shell',
          note: snapshot.note_side_effect,
          client_note_id: `note:${envelope.run_id}:start`,
        });
      }
      const command =
        typeof snapshot.command === 'string' && snapshot.command !== ''
          ? snapshot.command
          : 'echo xuxing-node-agent: no command in input_snapshot';

      const child = spawnCommand(command);
      active.set(envelope.run_id, { child, recordDir: dir });
      let output = '';
      child.stdout.on('data', (d) => {
        output = (output + d.toString()).slice(-8000);
      });
      child.stderr.on('data', (d) => {
        output = (output + d.toString()).slice(-8000);
      });
      const exitCode = await new Promise((resolve) => {
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(code ?? -1));
      });
      active.delete(envelope.run_id);
      const summary = output.trim().slice(-1800) || `exit_code=${exitCode}`;
      writeFileSync(
        join(dir, 'result.json'),
        JSON.stringify({ run_id: envelope.run_id, exit_code: exitCode, summary, finished_at: new Date().toISOString() }, null, 2),
      );
      return exitCode === 0 ? { summary } : { outcome_hint: 'failed', summary };
    },

    /** S6 存活探针：被包裹的执行进程是否仍在跑（Run 心跳与之绑定）。 */
    isAlive(runId) {
      const entry = active.get(runId);
      return entry !== undefined && entry.child.exitCode === null && !entry.child.killed;
    },

    async cancel(runId) {
      const entry = active.get(runId);
      if (!entry) return;
      entry.child.kill('SIGTERM');
      setTimeout(() => {
        if (entry.child.exitCode === null) entry.child.kill('SIGKILL');
      }, 3000).unref?.();
    },

    async probe(runId, idempotencyKey) {
      const dir = recordDirOf(recordsDir, idempotencyKey);
      if (existsSync(join(dir, 'result.json'))) return 'executed';
      if (!existsSync(join(dir, 'started.json'))) return 'not_executed';
      if (this.isAlive(runId)) return 'unknown'; // 仍在执行：未定，交由后续判定（保守）
      return 'unknown'; // 启动过、进程已死、无结果：无法判定（REQ-RUN-3 unknown）
    },

    /** records 口径判定：该 Run 是否在本执行器留下过 started/result。 */
    hasRecord(idempotencyKey) {
      const dir = recordDirOf(recordsDir, idempotencyKey);
      return existsSync(join(dir, 'started.json')) || existsSync(join(dir, 'result.json'));
    },

    readRecord(idempotencyKey) {
      const file = join(recordDirOf(recordsDir, idempotencyKey), 'result.json');
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}
