// API 客户端：8 个契约端点的类型化封装。
// 本层不 import mock 任何内部实现；mock 在更外层拦截 fetch（见 src/mock/README.md）。
// 基址为同源相对 /api；如需指向其他主机，在反代或 dev server proxy 解决，不改本层语义。

import { apiCommand, apiGet, apiPost } from './http';
import type {
  CaptureRequest,
  CaptureResponse,
  CommandRequest,
  HealthResponse,
  HomeProjection,
  MyActionsProjection,
  ProjectProjection,
  ProposalProjection,
} from './types';

export const api = {
  health: (signal?: AbortSignal) => apiGet<HealthResponse>('/api/health', signal),

  home: (signal?: AbortSignal) => apiGet<HomeProjection>('/api/home', signal),

  actions: (signal?: AbortSignal) => apiGet<MyActionsProjection>('/api/actions', signal),

  project: (projectId: string, signal?: AbortSignal) =>
    apiGet<ProjectProjection>(`/api/projects/${encodeURIComponent(projectId)}`, signal),

  proposal: (proposalId: string, signal?: AbortSignal) =>
    apiGet<ProposalProjection>(`/api/proposals/${encodeURIComponent(proposalId)}`, signal),

  /** 捕获输入 → 落 FeedbackCaptured 并触发提议流程；回 {capture_id, proposal_id?} */
  capture: (request: CaptureRequest, signal?: AbortSignal) =>
    apiPost<CaptureResponse>('/api/capture', request, signal),

  /** 统一命令入口（一切写操作只走这里；client_submit_id 客户端生成、重试复用） */
  command: (request: CommandRequest, signal?: AbortSignal) =>
    apiCommand('/api/commands', request, signal),

  /** SSE 订阅地址（游标由 SseClient 自管） */
  streamUrl: (cursor: number) => `/api/stream?cursor=${cursor}`,
} as const;
