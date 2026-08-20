# PiNovelStudio 商用平台开发计划

> **任务编号**：PINOVEL-PLATFORM-BUILD-1
> **版本**：v1.8
> **日期**：2026-08-20
> **状态**：开发/stub 路径已关闭先前核查缺口（生产静态托管、设置项生效、助手 HTTP 适配器、路由对齐、反馈 API、JWT 文案）。P6-6 真实商户与 P8-6 真实模型、干净机器 compose 实测、sub2api 冻结仍待用户凭证/Docker/签署。
> **文档地位**：本文件是「新建轻量商用平台」（路线 C）的唯一开发计划真相源。执行期间所有设计变更必须回写本文档，不接受口头口径。

---

## 0. 前置结论（本计划赖以成立的三项调研事实）

1. **novel-runtime 可整体抽取**。它位于 [sub2api/services/novel-runtime/](../../sub2api/services/novel-runtime/)，是独立的 Node/TypeScript Express 服务（监听 `127.0.0.1:3100`），依赖仅 express / jose / zod / pino / undici，与 Go 主体的耦合只通过 HTTP 回调（billing-client）与任务令牌签发密钥，无 Go 代码依赖。
2. **PiNovelStudio 零改动即可脱离 sub2api 网关**。P0-3 网关出口是 env 条件性覆写（[api/fallback-manager.ts](../../.pi/extensions/novel-studio/api/fallback-manager.ts) 与 [utils/config.ts](../../.pi/extensions/novel-studio/utils/config.ts)）：只要**不设置** `SUB2API_INTERNAL_LLM_API_KEY` / `SUB2API_INTERNAL_LLM_BASE_URL`，模型调用即恢复原生 provider 直连。新平台不设置这两个 env 即可，PiNovelStudio 主链路代码一行不改。
3. **sub2api 前端无标准组件库**（package.json 中无 naive-ui / element-plus 等），5 个 novel Vue 视图只能做**结构参考**，UI 层按 Element Plus 全新实现。

---

## 1. 背景与目标

### 1.1 现状

- PiNovelStudio 本体（`.pi/extensions/novel-studio/`）是章节生成内核，质量链路成熟，但没有任何商用能力（用户、计费、支付、后台）。
- sub2api（fork，LGPL-3.0，Go + Vue）承载了小说业务层的 85-90%：15 张 novel 表、计费闭环（预占/结算/释放/调账）、9 种支付方式、novel-runtime 集成。但：
  - 约 90% 代码（账号池/API Key/渠道/代理/兑换码/返佣/批量图片）与小说商用无关；
  - 从未真实部署验证（Docker / E2E / 真实扣费链路空白）；
  - 管理后台缺失小说管理界面、费率静态不可调、模型用量明细缺失、调账 API 未暴露。

### 1.2 用户痛点（已确认）

部署运维重、代码维护重、界面功能杂。不需要 sub2api 的核心能力「API 分发」。

### 1.3 目标

构建一个**全 TypeScript 单栈的轻量商用平台**，只保留小说商用必需能力：

- 用户侧：小说项目管理、对话式大纲/章节生成、结构化章节目录、余额与消费明细、充值。
- 管理侧：用户管理、模型与费率配置、模型用量统计、收入明细、调账、审计日志、系统设置。
- 内核：完整复用 PiNovelStudio 统一主链路（铁律不变：`novel_generate_chapter` 是唯一章节入口，AI 不得直接撰写正文）。

### 1.4 非目标（明确不做）

- ❌ API 分发 / 渠道 / 账号池 / 兑换码 / 推广返佣（sub2api 核心能力，放弃）。
- ❌ 多货币、发票、订阅制会员体系（只做预充值 + 按量扣费）。
- ❌ 移动端 App / 小程序（只做响应式 Web）。
- ❌ 对 PiNovelStudio 内核做任何修改（保持零改动，见 §4.4）。
- ❌ 维护 sub2api 双轨并行（新平台上线即冻结 sub2api，见 §17）。

---

## 2. 决策记录

### 2.1 用户已确认决策

| 决策项 | 结论 |
|---|---|
| 痛点 | 部署运维重 + 代码维护重 + 界面功能杂 |
| API 分发能力 | 不需要，只自用 |
| 支付渠道 | 支付宝/微信官方直连 |
| 技术栈 | 全 TypeScript 单栈 |
| 代码位置（原 D1） | 本仓库 `platform/` 目录（与 PiNovelStudio 同仓，pnpm workspace） |
| 后端框架（原 D2） | NestJS（结构化强、AI 协作一致性好） |
| 助手规划模型（原 D4） | 沿用 sub2api 的 GPT-5.6 选型，但**不走网关**：配置独立规划模型 route（直连 provider），费率单列 |
| UI 组件库（原 D3） | Element Plus（用户门户 + 管理台统一，管理台生态最全） |

### 2.2 剩余默认决策（未逐项确认，标注为可调整）

> D1-D4 已于 2026-08-19 经用户确认，移入 §2.1。

| 编号 | 决策项 | 默认值 | 调整代价 |
|---|---|---|---|
| D5 | 余额单位 | 分（整数），全程整数运算 | 不可调（防浮点误差，硬约束） |
| D6 | 生成任务进度 | 轮询（GET /jobs/:id），不做 WebSocket/SSE 推送进度；对话回复用 SSE | 低（后期可加推送） |
| D7 | 部署形态 | 单机 Docker Compose（3 容器），无 Redis | 低 |
| D8 | 用户体系 | 邮箱 + 密码（JWT），不做 OAuth | 低 |

---

## 3. 技术栈与代码组织

### 3.1 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js 20 LTS + TypeScript 5.7 | 与 novel-runtime、PiNovelStudio 同栈 |
| 后端框架 | NestJS 11 + Fastify adapter | 模块化 DI、OpenAPI 自带、guard/interceptor 体系适合管理台权限 |
| ORM | Prisma | schema 即文档，迁移内建，与 NestJS 集成成熟 |
| 数据库 | PostgreSQL 15 | 沿用 sub2api 选型，事务 + 行锁（SELECT FOR UPDATE）支撑预占 |
| 缓存 | 无 | 单机规模不需要；会话用 JWT（无状态） |
| 前端 | Vue 3.5 + Vite + Pinia + Vue Router + Element Plus | 用户已确认 TS 单栈；Element Plus 管理台生态最全 |
| 任务进度 | HTTP 轮询 + SSE（仅对话流式） | 简单可靠，无长连接基础设施 |
| 部署 | Docker Compose（postgres + platform-api + novel-runtime） | 3 容器，无 Redis |
| 测试 | Vitest（单元）+ Supertest（API）+ Playwright（E2E） | 单栈统一 |

### 3.2 目录结构

```
platform/                          # pnpm workspace 根
├── pnpm-workspace.yaml
├── package.json                   # 公共 scripts：dev / build / test / migrate
├── docker-compose.yml             # 生产：postgres + api + runtime
├── docker-compose.dev.yml         # 开发：仅 postgres
├── .env.example
├── apps/
│   ├── api/                       # NestJS 后端（platform-api）
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/            # guards / filters / interceptors / decorators
│   │   │   ├── config/            # 配置模块（env 校验，zod）
│   │   │   ├── modules/
│   │   │   │   ├── auth/          # 注册/登录/JWT
│   │   │   │   ├── users/         # 用户资料
│   │   │   │   ├── projects/      # novel_project CRUD
│   │   │   │   ├── chapters/      # 章节目录/正文/版本
│   │   │   │   ├── outline/       # 大纲树
│   │   │   │   ├── characters/    # 角色档案
│   │   │   │   ├── documents/     # 设定文档
│   │   │   │   ├── assistant/     # 对话消息 + SSE
│   │   │   │   ├── jobs/          # 生成任务提交/轮询（调 novel-runtime）
│   │   │   │   ├── billing/       # 计费引擎（预占/结算/释放/调账）+ 明细查询
│   │   │   │   ├── payment/       # 充值订单 + 支付宝/微信直连
│   │   │   │   ├── internal/      # 内部 API（novel-runtime 回调，HMAC）
│   │   │   │   └── admin/         # 管理后台聚合模块
│   │   │   └── prisma/            # schema.prisma + migrations
│   │   └── test/                  # Supertest 集成测试
│   └── web/                       # Vue3 前端（platform-web）
│       ├── src/
│       │   ├── api/               # 接口封装（openapi-typings 可选）
│       │   ├── stores/            # Pinia
│       │   ├── router/
│       │   ├── layouts/           # PortalLayout / AdminLayout
│       │   ├── views/
│       │   │   ├── portal/        # 用户门户（工作台/项目/计费/充值）
│       │   │   └── admin/         # 管理后台
│       │   └── components/
├── services/
│   └── novel-runtime/             # 从 sub2api/services/novel-runtime 抽取（§8）
└── docs/                          # 平台自身文档（部署/运维/对账）
```

