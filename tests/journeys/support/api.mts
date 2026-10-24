import type { APIRequestContext } from '@playwright/test';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  ActionsProjection,
  ApiErrorBody,
  CaptureResponse,
  CommandResponse,
  CommandType,
  HealthResponse,
  HomeProjection,
  ProjectProjection,
  ProjectTaskNode,
  ProposalProjection,
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
// 纪律：旅程的**领域状态断言只读投影**（home / project / actions / proposal）。
// 这里不暴露任何 mock 内部结构；协议级 SSE 测试走 sse-client.mts。
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

export async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const result = await requestJson<T>(request, path);
  if (result.status !== 200) {
    throw new HttpError(result.status, result.body, `GET ${path} 期望 200，实际 ${result.status}`);
  }
  return result.body;
}

export function getHealth(request: APIRequestContext): Promise<HealthResponse> {
  return getJson<HealthResponse>(request, '/api/health');
}

export function getHome(request: APIRequestContext): Promise<HomeProjection> {
  return getJson<HomeProjection>(request, '/api/home');
}

export function getActions(request: APIRequestContext): Promise<ActionsProjection> {
  return getJson<ActionsProjection>(request, '/api/actions');
}

export function getProject(request: APIRequestContext, projectId: string): Promise<ProjectProjection> {
  return getJson<ProjectProjection>(request, `/api/projects/${encodeURIComponent(projectId)}`);
}

export function getProposal(request: APIRequestContext, proposalId: string): Promise<ProposalProjection> {
  return getJson<ProposalProjection>(request, `/api/proposals/${encodeURIComponent(proposalId)}`);
}

export async function capture(
  request: APIRequestContext,
  text: string,
): Promise<CaptureResponse> {
  const result = await requestJson<CaptureResponse>(request, '/api/capture', {
    method: 'POST',
    data: { text },
  });
  if (result.status !== 201 && result.status !== 200) {
    throw new HttpError(result.status, result.body, `POST /api/capture 期望 201/200，实际 ${result.status}`);
  }
  if (!result.body?.capture_id) {
    throw new Error(`capture 响应缺少 capture_id：${JSON.stringify(result.body)}`);
  }
  return result.body;
}

export interface CommandResult {
  status: number;
  body: CommandResponse | ApiErrorBody;
}

export async function postCommand(
  request: APIRequestContext,
  type: CommandType | string,
  payload: Record<string, unknown>,
  clientSubmitId: string,
): Promise<CommandResult> {
  return requestJson<CommandResponse | ApiErrorBody>(request, '/api/commands', {
    method: 'POST',
    data: { type, payload, client_submit_id: clientSubmitId },
  });
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

export function findTask(project: ProjectProjection, taskId: string): ProjectTaskNode {
  const task = project.task_graph.nodes.find((node) => node.task_id === taskId);
  if (!task) {
    throw new Error(
      `Project ${project.project_id} 中找不到 task ${taskId}；现有：${project.task_graph.nodes
        .map((node) => node.task_id)
        .join(', ')}`,
    );
  }
  return task;
}

/** Home 里某个项目的摘要。 */
export function projectSummary(home: HomeProjection, projectId: string) {
  const summary = home.projects.find((project) => project.project_id === projectId);
  if (!summary) throw new Error(`Home 投影中找不到 project ${projectId}`);
  return summary;
}

export async function waitForActiveStreams(
  request: APIRequestContext,
  expected: number,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<HealthResponse | null> {
  const first = await getHealth(request);
  if (!first.streams || typeof first.streams.active !== 'number') {
    // 外部真服务的 /api/health 契约只保证 {ok:true}；没有 active 计数时
    // 跳过这项本地观测，不让 mock 扩展字段成为集成阻塞项。
    return null;
  }
  return waitForProjection(
    () => getHealth(request),
    (health) => health.streams?.active === expected,
    `SSE active streams == ${expected}`,
    timeoutMs,
  );
}

export function currentActorId(): string {
  return CURRENT_ACTOR_ID;
}

export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${JOURNEY_BASE_URL}${path}`;
}
