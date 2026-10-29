# platform-api 生产镜像（P3-3）
#
# ⚠️ 构建上下文 = platform/（pnpm workspace 根），不是本目录：
#   docker build -f apps/api/Dockerfile -t platform-api .
#
# 多阶段：builder（workspace install + nest build + prisma generate）
#   → deploy（pnpm deploy 产出自包含生产依赖树）
#   → runner（含 prisma CLI 供 compose 的 migrate 服务执行 prisma migrate deploy）

# ---------- 阶段 1：构建 ----------
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @platform/api... --filter @platform/web...
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY tsconfig.base.json ./
RUN pnpm --filter @platform/api build
RUN pnpm --filter @platform/web build

# ---------- 阶段 2：提取自包含生产依赖树 ----------
FROM node:20-alpine AS deploy
RUN corepack enable
WORKDIR /build
COPY --from=builder /build ./
RUN pnpm --filter @platform/api deploy --prod /out --legacy

# ---------- 阶段 3：运行镜像 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy /out ./
# pnpm deploy 产物不含 prisma generate 生成的 .prisma/client（@prisma/client
# 运行时必需）；在镜像内基于锁定的生产依赖树现场生成，否则 bootstrap 与 api
# 启动即报 Cannot find module '.prisma/client/default'。
RUN npx --no-install prisma generate --schema prisma/schema.prisma
COPY --from=builder /build/apps/web/dist ./web
ENV WEB_DIST_DIR=/app/web
# prisma CLI is part of the lockfile-resolved production dependency tree;
# compose overrides the default command for the migration job.

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
