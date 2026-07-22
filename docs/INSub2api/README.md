# PiNovelStudio × PI × Sub2API 商业化集成

本目录是 `PINOVEL-SUB2API-INTEGRATION-1` 任务的真相源文档集合。任务总计划见 [plan202600722.md](./plan202600722.md)。

## 目录结构

| 文档 | 阶段 | 用途 |
|---|---|---|
| [plan202600722.md](./plan202600722.md) | 总计划 | 10 Phase 集成开发任务书（v1，2026-07-22） |
| [baseline.md](./baseline.md) | T0-1 | 集成基线 SHA、分支策略、工作树保护说明 |
| [01-user-permissions.md](./01-user-permissions.md) | T0-2 | 小说用户权限矩阵与可见页面清单 |
| [02-billing-rules.md](./02-billing-rules.md) | T0-2 | 余额预占、扣费、取消、退款规则 |
| [03-model-attribution.md](./03-model-attribution.md) | T0-2 | 模型调用归属与计费网关规则 |
| [04-content-safety.md](./04-content-safety.md) | T0-2 | 请求前门禁、小说场景安全策略、输出防泄露 |
| [05-data-retention.md](./05-data-retention.md) | T0-2 | 数据保留周期与用户删除规则 |
| [06-upstream-licensing.md](./06-upstream-licensing.md) | T0-2 | 上游模型商业授权记录 |
| [07-license-notice.md](./07-license-notice.md) | T0-2 | Sub2API LGPL-3.0 Notice 与第三方许可证清单 |

## 集成分支

- PiNovelStudio: `codex/sub2api-integration`（从 `9df76de` 创建）
- Sub2API: `codex/sub2api-integration`（克隆后创建）

## 真相源优先级

1. [plan202600722.md](./plan202600722.md)（任务总计划，冻结架构决策）
2. 本目录 T0-2 治理文档（业务规则冻结）
3. PiNovelStudio [AGENTS.md](../../AGENTS.md)（统一主链路约束，与 Sub2API 集成不冲突时继续生效）

如本目录与 PiNovelStudio 主项目 AGENTS.md 冲突，集成场景以本目录为准；PiNovelStudio 单机生成行为仍以 AGENTS.md 为准。
