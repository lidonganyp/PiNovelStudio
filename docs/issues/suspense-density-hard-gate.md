# Issue: Stage 6.5 悬念密度闭环门禁

> **legacy 说明**（2026-07-16）：本 issue 描述的 Stage 6.5 悬念密度门禁、`DramaCoach` 与 `craft/suspense-density-analyzer.ts` 均属 legacy Stage0-8 架构资产，已随统一主链路迁移退役。`agents/drama_coach.ts` 与 `craft/suspense-density-analyzer.ts` 均已物理删除，悬念密度不再作为独立硬门禁存在。本文保留为历史行为记录。

**优先级**: P2
**状态**: Resolved（legacy，已退役）
**创建日期**: 2026-06-21
**解决日期**: 2026-06-21
**关联**: PR #gate-fixes 验收遗留项

## 问题描述

Stage 6.5 悬念密度检测已接入主流程，但只是 warning-only 软指标：
- 低于阈值只 `console.warn`，不阻断
- 检测失败明确"不阻断主流程"
- 未真正调用 `DramaCoach.analyzeSuspenseDensity`（DramaCoach 已退役），而是内联计算

### 解决方案

1. 提取 `analyzeSuspenseDensity` 为独立工具函数 `craft/suspense-density-analyzer.ts`（该文件已随 legacy 退役删除），原计划 DramaCoach 和 Stage 6.5 共用
2. Stage 6.5 升级为硬门禁：低密度时设置 `status: "error"` 并阻断主流程
3. 检测失败也阻断（fail-closed）
4. 注入建议通过 `blockingIssues.injections` 传递

### 验收标准

1. ✅ 悬念密度低于阈值时触发阻断（status: error + blockingIssues）
2. ✅ 调用共享 `analyzeSuspenseDensity` 获取注入建议
3. ✅ 注入建议通过 blockingIssues 传递给调用方
4. ✅ 检测失败时也阻断（fail-closed）
