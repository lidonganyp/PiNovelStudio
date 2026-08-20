# 部署与升级

PiNovelStudio 商用平台生产拓扑是 Docker Compose：`postgres` + `api-migrate` + `api-bootstrap` + `api` + `runtime`。TLS 终结放在宿主机已有网关（Nginx/Caddy），compose 不内置反代容器。

## 一键启动

在仓库根准备 `platform/.env`（从 `platform/.env.example` 复制，**生产必须替换全部 `dev-only-` / `change-me` 密钥**）：

```bash
cd platform
cp .env.example .env
# 填写 POSTGRES_PASSWORD、JWT_SECRET、INTERNAL_API_SECRET、AES_MASTER_KEY、
# NOVEL_TASK_TOKEN_HMAC_KEY、CORS_ORIGINS、PAYMENT_MODE=live、
# PAYMENT_NOTIFY_BASE_URL（https）、BOOTSTRAP_*、PINOVEL_RELEASE_COMMIT、
# 以及至少一套支付宝或微信商户凭证。

docker compose up -d --build
```

API 镜像会构建并托管 `apps/web` 的静态产物（`WEB_DIST_DIR=/app/web`）。浏览器访问 `https://your-domain/` 即用户门户，`/admin` 为管理台，`/api` 为接口。TLS 仍由宿主机 Nginx/Caddy 终结后反代到 `api:3000`。

启动顺序由 compose 强制：

1. `postgres` healthcheck（`pg_isready`）
2. `api-migrate`：`prisma migrate deploy`，成功后退出
3. `api-bootstrap`：幂等创建管理员、加密 Gemini Provider、写入生产费率；缺 `BOOTSTRAP_*` fail-closed
4. `api`：健康检查 `GET /api/health`
5. `runtime`：仅 compose 内网 `3100`，从 platform-api 拉取加密凭证

构建上下文：

- `api` 镜像上下文 = `platform/`
- `runtime` 镜像上下文 = 仓库根（需 COPY PiNovelStudio `dist/` 与标记文件）

生产禁止 `PAYMENT_MODE=stub`、`NOVEL_RUNTIME_MODE=stub`、`PLANNER_MODE=stub`。API 进程在 `NODE_ENV=production` 启动时会拒绝这些值。

## 升级

```bash
cd platform
git pull
# 先在仓库根构建 PiNovelStudio 生产产物，runtime 镜像会 COPY dist/
cd ..
npm run build:prod
cd platform
docker compose build
docker compose up -d
```

Prisma 迁移由 `api-migrate` 一次性容器在 API 启动前执行，不要在生产跑 `prisma migrate dev`（会交互、可能重置 shadow DB）。

回滚：将镜像/compose 指回上一 git tag，再 `up -d`。已应用的 forward-only 迁移需要对应的 down SQL 才可数据库回滚；v1 以「修正向迁移」为主。

## 健康检查

- API：`GET /api/health` → `{ "status": "ok" }`
- runtime：compose 内网 `GET http://runtime:3100/health`（不映射宿主端口）

外部拨测建议打网关上的 `/api/health`。
