# 模型路由现状审计与基线冻结（WP-00）

**快照日期**：2026-08-12（2026-10-14 按路由真相源 v4.36.0 校订）
**配置真相源**：`config/model-routing.json`（v4.36.0）
**运行时入口**：`novel_generate_chapter` → `handlers/public-handlers.ts` → `v2/core/unified-entry.ts` → `v2/core/unified-orchestrator.ts`

本文件冻结本轮治理基线。目标不是重建第二套路由系统，而是统一并补齐：

- 任务级运行锁（`RunRoutingContext`）
- 生产 / 评测 / 开发 / 校准物理隔离
- 正常预算与恢复预算分离
- 模型调用成本 / 延迟 / 失败 trace

---

## 1. 当前路由矩阵（生产主链路相关）

| 任务 | 当前路由 | provider / model | 生产可用 | fallback | 说明 |
|---|---|---|---:|---:|---|
| Agentic 初稿 | `v2_rawstage2_gemini31` | gemini31 / `.env GEMINI_MODEL` 解析（当前 gemini-4-argon） | 是 | `[]` | 默认 `writerModel` 省略时解析到此；单渠道，失败仅同渠道有界重试 |
| 作者风格优化 | `v2_amplified_gemini31` | gemini31 / `.env GEMINI_MODEL` 解析（当前 gemini-4-argon） | 是 | `[]` | 生产必须经过风格整章优化；单渠道，失败仅同渠道有界重试 |
| 显式 Claude 初稿 | `v2_rawstage2` | claude / claude-opus-4-6 | 是（显式） | `[]` | 仅 `writerModel=claude` |
| 显式 Claude 风格 | `v2_amplified` | claude / claude-opus-4-6 | 是（显式） | `[]` | 仅 `writerModel=claude` |
| 事实验证 / FactGuard | 本地规则 + 结构化解析 | local / 结构化模型 | 是 | 同阶段策略 | 不可因降本绕过 |
| 文学评测 judge | `v2_literary_judge` / `v2_opportunity_judge` | gpt / gpt-5.6-sol | **否（生产不调用）** | `[]` | 仅隔离评测 / 历史回放；SSE 传输 |
| NovelBench 生成 | `nb4_generate_*` | glm/doubao/gpt/claude/gemini... | 否 | `[]` | lab / comparison only |
| NovelBench judge | `nb4_judge_*` / `nb5_judge_*` | glm/doubao | 否 | `[]` | lab only |
| 中文校准 | `v2_chinese_calibration` | doubao | 否（默认生产不入） | `[]` | 校准 / 受限 span 路径 |
| 开发测试锁 | `narrator_testing_*` / `modelTestRoute` | glm/doubao/... | 否 | 多数 `[]` | 与生产 writer 互斥 |

> 历史记录：v4.34.0 曾以 `v2_rawstage2_gpt6astra` / `v2_amplified_gpt6astra`（gpt / gpt-6-astra，`GPT_API_KEY` / `GPT_WRITER_MODEL`）为生产写路由；v4.35.0（GEMINI38-FLASH-PRODUCTION-RESTORE-1）复原 Gemini 为唯一生产正文模型并物理删除 gpt6astra 写路由，不保留并行回退。v4.36.0（WRITER-ENV-UNIFY-1）将写模型与端点收敛为 `.env` 单一配置入口（`GEMINI_MODEL` / `GOOGLE_GEMINI_BASE_URL`），并物理删除 Aimagichub/Solov 双渠道互备与 `GEMINI_SOLOV_*` / `GEMINI_AIMAGICHUB_*` 渠道变量。下文矩阵以 v4.36.0 为准。

### 1.1 默认生产解析（运行时）

`resolveWriterModelRouteLock(writerModel)`（`unified-entry.ts`）：

- `writerModel === undefined | "gemini31"` → Gemini 生产锁（`v2_rawstage2_gemini31` / `v2_amplified_gemini31`，profile `gemini_writer_v2`；实际模型由 `.env GEMINI_MODEL` 解析）
- `writerModel === "claude"` → Claude 显式锁
- `writerModel` 与 `modelTestRoute` **不能同时设置**

`buildTrustedControlPlane(...)` 在入口创建：

- `generationLock = { route, provider, model }`
- `judgeLock` 当前仍指向 GPT judge 路由（历史兼容；生产主链路不再调用文学裁判）
- `enforceModelLocks = true`（当 writer/test lock 存在时）

