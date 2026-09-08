# 安全自查清单（对照 development-plan.md §11）

核对日期：2026-08-20。P8-4 静态断言见 `apps/api/test/security-checklist.spec.ts`。

| # | §11 条款 | 实现 | 状态 |
|---|---|---|---|
| 1 | 传输：网关终结 TLS，内网走 compose 网络 | compose 仅映射 `api:3000`；runtime 不映射宿主端口。Caddy/Nginx 由宿主机承担，compose 不内置反代 | 文档约束；公网 TLS 取决于部署 |
| 2 | argon2id + JWT HS256 7d，无 refresh/黑名单 | `AuthService` argon2.hash/verify；`JwtModule` HS256 `JWT_EXPIRES_IN=7d`；登出丢前端 token。封禁账号持有旧 JWT 访问受保护接口返回「账号不存在或已被封禁」 | 已实现 |
| 3 | 公开 / 用户（归属校验）/ 管理员三级 | `JwtAuthGuard` / `AdminGuard`；`requireOwnedProject` 越权 404 | 已实现 |
| 4 | 内部 API HMAC-SHA256 + 5 分钟窗口，仅内网 | `INTERNAL_HMAC_WINDOW_MS = 5min`；runtime 不暴露宿主端口 | 已实现 |
| 5 | Provider key AES-256-GCM；日志脱敏 | `encryptSecret`；管理 API 只回 `apiKeyMasked`；pino redact `authorization` | 已实现 |
| 6 | Prisma 参数化；`:id` 归属校验 | Prisma；越权 404 | 已实现 |
| 7 | 支付验签 + 金额核对 | live 走支付宝/微信 SDK 验签；通知金额必须等于订单金额 | stub 开发路径除外；P6-6 真实商户未验 |
| 8 | 调账/费率/封禁/设置写 audit_logs | `AdminService` + 支付成功 `actor_type=channel` | 已实现 |
| 9 | 登录 IP 限流；生成每用户 1 个 running job | `LoginRateLimitGuard`（生产 20 次/60s，开发/测试放宽）；jobs 部分唯一索引 | 已实现 |

## 密钥盘点（生产 env 必须与 `.env.example` 键对齐，值不得用示例）

| 键 | 用途 | 生产要求 |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_PASSWORD` | 数据库 | 强随机；不入库 |
| `JWT_SECRET` | 用户 JWT | ≥32 字符，禁止 `dev-only-` |
| `INTERNAL_API_SECRET` | HMAC | ≥32 字符，禁止 `dev-only-` |
| `NOVEL_TASK_TOKEN_HMAC_KEY` | 任务令牌 | ≥32 字符，禁止 `dev-only-` |
| `AES_MASTER_KEY` | Provider 密钥加密 | 64 hex；禁止连续 `0123456789abcdef` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首个管理员 | ≥16 字符，显式设置 |
| `BOOTSTRAP_GPT_API_KEY` | 生产费率 bootstrap | 真实凭证 |
| `ALIPAY_*` / `WECHAT_*` | 收款 | live 至少一套完整；P6-6 仍待商户号 |
| `PINOVEL_RELEASE_COMMIT` | runtime 身份指纹 | 必须等于当前 release manifest |
| `CORS_ORIGINS` | 浏览器来源 | 生产必须公开 HTTPS，禁止 localhost |
| `PAYMENT_NOTIFY_BASE_URL` | 支付回调 | 生产必须 HTTPS |

`pnpm db:seed` 不再提供默认管理员口令。丢失 `AES_MASTER_KEY` 无法解密已落库的供应商密钥。
