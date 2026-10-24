// 续行 K0 旅程控制台 —— 无框架 UI。
//
// 纪律：页面只渲染投影接口给的字段（lifecycle / goal_status / acceptance.status /
// available_actions），不在前端推导领域状态；点击命令后重新拉投影再重绘。
// data-testid 与 tests/journeys/support/testids.mts 的命名契约一一对应。

const app = document.getElementById('app');

const ui = {
  acceptance: new Map(), // taskId -> { criterion_ref: 'passed' | 'failed' }
};

let renderToken = 0;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'testid') node.setAttribute('data-testid', value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== null && dataValue !== undefined) node.dataset[dataKey] = String(dataValue);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(append);
      return;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);
  return node;
}

function badge(text, kind, testid) {
  return h('span', { class: `badge ${kind ?? ''}`.trim(), testid }, text);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function newSubmitId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function sendCommand(type, payload) {
  return api('/api/commands', {
    method: 'POST',
    body: JSON.stringify({ type, payload, client_submit_id: newSubmitId() }),
  });
}

function flash(message, kind = 'error') {
  const existing = app.querySelector('.flash');
  if (existing) existing.remove();
  const node = h('div', { class: `flash ${kind}`, testid: kind === 'error' ? 'flash-error' : 'flash-info' }, message);
  app.prepend(node);
}

function errorPage(error) {
  return h(
    'section',
    { class: 'card' },
    h('h1', {}, '读取出错'),
    h('div', { class: 'flash error', testid: 'app-error' }, error instanceof Error ? error.message : String(error)),
    h('p', { class: 'muted' }, '投影读取失败；修复服务后刷新页面。'),
  );
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'home') return { name: 'home' };
  if (parts[0] === 'capture') return { name: 'capture' };
  if (parts[0] === 'actions') return { name: 'actions' };
  if (parts[0] === 'proposals' && parts[1]) return { name: 'proposal', proposalId: parts[1] };
  if (parts[0] === 'projects' && parts[1]) {
    if (parts[2] === 'tasks' && parts[3] && parts[4] === 'acceptance') {
      return { name: 'acceptance', projectId: parts[1], taskId: parts[3] };
    }
    return { name: 'project', projectId: parts[1] };
  }
  return { name: 'notfound' };
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

function renderHome(data) {
  const cards = data.projects.map((project) =>
    h(
      'a',
      {
        class: 'card',
        testid: 'home-project-card',
        dataset: { projectId: project.project_id, degraded: String(project.degraded) },
        href: `#/projects/${encodeURIComponent(project.project_id)}`,
        style: 'text-decoration:none;color:inherit',
      },
      h('div', { class: 'row' }, h('strong', {}, project.title), project.degraded ? badge('degraded', 'degraded', 'home-degraded') : null),
      h('p', { class: 'muted' }, project.goal_text),
      h(
        'div',
        { class: 'row' },
        h('span', {}, '目标 '),
        h('span', { testid: 'home-goal-status', class: 'badge ok' }, project.goal_status),
        h('span', { class: 'muted' }, `任务 ${project.task_summary.accepted_tasks}/${project.task_summary.active_tasks} 已验收`),
        h('span', { class: 'muted' }, `待我处理 ${project.pending_actions_count}`),
      ),
    ),
  );

  const activity = data.recent_activity.map((item) =>
    h(
      'div',
      { class: 'activity-item', testid: 'home-activity-item', dataset: { kind: item.kind, seq: String(item.seq) } },
      h('span', { class: 'mono muted' }, `#${item.seq}`),
      ' ',
      h('strong', {}, item.kind),
      ' ',
      h('span', { class: 'muted' }, item.summary),
      item.degraded ? h('span', {}, ' ', badge('degraded', 'degraded')) : null,
    ),
  );

  return h(
    'section',
    {},
    h('h1', {}, 'Home'),
    h(
      'div',
      { class: 'stat card' },
      h('div', {}, h('span', { class: 'value', testid: 'home-pending-count' }, String(data.pending_actions_count)), h('span', { class: 'label' }, '待我处理')),
      h('div', {}, h('span', { class: 'value' }, String(data.projects.length)), h('span', { class: 'label' }, '项目')),
      h('div', {}, h('span', { class: 'value mono' }, `v${data.projection_version}`), h('span', { class: 'label' }, '投影版本')),
    ),
    h('h2', {}, '项目'),
    h('div', { class: 'grid' }, cards),
    h('h2', {}, '最近活动'),
    h('div', { class: 'card activity' }, activity),
  );
}

function renderCapture() {
  const input = h('textarea', {
    testid: 'capture-input',
    placeholder: '一句话描述要做的事，例如：把 nx-pipeline 最近一轮 run 导入续行，跑通双轨对照',
  });
  const submit = h('button', { type: 'submit', testid: 'capture-submit' }, '提交捕获');
  const form = h(
    'form',
    { class: 'stack' },
    h('label', {}, '捕获输入'),
    input,
    h('div', {}, submit),
    h('p', { class: 'muted' }, '提交后由智能层产出提议；提议必须经人接受才会生成任务。'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const result = await api('/api/capture', {
        method: 'POST',
        body: JSON.stringify({ text: input.value }),
      });
      if (result.proposal_id) {
        location.hash = `#/proposals/${encodeURIComponent(result.proposal_id)}`;
      } else {
        flash('已捕获，但智能层未产出提议（proposal_id 为空）', 'info');
      }
    } catch (error) {
      flash(error.message);
      submit.disabled = false;
    }
  });
  return h('section', { class: 'card' }, h('h1', {}, 'Capture'), form);
}

