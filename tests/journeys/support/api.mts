import type { APIRequestContext } from '@playwright/test';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  ActionItem,
  ActionsData,
  ApiErrorBody,
  CaptureData,
  CommandResultData,
  CommandType,
  HealthData,
  HomeData,
  HomeProjectSummary,
  ProjectData,
  ProjectResponse,
  ProjectTaskRow,
  ProposalData,
  SuccessEnvelope,
} from '../contract.mts';
import {
  CURRENT_ACTOR_ID,
  JOURNEY_BASE_URL,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from '../journeys.config.mts';

// ============================================================================
// 投影接口客户端与轮询断言工具。
//
// 纪律（R-2）：全部端点统一信封 {ok:true,data} / {ok:false,error}。
// 本客户端是**唯一**的解包点：业务函数一律返回 `data`，任何调用方都不再读响应顶层。
// 旅程的领域状态断言只读投影（home / project / actions / proposal）；
// 协议级 SSE 测试走 sse-client.mts。
// ============================================================================

export interface JsonResult<T> {
  status: number;
  body: T;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export async function requestJson<T>(
  request: APIRequestContext,
  path: string,
  init: Parameters<APIRequestContext['fetch']>[1] = {},
): Promise<JsonResult<T>> {
  const response = await request.fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-xuxing-actor': CURRENT_ACTOR_ID,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status(), body: body as T };
}

function isSuccessEnvelope<T>(body: unknown): body is SuccessEnvelope<T> {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
}

function isErrorEnvelope(body: unknown): body is ApiErrorBody {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false;
}

/** 拆信封：成功返回 data，失败抛 HttpError（code/message 原样保留）。 */
export function unwrap<T>(path: string, status: number, body: unknown): T {
  if (isSuccessEnvelope<T>(body)) return body.data;
  const detail = isErrorEnvelope(body) ? `${body.error.code}: ${body.error.message}` : JSON.stringify(body);
  throw new HttpError(status, body, `${path} 失败（HTTP ${status}）：${detail}`);
}

/**
 * 读一个 GET 端点：断言 200 + ok:true，返回 data。
 * 端点不存在时给出可读报错（真服务与 mock 的端点集合必须一致，缺端点算契约缺口）。
 */
export async function getData<T>(request: APIRequestContext, path: string): Promise<T> {
  const result = await requestJson<unknown>(request, path);
  if (result.status !== 200) {
    throw new HttpError(result.status, result.body, `GET ${path} 期望 200，实际 ${result.status}`);
  }
  return unwrap<T>(path, result.status, result.body);
}

export function getHealth(request: APIRequestContext): Promise<HealthData> {
  return getData<HealthData>(request, '/api/health');
}

export function getHome(request: APIRequestContext): Promise<HomeData> {
  return getData<HomeData>(request, '/api/home');
}

export function getActions(request: APIRequestContext): Promise<ActionsData> {
  return getData<ActionsData>(request, '/api/actions');
}

export function getProject(request: APIRequestContext, projectId: string): Promise<ProjectData> {
  return getData<ProjectData>(request, `/api/projects/${encodeURIComponent(projectId)}`);
}

export function getProposal(request: APIRequestContext, proposalId: string): Promise<ProposalData> {
  return getData<ProposalData>(request, `/api/proposals/${encodeURIComponent(proposalId)}`);
}

/** POST /api/capture：首次 201、幂等重放 200，均返回 data。 */
export async function capture(
  request: APIRequestContext,
  text: string,
  options: { projectId?: string } = {},
): Promise<CaptureData> {
  const result = await requestJson<unknown>(request, '/api/capture', {
    method: 'POST',
    data: { text, ...(options.projectId ? { project_id: options.projectId } : {}) },
  });
  if (result.status !== 201 && result.status !== 200) {
    throw new HttpError(result.status, result.body, `POST /api/capture 期望 201/200，实际 ${result.status}`);
  }
  const data = unwrap<CaptureData>('/api/capture', result.status, result.body);
  if (!data.capture_id) {
    throw new Error(`capture 响应的 data 缺少 capture_id：${JSON.stringify(result.body)}`);
  }
  return data;
}

export interface CommandResult {
  status: number;
  body: unknown;
}

export async function postCommand(
  request: APIRequestContext,
  type: CommandType | string,
  payload: Record<string, unknown>,
  clientSubmitId: string,
): Promise<CommandResult> {
  return requestJson<unknown>(request, '/api/commands', {
    method: 'POST',
    data: { type, payload, client_submit_id: clientSubmitId },
  });
}

/** R-6：首次成功命令 = 201 + {ok:true,data}；data.replayed === false。 */
export function expectCreatedCommand(result: CommandResult): CommandResultData {
  if (result.status !== 201) {
    throw new Error(`命令期望 201，实际 ${result.status}：${JSON.stringify(result.body)}`);
  }
  const data = unwrap<CommandResultData>('/api/commands', result.status, result.body);
  if (data.replayed !== false) {
    throw new Error(`首次命令 data.replayed 必须为 false：${JSON.stringify(result.body)}`);
  }
  return data;
}

/** R-6：幂等重放 = 200 + {ok:true,data} + data.replayed === true。 */
export function expectReplayedCommand(result: CommandResult): CommandResultData {
  if (result.status !== 200) {
    throw new Error(`幂等重放期望 200，实际 ${result.status}：${JSON.stringify(result.body)}`);
  }
  const data = unwrap<CommandResultData>('/api/commands', result.status, result.body);
  if (data.replayed !== true) {
    throw new Error(`幂等重放 data.replayed 必须为 true：${JSON.stringify(result.body)}`);
  }
  return data;
}

/** 轮询投影直到 predicate 为真；超时抛出带最后一次投影的错误。 */
export async function waitForProjection<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      latest = await read();
      lastError = undefined;
      if (predicate(latest)) return latest;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const detail = lastError instanceof Error ? `最后一次读取错误：${lastError.message}` : `最后投影：${JSON.stringify(latest)}`;
  throw new Error(`等待投影超时：${description}\n${detail}`);
}

/** R-8：任务在项目视图 `data.tasks` 里（旧读法 task_graph.nodes 已作废）。 */
export function findTask(project: ProjectData, taskId: string): ProjectTaskRow {
  const task = project.tasks.find((node) => node.task_id === taskId);
  if (!task) {
    throw new Error(
      `Project ${project.project.project_id} 中找不到 task ${taskId}；现有：${project.tasks
        .map((node) => node.task_id)
        .join(', ')}`,
    );
  }
  return task;
}

/** R-8：任务图节点在 `data.graph.nodes`（节点字段是 {id,title,lifecycle}）。 */
export function findGraphNode(project: ProjectData, taskId: string): ProjectData['graph']['nodes'][number] {
  const node = project.graph.nodes.find((candidate) => candidate.id === taskId);
  if (!node) {
    throw new Error(
      `Project ${project.project.project_id} 的任务图里找不到节点 ${taskId}；现有：${project.graph.nodes
        .map((candidate) => candidate.id)
        .join(', ')}`,
    );
  }
  return node;
}

/** My Actions 里的某一行（不存在返回 undefined）。 */
export function findAction(actions: ActionsData, taskId: string): ActionItem | undefined {
  return actions.items.find((row) => row.task_id === taskId);
}

/** Home 里某个项目的摘要。 */
export function projectSummary(home: HomeData, projectId: string): HomeProjectSummary {
  const summary = home.projects.find((project) => project.project_id === projectId);
  if (!summary) throw new Error(`Home 投影中找不到 project ${projectId}`);
  return summary;
}

export function currentActorId(): string {
  return CURRENT_ACTOR_ID;
}

export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${JOURNEY_BASE_URL}${path}`;
}

// 供 spec 直接引用投影类型（避免各自 import contract）。
export type { ProjectData, ProjectTaskRow, ProposalData, ActionsData, HomeData };
