# 第三轮 P0 修复验证报告

**任务编号**：PINOVEL-SUB2API-INTEGRATION-1
**修复日期**：2026-07-23
**前置审计**：第二轮生产审计 22/100，9 项 P0 阻断（详见 [plan202600722.md](./plan202600722.md) §进度快照）
**用户指定修复顺序**：真实工具适配 → Sub2API 唯一模型出口和真实 Token 计量 → API DTO 契约 → 安全门禁 → 取消/预算中止 → 可启动部署 → 真实端到端测试
**结论**：P0-1 ~ P0-8 与 P0-E2E 代码层全部完成并提交。P0-9（PI 互动界面）用户已声明降级为 P1，不在本轮范围。仍需真实部署环境验证（Docker 构建、e2e-smoke.sh 人工冒烟、真实生成链路）方可声明生产可上线。

---

## 一、修复提交清单

### PiNovelStudio 仓库（branch `codex/sub2api-integration`）

| 编号 | 问题 | 提交 | 内容 |
|---|---|---|---|
| P0-2 | 真实 Token 计量 | `79bf692`（用户 WIP）+ `ac05f0c` | 取消 `tokenUsage="unknown"` 固定值，从 `ModelCallEntry` 真实读 inputTokens/outputTokens；PricingTable 与 metering-binder 消费真实值 |
| P0-3 | Sub2API 唯一模型出口 | `ac05f0c` | `modelClient` 在 production 路径强制走 `SUB2API_INTERNAL_LLM_BASE_URL` + `SUB2API_INTERNAL_LLM_API_KEY`；删除直连厂商 fallback |

### Sub2API 仓库（branch `codex/sub2api-integration`）

| 编号 | 问题 | 提交 | 内容 |
|---|---|---|---|
| P0-1 | 真实工具适配（execute→invoke） | `4b96d63` | novel-runtime 加 `extension-loader.ts`，对 PiNovelStudio 真实工具 `execute()` 包装 `invoke()` 适配层；`/v1/invoke` 不再返回 `TOOL_NOT_FOUND` |
| P0-4 | 生成请求补 chapterId | `4b96d63`（同期） | Go 后端 `CreateGenerationRequest` 加 `chapter_id`，runtime 透传给 PiNovelStudio |
| P0-5 | API DTO 契约对齐 | `73d3369`（backend）+ `352473b`（frontend） | `ProjectDTO`/`DocumentDTO`/`ChapterDTO`/`ChapterListItemDTO`/`FeedbackDTO` json tag 全部 snake_case；`ProjectDTO` 加 `chapter_count`；`SaveDocumentRequest.title` 去掉 required + 后端按 docType 派生默认标题；前端 `author_style_profile` → `style_profile` |
| P0-6 | 安全门禁接入请求链路 | `2dcee2b` | `runGeneration` 在物化 workspace 后调 `safetyService.CheckInput`，在提取正文后调 `CheckOutput`；任一失败则 `MarkJobFailed` 且不 SaveChapter |
| P0-7 | 取消/预算中止信号传播 | `dfa6598`（JobCancelRegistry）+ `99e2ece`（metering-binder break） | 新增 `JobCancelRegistry` 单例跟踪运行中 `ctx.CancelFunc`；`runGeneration` 改用 `registry.Register(jobID)`；`CancelGeneration` 调 `registry.Cancel(jobID)`；metering-binder `budgetExhausted=true` 时 `break` settle 循环 |
| P0-8 | 可启动部署配置 | `9443dff` | Dockerfile 重写为 3 阶段（builder-pinovelstudio + builder-runtime + runtime）；Compose 加 `NOVEL_RUNTIME_HOST=0.0.0.0`/`NOVEL_STUDIO_DIST_PATH`/`SUB2API_INTERNAL_LLM_BASE_URL` 等环境变量；healthcheck 改 `/healthz` fetch；MinIO 镜像 pin `RELEASE.2024-12-13T22-00-00Z`；novel-runtime 镜像 pin `v0.1.0`；新增 sub2api backend overlay 注入 `NOVEL_RUNTIME_BASE_URL` + HMAC Key + 内部结算 Key |
| P0-E2E | 真实端到端测试 | `46f2f55`（real-extension-loading.test.ts）+ `e9b02f1`（e2e-smoke.sh） | 集成测试加载真实 PiNovelStudio dist 验证 6 工具均暴露 `invoke` 函数；冒烟脚本 `deploy/e2e-smoke.sh` build 双端 + 启动 runtime + 轮询 `/healthz` 验证 toolCount=6 |