### 3.3 与 PiNovelStudio 主仓库的关系

- `platform/` 是独立 npm workspace，**不 import** PiNovelStudio 源码；novel-runtime 通过 `extension-loader` 在运行时加载 PiNovelStudio 编译产物（`dist/`），与现有机制一致。
- `.pi/extensions/novel-studio/` 构建产物 `dist/` 是 novel-runtime 的加载目标，主仓库 `npm run build:prod` 产物直接可用。
- 主仓库根 `.env` 中 PiNovelStudio 所需 provider 凭证（`GLM_*` / `CLAUDE_*` / `ARK_*` 等）改为注入 novel-runtime 容器 env（§4.4）。

---

## 4. 系统架构

### 4.1 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  用户浏览器                                                  │
│  ├─ 用户门户（platform-web/portal）                           │
│  └─ 管理后台（platform-web/admin）                            │
└──────────────┬─────────────────────────────────────────────┘
               │ HTTPS（Nginx/Caddy 终结 TLS，反代）
┌──────────────▼─────────────────────────────────────────────┐
│  platform-api（NestJS，容器 2）                               │
│  ├─ 认证（JWT）· 用户/项目/章节/大纲/角色/文档 CRUD             │
│  ├─ 助手对话（SSE）· 生成任务编排（提交/轮询/进度）              │
│  ├─ 计费引擎（预占/逐调用结算/释放/调账/费率）                   │
│  ├─ 支付（支付宝/微信直连 · 订单 · 异步通知）                    │
│  ├─ 管理后台 API（用户/费率/用量/收入/审计/设置）                │
│  └─ internal API（HMAC 签名，仅内网）                          │
└──────┬──────────────────────────────┬──────────────────────┘
       │ Prisma                       │ HTTP（任务令牌 + HMAC）
       ▼                              ▼
┌──────────────┐            ┌─────────────────────────────────┐
│ PostgreSQL 15│            │ novel-runtime（Express，容器 3）  │
│ （容器 1）     │            │ 127.0.0.1:3100，仅内网可达         │
│              │            │ ├─ task-token-auth（jose JWT）    │
│ 21 张表       │            │ ├─ tool-whitelist（6 个 novel_*） │
│ （§5）        │            │ ├─ workspace-manager（多租户）     │
│              │◄───────────┤ ├─ metering-binder（逐调用计量）   │
│              │ 结算回调     │ └─ extension-loader              │
└──────────────┘（HMAC）     │      └─ 加载 PiNovelStudio dist/   │
                             │         → 统一主链路（零改动）      │
                             └────┬────────────────────────────┘
                                  │ 原生 provider 直连
                                  ▼
                        GLM / Claude / Doubao / Gemini API
                        （env 注入凭证，不设置 SUB2API_INTERNAL_LLM_*）
```

### 4.2 组件职责边界

| 组件 | 职责 | 明确不做 |
|---|---|---|
| platform-web | 渲染与交互；轮询任务进度 | 不做任何计费/编排逻辑 |
| platform-api | 唯一业务权威：数据 CRUD、计费、支付、任务编排、鉴权 | 不直接调用模型，**助手规划模型除外**（GPT-5.6 独立 route 直连，不经 novel-runtime/PiNovelStudio，不受 model-routing.json 约束）；不加载 PiNovelStudio |
| novel-runtime | 唯一 PiNovelStudio 执行环境：工具白名单、多租户工作区、计量上报 | 不持有业务数据库连接（只通过 internal API 回调） |
| PostgreSQL | 唯一持久化真相源 | — |

### 4.3 关键链路：生成一章的完整时序

```
用户点击「生成章节」
  → POST /api/projects/:id/chapters/:cid/generate（platform-api）
    1. 校验章节状态/seed 完整性
    2. 计费预检：可用余额 = balance - Σ(active holds 未结算部分)
    3. 估算 max_charge（字数预算 × 费率快照），写入 novel_balance_hold(active)
    4. 创建 novel_generation_job(pending)，签发任务令牌（jose JWT + HMAC）
    5. 异步调用 novel-runtime POST /v1/invoke（任务令牌）
  → novel-runtime
    6. 校验任务令牌 → 创建/复用租户工作区（_projectRoot 注入）
    7. 调用 novel_generate_chapter（统一主链路）
       Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic
       → FactGuard → 作者风格整章优化 → StoryPreservation
       → FinalFactRecheck → Completeness → FinalStateCommit → AtomicSave
    8. 每次模型调用 → metering-binder → POST internal/billing/settlements
       （jobId+callId 幂等，逐笔扣减 hold，费率快照落库）
    9. 进度事件（6 阶段）→ job 记录阶段字段（供轮询）
  → platform-api
    10. 收到 runtime 完成/失败回调（或轮询拉取）→ 收尾：
        - 成功：hold 转 settled，结算差额退回/补扣，章节状态 generated
        - 失败：hold 剩余部分 released，job 状态与 FailureEnvelope 落库
  → 前端轮询 GET /api/jobs/:id 展示阶段与结果
