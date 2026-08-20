# novel-runtime

PiNovelStudio 平台的小说生成执行层（内部 Node.js 服务）。加载 PiNovelStudio 6 个公开工具，执行任务令牌能力校验、多租户临时 workspace 隔离与逐模型调用计费结算。

> 任务计划：`docs/platform/development-plan.md` Phase 3（PINOVEL-PLATFORM-BUILD-1）

## 架构位置

```
浏览器 / 前端
  └─ platform-api（NestJS，公开 API + /internal HMAC 内部 API）
       └─ POST runtime /v1/invoke（X-Novel-Task-Token 短期任务令牌）
            └─ novel-runtime（本服务）
                 ├─ 任务令牌验证（issuer=platform-api，HS256，防重放）
                 ├─ 临时 workspace 物化/清理（per-job 隔离）
                 ├─ PiNovelStudio 6 工具（白名单强制）
                 │    └─ Provider 直连（GLM/Gemini/Claude/Ark/GPT，凭证来自容器 env 或 platform-api）
                 └─ 计费闭环（HMAC 签名回 platform-api）
                      ├─ 逐调用结算 POST /internal/billing/settlements（token 上报制，金额权威归 platform-api）
                      └─ 失败收尾   POST /internal/billing/holds/:jobId/finalize；成功收尾由 platform-api 与章节保存原子完成
```

## 安全边界

| 边界 | 机制 |
|------|------|
| 只接受 platform-api 签发的任务令牌 | `src/task-token.ts`（issuer=platform-api、audience=novel-runtime、nonce 防重放、capabilities 限定） |
| 用户身份不可伪造 | jobId/userId/projectId 只来自令牌 payload，不信请求体 |
| 内部回调不可伪造 | `src/internal-hmac.ts`（与 platform-api HmacGuard 逐字节对齐的 HMAC-SHA256 签名） |
| 多租户隔离 | per-job 临时 workspace（`src/workspace-manager.ts`），路径穿越校验 + 原子写入 + finally 清理 |
| 工具白名单 | `src/tool-whitelist.ts`（仅 6 个 `novel_*` 公开工具） |
| 不暴露公网端口 | 默认监听 `0.0.0.0:3100`，仅 compose 内网可达，不映射宿主机端口 |

## 内部 API

| Method | Path | 认证 | 说明 |
|--------|------|------|------|
| GET | `/healthz` | 无 | 健康检查（含 6 工具加载状态） |
| GET | `/v1/tools` | 无 | 工具名列表（仅供 platform-api 调试） |
| POST | `/v1/invoke` | `X-Novel-Task-Token` | 调用工具；返回 result + metering（分） |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `NOVEL_TASK_TOKEN_HMAC_KEY` | ✅ | 任务令牌 HMAC 密钥（platform-api 签发 / runtime 校验，两侧一致） |
| `PLATFORM_API_BASE_URL` | ✅ | platform-api 基础 URL（/internal 计费回调） |
| `INTERNAL_API_SECRET` | ✅ | 内部 API HMAC 密钥（与 platform-api 一致） |
| `NOVEL_RUNTIME_HOST` | 否 | 监听地址（默认 `0.0.0.0`） |
| `NOVEL_RUNTIME_PORT` | 否 | 监听端口（默认 `3100`） |
| `NOVEL_PROVIDER_CREDENTIALS_SOURCE` | 否 | `env`（默认，容器注入直连密钥）\| `platform`（启动时拉取凭证注入） |
| `NOVEL_STUDIO_DIST_PATH` | 否 | PiNovelStudio dist/index.js（默认 `/app/novel-studio/dist/index.js`） |
| `NOVEL_STUDIO_PROJECT_ROOT` | 否 | PiNovelStudio 项目根（默认 `/app/novel-studio`） |
| `NOVEL_TEMP_WORKSPACE_ROOT` | 否 | 临时 workspace 根（默认 `/var/lib/novel-runtime/workspaces`） |
| `PINOVEL_MODEL_REQUEST_TIMEOUT_MS` | 否 | LLM 请求/内部回调超时（默认 300000） |
| `NOVEL_RUNTIME_PRICING_TABLE_PATH` | 否 | 本地诊断费率表（可选；仅日志粗估，权威金额归 platform-api） |

Provider 直连密钥（`env` 来源时容器注入）：`GLM_API_KEY` / `GEMINI_API_KEY` / `CLAUDE_API_KEY` / `ARK_API_KEY` / `GPT_API_KEY`（与主仓库同名同义，可选 `*_BASE_URL`）。

## 测试

| 文件 | 覆盖 |
|------|------|
| `tests/billing-client.test.ts` | 计费回调：HMAC 头、stableStringify body、分金额、幂等、耗尽、重试、finalize |
| `tests/metering-binder.test.ts` | 事后结算：token 上报、callId 幂等、耗尽中止、结算失败不阻断交付 |
| `tests/platform-task-token-contract.test.ts` | platform-api 签发 claim 结构 → runtime 验证（跨系统契约） |
| `tests/task-token.test.ts` | 令牌验证单元：过期/重放/能力/篡改 |
| `tests/workspace-manager.test.ts` | 临时 workspace 物化/清理/路径穿越 |
| `tests/real-extension-loading.test.ts` | 真实 PiNovelStudio dist 加载 6 工具（需先 build:prod，否则 skip） |
| `tests/extension-loader.test.ts` / `tests/tool-whitelist.test.ts` / `tests/health-route.test.ts` | 加载器 / 白名单 / 健康检查 |

```bash
npm test          # 全部测试
npm run build     # tsc 编译
npm run typecheck
```