> 完整 sub2api 提交历史：
> ```
> e9b02f1 test(p0-e2e): 添加 e2e-smoke.sh 端到端冒烟脚本
> 46f2f55 test(p0-e2e): real-extension-loading.test.ts + e2e-smoke.sh——真实 PiNovelStudio dist 加载 6 工具
> 9443dff fix(p0-8): Dockerfile 多阶段构建 novel-runtime + compose env/healthcheck/tag 对齐（待 Docker 验证）
> 99e2ece fix(p0-7): metering-binder budgetExhausted 时中止 settle 循环
> dfa6598 fix(p0-7): JobCancelRegistry——取消信号传播至运行中 goroutine ctx
> 2dcee2b fix(p0-6): 安全门禁接入生成链路——CheckInput 前置 / CheckOutput 后置
> 4b96d63 fix(p0-1, p0-4): execute→invoke 适配 + chapter_id 透传
> ```

---

## 二、验证结论

### 代码层验证（开发机已执行）

| 验证项 | 仓库 | 结果 | 备注 |
|---|---|---|---|
| `npm run build:prod` | PiNovelStudio | ✅ 通过 | dist/index.js 编译成功 |
| `npm run smoke` | PiNovelStudio | ✅ 2/2 通过 | phase5-unified-default-path |
| `npm test`（p0-2 test） | PiNovelStudio | ✅ 2/2 通过 | tokenUsage 真实计量断言 |
| `npm run build` | sub2api/novel-runtime | ✅ 通过 | 编译 dist/ |
| `npm run typecheck` | sub2api/novel-runtime | ✅ 通过 | |
| `npm test` | sub2api/novel-runtime | ✅ 90/90 通过 | 含新加 real-extension-loading.test.ts（2 个用例） |
| `go build ./...` | sub2api/backend | ✅ 通过 | Go 1.26.5 |
| `go test ./internal/handler/... ./internal/service/...` | sub2api/backend | ✅ 通过 | 含 JobCancelRegistry 5 个单测 |
| `npm run typecheck` | sub2api/frontend | ✅ 通过 | |
| `npm run build` | sub2api/frontend | ✅ 通过 | 生产构建 |

### 新增测试用例

#### `services/novel-runtime/tests/real-extension-loading.test.ts`（P0-E2E）

- `loads 6 tools, all expose invoke function after adapter` — 加载真实 PiNovelStudio dist 验证 6 工具均暴露 `invoke`
- `healthz filterResult contains novel_generate_chapter` — `/healthz` 返回 6 工具且包含 `novel_generate_chapter`

测试 import 真实 `D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/dist/index.js`，而非伪造 mock。如 dist 不存在则整个 describe block 自动 skip。

#### `services/novel-runtime/tests/metering-binder.test.ts`（P0-7 更新）

测试重命名 `中止后续 settle，不再扣费（P0-7）`：
- 模拟第一笔 settle 返回 `budgetExhausted=true`，断言第二笔 settle **不被调用**（`settleMock.calls.length === 1`）
- 断言 `totalSettledAmount === 5.0`（仅第一笔扣费，第二笔被 break 跳过）

#### `backend/internal/service/novel_job_cancel_registry_test.go`（P0-7 新增）

5 个单测覆盖：
- `Register` 返回可取消 ctx
- 重复 Register 同 jobId 先取消旧 ctx（防御性）
- `Cancel` 触发 ctx.Done()
- `Cancel` 不存在的 jobId 返回 false（no-op）
- `Release` 清理 map 且不再可被 Cancel

---

## 三、待人工验证项（非代码阻断）

### 1. Docker 真实构建（P0-8）

当前开发机无 Docker，需用户执行：