function renderProposal(proposal) {
  const degradedBlock = proposal.degraded
    ? h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' }, badge('degraded', 'degraded', 'proposal-degraded'), h('span', { class: 'muted' }, '提议由降级链路产出，仍可人工接受并完整走完验收')),
        h('ul', { testid: 'proposal-degraded-reasons' }, proposal.degraded_reasons.map((reason) => h('li', { class: 'mono' }, reason))),
      )
    : null;

  const taskCards = proposal.proposed_tasks.map((task) =>
    h(
      'div',
      { class: 'task-card', testid: 'proposal-task' },
      h('div', { class: 'row' }, h('strong', { testid: 'proposal-task-title' }, task.title), badge(task.assignee_kind, 'warn')),
      h(
        'ul',
        { class: 'criteria' },
        task.criteria.map((criterion) =>
          h('li', { class: 'criterion', testid: 'proposal-criterion' }, h('span', {}, criterion.label), h('span', { class: 'mono muted' }, `${criterion.criterion_ref} / ${criterion.kind}`)),
        ),
      ),
    ),
  );

  const buttons = [];
  if (proposal.available_actions.includes('accept_proposal')) {
    buttons.push(
      h(
        'button',
        {
          testid: 'proposal-accept',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await sendCommand('accept_proposal', { proposal_id: proposal.proposal_id });
              await render();
            } catch (error) {
              flash(error.message);
              button.disabled = false;
            }
          },
        },
        '接受提议',
      ),
    );
  }
  if (proposal.available_actions.includes('reject_proposal')) {
    buttons.push(
      h(
        'button',
        {
          class: 'danger',
          testid: 'proposal-reject',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await sendCommand('reject_proposal', { proposal_id: proposal.proposal_id, reason: 'UI 拒绝' });
              await render();
            } catch (error) {
              flash(error.message);
              button.disabled = false;
            }
          },
        },
        '拒绝提议',
      ),
    );
  }

  return h(
    'section',
    { class: 'card', testid: 'proposal-panel' },
    h('div', { class: 'row' }, h('h1', {}, '提议'), h('span', { testid: 'proposal-status', class: 'badge warn' }, proposal.status)),
    h('p', { class: 'mono muted' }, `proposal_id=${proposal.proposal_id} · capture_id=${proposal.capture_id}`),
    h('p', {}, proposal.summary),
    h('p', { class: 'muted' }, proposal.rationale),
    degradedBlock,
    h('h2', {}, '拟生成任务'),
    h('div', { class: 'list' }, taskCards),
    h('div', { class: 'row', style: 'margin-top:14px' }, buttons),
    proposal.status === 'accepted'
      ? h('p', {}, h('a', { testid: 'proposal-link-actions', href: '#/actions' }, '去 My Actions 处理已生成的任务 →'))
      : null,
  );
}

function renderActions(data) {
  if (data.actions.length === 0) {
    return h(
      'section',
      { class: 'card' },
      h('h1', {}, 'My Actions'),
      h('p', { class: 'muted', testid: 'actions-empty' }, '当前没有待你处理的动作。'),
    );
  }
  const rows = data.actions.map((row) => {
    const buttons = [];
    if (row.available_actions.includes('complete_task')) {
      buttons.push(
        h(
          'button',
          {
            testid: 'action-complete-task',
            onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                await sendCommand('complete_task', { task_id: row.task_id });
                await render();
              } catch (error) {
                flash(error.message);
                button.disabled = false;
              }
            },
          },
          '完成任务',
        ),
      );
    }
    if (row.available_actions.includes('record_acceptance')) {
      buttons.push(
        h(
          'a',
          {
            class: 'button',
            testid: 'action-open-acceptance',
            href: `#/projects/${encodeURIComponent(row.project_id)}/tasks/${encodeURIComponent(row.task_id)}/acceptance`,
          },
          '逐判据验收',
        ),
      );
    }
    return h(
      'div',
      { class: 'task-card', testid: 'my-actions-row', dataset: { taskId: row.task_id, projectId: row.project_id, degraded: String(row.degraded) } },
      h(
        'div',
        { class: 'row' },
        h('strong', { testid: 'action-task-title' }, row.title),
        h('div', {}, h('span', { class: 'badge warn', testid: 'task-lifecycle' }, row.lifecycle), ' ', row.degraded ? badge('degraded', 'degraded', 'action-degraded') : null),
      ),
      h('p', { class: 'mono muted' }, `task_id=${row.task_id} · available_actions=${row.available_actions.join(',')}`),
      row.pending_criteria.length > 0
        ? h('p', { class: 'muted' }, `待补判据：${row.pending_criteria.join(', ')}`)
        : null,
      h('div', { class: 'row' }, buttons),
    );
  });
  return h(
    'section',
    {},
    h('h1', {}, 'My Actions'),
    h('p', { class: 'mono muted' }, `actor=${data.actor_id} · projection_version=${data.projection_version}`),
    h('div', { class: 'list' }, rows),
  );
}

