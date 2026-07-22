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

> **Phase 完成不等于可上线**：第二轮审计 22/100 标记 9 项 P0 阻断；第三轮已修复 P0-1 ~ P0-8 与 P0-E2E 代码层（详见下方「第二轮审计 P0 阻断（22/100，9 项）与第三轮修复状态」），P0-9 PI 互动界面用户已降级为 P1。仍需 Docker 真实构建、e2e-smoke.sh 人工冒烟与真实生成链路验证。

## 第一轮 P0 修复（28/100 → 提交 6 个 commit，但二轮审计揭示根因未消除）

| 编号 | 问题 | 提交 | 第二轮审计结论 |
|---|---|---|---|
| P0-1 | 生成 API 缺失 | `ec7e186` | 端点存在但调用链断（execute≠invoke、缺 chapterId），实际无法生成 |
| P0-2 | 模型与计费未接线 | `4ff52eb` | metering-binder 存在但 `tokenUsage="unknown"` 导致 `actualCharge=0` |
| P0-3 | 令牌授权不可信 | `a21c023` | 仍然有效 |
| P0-4 | 多租户 Workspace 未实现 | `4d909f5` | 仍然有效，但 chapterId 缺失导致 PiNovelStudio 拒绝输入 |
| P0-5 | 部署配置无法启动 | `9dae89c` | 仅 env 层面，Dockerfile/compose 未配套 |
| P0-6 | 安全事件/指标开放过宽 | `d02fcbf` | 仅路由收敛，CheckInput/CheckOutput 未接入请求链路 |

## 第二轮审计 P0 阻断（22/100，9 项）与第三轮修复状态

### 修复完成情况（2026-07-23）

| 编号 | 问题 | 修复提交 | 验证 |
|---|---|---|---|
| P0-1 真实工具适配（execute→invoke） | sub2api `4b96d63` | novel-runtime 88/88 测试通过 |
| P0-2 真实 Token 计量 | PiNovelStudio `79bf692`（用户 WIP）+ `ac05f0c` | build:prod ✓、smoke 2/2 ✓、p0-2 test 2/2 ✓ |
| P0-3 Sub2API 唯一模型出口 | PiNovelStudio `ac05f0c` | 同 P0-2 验证 |
| P0-4 生成请求补 chapterId | sub2api（与 P0-1 同期提交） | novel-runtime 单测覆盖 |
| P0-5 API DTO 契约对齐 | sub2api（snake_case + title 派生 + 反馈字段） | go build/test ✓、frontend typecheck/build ✓ |
| P0-6 安全门禁接入请求链路 | sub2api `2dcee2b` | go build/test ✓（CheckInput 前置 / CheckOutput 后置） |
| P0-7 取消/预算中止信号传播 | sub2api `dfa6598`（JobCancelRegistry） + `99e2ece`（metering-binder break） | go test ✓、novel-runtime 88/88 ✓ |
| P0-8 可启动部署配置 | sub2api `9443dff` | Dockerfile 多阶段 + compose env/healthcheck/tag 对齐（**待 Docker 真实构建验证**） |
| P0-E2E 真实端到端测试 | sub2api `46f2f55`（real-extension-loading.test.ts） + `e9b02f1`（e2e-smoke.sh） | novel-runtime 90/90 测试通过；smoke 脚本待用户人工执行（需 build + curl） |
| P0-9 PI 互动界面 | — | **用户已声明降级为 P1，不在本轮 P0 范围** |

### 仍待真实环境验证（非阻断代码问题）

1. **Docker 真实构建与 Compose 启动**：当前开发机无 Docker，需用户执行 `docker build -f deploy/Dockerfile.novel -t weishaw/novel-runtime:v0.1.0 .` 与 `docker-compose -f docker-compose.yml -f docker-compose.novel.yml up -d`。
2. **e2e-smoke.sh 端到端冒烟**：需用户在 Linux/WSL 环境执行 `bash deploy/e2e-smoke.sh`（依赖 curl + python）。
3. **真实生成链路验证**：需 DB + task token + 余额预占完整环境，调用 `/api/v1/novel/projects/{id}/generate` 触发真实 PiNovelStudio 章节生成并验证扣费。

详细修复证据与验证结论见 [verification-round-3.md](./verification-round-3.md)。原始 P0 问题清单与冻结决策见 [plan202600722.md](./plan202600722.md)。

## 架构关键事实（仍有效）

- **任务令牌**：使用 `jose` JWT (HS256)，issuer="sub2api-backend", audience="novel-runtime"。包含 userId/projectId/jobId/capabilities/maxCharge/issuedAt/expiresAt/nonce。内存 nonce 防重放（生产应换 Redis）。
- **内部结算回调鉴权**：使用 `SUB2API_INTERNAL_LLM_API_KEY` 共享密钥 + `crypto/subtle.ConstantTimeCompare`，**不是 JWT**。
- **6 个友好进度阶段**：`checking_materials | preparing_chapter | generating_text | optimizing_style | checking_continuity | saving_chapter`，固化在 `stageLabels.ts`。内部阶段名严禁前端出现。
- **PiNovelStudio 返回形态**：`result.text`（章节正文）、`result.chapterId`、`result.stageResults.modelCalls[]`（ModelCallEntry 数组）、`result.stageResults.modelBudget`。
- **`_projectRoot` 注入**：`input._projectRoot` 绕过 PiNovelStudio 的 `setProjectRoot`/`findProjectRoot` 标记文件校验，直接作为 pipeline 的 `projectRoot`。这是多租户隔离的注入点。
- **DB 存储与文件系统解耦**：Sub2API 用 ent ORM 把章节/文档存为 DB 行（按 userID 租户隔离）；PiNovelStudio 的文件系统写入完全独立，无自动同步。

## 第二轮验证结果

- **Novel Runtime**：构建、typecheck 通过，80/80 单元测试通过；但测试全部使用伪造的 `invoke` 工具，未覆盖真实 PiNovelStudio 加载。
- **前端**：typecheck、生产构建通过；全量测试有 2 项既有回滚 API 测试失败；小说功能没有任何前端测试。
- **PiNovelStudio**：三套构建通过；关键生产流程测试 42 通过、1 跳过。全量测试未通过，主要因缺少 `workspaces/xinmo/chapters/chapter-17.md` 等真实验收素材。
- **Go 与 Docker**：当前环境没有 Go/Docker，无法独立执行后端构建、数据库集成测试和 Compose 启动验证。
- **Git 状态**：两个仓库保持原样；21 个 staged WIP、未跟踪 `tmp/` 均未处理。
