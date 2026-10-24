// TanStack Query 键集中管理。投影是唯一事实源：一切领域展示数据都经这些键缓存。

export const queryKeys = {
  health: ['health'] as const,
  home: ['home'] as const,
  actions: ['actions'] as const,
  project: (projectId: string) => ['project', projectId] as const,
  proposal: (proposalId: string) => ['proposal', proposalId] as const,
} as const;

/** 失效粒度：SSE 事件按影响范围失效（契约 §1.2 事件→投影映射）。 */
export type InvalidationTarget = 'home' | 'actions' | 'project' | 'proposals' | 'all';