function renderProject(project) {
  const taskRows = project.task_graph.nodes.map((task) => {
    const results = new Map(task.criterion_results.map((result) => [result.criterion_ref, result.verdict]));
    return h(
      'div',
      { class: 'task-card', testid: 'task-row', dataset: { taskId: task.task_id, degraded: String(task.degraded) } },
      h(
        'div',
        { class: 'row' },
        h('strong', { testid: 'task-title' }, task.title),
        h(
          'div',
          {},
          h('span', { class: 'badge warn', testid: 'task-lifecycle' }, task.lifecycle),
          ' ',
          task.degraded ? badge('degraded', 'degraded', 'task-degraded') : null,
        ),
      ),
      h('p', { class: 'mono muted' }, `task_id=${task.task_id} · assignee=${task.intended_assignee_id} · contract_rev=${task.current_contract_rev}`),
      h(
        'ul',
        { class: 'criteria' },
        task.criteria.map((criterion) =>
          h(
            'li',
            { class: 'criterion', testid: 'project-criterion' },
            h('span', {}, criterion.label),
            h('span', { class: 'mono' }, results.get(criterion.criterion_ref) ?? 'pending'),
          ),
        ),
      ),
      task.available_actions.includes('record_acceptance')
        ? h(
            'p',
            {},
            h(
              'a',
              {
                class: 'button',
                testid: 'project-open-acceptance',
                href: `#/projects/${encodeURIComponent(project.project_id)}/tasks/${encodeURIComponent(task.task_id)}/acceptance`,
              },
              '进入逐判据验收 →',
            ),
          )
        : null,
    );
  });

  return h(
    'section',
    { class: 'card' },
    h('h1', { testid: 'project-title' }, project.title),
    h('p', { class: 'muted' }, project.goal.text),
    h(
      'div',
      { class: 'stat' },
      h('div', {}, h('span', { class: 'value', testid: 'goal-status' }, project.goal.status), h('span', { class: 'label' }, '目标状态')),
      h('div', {}, h('span', { class: 'value', testid: 'project-acceptance-status' }, project.acceptance.status), h('span', { class: 'label' }, '验收状态')),
      h('div', {}, h('span', { class: 'value', testid: 'project-accepted-count' }, `${project.acceptance.accepted_tasks}/${project.acceptance.active_tasks}`), h('span', { class: 'label' }, '已验收')),
      h('div', {}, h('span', { class: 'value mono' }, `v${project.projection_version}`), h('span', { class: 'label' }, '投影版本')),
    ),
    h(
      'p',
      { class: 'muted' },
      '待补判据：',
      h(
        'span',
        { testid: 'project-pending-criteria' },
        project.acceptance.pending_criteria.length === 0
          ? 'none'
          : project.acceptance.pending_criteria.map((item) => item.criterion_ref).join(', '),
      ),
    ),
    h('h2', {}, '任务图'),
    h('div', { class: 'list' }, taskRows.length > 0 ? taskRows : h('p', { class: 'muted' }, '暂无任务')),
  );
}