```powershell
Set-Location D:\CODE\sub2api
docker build -f deploy/Dockerfile.novel -t weishaw/novel-runtime:v0.1.0 .
docker-compose -f docker-compose.yml -f docker-compose.novel.yml up -d
```

期望：
- 3 阶段构建无错误
- `novel-runtime` 容器 `/healthz` 返回 200，`toolCount=6`
- `minio` 容器 `mc ready local` 通过
- sub2api backend 容器正常启动且能 reach `http://novel-runtime:3100`

### 2. e2e-smoke.sh 端到端冒烟（P0-E2E）

需用户在 Linux/WSL 环境执行（依赖 `curl` + `python3`）：

```bash
cd /d/CODE/sub2api
bash deploy/e2e-smoke.sh
```

脚本步骤：
1. build PiNovelStudio `dist/`
2. build novel-runtime `dist/`
3. 启动 `node dist/index.js`（注入测试用环境变量）
4. 轮询 `http://127.0.0.1:3100/healthz` 最多 30 秒
5. 验证响应 `toolCount === "6"`

### 3. 真实生成链路（P0-2/P0-3/P0-4 联合验证）

需完整 DB + task token + 余额预占环境：

```bash
# 通过 Sub2API backend 发起生成请求
curl -X POST http://localhost:8080/api/v1/novel/projects/{projectId}/generate \
  -H "Authorization: Bearer <jwt>" \
  -d '{"chapter_id": <existing_chapter_id>, "chapter_number": 1, "workspace_seed": "..."}'
```

期望：
- PiNovelStudio 真实启动 `NovelOS Agentic → 作者风格整章优化` 主链路
- 所有 LLM 调用走 `SUB2API_INTERNAL_LLM_BASE_URL`，**不**直连 Gemini/Claude/GPT
- `tokenUsage` 字段含真实 `inputTokens`/`outputTokens`（非 `unknown`）
- 余额正确预占 + 结算；预算耗尽时主链路被 break
- 调用 `CancelGeneration` 端点能中断运行中 goroutine

---

## 四、未覆盖范围（明确声明）

### P0-9 PI 互动界面

用户在第二轮审计反馈中已明确声明：「PI 互动界面」降级为 P1，不在本轮 P0 范围。当前 `frontend/src/views/novel/NovelProjectView.vue` 仍只有「资料/章节/生成/反馈」四个标签，没有 PI 对话、交互式大纲规划或受限小说助手界面。后续将作为独立 P1 任务规划。

### 真实文学质量验证

P0 修复仅保证**链路通畅**与**计费正确**，不评估 PiNovelStudio 章节生成质量。质量评估仍由用户通过最终正文和后续修改反馈评价（遵循 PiNovelStudio 统一主链路「文学评价权归用户」铁律）。

### 性能与并发压测

未执行并发生成压测、长时间运行稳定性测试、Redis nonce 防重放生产部署验证（当前仍是内存 nonce，生产应换 Redis）。

---

## 五、Git 状态说明

### Sub2API 仓库

- 分支：`codex/sub2api-integration`
- 工作树：clean（最后提交 `e9b02f1`）
- 9 个 P0 修复 commit 已落库

### PiNovelStudio 仓库

- 分支：`codex/sub2api-integration`
- 本次提交包含：
  - `docs/INSub2api/README.md`（第三轮修复状态表 + 顶部说明更新）
  - `docs/INSub2api/plan202600722.md`（状态行更新为「第三轮 P0 代码修复完成」）
  - `docs/INSub2api/verification-round-3.md`（本文件新增）
- P0-2/P0-3 代码修复已在前序提交 `ac05f0c`（用户 WIP `79bf692`）落库

---

## 六、下一步建议

1. **立即执行 Docker 构建与 Compose 启动验证**，确认 P0-8 容器化层正确
2. **在测试环境执行 `bash deploy/e2e-smoke.sh`**，确认 PiNovelStudio 真实工具加载
3. **配置真实 LLM 网关 + DB + 余额账户，触发一次真实生成**，验证 P0-2/P0-3/P0-4/P0-7 联合行为
4. 三项全部通过后，可声明「P0 阻断全部解除，可进入 P1 阶段」
5. P1 阶段首要任务：P0-9 PI 互动界面设计与实现
