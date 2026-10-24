based_on: 06a57950f2b9acb2a76278ae5e8f867426937931

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ 80a09c1（feat/actor-separation 基于此开发，未 push） |
| K0-Q12 actor 分离（C6） | 已实现待独立评审：REQ-ACC-2 分离拦截 + INV-6 Tool Gateway + actor 写路径校验（详见开发轨报告 Q12-1024） |
| Batch1 复审 fix 波次 | 已合入基线（PR #1–#7） |
| D9 交互契约 | v0.2 已合入 develop（D11 裁决落地） |
| 门禁：本分支实测（真机 PG16） | 根 npm test 498 passed / 5 todo / 0 failed；server:test 85 passed / 0 failed；根与 server 双 typecheck 全绿 |

决策见 docs/DECISIONS.md
