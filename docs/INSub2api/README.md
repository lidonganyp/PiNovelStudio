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

> **Phase 完成不等于可上线**：第二轮审计 22/100，9 项 P0 阻断仍在。详见下方「第二轮审计 P0 阻断」。

## 第一轮 P0 修复（28/100 → 提交 6 个 commit，但二轮审计揭示根因未消除）

| 编号 | 问题 | 提交 | 第二轮审计结论 |
|---|---|---|---|
| P0-1 | 生成 API 缺失 | `ec7e186` | 端点存在但调用链断（execute≠invoke、缺 chapterId），实际无法生成 |
| P0-2 | 模型与计费未接线 | `4ff52eb` | metering-binder 存在但 `tokenUsage="unknown"` 导致 `actualCharge=0` |
| P0-3 | 令牌授权不可信 | `a21c023` | 仍然有效 |
| P0-4 | 多租户 Workspace 未实现 | `4d909f5` | 仍然有效，但 chapterId 缺失导致 PiNovelStudio 拒绝输入 |
| P0-5 | 部署配置无法启动 | `9dae89c` | 仅 env 层面，Dockerfile/compose 未配套 |
| P0-6 | 安全事件/指标开放过宽 | `d02fcbf` | 仅路由收敛，CheckInput/CheckOutput 未接入请求链路 |

## 第二轮审计 P0 阻断（22/100，9 项，待修复）

按推荐修复顺序：

1. **真实生成工具无法调用** — Novel Runtime 期望 `tool.invoke()`，PiNovelStudio 真实工具只有 `execute()` → `/v1/invoke` 返回 `TOOL_NOT_FOUND`。
2. **计费实际为零** — PiNovelStudio 把 `tokenUsage` 固定为 `"unknown"` → in=0/out=0 → `actualCharge=0`。
3. **所有 LLM 请求仍然直连厂商** — `llmClient` 未投入使用，PiNovelStudio 直连 Gemini/Claude/GPT，违反冻结决策 5。
4. **生成请求缺少必填 chapterId** — Go 后端只传 `workspaceId + chapterNumber`，PiNovelStudio 要求 `workspaceId + chapterId + chapterNumber`。
5. **前后端公共契约没有对齐** — snake_case/camelCase 不一致、`title` 必填但前端不传、`author_style_profile`/`style_profile` 不一致、反馈字段 `type/comment` vs `feedbackType/content`。
6. **安全门禁没有进入真实请求链路** — `NovelSafetyService.CheckInput/CheckOutput` 仅单元测试和管理统计调用，未在生成 Handler 实际执行。
7. **余额耗尽和取消不能停止正在进行的模型调用** — 后台用 `context.Background()`，取消只改 DB；Metering Binder 遇预算耗尽仍继续。
8. **部署配置无法形成可运行系统** — Dockerfile 未含 novel-runtime；Compose 缺 `NOVEL_RUNTIME_HOST=0.0.0.0`；Overlay 缺 `NOVEL_RUNTIME_BASE_URL`/HMAC/结算 Key；健康检查只是 `process.exit(0)`；镜像用 `latest`。
9. **PI 互动界面尚未实现** — 当前只有「资料/章节/生成/反馈」四标签，无 PI 对话/交互式大纲规划/受限小说助手界面。

详细证据与修复顺序见 [plan202600722.md](./plan202600722.md) §进度快照。

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
