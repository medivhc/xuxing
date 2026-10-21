import { describe, it } from 'vitest';

// G1（spec §8.1，第一 conformance）：联系张三确认方案 —— 人类轻量 Run + Outcome
// no_response + 唯一 WaitCondition/跟进 + 重放幂等。实现随 develop 阶段逐条点亮。
describe('G1 联系不在与唯一跟进', () => {
  it.todo('Run A（human_light）回报联系尝试 → Outcome conclusion_kind=no_response, info_obtained=false');
  it.todo('Task 进 waiting_on_person，恰一个 active WaitCondition、恰一个跟进 Task');
  it.todo('同一 Feedback 重放 10 次，跟进仍恰一个（REQ-DD-1 / INV-10）');
  it.todo('第二次 Feedback 的转述意见以 user_statement 来源入 Evidence，不冒充已验证事实');
  it.todo('验收 accepted 后 Task=accepted；新 Task 提议以 PlanChange 呈现，未应用不入图');
});