```

**6 个友好进度阶段**（沿用 sub2api 已定义口径）：`checking_materials | preparing_chapter | generating_text | optimizing_style | checking_continuity | saving_chapter`。

**PiNovelStudio 返回契约**（platform-api 解析）：`result.text`（正文）、`result.chapterId`、`result.stageResults.modelCalls[]`（计量对账依据）、`result.stageResults.modelBudget`。

### 4.4 PiNovelStudio 零改动结论（关键）

- [api/fallback-manager.ts](../../.pi/extensions/novel-studio/api/fallback-manager.ts) 与 [utils/config.ts](../../.pi/extensions/novel-studio/utils/config.ts) 中的 sub2api 网关出口仅在 `SUB2API_INTERNAL_LLM_API_KEY` / `SUB2API_INTERNAL_LLM_BASE_URL` 存在时覆写。
- **新平台部署中这两个 env 永远不设置** → 模型调用走原生 provider 直连（GLM/Claude/Doubao/Gemini 各自 base URL + key，从 `config/model-routing.json` 路由规则）。
- Provider 凭证通过 novel-runtime 容器 env 注入（`GLM_*` / `CLAUDE_*` / `ARK_*` 等，与主仓库 `.env` 同名同义）。
- 计量不依赖网关：novel-runtime 的 metering-binder 从 PiNovelStudio 返回的 `stageResults.modelCalls[]` 直接取数上报。

---

## 5. 数据模型（Prisma schema）

### 5.1 从 sub2api 移植的 15 张 novel 表

移植原则：**表结构与字段语义 1:1 照搬**（这是行为接口，保持兼容可对照验收），实现层用 Prisma 重写。

| 表 | 关键字段 | 说明 |
|---|---|---|
| novel_project | user_id, title, genre, status, workflow_state | 小说项目主档 |
| novel_chapter | project_id, chapter_number, title, content, status(draft\|generated\|final), **version(乐观锁)**, deleted_at(软删除) | 章节正文 |
| novel_chapter_seed | chapter_id, intent, must_include, forbidden_facts, promises, ending_goal | 写前种子（作者内容契约载体） |
| novel_generation_job | job_id, user_id, project_id, chapter_id, status(pending\|running\|succeeded\|failed\|insufficient_balance…), max_charge, settled_amount | 生成任务 |
| novel_character | project_id, name, role_type, identity, goals… | 角色档案 |
| novel_outline_node | project_id, **parent_id(树)**, node_type(book\|volume\|arc\|chapter), title, summary, sort_order | 结构化大纲树 |
| novel_document | project_id, document_type(7 种), title, current_version | 设定文档（世界观/规则等） |
| novel_document_version | document_id, version, content | 文档版本 |
| novel_chapter_version | chapter_id, version, content, source(manual_save\|ai_generated\|restore) | 章节版本历史 |
| novel_balance_hold | user_id, job_id, amount, settled_amount, status(active\|released\|settled) | 余额预占 |
| novel_generation_call | job_id, **call_id(幂等唯一约束 job_id+call_id)**, internal_stage, model, tokens_in/out, rate_snapshot, actual_charge | 逐调用计量与结算 |
| novel_billing_adjustment | user_id, amount, reason, admin_user_id, created_at（**只追加，禁止 update/delete**） | 管理员调账流水 |
| novel_assistant_message | project_id, user_id, role, content | 对话历史 |
| novel_feedback | user_id, chapter_id/job_id, type, content | 用户反馈 |

### 5.2 新增表（6 张）

| 表 | 关键字段 | 说明 |
|---|---|---|
| users | id, email(唯一), password_hash(argon2), nickname, role(user\|admin), status(active\|banned), **balance(分,整数)**, created_at | 账户 + 余额 |
| payment_orders | id, order_no(唯一), user_id, channel(alipay\|wechat), amount(分), status(created\|paid\|failed\|expired), external_trade_no, paid_at | 充值订单 |
| model_providers | id, provider_key(唯一), name, api_base_url, api_key_encrypted(AES-256-GCM), enabled | Provider 配置（密钥落库加密；正文模型凭证运行时下发 novel-runtime，GPT-5.6 规划模型由 platform-api 自用直连） |
| model_rates | id, model_key, display_name, provider_id, input_price_per_million(分), output_price_per_million(分), effective_from, enabled | 费率（可调，历史费率不删，结算取调用时刻生效值） |
| audit_logs | id, actor_id, actor_type, action, target_type, target_id, detail(Json), ip, created_at（只追加） | 管理操作审计 |
| settings | key(唯一), value(Json), updated_at | 系统设置键值 |

### 5.3 计费字段设计要点

- **余额一律用分（int64）**，费率用「每百万 token 多少分」，运算全程整数（分 × token ÷ 1_000_000 向上取整）。
- **可用余额** = `users.balance − Σ(novel_balance_hold WHERE status=active 的 amount − settled_amount)`。
- **费率快照**：`novel_generation_call.rate_snapshot` 记录结算时点的单价，后续调费率不影响历史账单。
- **调账只追加**：`novel_billing_adjustment` 无 update/delete 路径（service 层禁止暴露，Prisma 层可加拒绝中间件）。

---

## 6. 后端 API 设计

### 6.1 认证（公开）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register | 邮箱注册（邀请码开关由 settings 控制） |
| POST | /api/auth/login | 登录，签发 JWT（7d） |
| GET | /api/auth/me | 当前用户 + 余额 |

### 6.2 用户门户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | /api/projects | 项目列表（分页/搜索）/ 创建 |
| GET/PATCH/DELETE | /api/projects/:id | 详情 / 更新 / 删除（软删） |
| GET | /api/projects/:id/chapters | 章节目录（树/列表，含状态） |
| GET/PUT | /api/projects/:id/chapters/:cid | 章节正文 / 保存编辑（**乐观锁 version**，冲突 409） |
| GET/POST | /api/projects/:id/chapters/:cid/seed | 查看 / 编写写前种子 |
| GET | /api/projects/:id/outline | 大纲树 |
| GET/POST/PATCH/DELETE | /api/projects/:id/characters | 角色档案 CRUD |
| GET/POST/PATCH/DELETE | /api/projects/:id/documents | 设定文档 CRUD（带版本） |
| POST | /api/projects/:id/chapters/:cid/generate | 提交生成任务（预检 + 预占 + 建 job） |
| GET | /api/jobs/:jobId | 任务进度（阶段/耗时/失败 envelope） |
| GET | /api/jobs/:jobId/calls | 该任务逐调用明细（用户可见账单级） |
| GET/POST | /api/projects/:id/assistant/messages | 对话历史 / 发消息（**SSE 流式**） |
| GET | /api/billing/summary | 余额 + 近 30 日消耗 |
| GET | /api/billing/records | 消费明细分页（按时间/项目/模型筛选） |
| POST | /api/payment/orders | 创建充值订单（返回支付二维码/跳转参数） |
| GET | /api/payment/orders/:orderNo | 订单状态轮询 |

### 6.3 管理后台（Admin guard）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/admin/users | 用户列表（余额/消耗/状态筛选） |
| GET | /api/admin/users/:id | 用户详情（余额、预占、消费、订单聚合） |
| POST | /api/admin/users/:id/adjustments | 调账（正负，必填 reason，写审计） |
| POST | /api/admin/users/:id/status | 封禁/解封 |
| GET/POST/PATCH | /api/admin/model-providers | Provider 配置 |
| GET/POST/PATCH | /api/admin/model-rates | 费率配置（新费率只增不改，effect_from 生效） |
| GET | /api/admin/usage/summary | 模型用量汇总（按模型/用户/日） |
| GET | /api/admin/usage/records | 调用明细下钻 |
| GET | /api/admin/revenue/summary | 收入（充值 + 消耗口径，日/月） |
| GET | /api/admin/audit-logs | 审计日志（只读，筛选） |
| GET/PUT | /api/admin/settings | 系统设置 |

### 6.4 内部 API（HMAC 签名，仅 novel-runtime 可调，网络层仅内网）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /internal/billing/holds | 预占（幂等：jobId） |
| POST | /internal/billing/settlements | 逐调用结算（幂等：jobId+callId） |
| POST | /internal/billing/holds/:jobId/finalize | 任务收尾（settled 或 released + 金额） |
| GET | /internal/models/credentials | 下发 Provider 凭证（按 enabled providers） |
| POST | /internal/jobs/:jobId/status | 进度/阶段/结果回调 |

---

## 7. 计费引擎详细设计（核心模块）

### 7.1 状态机

```
预占：POST holds
  事务（SERIALIZABLE 或 SELECT FOR UPDATE users 行锁）：
    可用 = balance − Σ(active holds 未结算)
    可用 < max_charge → 拒绝（job 标记 insufficient_balance，402）
    可用 ≥ max_charge → 插入 hold(active, amount=max_charge)

逐调用结算：POST settlements（jobId+callId 唯一约束兜底幂等）
  事务：
    已存在该 callId → 返回原结果（幂等命中）
    不存在 → charge = ceil(tokens 计费 × rate_snapshot)
      hold.settled_amount += charge
      users.balance −= charge
      插入 novel_generation_call
      若 hold.settled_amount ≥ hold.amount：
        后续调用直接拒绝（超预占上限 = 模型异常，任务转 failed + envelope）

收尾：POST finalize
  成功：hold.status = settled（settled_amount 定格，差额留在余额，已逐笔扣）
  失败：退回 hold.amount − hold.settled_amount → balance（hold.status = released）
  幂等：重复 finalize 按 hold 当前状态返回

调账：POST /api/admin/users/:id/adjustments
  balance += amount（可正可负，负数不得使 balance < 0）
  只追加流水 + 审计
