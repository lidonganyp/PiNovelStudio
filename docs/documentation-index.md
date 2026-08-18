# 文档索引与生效范围

**核对日期**：2026-08-19

## 当前生产权威文档

| 文档 | 用途 |
|---|---|
| [`production-architecture.md`](production-architecture.md) | 当前入口、阶段、路由、workspace、事务和构建边界 |
| [`production-runbook.md`](production-runbook.md) | 发布、预检、正式生成、成功判定和失败处理 |
| [`top-tier-chinese-novel-system-development-plan.md`](top-tier-chinese-novel-system-development-plan.md) | 统一主链路的长期架构与设计原则 |
| [`project-memory.md`](project-memory.md) | 跨会话状态、近期变更和受保护工作树说明 |
| [`route-inventory.md`](route-inventory.md) | 当前路由矩阵与生产/评测隔离 |

如果文档与代码不一致，按以下顺序处理：

1. `config/model-routing.json`：模型路由唯一真相源；
2. `index.ts`、`handlers/public-handlers.ts`、`v2/core/unified-entry.ts`、`v2/core/unified-orchestrator.ts`：生产执行真相；
3. `production-architecture.md` 与本运行手册：面向使用者的解释。

## 历史或隔离评测资料

以下内容不应被当作当前生产流程：

- `dist-eval/`、`tests-eval/`、NovelBench 和 `reports/` 中的回放结果；
- 文档中明确标记为 `legacy`、`eval-only`、`historical` 的章节；
- 旧 Stage0–8、raw → editorial → judge → select、bounded best-of-N 设计稿；
- `.trae/` 与 `delete/` 下的本地历史计划/归档资料。

这些资料可用于追溯决策或重放实验，但不能作为生产入口、默认模型或回退策略的依据。

