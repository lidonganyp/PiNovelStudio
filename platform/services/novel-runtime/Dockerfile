# novel-runtime 生产镜像（P3-3）
#
# ⚠️ 构建上下文 = 仓库根（d:\CODE\PiNovelStudio），不是本目录：
#   docker build -f platform/services/novel-runtime/Dockerfile -t platform-novel-runtime .
# 镜像在构建阶段编译 PiNovelStudio 扩展与 runtime；不依赖开发机遗留的 dist/。
#
# 镜像内 PiNovelStudio 项目根布局（/app/pnovel，保持仓库相对结构）：
#   /app/pnovel
#   ├── .pi/extensions/novel-studio/{dist,config,presets,package.json,node_modules}
#   ├── docs/top-tier-chinese-novel-system-development-plan.md   ← isProjectRoot 标记
#   ├── config/          ← model-routing.json（路由真相源）
#   ├── data/            ← 运行时索引（fewshots/runtime）
#   └── styles/          ← 共享风格指纹
# 工作区卷：/var/lib/novel-runtime/workspaces（per-job 临时 workspace，任务后清理）

# ---------- 阶段 1：编译 PiNovelStudio 扩展 ----------
FROM node:20-alpine AS ext-builder
WORKDIR /build/ext
COPY .pi/extensions/novel-studio/package.json ./
COPY .pi/extensions/novel-studio/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY .pi/extensions/novel-studio ./
RUN npm run build:prod \
    && npm prune --omit=dev --no-audit --no-fund

# ---------- 阶段 2：编译 runtime 服务 ----------
FROM node:20-alpine AS service-builder
WORKDIR /build/service
COPY platform/services/novel-runtime/package.json platform/services/novel-runtime/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY platform/services/novel-runtime ./
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund

# ---------- 阶段 3：运行镜像 ----------
FROM node:20-alpine
ENV NODE_ENV=production

# 服务本体
WORKDIR /app/service
COPY --from=service-builder /build/service/node_modules ./node_modules
COPY platform/services/novel-runtime/package.json ./
COPY --from=service-builder /build/service/dist ./dist

# PiNovelStudio 项目根树（标记文件 + 根相对资产）
WORKDIR /app/pnovel
COPY --from=ext-builder /build/ext/node_modules ./.pi/extensions/novel-studio/node_modules
COPY --from=ext-builder /build/ext/package.json ./.pi/extensions/novel-studio/package.json
COPY --from=ext-builder /build/ext/dist ./.pi/extensions/novel-studio/dist
COPY --from=ext-builder /build/ext/config ./.pi/extensions/novel-studio/config
COPY --from=ext-builder /build/ext/presets ./.pi/extensions/novel-studio/presets
COPY docs/top-tier-chinese-novel-system-development-plan.md ./docs/
COPY config ./config
COPY data ./data
COPY styles ./styles

# 服务配置（config.ts 默认值面向容器卷；显式声明便于审计）
ENV PINOVEL_PROJECT_ROOT=/app/pnovel \
    NOVEL_STUDIO_DIST_PATH=/app/pnovel/.pi/extensions/novel-studio/dist/index.js \
    NOVEL_STUDIO_PROJECT_ROOT=/app/pnovel \
    NOVEL_TEMP_WORKSPACE_ROOT=/var/lib/novel-runtime/workspaces \
    NOVEL_RUNTIME_HOST=0.0.0.0 \
    NOVEL_RUNTIME_PORT=3100

# 工作区卷（per-job 隔离；invoke 完成后清理）
RUN mkdir -p /var/lib/novel-runtime/workspaces \
    && chown -R node:node /var/lib/novel-runtime /app/service /app/pnovel
VOLUME /var/lib/novel-runtime/workspaces

WORKDIR /app/service
EXPOSE 3100
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/index.js"]
