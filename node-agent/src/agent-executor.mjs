// K0-Q25：agent_hands_agent 执行器——把一条 Run 变成 ah1 容器里的
// opencode 一次性任务（worktree 隔离、tmux 会话、超时/取消）。
//
// 与 agent_hands_shell 同构：recordsDir/<幂等键>/{started.json,result.json}，
// 供 probe 对账；Run 心跳仍由 agent.mjs 按 watcher 存活探针驱动。
//
// 配置（全部来自 env，缺省值见 README）：
//   XUXING_AGENT_MODEL      模型（缺省 opencode-go/deepseek-v4.1-flash）
//   XUXING_AGENT_TIMEOUT_MS 单 Run 超时（缺省 1800000）
//   XUXING_AGENT_RUNS_DIR   容器内每 Run 工作区根目录（缺省 /home/dev/xuxing-runs）
//   XUXING_AGENT_REPO_DIR   容器内 xuxing clone 路径（缺省 /home/dev/xuxing；与 provision-ah1.sh 同名）
//   XUXING_HANDS_USER       容器内执行用户（缺省 dev）
//
// 并发口径：不做 executor 内串行化；每 Run 独立 tmux session + git worktree，
// 资源占用随并发 Run 线性增长（见 README）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_RUNS_DIR = '/home/dev/xuxing-runs';
const DEFAULT_HANDS_USER = 'dev';
const DEFAULT_BASE_REF = 'develop/eventstore-batch1';
const DEFAULT_REPO_PATH = '/home/dev/xuxing';
const KIND = 'agent_hands_agent';
const SUPPORTED_REPOS = new Set(['medivhc/xuxing', 'xuxing']);
const SUMMARY_LIMIT = 1800;
const OUTPUT_TAIL_BYTES = 8000;

