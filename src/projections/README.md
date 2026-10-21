# Projections（CQRS 读模型）

Home / MyActions / Project 三个投影由事件消费者维护，可由事件流按 global_seq 重演重建（C5）。
前端只渲染投影给出的 available_actions，不自算状态逻辑（REQ-PJ-1）。