function renderAcceptance(project, task) {
  let draft = ui.acceptance.get(task.task_id);
  if (!draft) {
    draft = {};
    for (const result of task.criterion_results) draft[result.criterion_ref] = result.verdict;
    ui.acceptance.set(task.task_id, draft);
  }
  const projectedResults = new Map(task.criterion_results.map((result) => [result.criterion_ref, result.verdict]));

  const rows = task.criteria.map((criterion) => {
    const pass = h(
      'button',
      {
        class: `ghost ${draft[criterion.criterion_ref] === 'passed' ? 'selected' : ''}`.trim(),
        testid: `criterion-pass-${criterion.criterion_ref}`,
        onclick: () => {
          draft[criterion.criterion_ref] = 'passed';
          render();
        },
      },
      '通过',
    );
    const fail = h(
      'button',
      {
        class: `ghost ${draft[criterion.criterion_ref] === 'failed' ? 'selected' : ''}`.trim(),
        testid: `criterion-fail-${criterion.criterion_ref}`,
        onclick: () => {
          draft[criterion.criterion_ref] = 'failed';
          render();
        },
      },
      '不通过',
    );
    return h(
      'div',
      { class: 'criterion', testid: 'criterion-row', dataset: { criterionRef: criterion.criterion_ref } },
      h(
        'div',
        {},
        h('strong', {}, criterion.label),
        ' ',
        h('span', { class: 'mono muted' }, `${criterion.criterion_ref} / ${criterion.kind}`),
        ' ',
        h('span', { class: 'badge' }, projectedResults.get(criterion.criterion_ref) ?? 'pending'),
      ),
      h('div', { class: 'criterion-actions' }, pass, fail),
    );
  });

  const canSubmit = task.lifecycle === 'awaiting_acceptance';
  const submit = h(
    'button',
    {
      testid: 'acceptance-submit',
      disabled: !canSubmit,
      onclick: async (event) => {
        const button = event.currentTarget;
        const results = task.criteria.map((criterion) => ({
          criterion_ref: criterion.criterion_ref,
          verdict: draft[criterion.criterion_ref],
          evidence_refs: [],
        }));
        if (results.some((result) => !result.verdict)) {
          flash('请先为每条判据给出通过/不通过');
          return;
        }
        button.disabled = true;
        try {
          await sendCommand('record_acceptance', {
            task_id: task.task_id,
            criterion_results: results,
            rationale: 'UI 逐判据验收',
          });
          await render();
        } catch (error) {
          flash(error.message);
          button.disabled = false;
        }
      },
    },
    '提交逐判据验收',
  );

  const pending = project.acceptance.pending_criteria
    .filter((item) => item.task_id === task.task_id)
    .map((item) => item.criterion_ref);

  return h(
    'section',
    { class: 'card' },
    h('h1', {}, '逐判据验收'),
    h('p', { class: 'muted' }, task.title),
    h(
      'div',
      { class: 'stat' },
      h('div', {}, h('span', { class: 'value badge warn', testid: 'task-lifecycle' }, task.lifecycle), h('span', { class: 'label' }, '任务状态')),
      h('div', {}, h('span', { class: 'value', testid: 'acceptance-verdict' }, task.last_acceptance?.verdict ?? 'not_submitted'), h('span', { class: 'label' }, '最近一次验收')),
      h('div', {}, h('span', { class: 'value mono' }, `v${project.projection_version}`), h('span', { class: 'label' }, '投影版本')),
    ),
    h('p', { class: 'muted' }, '待补判据：', h('span', { testid: 'acceptance-pending-criteria' }, pending.length === 0 ? 'none' : pending.join(', '))),
    h('div', { class: 'criteria' }, rows),
    h('div', { class: 'row', style: 'margin-top:14px' }, submit),
    h('p', {}, h('a', { href: `#/projects/${encodeURIComponent(project.project_id)}` }, '← 返回项目')),
  );
}

// ---------------------------------------------------------------------------
// 路由与渲染
// ---------------------------------------------------------------------------

async function render() {
  const token = ++renderToken;
  const route = parseRoute();
  try {
    let view;
    if (route.name === 'home') {
      view = renderHome(await api('/api/home'));
    } else if (route.name === 'capture') {
      view = renderCapture();
    } else if (route.name === 'actions') {
      view = renderActions(await api('/api/actions'));
    } else if (route.name === 'proposal') {
      view = renderProposal(await api(`/api/proposals/${encodeURIComponent(route.proposalId)}`));
    } else if (route.name === 'project') {
      view = renderProject(await api(`/api/projects/${encodeURIComponent(route.projectId)}`));
    } else if (route.name === 'acceptance') {
      const project = await api(`/api/projects/${encodeURIComponent(route.projectId)}`);
      const task = project.task_graph.nodes.find((node) => node.task_id === route.taskId);
      view = task
        ? renderAcceptance(project, task)
        : h('section', { class: 'card' }, h('h1', {}, '任务不存在'), h('p', { class: 'muted' }, `task_id=${route.taskId}`));
    } else {
      view = h('section', { class: 'card' }, h('h1', {}, '未找到页面'), h('p', { class: 'muted' }, '回到 Home 继续。'));
    }
    if (token !== renderToken) return;
    app.replaceChildren(view);
  } catch (error) {
    if (token !== renderToken) return;
    app.replaceChildren(errorPage(error));
  }
}

window.addEventListener('hashchange', () => {
  render();
});
// 只触发一次首屏渲染：脚本在解析期执行则等 DOMContentLoaded，否则立刻渲染。
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => render(), { once: true });
} else {
  render();
}
