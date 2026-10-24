// 命令提交 hook（契约 §0.5/§0.6/§0.7）：
// - 一切写操作只走 POST /api/commands；client_submit_id 客户端生成、重试复用；
// - 202 + receipt = 已受理（P 层待确认），不等领域完成；
// - 409 原样呈现（页面错误条），不自动重试覆盖；
// - 网络层失败（NetworkError）结果未知：保留幂等键，界面提示「结果待确认」，
//   用户重试时复用同一 client_submit_id（服务端去重）；
// - 成功后幂等键清除；投影刷新主要靠 SSE 失效（§1.2），此处仅兜底 invalidate。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ApiError, CommandConflictError, NetworkError } from '../../api/http';
import { queryKeys } from '../../api/queryKeys';
import type { CommandReceipt, CommandRequest, CommandType } from '../../api/types';
import { clearSubmitId, reuseOrCreateSubmitId } from './submit-id';

export interface SubmitVars {
  payload: Record<string, unknown>;
  /** 幂等键：同一次用户意图保持不变（如 `cmd:task_advance:start:${taskId}`）。 */
  idemKey: string;
}

export interface UseCommandOptions {
  type: CommandType;
  /** 202 已受理回执（注意：不代表领域动作完成）。 */
  onAccepted?: (receipt: CommandReceipt) => void;
  /** 409：前置条件冲突（原因码原样呈现，由页面错误条展示）。 */
  onConflict?: (error: CommandConflictError) => void;
  /** 确定性客户端错误（400/404/422 等）：payload 需修正后重提。 */
  onRejected?: (error: ApiError) => void;
  /** 结果未知（网络失败/5xx/408）：提示「结果待确认」，保留幂等键。 */
  onIndeterminate?: (error: NetworkError | ApiError) => void;
}

/** 结果未知的错误：网络失败、5xx、408（§0.7）。 */
function isIndeterminateApiError(error: ApiError): boolean {
  return error.retryable;
}

export function useCommand(options: UseCommandOptions) {
  const queryClient = useQueryClient();

  return useMutation<CommandReceipt, Error, SubmitVars>({
    mutationFn: async (vars: SubmitVars) => {
      // 幂等键在 mutationFn 内解析：手动重试会自动复用同一 client_submit_id
      const clientSubmitId = reuseOrCreateSubmitId(vars.idemKey);
      const request: CommandRequest = {
        type: options.type,
        payload: vars.payload,
        client_submit_id: clientSubmitId,
      };
      return api.command(request);
    },
    onSuccess: (receipt, vars) => {
      // accepted/duplicate 都是确定性终态：清除幂等键
      clearSubmitId(vars.idemKey);
      options.onAccepted?.(receipt);
      // 兜底刷新（SSE 失效是主路径，§1.2）
      void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      void queryClient.invalidateQueries({ queryKey: queryKeys.actions });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['proposal'] });
    },
    onError: (error, vars) => {
      // 顺序判断（不用类型守卫函数：守卫失败分支会把 error 窄化成 never）
      if (error instanceof CommandConflictError) {
        // 409：确定性冲突，清除幂等键允许修正后重提；原因由页面呈现
        clearSubmitId(vars.idemKey);
        options.onConflict?.(error);
        return;
      }
      if (error instanceof NetworkError || (error instanceof ApiError && isIndeterminateApiError(error))) {
        // 结果未知：保留幂等键（§0.7）
        options.onIndeterminate?.(error);
        return;
      }
      if (error instanceof ApiError) {
        // 400/404/422：确定性拒绝，清除幂等键
        clearSubmitId(vars.idemKey);
        options.onRejected?.(error);
        return;
      }
      // 未知错误：保守按结果未知处理（保留幂等键）
      options.onIndeterminate?.(error as NetworkError);
    },
  });
}
