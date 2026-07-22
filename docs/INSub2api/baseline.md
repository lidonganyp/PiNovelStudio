# 集成基线（T0-1）

记录 `PINOVEL-SUB2API-INTEGRATION-1` 启动时的两个项目基线 SHA、分支策略与工作树保护规则。

## 1. 基线 SHA

### PiNovelStudio

| 项 | 值 |
|---|---|
| 仓库 | `D:\CODE\PiNovelStudio` |
| 基线分支 | `main` |
| 基线 SHA（完整） | `9df76dee61714ee194520e1815027e17028b5709` |
| 基线 SHA（短） | `9df76de` |
| 基线提交标题 | `feat: implement batch chapter generation mode (BATCH-P0)` |
| 集成分支 | `codex/sub2api-integration`（从上述 SHA 创建） |
| 集成分支创建时间 | 2026-07-22 |

### Sub2API

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/Wei-Shaw/sub2api |
| License | LGPL-3.0 |
| 技术栈 | Go 1.25.7 (Gin, Ent) + Vue 3.4+ + PostgreSQL 15+ + Redis 7+ |
| 本地克隆路径 | `D:\CODE\sub2api` |
| 基线分支 | `main` |
| 基线 SHA（完整） | `ebfaf2496b482ef086ac02e848881dc051c01431` |
| 基线 SHA（短） | `ebfaf24` |
| 集成分支 | `codex/sub2api-integration`（已从上述 SHA 创建，2026-07-22） |
| 克隆方式 | `git -c http.proxy= clone --depth 1 https://gh-proxy.com/https://github.com/Wei-Shaw/sub2api.git`（绕过本地失效代理 127.0.0.1:10808） |

> Sub2API 现有结构：`backend/internal/{config,domain,handler[admin/dto/quotaview],middleware,model,payment,pkg,repository,server[routes/middleware],service,securityaudit,integration,...}` + `backend/ent/`（含 account/apikey/user/paymentorder/usagelog 等 Ent 实体）+ `frontend/` + `deploy/`。小说功能将在 `backend/internal/novel/` 新增独立模块。

> 集成期间 Sub2API 固定到上述基线 SHA，不直接跟随 `latest`。如需跟进上游，必须在独立 PR 中升级并重跑验收。

## 2. 工作树保护规则（来自 PiNovelStudio AGENTS.md）

启动集成时 PiNovelStudio `main` 工作树存在用户进行中的修改，包括：

- `.pi/extensions/novel-studio/handlers/batch-generation-handler.ts`（staged）
- `.pi/extensions/novel-studio/v2/core/batch-generation-job-store.ts`（staged）
- `.pi/extensions/novel-studio/v2/core/batch-generation-lock.ts`（staged）
- `.pi/extensions/novel-studio/v2/core/batch-generation-orchestrator.ts`（staged）
- `.pi/extensions/novel-studio/novelos/agent/agentic-raw-candidate-source.ts`（unstaged）
- `.pi/extensions/novel-studio/novelos/agent/evidence-plan.ts`（unstaged）
- `.pi/extensions/novel-studio/novelos/verification/narrative-verifier-suite.ts`（unstaged）
- `.pi/extensions/novel-studio/tests/*.test.mjs`（多个 unstaged）
- `.pi/extensions/novel-studio/v2/core/author-style-optimizer.ts`（untracked）
- `config/model-routing.json`、`config/model-routing.recommendation.json`、`AGENTS.md`、`README.md`、`docs/project-memory.md`（unstaged）

**保护约束（强制）**：

- ❌ 禁止恢复、删除、暂存（`git add`）、覆盖上述任何修改。
- ❌ 禁止 `git stash pop/drop`、`git checkout --`、`git reset --hard` 等破坏性操作。
- ❌ 禁止把上述修改卷入集成提交。
- ✅ 集成工作只在新增文件/目录中进行：
  - `docs/INSub2api/`（本目录）
  - 后续在 Sub2API 仓库中新增 `backend/internal/novel/`、`frontend/src/features/novel-studio/`、`services/novel-runtime/`、`deploy/`、`docs/novel/`
- ✅ 如集成必须修改 PiNovelStudio 现有源码（如 Phase 1 T1-3 模型出口改造），必须在独立提交中完成，且不触碰上述受保护文件。

## 3. 干净检出验证

按 T0-1 验收要求，须验证可从干净检出完成原项目构建与测试：

```powershell
# 在独立目录验证 PiNovelStudio 干净检出
git clone D:\CODE\PiNovelStudio D:\CODE\PiNovelStudio-clean-checkout
cd D:\CODE\PiNovelStudio-clean-checkout\.pi\extensions\novel-studio
npm ci
npm run build
npm test
```

> 验收脚本待 Sub2API 克隆完成后补充对 Sub2API 的等价验证（`go build ./...`、`go test ./...`、前端 `pnpm install && pnpm build`）。