function recordDirOf(recordsDir, idempotencyKey) {
  return join(recordsDir, idempotencyKey.replaceAll(/[^a-zA-Z0-9_.-]/g, '_'));
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeSegment(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
}

/** 跑一条容器内命令，收集 stdout/stderr（工作区准备/采集用）。 */
function capture(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function trimTail(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

export function createAgentHandsAgentExecutor(options) {
  const transport = options.transport ?? 'docker';
  const container = options.container ?? 'ah1';
  const recordsDir = options.recordsDir;
  const runsDir = options.runsDir ?? process.env.XUXING_AGENT_RUNS_DIR ?? DEFAULT_RUNS_DIR;
  const handsUser = options.handsUser ?? process.env.XUXING_HANDS_USER ?? DEFAULT_HANDS_USER;
  const authFile = options.authFile ?? process.env.XUXING_AGENT_AUTH_FILE ?? `/home/${handsUser}/.local/share/opencode/auth.json`;
  const opencodeBin =
    options.opencodeBin ?? process.env.XUXING_AGENT_OPENCODE_BIN ?? `/home/${handsUser}/.opencode/bin/opencode`;
  const model = options.model ?? process.env.XUXING_AGENT_MODEL ?? DEFAULT_MODEL;
  const repoPath = options.repoPath ?? process.env.XUXING_AGENT_REPO_DIR ?? DEFAULT_REPO_PATH;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.XUXING_AGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS;
  const active = new Map(); // run_id -> { watcher, session, ws, recordDir, timedOut, canceled, finished }
  const cancelRequested = new Set(); // dispatch 尚未建会话时收到的取消

  /** 容器内 bash（local transport 时在本机执行，便于无容器开发）。 */
  function runShell(command, options = {}) {
    if (transport === 'local') {
      return capture(['bash', '-lc', command], options);
    }
    return capture(['docker', 'exec', '-i', '-u', handsUser, container, 'bash', '-lc', command], options);
  }

  function startWatcher(session) {
    const command = `while tmux has-session -t ${shQuote(session)} 2>/dev/null; do sleep 3; done`;
    const args =
      transport === 'local'
        ? ['bash', '-lc', command]
        : ['docker', 'exec', '-u', handsUser, container, 'bash', '-lc', command];
    return spawn(args[0], args.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] });
  }

  function buildPrompt(envelope) {
    const snapshot = envelope.input_snapshot ?? {};
    const task = snapshot.task ?? {};
    const contract = snapshot.contract ?? {};
    const workspace = snapshot.workspace ?? {};
    const repo = typeof workspace.repo === 'string' ? workspace.repo : null;
    const baseRef = typeof workspace.base_ref === 'string' ? workspace.base_ref : DEFAULT_BASE_REF;
    const branch = `xu-agent/${safeSegment(envelope.run_id).slice(-12)}`;
    const instruction = typeof snapshot.instruction === 'string' ? snapshot.instruction : (task.description ?? '');
    const criteria = Array.isArray(contract.acceptance_criteria) ? contract.acceptance_criteria : [];
    const criteriaLines = criteria.length
      ? criteria.map((c) => `- [${c.criterion_ref ?? '?'}] ${c.text ?? ''}${c.auto ? '（自动判定）' : ''}`).join('\n')
      : '- （无结构化验收标准）';
    const workspaceLines = repo
      ? [
          `- repo=${repo}`,
          `- base_ref=${baseRef}`,
          `- 分支=${branch}（已从 origin/${baseRef} 切出）`,
          `- 工作区=${join(runsDir, safeSegment(envelope.idempotency_key))}/work`,
        ].join('\n')
      : `- 无代码仓库（workspace.repo=null）；工作目录=${join(runsDir, safeSegment(envelope.idempotency_key))}/work`;

    return [
      '# 续行 agent 执行任务',
      '',
      `## 任务`,
      `标题：${task.title ?? ''}`,
      '',
      'instruction：',
      instruction,
      '',
      '## 验收标准',
      criteriaLines,
      '',
      '## 项目',
      `project_id=${snapshot.project?.project_id ?? ''}`,
      '',
      '## 工作区',
      workspaceLines,
      '',
      '## 行为要求',
      '- 只在上述工作区内改动，不得修改工作区外的文件。',
      ...(repo
        ? [
            '- 完成后 `git add -A && git commit -m "<一句话说明改动>"`；**不要 push**。',
            '- 不要在仓库里留下未提交的改动。',
          ]
        : ['- 本次没有代码仓库，不要执行 git 命令。']),
      '- 运行与改动相关的测试，并如实报告通过/失败；没有可跑测试也要说明。',
      '- 末尾输出结构化小结，固定四行：',
      '  结论：',
      '  改动文件：',
      '  测试结果：',
      '  分支与提交：',
      '',
    ].join('\n');
  }

  function parseExitMarker(output) {
    const matches = [...output.matchAll(/__EXIT__:(-?\d+)/g)];
    return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
  }

  function stripExitMarker(output) {
    return output.replace(/\n?__EXIT__:-?\d+\s*$/g, '').trim();
  }

  function stripAnsi(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
  }

  function composeSummary({ output, marker, timedOut, canceled, artifacts, transcriptRef, noChanges }) {
    const fileLabel = artifacts.files_changed.length > 0 ? trimTail(artifacts.files_changed.join(','), 600) : '-';
    const artifactsLine = `[artifacts] branch=${artifacts.branch ?? '-'} commits=${artifacts.commits.length} files=${fileLabel} transcript=${transcriptRef}`;
    const prefix = timedOut ? 'TIMEOUT ' : canceled ? 'CANCELED ' : '';
    const body = stripAnsi(stripExitMarker(output));
    const notice = noChanges ? '\nno changes' : '';
    const markerNote = marker === null ? '\nexit marker missing' : marker === 0 ? '' : `\nexit_code=${marker}`;
    const available = Math.max(0, SUMMARY_LIMIT - prefix.length - artifactsLine.length - notice.length - markerNote.length - 2);
    const excerpt = trimTail(body, available);
    const summary = `${prefix}${excerpt}${notice}${markerNote}\n${artifactsLine}`;
    return summary.length <= SUMMARY_LIMIT ? summary : summary.slice(0, SUMMARY_LIMIT);
  }

  async function prepareWorkspace({ ws, worktree, repo, baseRef, branch }) {
    if (repo === null) {
      const made = await runShell(`mkdir -p ${shQuote(worktree)}`);
      return made.code === 0 ? null : `mkdir workspace failed: ${made.stderr.trim()}`;
    }
    if (!SUPPORTED_REPOS.has(repo)) {
      return `unsupported workspace repo: ${repo}（MVP 只支持 medivhc/xuxing、xuxing 与 null）`;
    }
    const exists = await runShell(`test -e ${shQuote(join(worktree, '.git'))}`);
    if (exists.code === 0) return null; // 幂等重放：工作区已就绪
    const fetched = await runShell(
      `mkdir -p ${shQuote(ws)} && git -C ${shQuote(repoPath)} fetch origin ${shQuote(baseRef)}`,
    );
    if (fetched.code !== 0) return `git fetch origin ${baseRef} failed: ${fetched.stderr.trim() || fetched.stdout.trim()}`;
    const added = await runShell(
      `git -C ${shQuote(repoPath)} worktree add ${shQuote(worktree)} -b ${shQuote(branch)} ${shQuote(`origin/${baseRef}`)}`,
    );
    if (added.code === 0) return null;
    // 分支可能已存在（上次 dispatch 中断）：改用已有分支重新挂 worktree。
    const retry = await runShell(
      `git -C ${shQuote(repoPath)} worktree add ${shQuote(worktree)} ${shQuote(branch)}`,
    );
    if (retry.code === 0) return null;
    return `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`;
  }

  async function collectArtifacts({ repo, baseRef, worktree }) {
    if (repo === null) return { repo: null, branch: null, commits: [], files_changed: [], worktree };
    const branch = await runShell(`git -C ${shQuote(worktree)} rev-parse --abbrev-ref HEAD 2>/dev/null`);
    const commits = await runShell(
      `git -C ${shQuote(worktree)} log --oneline ${shQuote(`origin/${baseRef}..HEAD`)} 2>/dev/null`,
    );
    const files = await runShell(
      `git -C ${shQuote(worktree)} diff --name-only ${shQuote(`origin/${baseRef}...HEAD`)} 2>/dev/null`,
    );
    const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      repo,
      branch: branch.code === 0 ? branch.stdout.trim() || null : null,
      commits: commits.code === 0 ? lines(commits.stdout) : [],
      files_changed: files.code === 0 ? lines(files.stdout) : [],
      worktree,
    };
  }

  return {
    kind: KIND,

    capabilities() {
      return { executor_kinds: ['agent_hands_agent'], max_side_effect_level: options.maxSideEffectLevel ?? 'L1' };
    },

    async dispatch(envelope, hooks) {
      const dir = recordDirOf(recordsDir, envelope.idempotency_key);
      mkdirSync(dir, { recursive: true });
      const startedAt = new Date().toISOString();
      writeFileSync(
        join(dir, 'started.json'),
        JSON.stringify({ run_id: envelope.run_id, executor_kind: KIND, started_at: startedAt }),
      );

      const snapshot = envelope.input_snapshot ?? {};
      const workspace = snapshot.workspace ?? {};
      const repo = typeof workspace.repo === 'string' ? workspace.repo : null;
      const baseRef = typeof workspace.base_ref === 'string' ? workspace.base_ref : DEFAULT_BASE_REF;
      const segment = safeSegment(envelope.idempotency_key);
      const ws = join(runsDir, segment);
      const worktree = join(ws, 'work');
      const branch = `xu-agent/${safeSegment(envelope.run_id).slice(-12)}`;
      const session = `xu-${safeSegment(envelope.run_id).slice(-12)}`;
      const outputLog = join(ws, 'output.log');
      const transcriptRef = `ah1:${outputLog}`;
      const effectiveTimeout =
        typeof snapshot.timeout_ms === 'number' && Number.isFinite(snapshot.timeout_ms) && snapshot.timeout_ms >= 5000
          ? Math.min(snapshot.timeout_ms, 3_600_000)
          : timeoutMs;

      const writeResult = (payload) =>
        writeFileSync(join(dir, 'result.json'), JSON.stringify({ run_id: envelope.run_id, ...payload }, null, 2));
      const finishCanceled = (stage) => {
        const summary = `CANCELED before session start (${stage})`;
        writeResult({
          exit_marker: null,
          outcome: 'failed',
          summary,
          artifacts: { repo, branch: null, commits: [], files_changed: [], worktree },
          transcript_ref: transcriptRef,
          finished_at: new Date().toISOString(),
        });
        cancelRequested.delete(envelope.run_id);
        return { outcome_hint: 'failed', summary, raw_result_ref: `agent-run://${envelope.idempotency_key}` };
      };
      if (cancelRequested.has(envelope.run_id)) return finishCanceled('dispatch');

      await hooks.sideEffectNote({
        tool_name: 'opencode',
        note: 'agent run started in ah1 worktree',
        client_note_id: `note:${envelope.run_id}:start`,
      });

      // PROMPT.md 经 base64 传入，避免引号/换行转义问题。
      const prompt = buildPrompt(envelope);
      const promptWrite = await runShell(
        `mkdir -p ${shQuote(ws)} && base64 -d > ${shQuote(join(ws, 'PROMPT.md'))}`,
        { input: Buffer.from(prompt, 'utf8').toString('base64') },
      );
      if (promptWrite.code !== 0) {
        const summary = `agent framework error: write PROMPT.md failed: ${promptWrite.stderr.trim()}`;
        writeResult({ exit_marker: null, outcome: 'failed', summary, artifacts: { repo, branch: null, commits: [], files_changed: [], worktree }, transcript_ref: transcriptRef, finished_at: new Date().toISOString() });
        return { outcome_hint: 'failed', summary, raw_result_ref: `agent-run://${envelope.idempotency_key}` };
      }

      const prepareError = await prepareWorkspace({ ws, worktree, repo, baseRef, branch, runId: envelope.run_id });
      if (prepareError !== null) {
        const summary = `agent framework error: ${prepareError}`;
        writeResult({ exit_marker: null, outcome: 'failed', summary, artifacts: { repo, branch: null, commits: [], files_changed: [], worktree }, transcript_ref: transcriptRef, finished_at: new Date().toISOString() });
        return { outcome_hint: 'failed', summary, raw_result_ref: `agent-run://${envelope.idempotency_key}` };
      }
      if (cancelRequested.has(envelope.run_id)) return finishCanceled('workspace_ready');

      const opencodeCommand = [
        `tmux kill-session -t ${shQuote(session)} 2>/dev/null || true`,
        `tmux new-session -d -s ${shQuote(session)} -c ${shQuote(worktree)} ${shQuote(
          `OPENCODE_API_KEY="$(jq -r ${shQuote('.["opencode-go"].key')} ${shQuote(authFile)})" ${shQuote(opencodeBin)} run --standalone --model ${shQuote(model)} "$(cat ${shQuote(join(ws, 'PROMPT.md'))})" > ${shQuote(outputLog)} 2>&1; echo __EXIT__:$? >> ${shQuote(outputLog)}`,
        )}`,
      ].join(' && ');
      const launched = await runShell(opencodeCommand);
      const state = { watcher: null, session, ws, recordDir: dir, timedOut: false, canceled: false, finished: false };
      if (launched.code !== 0) {
        const summary = `agent framework error: tmux new-session failed: ${launched.stderr.trim() || launched.stdout.trim()}`;
        writeResult({ exit_marker: null, outcome: 'failed', summary, artifacts: { repo, branch: null, commits: [], files_changed: [], worktree }, transcript_ref: transcriptRef, finished_at: new Date().toISOString() });
        return { outcome_hint: 'failed', summary, raw_result_ref: `agent-run://${envelope.idempotency_key}` };
      }

      const watcher = startWatcher(session);
      state.watcher = watcher;
      active.set(envelope.run_id, state);
      const exited = new Promise((resolve) => {
        watcher.on('error', () => resolve());
        watcher.on('close', () => resolve());
      });
      let timeoutTimer = null;
      const timedOut = new Promise((resolve) => {
        timeoutTimer = setTimeout(() => resolve('timeout'), effectiveTimeout);
        timeoutTimer.unref?.();
      });
      const reason = await Promise.race([exited.then(() => 'exited'), timedOut]);
      clearTimeout(timeoutTimer);
      if (reason === 'timeout') {
        state.timedOut = true;
        await runShell(`tmux kill-session -t ${shQuote(session)} 2>/dev/null || true`);
        watcher.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      if (state.canceled) {
        await runShell(`tmux kill-session -t ${shQuote(session)} 2>/dev/null || true`);
      }
      state.finished = true;

      // 收尾采集：输出尾部 + git 产物（只读，不改工作区）。
      const tail = await runShell(`tail -c ${OUTPUT_TAIL_BYTES} ${shQuote(outputLog)} 2>/dev/null || true`);
      const output = tail.stdout;
      const marker = parseExitMarker(output);
      const artifacts = await collectArtifacts({ repo, baseRef, worktree });
      const failed = state.timedOut || state.canceled || marker !== 0;
      const noChanges = !failed && artifacts.commits.length === 0 && artifacts.files_changed.length === 0;
      const summary = composeSummary({
        output,
        marker,
        timedOut: state.timedOut,
        canceled: state.canceled,
        artifacts,
        transcriptRef,
        noChanges,
      });
      writeResult({
        exit_marker: marker,
        outcome: failed ? 'failed' : 'success',
        summary,
        artifacts,
        transcript_ref: transcriptRef,
        finished_at: new Date().toISOString(),
      });
      active.delete(envelope.run_id);
      cancelRequested.delete(envelope.run_id);
      return {
        ...(failed ? { outcome_hint: 'failed' } : {}),
        summary,
        raw_result_ref: `agent-run://${envelope.idempotency_key}`,
      };
    },

    /** S6 存活探针：watcher（tmux 会话在跑）仍存活。 */
    isAlive(runId) {
      const entry = active.get(runId);
      if (!entry || !entry.watcher) return false;
      return !entry.finished && entry.watcher.exitCode === null && !entry.watcher.killed;
    },

    async cancel(runId) {
      cancelRequested.add(runId);
      const entry = active.get(runId);
      if (!entry) return;
      entry.canceled = true;
      await runShell(`tmux kill-session -t ${shQuote(entry.session)} 2>/dev/null || true`);
      entry.watcher?.kill('SIGTERM');
    },

    async probe(runId, idempotencyKey) {
      const dir = recordDirOf(recordsDir, idempotencyKey);
      if (existsSync(join(dir, 'result.json'))) return 'executed';
      if (!existsSync(join(dir, 'started.json'))) return 'not_executed';
      if (this.isAlive(runId)) return 'unknown';
      return 'unknown'; // 启动过、进程已死、无结果：无法判定（REQ-RUN-3 unknown）
    },

    /**
     * records 口径判定：该 Run 是否在本执行器留下过 started/result。
     * F1 标记法：started.json 带 executor_kind 时只认领同 kind；字段缺失（历史
     * records）或 JSON 读不出时按存在处理，保证向后兼容、不因老记录报错。
     */
    hasRecord(idempotencyKey) {
      const dir = recordDirOf(recordsDir, idempotencyKey);
      if (!existsSync(dir)) return false;
      const startedFile = join(dir, 'started.json');
      const hasStarted = existsSync(startedFile);
      if (hasStarted) {
        let marker = null;
        try {
          marker = JSON.parse(readFileSync(startedFile, 'utf8'));
        } catch {
          marker = null;
        }
        const markedKind = marker?.executor_kind;
        if (typeof markedKind === 'string' && markedKind !== '' && markedKind !== KIND) return false;
      }
      return hasStarted || existsSync(join(dir, 'result.json'));
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
