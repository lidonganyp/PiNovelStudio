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
| Phase 2 | T2-1 小说用户权限 / T2-2 任务令牌签发（Go 后端） | ✅ 完成 | `9fc8cf7` |
| Phase 3 | T3-1 账本 schema / T3-2 余额预占服务 / T3-3 结算回调 | ✅ 完成 | `43879b9` / `956ec2a` / `004132b` |
| Phase 4 | T4-1 数据模型 schema / T4-2/T4-3 数据服务租户隔离 | ✅ 完成 | `d0e2258` / `35055e7` |
| Phase 5 | Sub2API Vue 前端 /novel 页面 (T5-1/T5-2/T5-3) | ✅ 完成 | `66ffd4e` |
| Phase 6 | T6-2/T6-3 内容安全与反向提取防护 | ✅ 完成 | `f206530` |
| Phase 7 | T7-1 公共 API 注册 | ✅ 完成 | `cf93ccd` |
| Phase 8 | NovelAdminService 管理后台与可观测性 | ✅ 完成 | `456b99f` |
| Phase 9 | NovelSafetyService/NovelAdminService 单元测试 | ✅ 完成 | `468119f` |
| Phase 10 | 部署配置与文档 | ✅ 完成 | `7806d1c` |

### P0 阻断项修复（生产审计 28/100 → 全部修复）

生产审计发现 6 个 P0 阻断项，阻断上线。以下 6 个 commit 全部完成修复：

| 编号 | 问题 | 修复 | 提交 |
|---|---|---|---|
| P0-1 | 生成 API 缺失（估价/创建任务/状态/SSE/取消/内部结算） | 6 个端点全部实现 | `ec7e186` |
| P0-2 | 模型与计费未接线（billingClient.settle() 只在测试中调用） | metering-binder 包装 invoke，事后结算每次模型调用 | `4ff52eb` |
| P0-3 | 令牌授权不可信（前端可自行提交 project_id/job_id） | 签发前验证项目归属，GetJobStatus 按 userID 过滤 | `a21c023` |
| P0-4 | 多租户 Workspace 未实现（临时 Workspace 配置未被消费） | workspace-manager 三阶段生命周期：物化/提交/清理 | `4d909f5` |
| P0-5 | 部署配置无法启动（缺必填变量 + 注入禁止的模型厂商 Key） | 移除禁止 Key，补齐 SUB2API_INTERNAL_* 必填变量 | `9dae89c` |
| P0-6 | 安全门禁未接入请求链路；安全事件/指标对所有登录用户开放 | 收敛至 admin-only 端点，移除公共路由 | `d02fcbf` |

### 架构关键事实

- **统一模型出口**：PiNovelStudio 当前仍直连 Provider（保留架构兼容性）；`llmClient` 作为未来切换到 Sub2API 内部网关的占位基础设施。`metering-binder` 通过 `pricing-table` 估算 `actualCharge` 调用 `billingClient.settle()` 完成事后结算。
- **多租户 Workspace 生命周期**：
  - 物化（materialize）：Sub2API 后端从 DB 取项目文档+配置+前章 → 通过 invoke input 传给 Novel Runtime → Novel Runtime 在 `{tempWorkspaceRoot}/{jobId}/` 下创建临时 workspace 写入这些文档
  - 提交（commit）：成功后从 invoke 返回 `result.text` 提取正文 → `dataService.SaveChapter` 到 DB（DB 生成的 chapter ID 覆盖 PiNovelStudio 返回值）
  - 清理（cleanup）：Novel Runtime 在 `finally` 块删除临时 workspace（无论成功失败）
- **任务令牌**：使用 `jose` JWT (HS256)，issuer="sub2api-backend", audience="novel-runtime"。包含 userId/projectId/jobId/capabilities/maxCharge/issuedAt/expiresAt/nonce。内存 nonce 防重放（生产应换 Redis）。
- **内部结算回调鉴权**：使用 `SUB2API_INTERNAL_LLM_API_KEY` 共享密钥 + `crypto/subtle.ConstantTimeCompare`，**不是 JWT**。
- **6 个友好进度阶段**：`checking_materials | preparing_chapter | generating_text | optimizing_style | checking_continuity | saving_chapter`，固化在 `stageLabels.ts`。内部阶段名（agentic_raw/style_optimizer/fact_recheck/save_commit 等）严禁前端出现。
- **PiNovelStudio 返回形态**：`result.text`（章节正文）、`result.chapterId`、`result.stageResults.modelCalls[]`（ModelCallEntry 数组，含 route/kind/ts/tokenUsage/failed/provider）、`result.stageResults.modelBudget`。
- **`_projectRoot` 注入**：`input._projectRoot` 绕过 PiNovelStudio 的 `setProjectRoot`/`findProjectRoot` 标记文件校验，直接作为 pipeline 的 `projectRoot`。这是多租户隔离的注入点。
- **DB 存储与文件系统解耦**：Sub2API 用 ent ORM 把章节/文档存为 DB 行（按 userID 租户隔离）；PiNovelStudio 的文件系统写入完全独立，无自动同步。`runGeneration` goroutine 显式调用 `SaveChapter` 把 PiNovelStudio 返回的正文持久化到 DB。

### 当前测试基线

- **Go 后端**：`go build ./...` 通过；`go vet ./internal/handler/...` 通过。
- **Novel Runtime**：`npm test` 80/80 通过；`npm run build` 通过；`npm run typecheck` 通过。
- **前端**：`npm run typecheck` 通过；`npm run build` 通过。

### 已知事项

- **预存 flaky 测试**：`TestContentModerationRuntimeSnapshotRefreshFailureKeepsStaleConfig` 在基线上 5/5 失败（与 P0 修复无关），需要独立治理。
- **Nonce 防重放**：当前为内存 Set（max 100k 条目，LRU 驱逐），单实例。生产多实例部署需要换 Redis + TTL。
- **PiNovelStudio 直连 Provider**：当前 `llmClient` 仅作为架构占位；PiNovelStudio 仍直连模型 Provider。生产部署若需统一出口审计，需后续切换 PiNovelStudio 模型路由配置到 `SUB2API_INTERNAL_LLM_BASE_URL`。
- **后续可灰度上线**：所有 P0 阻断项已修复，可进入下一轮生产审计。
