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

## 进度跟踪

| Phase | 任务 | 状态 | Sub2API 提交 |
|---|---|---|---|
| Phase 0 | T0-1 基线+分支 / T0-2 治理文档 | ✅ 完成 | PiNovelStudio `04d8b67` |
| Phase 1 | T1-1 novel-runtime 骨架 / T1-2 工具白名单 / T1-3 统一模型出口 / T2-2 令牌验证侧 | ✅ 完成 | `8fc7652` |
| Phase 2 | T2-1 小说用户权限 / T2-2 任务令牌签发（Go 后端） | ✅ 完成 | 本次提交 |
| Phase 3 | 余额预占与逐次计费账本 | ⬜ 待开始 | — |
| Phase 4 | 小说数据模型与临时 Workspace 适配 | ⬜ 待开始 | — |
| Phase 5 | Sub2API Vue 前端 /novel 页面 | ⬜ 待开始 | — |
| Phase 6 | 内容安全与反向提取防护 | ⬜ 待开始 | — |
| Phase 7 | 公共 API 与错误模型 | ⬜ 待开始 | — |
| Phase 8 | 管理后台与可观测性 | ⬜ 待开始 | — |
| Phase 9-10 | 测试验收与部署发布 | ⬜ 待开始 | — |

### 已知阻塞

- **Go 工具链不可用**：当前环境无 `go` / `wire` 命令，Phase 2+ 的 Go 代码无法 `go build` / `go test` 编译验证。已写 Go 源码与测试作为验收规约，待工具链可用后执行。
- **跨系统契约已验证**：Phase 2 通过 Node 侧 `cross-system-go-contract.test.ts`（5 用例）可执行地证明 Go MapClaims 结构（含 nbf/jti/字符串 aud）能被 Novel Runtime `verifyTaskToken` 接受。
