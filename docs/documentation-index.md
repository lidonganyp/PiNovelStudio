# 文档索引与生效范围

**核对日期**：2026-11-03（当日完成历史文档清理与归档）

## 当前生产权威文档

| 文档 | 用途 |
|---|---|
| [`production-architecture.md`](production-architecture.md) | 当前入口、阶段、路由、workspace、事务和构建边界 |
| [`production-runbook.md`](production-runbook.md) | 发布、预检、正式生成、成功判定和失败处理 |
| [`production-release-governance-runbook-20261102.md`](production-release-governance-runbook-20261102.md) | 发布治理状态机、四臂评测矩阵与 eval-gate 证据门禁 |
| [`production-sync-instructions.md`](production-sync-instructions.md) | 生产同步操作说明 |
| [`top-tier-chinese-novel-system-development-plan.md`](top-tier-chinese-novel-system-development-plan.md) | 统一主链路的长期架构与设计原则（架构真相源） |
| [`project-memory.md`](project-memory.md) | 跨会话状态、近期变更和受保护工作树说明 |
| [`route-inventory.md`](route-inventory.md) | 当前路由矩阵与生产/评测隔离 |
| [`memory-layer-baseline.md`](memory-layer-baseline.md) | 长程记忆层基线（CanonState / CharacterState / PromiseLedger / PatternMemory） |

如果文档与代码不一致，按以下顺序处理：

1. `config/model-routing.json`：模型路由唯一真相源；
2. `index.ts`、`handlers/public-handlers.ts`、`v2/core/unified-entry.ts`、`v2/core/unified-orchestrator.ts`：生产执行真相；
3. `production-architecture.md` 与本运行手册：面向使用者的解释。

## 运行治理与契约

| 文档 | 用途 |
|---|---|
| [`batch-generation-guide.md`](batch-generation-guide.md) | 批量章节生成操作指南 |
| [`budget-ledger-contract.md`](budget-ledger-contract.md) | 预算与计费台账契约 |
| [`test-portfolio-manifest.md`](test-portfolio-manifest.md) | 测试组合清单 |
| [`multi-agent-collaboration-runbook-20260812.md`](multi-agent-collaboration-runbook-20260812.md) | 多智能体协作运行手册 |
| [`prompt-injection-trust-architecture-runbook-20260812.md`](prompt-injection-trust-architecture-runbook-20260812.md) | 提示注入信任架构运行手册 |
| [`user-feedback-evidence-pipeline-runbook.md`](user-feedback-evidence-pipeline-runbook.md) | 用户反馈证据流水线运行手册 |
| [`issues/`](issues/) | 进行中问题记录 |

## 领域参考与外部知识

| 文档 | 用途 |
|---|---|
| [`AI小说工作流-从故事设计到长篇成书的系统方法.md`](AI小说工作流-从故事设计到长篇成书的系统方法.md) | 中文网文方法论参考 |
| [`research/`](research/) | 中文网文 AI 语言模式与提示源研究 |
| [`external-kb/`](external-kb/) | 场景卡与外部知识库数据 |
| [`evidence/`](evidence/) | 评测证据与迁移声明 |
| [`INSub2api/`](INSub2api/) | 平台合规、计费、权限、内容安全等基线文档 |
| [`小说大纲/`](小说大纲/) | 作品级故事大纲资产 |

## 历史或隔离评测资料

以下内容不应被当作当前生产流程：

- `dist-eval/`、`tests-eval/`、NovelBench 和 `reports/` 中的回放结果；
- 文档中明确标记为 `legacy`、`eval-only`、`historical` 的章节；
- 旧 Stage0–8、raw → editorial → judge → select、bounded best-of-N 设计稿；
- `archive/cleanup-20261103-135341/` 中归档的历史 development-plan、wave0-baseline、phase 设计、debugging/tasks/platform 等过程文档。

这些资料可用于追溯决策或重放实验，但不能作为生产入口、默认模型或回退策略的依据。
