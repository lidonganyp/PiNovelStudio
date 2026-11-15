# PiNovelStudio Platform 项目概览

## 项目定位

基于 PI Agent 的中文长篇小说章节生成系统（v2.0），提供用户门户、计费引擎、novel-runtime 编排和 AI 辅助写作。通过 B6 融合模块与 PiVideoStudio 联动，支持章节一键生成视频。

## 技术栈

- 后端：NestJS + PostgreSQL 15 + Prisma ORM（端口 3000）
- 前端：Vue 3 + Vite + Element Plus
- 运行时：Node.js >= 20.19，pnpm 10.26.2 monorepo
- 部署：Docker Compose（postgres + api + novel-runtime）
- 认证：JWT + AES-GCM 加密
- 支付：支付宝 / 微信支付

## 模块架构

- apps/api/：NestJS 后端（auth/projects/jobs/outline/assistant/pivideo/payment/admin/rates/health）
- apps/web/：Vue 3 前端（门户落地页、登录注册、用户工作台、管理后台）
- services/novel-runtime/：小说生成运行时（扩展加载、工具白名单、计量计费、任务令牌、HMAC 认证）

## 后端模块（apps/api）

| 模块 | 职责 |
|---|---|
| auth | 用户注册/登录/JWT 签发/密码修改 |
| projects | 小说项目管理（CRUD） |
| jobs | 章节生成任务编排、版本管理、运行时通信 |
| outline | 大纲节点管理（树形结构） |
| assistant | AI 写作助手对话、规划器集成 |
| pivideo | B6 融合：章节生成视频，聚合上下文调 PiVideoStudio API |
| payment | 支付宝/微信支付订单与回调 |
| admin | 管理后台（审计日志、用户管理、模型费率、收入统计） |
| rates | 模型计费费率管理 |
| health | 健康检查 |

## 前端页面（apps/web）

- LandingView：门户落地页
- LoginView / RegisterView：登录注册
- portal/HomeView：用户首页
- portal/WorkspaceView：写作工作台（章节树、编辑器、大纲、人物卡、AI 助手）
- portal/BillingView / RechargeView / PaymentResultView：计费充值
- admin/*：管理后台（审计、用户、模型、收入、支付订单、设置、反馈）

## B6 融合：PiVideoStudio 联动

章节编辑器『生成视频』按钮 -> POST /api/projects/:id/chapters/:cid/generate-video -> 聚合章节正文+大纲(50条)+人物卡(20个)+种子 -> 调 PiVideoStudio API 创建视频项目 -> 返回跳转 URL

## 数据模型（Prisma）

User / Setting / ModelProvider / ModelRate / NovelProject / NovelChapter / NovelChapterSeed / NovelChapterVersion / NovelCharacter / NovelOutlineNode / NovelDocument / NovelAssistantMessage / NovelGenerationJob / NovelFeedback / PaymentOrder / AuditLog

## 环境变量

- DATABASE_URL：PostgreSQL 连接串
- JWT_SECRET / JWT_EXPIRES_IN：JWT 配置
- AES_MASTER_KEY：AES-GCM 加密密钥
- GEMINI_MODEL / GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY：写作模型
- NOVEL_RUNTIME_BASE_URL：novel-runtime 内网地址
- PIVIDEO_API_URL：PiVideoStudio API 地址（默认 http://172.17.0.1:3100）
- PIVIDEO_WEB_URL：PiVideoStudio Web 地址（默认 http://localhost:5173）
- CORS_ORIGINS / PAYMENT_* / ALIPAY_* / WECHAT_*：支付与跨域配置

## 部署

Docker Compose：docker compose up -d（postgres + api-migrate + api-bootstrap + api + runtime）
开发：pnpm dev:api / pnpm dev:web / pnpm dev:db