---

## 2. 模型调用入口盘点

| 入口 | 路径 | 路由来源 | 是否受模型锁约束 |
|---|---|---|---|
| 章节生成公共工具 | `novel_generate_chapter` | writer lock / modelTestRoute | 是（入口构建 control plane） |
| Agentic 初稿 | `novelos/agent/agentic-raw-candidate-source.ts` | generation route | 经 orchestrator wrap |
| 作者风格优化 | `v2/core/author-style-optimizer.ts` | amplified route | 经 orchestrator wrap |
| FactGuard / 结构化 | orchestrator factguard / local gates | 本地或同阶段 | 不可降级为通过 |
| 回放 / NovelBench | `novelbench/*`, `eval/*` | lab routes | 必须 routeClass=evaluation/calibration |
| 历史 pairwise judge | `v2/core/pairwise-literary-judge.ts` | GPT judge | 仅 eval 闭包 |

编排器 `wrapModelFn` 已具备：

- capability 授权（`model.generate` / `model.judge` / `network.model_call`）
- expected lock 字段写入 modelCalls
- 失败调用也计数
- 硬上限 `HARD` 调用拦截

缺口（本轮补齐）：

1. 缺少不可变 `RunRoutingContext`（参数 / bundle / budgetProfile / routeClass 一次锁定）
2. 每次调用前 `assertModelCallMatchesLock` 未统一（仅 packet vs execution lock 静态比对）
3. `agent_routing` 无统一 `routeClass` / `productionEligible` / `allowedCallers`
4. 预算以恢复预算为主，正常/恢复/阶段/UX 四层未完全分离
5. 成本报告偏 duration/calls，缺少完整 token/cost/latency 分位与失败归因报告

---

## 3. 路由调用关系图

```text
novel_generate_chapter
  └─ public-handlers.handleGenerateChapter
       └─ unified-entry.runUnifiedPipeline
            ├─ resolveWriterModelRouteLock / resolveModelTestRouteLock
            ├─ buildTrustedControlPlane(generationLock, judgeLock)
            └─ UnifiedOrchestrator.orchestrate
                 ├─ wrapModelFn(generation / judge)
                 │    ├─ authorize capability
                 │    ├─ HARD budget check
                 │    ├─ model call → ModelCallEntry
                 │    └─ auditSink.recordModelTurn
                 ├─ NovelOS Agentic (generation lock)
                 ├─ Author Style Optimization (generation lock)
                 ├─ StoryPreservation / FactGuard / Completeness
                 └─ AtomicSave + Trace（仅成功交付）
```

跨模型恢复语义（强制）：

```text
Run A：Gemini 失败 → blocked（同 run 不静默切 Claude）
Run B：用户显式 writerModel=claude 后重新生成
```

---

## 4. 缺口清单

| ID | 缺口 | 影响 | 对应 WP |
|---|---|---|---|
| G1 | 无 `RunRoutingContext` | 参数漂移难审计 | WP-01 |
| G2 | 无调用前完整锁校验 | 可能发出不一致调用 | WP-01 |
| G3 | route 缺 `routeClass` 元数据 | 评测污染难静态拦截 | WP-02 |
| G4 | 正常/恢复预算未分层结算 | 恢复挤占正常预算风险 | WP-03 |
| G5 | 失败策略矩阵分散 | silent degrade 回归风险 | WP-04 |
| G6 | 延迟分位/成本报告不完整 | 无法证明“是否值得” | WP-05 |
| G7 | 最小路由/成本 eval 未固化 | 回归靠人工 | WP-06 |
| G8 | 质量-成本联合指标缺失 | 降本决策无审批材料 | WP-07 |

---

## 5. 不变量清单（本轮强制）

1. **一次运行内模型身份稳定**：route / provider / model / modelVersion 不因质量、延迟、单次策略失败、临时网络异常而静默切换。
2. **未授权跨模型切换 = 0**：Gemini 失败不得在同 run 伪装成 Claude 成功。
3. **生产不得调用评测模型**：GPT 文学裁判、GLM/Doubao lab 路由不得进入默认生产。
4. **fallback=[] 的生产写路由 hard block**：不得继承 provider 级 fallback 污染正文。
5. **评测结果不得自动改生产默认路由**。
6. **新旧模型策略统计按 modelVersion 隔离**。
7. **失败必有结构化 FailureEnvelope**；FactGuard 失败不得降为 warning。
8. **风格优化失败 hard block**；禁止 silent 交付 raw 初稿。
9. **所有模型调用有超时上限**；禁止无限等待。
10. **失败调用也计入成本与 trace**。
11. **降本不得削弱作者内容契约 / 事实硬门**。
12. **任何生产路由变更需固定样本 + 真人反馈 + 人工审批**。

