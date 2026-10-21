# Executors（执行层）

统一 RunProtocol 适配：代码 Agent 适配器（K0 一个）+ 人类执行者（轻量 Run，S3）。
执行层只能回报 RawResult，不能直接写 Outcome（REQ-OC-1）。
