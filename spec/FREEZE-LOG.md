# Spec 冻结日志

## K0 Spec v1.0 — 2026-10-21 冻结

- 冻结文件：`spec/K0-SPEC-FROZEN-v1.0.md`（与工作文件 `spec/K0-SPEC.md` 同内容，文首已标注冻结）
- sha256：`97581d9a5d8d6954d1d8b5f97ff51dcb0b61efcfb3c59cc74130cdba89f1eaec`
- 评审链：contract-review 三轮
  - R1（v0.1）：CHANGES_REQUESTED，P0×6/P1×10/P2×4 — `K0-CONTRACT-REVIEW.md` sha256 `f4bdbfe4f7f1a0037fb12eb69e694f734c6cecf0cb77d078be15c1f42e72198f`
  - R2（v0.2）：CHANGES_REQUESTED，第一轮 19/20 解决，新 P1×4/P2×8 — `K0-CONTRACT-REVIEW-R2.md` sha256 `c0b192f9dedc248851855060858cb87a381f607060afef55a3e2500cc1e852fe`
  - R3（v0.3）：**APPROVED**，13 项全闭合，新 P0/P1 为零 — `K0-CONTRACT-REVIEW-R3.md` sha256 `5491898b76a136f563fce1239beaa8235e217b6c2048c6e8ed2cb613e68c7491`
- 裁决依据：`docs/DECISIONS.md` D1–D7 + S1–S7（用户 2026-10-21 两次批准）
- 历史版本：`K0-SPEC-v0.1.md` / `K0-SPEC-v0.2.md` 保留备查
- 冻结后修订候选：`spec/V1.1-CANDIDATES.md`（R3 的 4 条 P2，不阻塞实现）
- 规则：冻结版不静默改动；任何修订走 v1.1 草稿 + 变更记录 + 重新评审