---

## 6. 已完成能力 vs 配置存在但未强制

### 已完成（可复用）

- `config/model-routing.json` 生产 Gemini 默认 + Claude 显式 + lab 路由
- `control-plane.ts` ModelLock / CapabilityPolicy / validateModelLock
- `recovery-budget.ts` 阶段/总次数/模型/恢复/延迟预算预扣
- `failure-envelope.ts` + recovery decision/policy
- `chapter-cost-snapshot.ts` 章节成本快照
- orchestrator wrapModelFn 失败计数与 expected/actual 字段

### 配置存在但运行时未完全强制（本轮收敛）

- route 级 `lab_testing` 标注不完整（部分 lab 路由未标）
- 无统一 `routeClass` / `allowedCallers`
- 无 `RunRoutingContext` 一次解析锁定 temperature/maxTokens/timeout/bundle/budgetProfile
- 无统一 `assertModelCallMatchesLock` 调用门
- 无自动化“生产污染评测模型”审计脚本作为发布门槛

---

## 7. 验收口径（基线冻结）

- 每条关键 route 有唯一用途（见矩阵）
- 每个生产模型调用点可追溯到 route + lock
- 明确 G1–G8 为后续 WP 交付边界
- 本轮不引入：自动选最便宜模型、运行中动态换模、生产 best-of-N、生产 GPT 文学裁判

---

## 8. 交付映射

| WP | 交付物 |
|---|---|
| WP-00 | 本文档 |
| WP-01 | `v2/core/run-routing-context.ts` |
| WP-02 | `v2/core/route-catalog.ts` + `scripts/audit-route-isolation.mjs` |
| WP-03 | `v2/core/layered-budget.ts` |
| WP-04 | `v2/core/failure-strategy-matrix.ts` |
| WP-05 | `v2/core/model-call-observability.ts` |
| WP-06 | `tests/model-routing-governance.test.mjs` |
| WP-07 | `v2/core/quality-cost-metrics.ts` |

---

## 9. 生产接入状态（2026-08-12 补验）

| WP | 模块 | 统一编排器生产接入 | 验收 |
|---|---|---|---|
| WP-00 | route-inventory | n/a（文档） | Verified |
| WP-01 | run-routing-context | `unified-entry` 创建 + `wrapModelFn` 校验 + controlPlane.runRouting | Verified |
| WP-02 | route-catalog + audit script | 配置/调用方校验 + 静态审计 | Verified |
| WP-03 | layered-budget | `routing-governance-runtime` → wrapModelFn 预扣/结算 + stageResults.layeredBudget | Production-wired |
| WP-04 | failure-strategy-matrix | hardBlock → recordFailureStrategy + stageResults.failureStrategyDecision | Production-wired |
| WP-05 | model-call-observability | 出口 buildGovernanceReports → stageResults.modelCallObservability | Production-wired |
| WP-06 | governance tests | 模块测试 + production-path 测试 | Verified |
| WP-07 | quality-cost-metrics | 出口 stageResults.qualityCostAnalysis（analysis only） | Production-wired |

运行时适配层：`v2/core/routing-governance-runtime.ts`  
接入点：`unified-orchestrator.ts`（wrapModelFn / hardBlock / deliverRaw / finishWithCollab / 主路径 ok）  
验收测试：
- `tests/model-routing-governance.test.mjs`（模块）
- `tests/model-routing-governance-production-path.test.mjs`（编排器 stageResults）
- `tests/model-routing-governance-trace-persistence.test.mjs`（quality-trace.json 落盘）

### 9.1 收尾补验（2026-08-12）

| 缺口 | 处理 |
|---|---|
| dist 295 ≥ 290 | 合法新增 7 个生产治理模块；dependency-boundary 阈值上调至 310 |
| stageResults vs quality-trace | final_selected / blocked error 记录顶层写入 routingGovernance 等字段；gate.evidence 含完整 V2 record |
| retryIndex 恒 0 | wrapModelFn 按外层 `_modelTimeoutRetryAttempt` / 本 run 已失败调用 / kind 启发式标记 recovery |