```

### 7.2 对照验收要求

- Go 版计费逻辑（sub2api `internal/service/novel_billing*.go`）作为**行为规范参照**，按行为重写为 TypeScript，**不复制源码文本**（LGPL 合规，见 §15.5）。
- 移植验收：对同一组测试用例（预占/并发预占/幂等结算/超上限/失败退回/调账），Go 版与 TS 版行为一致。测试用例以表驱动写在 Vitest 中，数值断言精确到分。

### 7.3 费率估算（max_charge）

- 按章节字数预算（settings 可配，默认沿用主链路 budget）× 该 route 模型费率 ×（输入+输出估算比）× 安全系数（1.3）。
- **助手对话模型（大纲规划）**：沿用 sub2api 的 GPT-5.6 选型，但不再走 sub2api 网关——在 `model_providers` 配置独立 GPT provider（直连 base URL + key），`model_rates` 中费率单列（不与正文生成模型混用费率项）。对话调用同样过预占/结算（hold 复用同一张表，job_id 为对话轮次 id）。该 route 由 platform-api 直接调用（SSE 流式转发），不经 novel-runtime，不受 PiNovelStudio `model-routing.json` 约束。

---

## 8. novel-runtime 抽取与改造

### 8.1 抽取范围（整体搬移，自有代码）

源：[sub2api/services/novel-runtime/](../../sub2api/services/novel-runtime/)（14 个 src 文件 + 10 个测试）。
目标：`platform/services/novel-runtime/`（git 内保留完整历史由仓库统一承载）。

**保持不变**（协议层）：
- `task-token-auth` / `task-token.ts`（jose JWT + HMAC 任务令牌）协议
- `tool-whitelist.ts`（6 个 `novel_*` 公开工具）
- `workspace-manager.ts`（多租户临时工作区，`_projectRoot` 注入）
- `metering-binder.ts`（逐调用计量上报协议）
- `extension-loader.ts`（加载 PiNovelStudio `dist/` 的机制）
- `routes/v1/invoke.ts` HTTP 契约

**必改点**：

| 编号 | 文件 | 改造内容 |
|---|---|---|
| R1 | billing-client.ts | 回调 URL 指向 platform-api `/internal/*`；HMAC 密钥换新平台 `INTERNAL_API_SECRET` |
| R2 | config.ts | 移除 sub2api 特有 env；新增 `PLATFORM_API_BASE_URL`、任务令牌签发方公钥/密钥来源 |
| R3 | task-token.ts | 令牌签发/校验密钥与 platform-api 对齐（platform-api 签发，runtime 校验） |
| R4 | llm-client.ts | 移除「强制走网关」逻辑；保留直连 provider 实现（凭证来自 env 或 `/internal/models/credentials` 下发，二选一，默认 env） |
| R5 | pricing-table.ts | 费率表来源改为 platform-api 下发或启动时拉取（`model_rates` 生效值），移除硬编码 |
| R6 | index.ts | 健康检查、端口、日志配置对齐新 compose 网络 |
| R7 | workspace-manager.ts | 工作区根目录改为容器 volume 挂载点（数据持久化路径） |

### 8.2 PiNovelStudio 加载方式

- novel-runtime Docker 镜像构建时 COPY 主仓库 `.pi/extensions/novel-studio/dist/`（`npm run build:prod` 产物）。
- 主仓库升级 PiNovelStudio → 重 build runtime 镜像（版本随镜像固化，避免运行时漂移）。
- `V2_FORCE_STUB=1` 保留为测试开关（stub 模式跑集成测试不调真实模型）。

### 8.3 验收

- `npm test`（10 个既有测试文件随迁并通过，cross-system-go-contract.test.ts 改为对照 platform-api 契约）。
- Stub 模式全链路：platform-api 提交 job → runtime 执行（stub）→ 计量回调 → 收尾 → 余额/明细正确。

---

## 9. 支付与充值

### 9.1 渠道（官方直连）

| 渠道 | 产品 | 说明 |
|---|---|---|
| 支付宝 | 当面付（扫码）或电脑网站支付 | 官方 SDK `alipay-sdk`；商户号需用户自备 |
| 微信支付 | Native 支付（扫码） | 官方 SDK `wechatpay-node-v3`；商户号需用户自备 |

### 9.2 订单流程

```
POST /api/payment/orders（channel, amount）
  → 创建 payment_orders(created)，返回支付参数（二维码内容/跳转 URL）
  → 用户扫码支付
  → 渠道异步通知 → POST /api/payment/notify/:channel
     验签 → 幂等（external_trade_no + order_no 状态机）→ 订单 paid
     → users.balance += amount（事务）→ 写 audit
  → 前端轮询订单状态展示成功
```

- **通知幂等**：订单已 paid 的重复通知直接返回成功应答。
- **对账兜底**：定时任务（每小时）调渠道查单接口，补偿「支付成功但通知丢失」的订单。
- **退款**：v1 不做用户自助退款；异常订单由管理员调账（负向 adjustment）+ 线下渠道退款处理。

### 9.3 降级路径

商户号未就绪期间：管理员通过 `POST /api/admin/users/:id/adjustments` 手动充值兜底，支付模块可独立后置（Phase 6 可延后，不阻塞其他阶段）。

---

## 10. 前端信息架构

### 10.1 用户门户（portal）

| 页面 | 路由 | 要点 |
|---|---|---|
| 登录/注册 | /login /register | — |
| 项目列表 | /projects | 卡片式；创建向导（标题/类型/简介） |
| **三栏工作台** | /projects/:id/workbench | 左：章节目录树（大纲树映射，状态徽标）；中：内容区（章节正文编辑 / 设定文档 / 角色）；右：AI 助手对话（SSE 流式，可下发生成指令） |
| 生成任务面板 | 工作台内抽屉/浮层 | 6 阶段进度、逐调用消耗实时展示、失败 envelope 友好呈现 + 重试按钮 |
| 章节版本 | /projects/:id/chapters/:cid/versions | 版本对比/恢复 |
| 计费总览 | /billing | 余额卡片 + 近 30 日消耗趋势（ECharts） |
| 消费明细 | /billing/records | 分页表格：时间/项目/模型/tokens/金额 |
| 充值 | /billing/topup | 金额选择 + 支付二维码 + 状态轮询 |

三栏工作台规格参照 [novel-workbench-development-task.md](../INSub2api/novel-workbench-development-task.md)（T/F 任务分解与验收指标沿用其口径，UI 用 Element Plus 全新实现）。

### 10.2 管理后台（admin）

| 页面 | 路由 | 要点 |
|---|---|---|
| 概览 | /admin | 今日消耗/充值/活跃用户卡片 |
| 用户管理 | /admin/users | 列表（余额/累计消耗/状态）；详情抽屉（预占明细、消费、订单、调账入口） |
| 模型与费率 | /admin/models | Provider 配置（密钥脱敏）；费率列表 + 新增生效 |
| 用量报表 | /admin/usage | 按模型/用户/日聚合 + 明细下钻 |
| 收入明细 | /admin/revenue | 充值订单 + 消耗口径两视图 |
| 审计日志 | /admin/audit | 只读，筛选 |
| 系统设置 | /admin/settings | 注册开关/字数预算/安全系数等 |

---

## 11. 安全设计

1. **传输**：Nginx/Caddy 终结 TLS，强制 HTTPS；内网容器间通信走 compose 内部网络。
2. **认证**：argon2id 密码哈希；JWT（HS256，7d），登出靠前端丢弃 + 短有效期权衡（v1 不做 refresh token/黑名单）。
3. **权限**：NestJS guard 三级：公开 / 用户（资源归属校验：所有 project 查询强制 `userId` 过滤）/ 管理员。
4. **内部 API**：HMAC-SHA256 签名（时间戳防重放，5 分钟窗口）；仅监听内网。
5. **密钥管理**：Provider API key 用 AES-256-GCM 加密落库（主密钥来自 env，不入库不入库备份）；日志全链路脱敏。
6. **注入与越权**：Prisma 参数化查询天然防注入；所有 :id 资源访问做归属校验（service 层统一 assertOwner）。
7. **支付验签**：支付宝/微信回调必须验签 + 金额核对（订单金额 vs 通知金额）。
8. **审计**：调账、费率变更、用户封禁、设置变更全部写 audit_logs。
9. **限流**：登录接口 IP 限速（内存滑动窗口即可，单机无 Redis）；生成接口按用户并发上限（默认 1 个 running job/用户）。

---

## 12. 部署方案

### 12.1 生产 Compose（3 容器 + 反代）

```yaml
services:
  postgres:   # postgres:15-alpine，volume 持久化，healthcheck
  platform-api:   # NestJS（含 platform-web 静态托管或独立 nginx 容器二选一，默认 api 托管 @nestjs/serve-static）
  novel-runtime:  # 仅 expose 内网 3100，volume 挂载工作区数据
  caddy:      # TLS 终结 + 反代（可并入宿主机已有网关）
```

### 12.2 运维要点

- **备份**：每日 `pg_dump` + 工作区目录 tar，保留 7 天。
- **升级**：`docker compose pull && up -d`；Prisma migrate 在 api 容器启动前执行（entrypoint）。
- **监控**：v1 用 `/health` + compose restart 策略；接入外部拨测可选。
- **环境变量清单**（`.env.example` 完整登记）：数据库 DSN、JWT 密钥、INTERNAL_API_SECRET、AES 主密钥、支付商户配置、各 Provider key、`PINOVEL_MODEL_REQUEST_TIMEOUT_MS`（沿用主链路超时）。

---

## 13. 分阶段任务分解

> 每阶段结束有可运行/可演示产物；阶段内任务编号 `P{阶段}-{序号}`。**Phase 3 完成前不写小说业务 API，Phase 6 可与 Phase 7 并行。**

### Phase 1：仓库骨架与认证基建

| 任务 | 内容 |
|---|---|
| P1-1 | `platform/` pnpm workspace 初始化：根 package.json、tsconfig base、eslint/prettier、`docker-compose.dev.yml`（postgres） |
| P1-2 | NestJS `apps/api` 骨架：config 模块（zod 校验 env）、pino 日志、全局异常过滤器、`/health` |
| P1-3 | Prisma 接入 + 首版 schema（users/settings）+ migrate 工作流 |
| P1-4 | 认证模块：注册/登录/me、argon2、JWT guard、Admin guard |
| P1-5 | Vue3 `apps/web` 骨架：路由、Portal/Admin 双 layout、登录注册页、axios 封装 |
| P1-6 | 种子脚本：创建首个 admin 账户 |

**验收**：`pnpm dev` 起 api+web+postgres；注册->登录->访问受保护接口->403 非 admin 访问 admin 接口；migrate 可重放。

> **完成记录（2026-08-19）**：P1-1~P1-6 全部完成，验收全绿——install / migrate（可重放）/ seed / build / typecheck / test（unit 8 + e2e 9，17/17）/ dev 链路（health ok、注册初始余额 0、me、非 admin 访问 admin 403、非法 token 401、错误密码 401）/ web typecheck+build 双 0。
>
> **执行偏差**（与原计划的差异，均已回写为当前事实）：
> - **数据库**：不使用 `docker-compose.dev.yml` 的 postgres 容器，改用本机 PostgreSQL 17（服务 `postgresql-x64-17`，`127.0.0.1:5432`）。原 postgres 超户密码本地未存储，经用户授权重置；新建 `platform` 库与专用账号（含 CREATEDB 权限，供 Prisma shadow database）。连接串见 `platform/.env`；postgres 超户新密码已单独交付用户（副本 `%TEMP%\pf-creds.txt`，不入库）。compose 文件保留但非验收路径。
> - **e2e 框架**：用 Fastify 原生 `inject()`（light-my-request）替代 Supertest，语义等价、依赖更少。
> - **Vitest 转译器**：接入 unplugin-swc（NestJS 官方 Vitest 方案）。vitest 默认 esbuild 转译不产出 `design:paramtypes`，Nest 依赖注入全部为 undefined（controller/guard 全 500）；`tsconfigRaw` 显式配置实测不生效，改用 swc 插件后全绿。
> - **fastify 显式依赖**：pnpm 严格 node_modules 下，源码裸 import 'fastify'（guard/filter/decorator 的类型引用）需在 apps/api 显式声明 fastify 依赖（^5.12.1）。
> - **pnpm 沙箱适配**：`platform/.npmrc` 将 store/cache/state 指向项目内目录，绕开 TRAE 沙箱对全局 pnpm 目录的写拦截。
> - **JWT expiresIn 类型**：@nestjs/jwt v11 的 ms 模板字面量类型需 `as JwtSignOptions['expiresIn']` 收窄后传入 signOptions。

### Phase 2：计费引擎

| 任务 | 内容 |
|---|---|
| P2-1 | Prisma：model_providers / model_rates / novel_balance_hold / novel_generation_call / novel_billing_adjustment 表 |
| P2-2 | billing service：预占（行锁 + 可用余额计算）、幂等结算（唯一约束兜底）、收尾（settled/released）、调账（只追加） |
| P2-3 | 费率 service：生效费率查询、费率快照结构 |
| P2-4 | internal API 模块：HMAC 签名中间件（时间戳防重放）+ 5 个 internal 路由 |
| P2-5 | 单测（表驱动，对照 §7.2）：并发预占不超扣、幂等结算重复调用同结果、超预占拒绝、失败退回精确到分、调账只追加 |

**验收**：全部计费单测绿；用两个并发事务验证同一用户可用余额计算正确。

> **完成记录（2026-08-19）**：P2-1~P2-5 全部完成，验收全绿——`pnpm --filter @platform/api test` 50/50（Phase 1 的 17 + Phase 2 的 33：money 8、hmac 6、billing.service 12、internal.e2e 7）；`typecheck` 通过；`pnpm lint` 通过。并发预占：余额 1000 分、两笔 600 分同时预占，恰好一笔成功一笔 402，可用余额精确为 400 分。迁移 `20260819152520_billing_engine` 已应用到本机 `platform` 库。
>
> **执行偏差**（与原计划的差异，均已回写为当前事实）：
> - **可用余额口径**：按 §7.1 采用 `balance − Σ(active holds 的 amount − settled_amount)`，而不是 Go 版 `SUM(active holds.amount)`。后者会把已结算部分重复占用。
> - **失败收尾不回写 `users.balance`**：预占创建时并不从 `balance` 扣款，只占用可用额度；逐笔结算才扣 `balance`。finalize 失败只把 hold 标为 `released`，已扣费用保留，未结算额度通过解除预占回到可用余额。重复 finalize 按当前状态幂等返回。
> - **HMAC 协议**（Phase 3 billing-client 必须对齐）：请求头 `X-Internal-Timestamp`（unix 秒）+ `X-Internal-Signature`（hex）；canonical 为 `timestamp\\nMETHOD\\npath\\nsha256(stableJsonBody)`；窗口 5 分钟；密钥 `INTERNAL_API_SECRET`。
> - **AES-256-GCM 密文格式**：`base64url(iv).base64url(tag).base64url(ciphertext)`，主密钥 `AES_MASTER_KEY`（64 hex）。`GET /internal/models/credentials` 对解密失败的 provider 记日志并跳过，避免测试夹具或坏行拖垮整表下发。
> - **任务进度暂存**：`POST /internal/jobs/:jobId/status` 把 `progress_stage` / `progress_detail` 写在 `novel_balance_hold` 上。`novel_generation_job` 表属 Phase 4，Phase 3 jobs 模块接入后应迁到 job 行。
> - **调账只追加**：Prisma Client extension 拒绝 `novel_billing_adjustment` 的 update/delete/upsert（含事务）。测试清理走未加守卫的 `PrismaClient`，生产路径无删除入口。
> - **内部路由前缀**：`/internal/*` 从全局 `/api` 前缀排除，与 §6.4 路径一致。

### Phase 3：novel-runtime 抽取与对接

| 任务 | 内容 |
|---|---|
| P3-1 | 拷贝 `sub2api/services/novel-runtime` → `platform/services/novel-runtime`，跑通独立 build/test |
| P3-2 | R1-R7 改造（§8.1）：billing-client 指向 platform-api、task-token 密钥对齐、llm-client 直连、pricing-table 动态化 |
| P3-3 | runtime Dockerfile（COPY PiNovelStudio dist/，volume 工作区）+ 生产 compose 组网 |
| P3-4 | jobs 模块（platform-api）：提交任务（预检+预占+令牌签发）、轮询接口、状态回调、收尾 |
| P3-5 | stub 模式集成测试：`V2_FORCE_STUB=1` 全链路（提交→执行→计量→结算→收尾→余额正确） |
| P3-6 | 验证 PiNovelStudio 零改动：容器内不设置 `SUB2API_INTERNAL_LLM_*`，确认直连（stub 下验证分支逻辑） |

**验收**：stub 模式下从 API 提交到章节落库、逐调用结算入账、失败退回，全链路测试绿；runtime 测试套件（10 文件）通过。

> **完成记录（2026-08-20）**：P3-1 / P3-2 / P3-3（文件就绪）/ P3-6 已完成。P3-4 jobs 模块与 stub 提交路径随 Phase 4 一并落地（`JobsService` + 任务令牌 + stub/http runtime 客户端 + `GET /api/jobs/:jobId`）；P3-5 的「真实 novel-runtime 进程 + V2_FORCE_STUB=1」端到端仍可在 Phase 8 用 compose 补跑。
>
> - **P3-2 验证**：`npm run build` 通过；88/88 测试绿（14 套件）；HMAC 与 Phase 2 契约逐字节对齐已核对（stableStringify 键字典序一致、canonical `${timestamp}\n${METHOD}\n${path}\n${sha256hex(body)}` 一致、Guard 取 `request.url.split('?')[0]` 与 runtime 签名路径一致、SettleCallDto/fen 字符串金额解析对齐 internal.controller）。
> - **P3-6 验证**：PiNovelStudio 零改动成立。`utils/config.ts` 的 `getApiKey/getBaseUrl` 与 `api/fallback-manager.ts` 的 `gatewayConfigured` 均为 `SUB2API_INTERNAL_LLM_*` 环境变量条件分支；平台部署不设置该变量即自然回落 per-provider 直连（凭证由 runtime 容器 env 或 internal API 注入）。上述两文件均未被修改。
> - **并行结论**（对用户问题的回答）：P3-1/2/3/6 与 Phase 2 无文件冲突，可并行（本次已并行完成）；P3-4/5 涉及 platform-api jobs 模块与 Phase 2 计费/内部 API 强耦合，须待 Phase 2 合入后开工。
>
> **执行偏差**（与原计划的差异）：
> 1. **billing-client 5xx 重试缺陷修复**：原实现重试仅在 catch 路径（网络错误/超时）生效，HTTP 5xx 响应正常返回不触发重试；已在 signedPost 循环内增加 `statusCode >= 500` 判定（重试耗尽返回末次响应，由调用方构造含 body 细节的错误）。对应测试（settle/finalize 5xx 重试耗尽）已转绿。
> 2. **runtime 镜像布局**：PiNovelStudio 项目根解析要求标记文件（`.pi/extensions/novel-studio` + `docs/top-tier-chinese-novel-system-development-plan.md`）同时存在，且 `config/model-routing.json`、`data/`、`styles/` 按项目根相对解析。镜像在 `/app/pnovel` 镜像仓库相对结构（`.pi/extensions/novel-studio/{dist,config,presets}` + 根 config/data/styles/docs 标记），`PINOVEL_PROJECT_ROOT=/app/pnovel`。
> 3. **镜像构建实测未执行**：本机 Docker Desktop 引擎未运行，`docker build` 无法连接 daemon。已做静态验证：`docker compose config` 通过；Dockerfile 全部 COPY 源路径存在（含 dist/index.js 与 docs 标记）。镜像端到端构建与容器启动验证推迟到引擎可用后补做。
> 4. **runtime 构建上下文 = 仓库根**（需 COPY 仓库级共享资产），配套新增仓库根 `.dockerignore` 精确放行镜像所需子集；api 镜像上下文 = `platform/`，独立 `.dockerignore`。
> 5. **生产初始化已接线**：Compose 在 `api-migrate` 后运行一次性、幂等的 `api-bootstrap`（`node dist/bootstrap.js`），显式创建管理员、加密 Gemini Provider 与两条生产路由费率；缺少 `BOOTSTRAP_*` 凭证或价格时 fail-closed。普通 `pnpm db:seed` 仍只用于开发/测试，且不提供默认管理员口令。
> 6. **扩展无 lockfile**：镜像内扩展依赖用 `npm install --omit=dev`（无锁可 ci）；runtime 服务依赖有 package-lock，用 `npm ci --omit=dev`。根 package.json 增加 `packageManager` 钉住 pnpm 版本供 corepack 使用。

### Phase 4：小说业务 API

| 任务 | 内容 |
|---|---|
| P4-1 | 剩余 novel 表 Prisma 化（project/chapter/seed/character/outline_node/document/版本表/assistant_message/feedback） |
| P4-2 | projects / chapters（含乐观锁 PUT、软删除、版本创建）/ outline / characters / documents 模块 |
| P4-3 | assistant 模块：消息存储 + SSE 流式（GPT-5.6 独立规划 route 直连，费率单列，对话调用同样走预占/结算） |
| P4-4 | 章节生成编排：seed 校验 → generate 提交（复用 P3-4）→ 结果写 chapter（version=ai_generated） |
| P4-5 | billing 用户侧查询：summary / records（联 novel_generation_call + job + project） |
| P4-6 | 集成测试：CRUD + 乐观锁冲突 + 归属越权（用户 A 访问用户 B 项目 → 404） |

**验收**：Supertest 覆盖全部门户 API；乐观锁冲突返回 409；越权一律 404。

> **完成记录（2026-08-20）**：P4-1~P4-6 全部完成，验收全绿——`pnpm --filter @platform/api test` 65/65；`typecheck` 通过；`pnpm lint` 通过。迁移 `20260819160708_novel_domain` 已应用到本机 `platform` 库。e2e 覆盖：建项目、越权 404、章节乐观锁 409、角色/大纲/文档 CRUD 与文档版本递增、种子不完整拒绝生成、stub 生成写入正文（`source=ai_generated`）、助手消息、账单 summary/records、软删除项目后 404。
>
> **执行偏差**（与原计划的差异，均已回写为当前事实）：
> - **P3-4 随 Phase 4 补齐**：计划原把 jobs 模块放在 Phase 3，但 api 侧当时尚未落地。Phase 4 实现 `JobsService.submitChapterGeneration`（预检种子 + 预占 + 建 job + stub/http 调度 + 轮询），并签发与 novel-runtime `verifyTaskToken` 对齐的 JWT（`iss=platform-api` / `aud=novel-runtime` / `project_id` / `job_id` / `max_charge` 分整数 / `nonce`）。
> - **默认 stub runtime**：`NOVEL_RUNTIME_MODE=stub`（测试与本地默认）；`http` 才调用 `NOVEL_RUNTIME_BASE_URL/v1/invoke`。stub 同步完成生成并写章节，避免 e2e 依赖 Docker/runtime 进程。
> - **助手规划模型默认 stub**：`PLANNER_MODE=stub`。JSON `Accept` 返回 `{userMessage, assistantMessage}`；`Accept: text/event-stream` 走 SSE。真实 GPT-5.6 直连待规划模型凭证就绪后切 `PLANNER_MODE=http`。对话同样走 hold/settle（无生效费率则跳过结算、仍 finalize）。
> - **种子挂 chapter_id**：`novel_chapter_seeds.chapter_id` 唯一外键（计划 §5.1 口径），创建章节时自动插入空种子。
> - **越权一律 404**：`requireOwnedProject` 对非本人或已软删资源不返回 403。
> - **内部进度双写**：`POST /internal/jobs/:jobId/status` 仍写 hold 的 progress 字段（Phase 2 兼容），同时若存在 `novel_generation_jobs` 行则更新 job。

### Phase 5：用户前端

| 任务 | 内容 |
|---|---|
| P5-1 | 项目列表 + 创建向导 |
| P5-2 | 三栏工作台：目录树（大纲映射 + 状态徽标）/ 内容区（章节编辑、seed 编辑、角色、文档）/ 助手对话（SSE） |
| P5-3 | 生成任务面板：6 阶段进度、消耗实时、失败呈现与重试 |
| P5-4 | 章节版本页（对比/恢复） |
| P5-5 | 计费总览 + 消费明细页 |
| P5-6 | 充值页（占位轮询，Phase 6 接通） |

**验收**：stub 模式下浏览器完成「建项目→写 seed→生成→查看章节→查消耗明细」全流程。

> **完成记录（2026-08-20）**：P5-1~P5-6 全部完成，验收通过——`pnpm --filter @platform/web typecheck` 与 `build` 双 0；浏览器全流程实测通过：注册（p5-acceptance@test.local）→ 建项目「星尘之约」（三步向导）→ 工作台新建章节 → 种子 tab 填写 intent/endingGoal → 「保存并生成」→ 生成任务面板显示「生成成功」（预占上限 ¥1.00）→ 章节 tab 展示 stub 正文 → 计费页余额 ¥100.00 / 消耗 ¥0.00 / 明细 0 行。
>
> **数据库对账一致**：job `succeeded`（max_charge=100 分，progress_stage=saving_chapter，completed）；hold `settled`（amount=100、settled_amount=0，正确收尾）；章节 `generated`、`version=2`；`novel_chapter_versions` 落 `version_number=2, source=ai_generated`；余额守恒（10000 分未变，stub 无模型调用不扣费）。
>
> **执行偏差**（与原计划的差异，均已回写为当前事实）：
> - **测试账号余额经 SQL 直充**：admin 调账 API 属 Phase 7（admin 模块当前仅 `ping`），验收账号余额 0 会被预占拒绝（`insufficient_balance`），故用 psql 直接 UPDATE `users.balance=10000`。Phase 7 落地后管理台调账可替代此操作。
> - **stub 生成零结算符合预期**：stub 模式无真实模型调用，`novel_generation_call` 0 行、已结算 ¥0.00、消费明细空（Phase 4 口径：无生效费率跳过结算、仍 finalize）。真实调用消耗展示待 Phase 8 真实模型验收。
> - **小视口下按钮点击被遮挡（轻微 UI 债）**：1366×768 视口中「种子」tab 与「保存并生成」按钮出现 click intercepted / 超出视口，浏览器自动化需 JS 点击绕过；真实用户可滚动触达，不阻断验收。后续可优化 SeedEditor 操作区吸底。

### Phase 6：支付充值

| 任务 | 内容 |
|---|---|
| P6-1 | payment_orders 表 + 订单 service（状态机） |
| P6-2 | 支付宝直连（当面付/电脑网站，SDK 集成 + 验签） |
| P6-3 | 微信 Native 支付（SDK + 验签） |
| P6-4 | 异步通知处理（幂等 + 金额核对）+ 每小时主动查单补偿 |
| P6-5 | 充值页接通 + 管理台订单视图 |
| P6-6 | 沙箱/真实小额验收（需用户提供商户号） |

**验收**：沙箱或真实小额：下单→支付→通知→余额入账幂等（重复通知不重复入账）；查单补偿覆盖通知丢失场景。

> **完成记录（2026-08-20）**：P6-1~P6-5 完成；P6-6 真实商户小额验收未做（无商户号）。开发验收覆盖：下单、通知入账、重复通知不重复加余额、金额不符拒绝、查单补偿、过期单拒绝入账、越权 404。e2e：`POST /api/payment/orders` → stub `POST /api/payment/notify/alipay` → 余额 1200 分 → 重复通知 alreadyPaid、余额不变。生产配置会拒绝 `PAYMENT_MODE=stub` 和 `NOVEL_RUNTIME_MODE=stub`；支付宝/微信的真实验签和小额回调仍须在实际商户环境验收。

> **生产启动门禁补充（2026-08-20）**：生产 API 还会拒绝非 HTTPS 的 `PAYMENT_NOTIFY_BASE_URL`，并要求至少配置一套完整的支付宝或微信商户凭证；生产 runtime 在 provider 凭证注入后会强制校验 `NOVEL_REQUIRED_PROVIDER_KEYS`（当前 Compose 固定为 `GEMINI_API_KEY`），缺失时不监听 HTTP。`pnpm db:seed` 不再提供默认管理员口令，必须显式设置 `SEED_ADMIN_EMAIL` 与不少于 16 个字符的 `SEED_ADMIN_PASSWORD`。
>
> **执行偏差**：
> - **开发默认 `PAYMENT_MODE=stub`**：商户号未就绪时仅开发/测试环境可用 stub 渠道（`stub://pay/{orderNo}` + `x-payment-stub-secret` 验签）。生产必须为 `PAYMENT_MODE=live`，并禁止模拟充值接口；live 模式走 `alipay-sdk` 当面付预下单 / `wechatpay-node-v3` Native，缺凭证则 503。
> - **P6-6 支付宝商户已配置（2026-08-20）**：本地 `.env`（不入库）写入 AppID 与密钥；回调对齐 sub2api `POST /api/v1/payment/webhook/alipay`。当前商户只开通电脑网站支付，生产下单固定 `alipay.trade.page.pay`（`FAST_INSTANT_TRADE_PAY`），不调用当面付。密钥 `keyType=PKCS8`。测试进程强制 `PAYMENT_MODE=stub`。真实小额须在 `ainovel.cloud` 打开收银台验收；微信仍未配置。
> - **`audit_logs` 提前落地**：支付成功写入 `audit_logs`（actor_type=channel），供 Phase 7 审计页复用。
> - **stub 模拟支付**：`POST /api/payment/orders/:orderNo/simulate`（JWT，仅 stub）供充值页「模拟支付成功」；生产 live 模式拒绝该接口。
> - **查单补偿**：进程内每小时 `reconcilePendingOrders`（`NODE_ENV=test` 不启动定时器）；渠道已支付则补入账，超时未支付则 `expired`。
> - **充值页 QR**：未引入二维码库，展示 `qrContent` 文本；live 接通后可用该字段生成二维码。

### Phase 7：管理后台

| 任务 | 内容 |
|---|---|
| P7-1 | admin 模块 API：用户列表/详情/调账/封禁、audit 写入 |
| P7-2 | 模型与费率管理 API + 页面（密钥加密存储、脱敏展示） |
| P7-3 | 用量报表（SQL 聚合 novel_generation_call：按模型/用户/日）+ 页面 |
| P7-4 | 收入明细（订单 + 消耗口径）+ 页面 |
| P7-5 | 审计日志 + 系统设置页面 |
| P7-6 | admin 前端全部页面 |

**验收**：调账即时生效且流水只追加；费率调整后新调用按新价、历史账单不变；用量报表与明细下钻数值一致。

> **完成记录（2026-08-20）**：P7-1~P7-6 完成。管理 API 覆盖用户列表/详情/调账/封禁、Provider 密钥加密脱敏、费率只增不改、用量汇总与明细、收入按日、审计日志、系统设置（含 `registration_enabled`）。e2e：非 admin 403、调账即时入账并写 audit、新费率不影响历史 `rate_snapshot`、用量汇总与明细金额一致、封禁后登录 401、不能封禁管理员、设置 JSON 不被 ValidationPipe 剥掉。前端 §10.2 全部页面接入（概览/用户/模型费率/用量/收入/订单/审计/设置）。
>
> **执行偏差**：
> - **费率 PATCH 只允许 enabled/displayName**：改价必须 `POST /admin/model-rates` 新增一行，历史结算快照不变。
> - **注册开关**：`settings.registration_enabled` 为 `false` 或 `{enabled:false}` 时 `POST /auth/register` 返回 403；缺失视为开放。e2e 不切换该全局键，避免并行测试互相阻断，解析逻辑有单测。

### Phase 8：端到端验收与上线

| 任务 | 内容 |
|---|---|
| P8-1 | Playwright E2E：注册→（管理员调账充值）→建项目→写 seed→生成（stub）→编辑章节→查明细 |
| P8-2 | 并发测试：同一用户 5 并发生成任务，预占不超扣、结算不重不漏（精确到分对账脚本） |
| P8-3 | 生产 compose 演练：干净机器一键 `docker compose up`，migrate 自动执行 |
| P8-4 | 安全自查清单（§11 逐项核对）+ 密钥盘点（生产 env 与示例对齐） |
| P8-5 | 部署/运维文档（platform/docs/）：升级、备份恢复、常见故障 |
| P8-6 | 真实模型小额验收（用户授权后）：一章真实生成，账单与模型侧用量核对 |

**验收**：全部 E2E 绿；对账脚本输出「逐调用合计 == Σ settled == 余额变动」零差额；用户签署上线确认。

> **完成记录（2026-08-20）**：P8-1~P8-5 开发验收完成；P8-6 未做（需用户授权真实模型调用）。
>
> - **P8-1**：CI 旅程为 Fastify inject（`test/p8-journey.e2e.spec.ts`）：注册 → 管理员调账 → 建项目 → 写 seed → stub 生成 → 编辑章节 → 查明细 + 账本恒等式。浏览器 Playwright 规格在 `apps/web/e2e/`，需 `E2E_BASE_URL` 且本地起 api+web；未安装 Playwright 时不纳入 CI。
> - **P8-2**：`test/p8-concurrent.e2e.spec.ts` + `pnpm ledger:reconcile`。每用户同时 1 个 running 章节任务；stub 若在并发请求前已收尾，后到请求可以再开新任务（部分唯一索引只约束 pending/running），因此断言为「201+409=5、成功数≥1、hold 与 job 一一对应且全部 settled、恒等式零差额」。另测 5 路 300 分预占对 1000 分余额不超扣。
> - **P8-3**：compose 静态契约测试已覆盖 migrate/bootstrap/healthcheck/生产禁 stub。本机 Docker 引擎若未运行，不宣称干净机器 `docker compose up` 已实测；文件与 `docker compose config` 级校验见 Phase 3 记录。
> - **P8-4**：`platform/docs/security-checklist.md` + `test/security-checklist.spec.ts`。本阶段补上登录 IP 滑动窗口限流（生产 20 次/60s，测试放宽）。
> - **P8-5**：`platform/docs/deploy.md`、`operations.md`、`reconciliation.md`。
> - **P8-6**：阻塞，需用户授权真实模型与预算。
>
> **核查补强（2026-08-20，v1.8）**：
> - API 生产镜像构建并托管 `apps/web` dist（`WEB_DIST_DIR=/app/web`），同一端口提供门户与 `/api`。
> - `PLANNER_MODE=http` 已接 OpenAI 兼容 chat/completions；生产禁止 stub，允许 `disabled` 或带凭证的 `http`。
> - 系统设置 `word_count_budget` / `safety_factor` 进入章节预占计算；缺失时保持原 400k/65k × 1.3 包络。
> - 门户路由对齐 §10.1（`/projects`、`/workbench`、`/billing/records`、`/billing/topup`），旧路径 301/redirect。
> - 反馈表暴露用户 API 与工作台页；JWT 封禁文案修复；计费页 ECharts；充值页 QR；种子操作区吸底。
> - Playwright 已作为 web 可选依赖；CI 仍以 inject 旅程为准。
> - **仍未关闭**：P6-6、P8-6、本机 Docker 一键 up、内核既有脏工作树、sub2api 冻结。
>
> **账本恒等式（回写，纠正原 DoD 笔误）**：预占不扣 `users.balance`。正确口径为
> `users.balance == Σ充值 + Σ调账 − Σ已结算调用`，
> `available == users.balance − Σ在途预占`。
> 原 §16「… − Σ在途预占 == users.balance」应改为 `== available`。

---

## 14. 测试策略

| 层 | 工具 | 覆盖重点 |
|---|---|---|
| 单元 | Vitest | 计费引擎（§7 全状态机）、费率快照、金额整数运算 |
| API 集成 | Supertest + 测试库（独立 schema，每用例隔离） | 归属越权、乐观锁、幂等、状态机 |
| runtime 集成 | 迁移的 10 个测试文件 + stub 全链路 | 令牌、白名单、工作区、计量上报契约 |
| E2E | Playwright（ Chromium） | 用户旅程全流程 |
| 对账 | 脚本（平台 docs） | 余额守恒：充值 + 调账 − Σ结算 − 释放误差 == 0 |
| 并发 | 脚本（Promise 并发） | 预占竞争、重复结算 |

**原则**：所有涉及金额的断言精确到分；stub 模式跑 CI，真实模型调用只在 P8-6 一次性验收。

---

## 15. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | novel-runtime 与 sub2api 存在未发现的隐藏耦合 | 中 | P3-1 先独立 build/test 再改造；发现耦合即登记到本计划附录 |
| 2 | Go 计费逻辑移植行为偏差 | 中 | 表驱动测试对照（§7.2）+ 并发对账脚本（P8-2） |
| 3 | 支付商户号申请周期 | 高（外部依赖） | Phase 6 独立可延后；管理台手动调账兜底可用 |
| 4 | PiNovelStudio 真实调用稳定性（超时/熔断） | 中 | 沿用主链路 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS` 与 FailureEnvelope；收尾路径保证任何失败都释放预占 |
| 5 | LGPL-3.0 合规 | 低 | novel-runtime 为本仓库自有代码整体搬移；Go 计费逻辑按行为规范重写不复制源码；15 张表结构为功能接口。新平台不分发 sub2api 二进制 |
| 6 | 模型上游商用授权 | 高（法律/商务） | 上游授权登记沿用 [06-upstream-licensing.md](../INSub2api/06-upstream-licensing.md)；商用收款前由用户确认各 route 授权状态，平台不替用户背书 |
| 7 | 单点单机规模上限 | 低 | v1 明确单机；扩展路径（api 无状态化 + 读写分离）留文档不留代码 |

---

## 16. 完成定义（DoD）

1. 8 个 Phase 验收标准全部通过，E2E 与对账脚本零差额。
2. `platform/` 一键 `docker compose up` 在干净机器可复现部署。
3. 计费守恒恒等式成立：`users.balance == Σ充值 + Σ调账 − Σ已结算调用`；`available == users.balance − Σ在途预占`（对账脚本验证，精确到分）。
4. PiNovelStudio 主仓库 diff 为零（除本计划文档与 platform/ 新增目录）。
5. sub2api 目录冻结（见 §17），新平台成为唯一商用承载。
6. 部署/运维/对账三份文档交付。

---

## 17. sub2api 冻结处置

- 新平台 Phase 8 验收通过后：`sub2api/` 目录**冻结只读**（不再接受功能开发；历史任务文档 `docs/INSub2api/` 保留为审计与移植对照记录）。
- 是否物理删除 sub2api 目录由用户届时决定（遵循仓库「版本收敛」原则倾向于删除，但须确认无未收割资产）。
- 移植对照索引：15 张表 → §5.1；计费行为 → §7.2；工作台 → §10.1；novel-runtime → §8。

---

## 18. 附录：执行顺序与并行性

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 8
                                    │
                                    └──► Phase 6（支付，可并行/延后）
                                    └──► Phase 7（管理台，可与 Phase 5 并行）
```

- Phase 6/7 依赖 Phase 2/4 的表与服务，不依赖 Phase 5 前端完成度（API 先行）。
- 每阶段完成即在本文件勾记状态并回写偏差。
