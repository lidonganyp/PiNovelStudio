# Phase 8 Stage P — Prompt-only 对比报告

**时间**：2026-08-10T11:44:42.187Z
**模式**：真实模型（Gemini 生产 route，需授权）
**批次**：3 | **seed/批**：3（seed 0-8）
**route**：narrator_primary（gemini31/gemini-3.1-pro-preview，fallback=[]）
**Provenance**：provider=gemini31, model=gemini-3.1-pro-preview, route=narrator_primary, temp=0.72, fallbackDisabled=false

> 两臂统一 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（fallback=[]），
> 只变化 systemPrompt（Prompt-only），使 Prompt 收益可独立归因。

- **P-A（基线）**：通用 `REAL_SYSTEM_PROMPT_BASE`
- **P-B（Gemini 专属）**：`GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE`

## 跨批次聚合对比

| 指标 | P-A（通用） | P-B（Gemini 专属） |
|------|------|------|
| 平均 mustVerify 覆盖率 | 0.983 | 0.134 |
| sourceRef 完整率 | 0.880 | 0.083 |
| 停止率 | 85% | 88% |
| 总调用 | 124 | 10 |
| 估算 token | 11610 | 52 |
| 非法工具选择 | 0 | 0 |
| 解析失败 | 0 | 0 |
| 空结果 | 0 | 9 |
| 错误 | 0 | 9 |
| 超时 | 0 | 9 |
| 首证据延迟(ms) | 4 | 3 |

## 门禁结论（P-B 相对 P-A，跨批次）

| 门禁 | 结论 | 详情 |
|------|------|------|
| mustVerify 覆盖率不降级 | ✗ | B=0.134 >= A=0.983 - 0.05 |
| sourceRef 完整率不降级 | ✗ | B=0.083 >= A=0.880 - 0.05 |
| 非法调用不恶化 | ✓ | 非法工具 B=0<=A=0, 解析失败 B=0<=A=0 |
| 空结果不恶化 | ✗ | B=9 <= A=0 |
| 停止率不降级 | ✓ | B=88% >= A=85% - 5% |
| token 成本获益（加分项） | ✓ | B=52 < A=11610×0.9=10449 |
| 首证据延迟不恶化（加分项） | ✓ | B=3ms <= A=4ms + 1 |

**硬门全部通过**：否
**全部通过（含加分项）**：否

## 各批次门禁

| 批次 | seeds | 硬门 | 全部 |
|------|-------|------|------|
| 1 | 0,1,2 | FAIL | FAIL |
| 2 | 3,4,5 | FAIL | FAIL |
| 3 | 6,7,8 | FAIL | FAIL |

> 稳定获益判定：≥2/3 批次硬门通过且跨批次方向一致，才进入 canary 候选设计；否则保持当前生产基线（漏洞保持通用 Prompt）。