# Sub2API LGPL-3.0 Notice 与第三方许可证清单（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 的开源合规义务。本文件为 Phase 10 发布前的合规前置项。

## 1. Sub2API 上游 License

### 1.1 主仓库

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/Wei-Shaw/sub2api |
| 上游基线 SHA | `ebfaf2496b482ef086ac02e848881dc051c01431` |
| License | GNU Lesser General Public License v3.0 only（LGPL-3.0-only） |
| 上游 Copyright | Copyright (c) Wei-Shaw 及 sub2api 贡献者 |

### 1.2 LGPL-3.0 合规义务

Sub2API 采用 LGPL-3.0，集成方需履行以下义务：

1. **保留原 LICENSE 文件**：在分发产物中保留 Sub2API 的 `LICENSE` 文件全文。
2. **保留 Copyright 声明**：在源码与二进制分发中保留 Sub2API 各源文件的 Copyright 头。
3. **显式 Notice**：在产品文档与 About 页面显式声明"本项目基于 Sub2API（LGPL-3.0）二次开发"，并附上游仓库链接与本文件链接。
4. **修改声明**：对 Sub2API 源码的任何修改必须在文件头或独立 `CHANGES.md` 中标注修改内容、修改者、修改日期。
5. **LGPL 例外条款**：
   - 我们将 Sub2API 作为**独立可执行服务**部署（sub2api-backend 进程），通过 HTTP API 调用，不与 PiNovelStudio 代码静态/动态链接。
   - 新增的 `backend/internal/novel/`、`frontend/src/features/novel-studio/`、`services/novel-runtime/` 是**我们自己的代码**，不修改 Sub2API 核心 Ent schema 时不构成衍生作品；即使修改 Sub2API 内部源码，也仅 Sub2API 部分受 LGPL 约束，我们的 novel 模块可保持自有 License。
   - 但对 Sub2API 自身源码的修改必须开源（LGPL 第 4 条），由本仓库 `codex/sub2api-integration` 分支公开。
6. **用户可获取源码**：任何分发给最终用户的二进制必须提供获取 Sub2API 修改后源码的途径（链接到我们的公开仓库或邮件索取入口）。
7. **不移动 License 文件**：`D:\CODE\sub2api\LICENSE` 必须保留在分发产物根目录。

### 1.3 我们的修改清单

> 实际修改发生时在此追加。Phase 0 阶段尚无修改。

| 修改文件 | 修改内容 | 修改日期 | 修改原因 |
|---|---|---|---|
| （待 Phase 2-8 填入） | | | |

## 2. PiNovelStudio License

| 项 | 值 |
|---|---|
| 仓库 | `D:\CODE\PiNovelStudio`（本仓库） |
| License | 待确认（仓库根目录未见 LICENSE 文件，需运营方确认） |
| 集成方式 | 作为 `services/novel-runtime` Node.js 服务的依赖加载（npm workspace 或文件路径引用） |

> ⚠️ PiNovelStudio 仓库根目录未见 LICENSE 文件。商业化集成前必须由运营方明确 License；若保持闭源，需确认 PiNovelStudio 内引用的所有第三方依赖的 License 允许闭源商业使用。

## 3. 第三方依赖许可证清单

### 3.1 Sub2API 后端（Go）

由 Sub2API `go.mod` 声明，主要依赖 License（需在 `D:\CODE\sub2api\backend\` 下运行 `go list -m -licenses` 或 `go-licenses` 工具生成完整清单）：

| 依赖 | License | 用途 |
|---|---|---|
| `github.com/gin-gonic/gin` | MIT | HTTP 框架 |
| `entgo.io/ent` | Apache-2.0 | ORM |
| `github.com/lib/pq` | BSD-3-Clause | PostgreSQL 驱动 |
| `github.com/redis/go-redis/v9` | BSD-2-Clause | Redis 客户端 |
| `golang.org/x/*` | BSD-3-Clause | Go 扩展库 |

> 完整清单待 Phase 10 前由 `go-licenses report` 生成并归档到 `D:\CODE\sub2api\docs\novel\third-party-licenses-go.md`。

### 3.2 Sub2API 前端（Vue）

由 Sub2API `frontend/package.json` 声明，主要依赖 License：

| 依赖 | License | 用途 |
|---|---|---|
| `vue` | MIT | 框架 |
| `vite` | MIT | 构建工具 |
| `tailwindcss` | MIT | CSS |
| `pinia` | MIT | 状态管理 |
| `vue-router` | MIT | 路由 |

> 完整清单待 Phase 10 前由 `license-checker` 或 `yarn licenses` 生成并归档到 `D:\CODE\sub2api\docs\novel\third-party-licenses-frontend.md`。

### 3.3 Novel Runtime（Node.js，待创建）

`services/novel-runtime/package.json` 计划依赖：

| 依赖 | License | 用途 |
|---|---|---|
| `@earendil-works/pi-agent-core` | 待确认（PI 上游 License） | PI Agent Runtime |
| PiNovelStudio extension（npm workspace） | 待 PiNovelStudio License 确认 | 6 个 `novel_*` 工具 |
| `express` 或 `fastify` | MIT | HTTP 服务（仅内网） |
| `jsonwebtoken` 或 `jose` | MIT | 任务令牌签名验证 |
| `undici` 或 `node-fetch` | MIT | 调用 Sub2API 计费网关 |
| `pino` | MIT | 日志 |
| `zod` | MIT | DTO 校验 |

> 完整清单在 Phase 1 创建 `services/novel-runtime/package.json` 后由 `license-checker` 生成。

## 4. 兼容性矩阵

| 我们的代码 | 引用 Sub2API | 引用 PiNovelStudio | License 选择 |
|---|---|---|---|
| `services/novel-runtime/` | 通过 HTTP 调用 sub2api-backend（不链接 Go 代码） | 通过 npm 加载（依赖关系） | 可闭源商业（前提：PiNovelStudio 自身 License 允许） |
| `backend/internal/novel/`（Go，加在 sub2api-backend 内） | 与 Sub2API 同进程 | 不直接引用 | LGPL-3.0（与 Sub2API 一致） |
| `frontend/src/features/novel-studio/`（Vue，加在 sub2api-frontend 内） | 与 Sub2API 前端同构建 | 不引用 | LGPL-3.0（与 Sub2API 一致） |
| PiNovelStudio 自身源码 | 不引用 Sub2API | — | 保持原 License |

> **关键结论**：只要 `services/novel-runtime/` 通过 HTTP 调用 Sub2API、不静态/动态链接其 Go 代码，novel-runtime 的 Node.js 代码可保持自有 License。但 `backend/internal/novel/` 和 `frontend/src/features/novel-studio/` 因为编译进 Sub2API 同一产物，必须遵循 LGPL-3.0。

## 5. 发布前合规检查清单

- [ ] Sub2API `LICENSE` 文件保留在分发产物根目录
- [ ] 显式 Notice 出现在产品文档与 About 页
- [ ] 修改清单（§1.3）已填入并公开
- [ ] 修改后的 Sub2API 源码可通过公开仓库获取
- [ ] Go 依赖完整 License 清单已生成
- [ ] 前端依赖完整 License 清单已生成
- [ ] Novel Runtime 依赖完整 License 清单已生成
- [ ] PiNovelStudio License 已确认并允许商业使用
- [ ] 上游模型商业授权（[06-upstream-licensing.md](./06-upstream-licensing.md)）已登记
- [ ] 各依赖 License 兼容性已审核（无 GPL-3.0 等 copyleft 冲突）
