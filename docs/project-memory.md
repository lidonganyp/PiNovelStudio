# PiNovelStudio 项目记忆

**快照日期**：2026-08-11（Phase 9 生产运营期 active_prod 状态更新）
**代码基线**：当前工作树已切换到 Agentic-Style 生产链路（NovelOS Agentic → 作者风格整章优化 → 事实复检 → 原子保存）；旧裁判链仅保留隔离评测。
**用途**：供 Codex、Claude Code 与维护者跨会话快速恢复当前事实。架构细节仍以 `top-tier-chinese-novel-system-development-plan.md` 为准，任务状态仍以 `remaining-development-dispatch-plan-20260715.md` 为准。

## AGENTIC-EVIDENCE-MERGE-1：证据决策合并进 Agentic 首轮（2026-08-12）

**状态：已完成（build / typecheck / test / test:eval 全部通过）。** 独立 `EvidenceDecision` 模型回合已退役，证据与检索判断合并进 NovelOS Agentic 首轮 ReAct 循环。

- **EvidencePlan 收敛为系统安全计划**：字段收敛为 `known / mustVerify / allowedTools / stopConditions / retrievalCallLimit`；移除只服务独立回合的 `unknown / queries / needRetrieval / retrievalDepth`。检索上限由确定性策略生成（`mustVerify ? 4 : 2`），是系统上限而非模型配额。
- **Agentic 合并**：`agentic-raw-candidate-source.ts` 删除 `runEvidenceDecisionRound` 调用，把 `retrievalCallLimit` 接线进 runtime `retrievalBudget`；Agentic 首轮可在同一循环内自主选择直接生成或调用系统授权工具。
- **物理清理**：`novelos/agent/evidence-decision.ts` 已物理删除；`context_decision` trajectory entry 类型与 `recordContextDecision` 死代码已移除；`ToolVisibilitySnapshot` 只记录 `systemAllowedTools / visibleTools`，不再记录模型决策的 `selectedTools / rejectedTools`。
- **保留的系统安全边界（未削弱）**：`mustVerify`、工具白名单（fail-closed）、`retrievalCallLimit` 上限强制、MustVerifyCoverageGate、Agentic FactGuard 与 verify/patch 闭环全部保留。
- **未引入**：固定 thinking token、未验证的 provider 隐藏推理参数、机器文学裁判或 raw fallback。
- **测试**：`tests/phase2d-evidence-decision.test.mjs` 重写为证明独立回合退役 + Agentic 内生决策 + 系统边界有效（18 项）；tool-visibility runtime/trajectory 测试与 replay 脚本同步改为新快照契约。完整测试 2787 pass / eval 1055 pass / 0 fail。

> 文档表述统一为：EvidencePlan 由系统建立安全边界；是否检索及检索顺序由 NovelOS Agentic 在同一 ReAct 循环内决定；系统通过工具白名单、调用上限、MustVerifyCoverageGate 和 FactGuard 保证安全。历史 `evidence-decision-prompt-inventory.md` 与 `phase-reasoning-budget-baseline.md` 保留为只读研究证据，不再描述为生产阶段。

## Phase 9 生产运营期 active_prod（2026-08-11）

**当前状态：生产运营期，稳定生产基线运行中。** 项目已从"开发/验收阶段"转入"生产运营与按需迭代"。active production pointer 已切换到 `rel-prod-103`（`active-production.json → rel-prod-103`），`PINOVEL_DEV_MODE=0`，不启动 canary，不开放新的 Prompt/Native 实验。

- **`rel-prod-103` 是当前正式生产审批**：`reviewTransport=network`、真实 `releaseManifestHash`、目标环境 `environmentFingerprint=57abb60c…`，审批 artifact 绑定 `approval-rel-prod-103-1786379908606-42cfb37a`（reviewerModel=gpt5.6-sol，finalVerdict=APPROVE_DEV）。rel-prod-103 解除 rel-prod-102 因 `evolution-cli` .env 加载修复提交（c9ef8ef）导致的 codeCommit 指纹漂移，重新捕获并与当前生产运行时指纹一致。
- **真实生产基线（xinmo ch19，2026-08-10）**：关闭 `PINOVEL_DEV_MODE` 后 `novel_generate_chapter` 完整主链路 150.5s，4 次模型调用（Gemini 3.1 Pro Preview），release gate 通过，trace 完整，narrative-state 推进到 ch19（hash 217 处引用），原子保存成功，无 silent degrade。此基线在 rel-prod-101 下验证，已由 rel-prod-103 继承遗传。
- **Bounded observation（ch20/ch21，2026-08-11，rel-prod-103）**：连续观察真实章节，每章生产验收 + 加固复检全绿。
  - **ch20**：生产验收 14/14 PASS、加固复检 22/22 PASS；5 次模型调用全部 gemini-3.1-pro-preview（expected=actual，无 fallback），budget used=5/soft=6/hard=10 未 capped，20.md 原子保存（SHA 681dd25d，与状态引用一致），narrative-state ch19→ch20（引用 258 处），selectedSource=v2_amplified 无 silent degrade。trace 含 2 条**历史** failureEnvelope（rel-prod-101 旧指纹 4e129c8f 漂移 + 早期 preflight），复检按"本次运行起点"（16:42:13）只统计本次 3 个 gate，历史 envelope 被正确隔离、无误判。
  - **ch21**：生产验收 12/12 PASS、加固复检 22/22 PASS；4 次模型调用全部 gemini-3.1-pro-preview，budget used=4/soft=6/hard=10 未 capped，21.md 原子保存（SHA 2f0feca9，与状态引用一致），narrative-state ch20→ch21（引用 206 处），selectedSource=v2_amplified 无 silent degrade，**trace 干净（0 failureEnvelope）**，证明 rel-prod-103 基线稳定。
- **加固复检（`phase9-acceptance-reverify.mjs`）：22/22 PASS** — devMode=false、release gate、trace、原子保存、状态提交全部通过；对 ch20 历史 envelope 的隔离验证了复检脚本对历史污染的健壮性。
- `phase9-acceptance-reverify.mjs` 的 releaseGovernance 检查为 **P0 硬门**：必须 `devMode===false` 且 `releaseId/approvalRef/environmentFingerprint` 全非空，任一条不满足即 FAIL。dev-mode 验收不再可能被误报为生产验收。
- **历史负向验证（已退役，保留为门禁有效性记录）**：`rel-000` 是 dev-bootstrap 审批，非生产审批（缺 `reviewTransport`、`releaseManifestHash="bootstrap-dev"`）；对 dev-mode ch18 trace 复检 20/23 FAIL 证明门禁会拒绝未审批 dev 产物。当前生产路径不再使用 `rel-000`，该记录仅说明门禁在 dev 产物下正确拒绝。
- **生产运营节奏**：每次发布前执行 drift check（环境指纹）、release gate（`evaluateProductionReleaseGate`）、加固复检（reverify）；持续归档章节 trace 与状态提交证据；监控 fallback、FailureEnvelope、预算封顶（A 组 soft=6/hard=10）与状态/hash 不一致。任何代码/配置变更后需重新 capture release 并走审批晋级（新 commit 会改变 codeCommit 指纹）。

## Tool Interface Contract v1 验收口径修正 + A 组冻结基线（2026-08-11）

**验收结论（修正后口径）**：当前生产 A 基线（9 专用工具，真实 Gemini route `v2_rawstage2_gemini31`）运行稳定；facade 与 compact envelope 未通过门禁，暂不切换 production pointer。

> ⚠️ 口径修正说明：不得用「6 项指标生产路径均无劣化」描述 B/C 相对 A 的结果。真实报告中 B 相对 A 的 empty/errors/timeouts 为 4 vs 3、invalid sourceRef 为 4 vs 3；C 的 mustVerify 覆盖率为 0.583，低于 A 的 0.667，且 B/C 均 `allPassed=false`。上一版 `reports/tool-interface-baseline.json`（2026-08-07）是零模型调用的确定性 stub（无 seed、无 schemaTokenCost、无真实模型指纹、无 stopRate），**不能**作为 B/C 的「同模型同 seed 同场景」对照基线。因此上述修正口径成立。

**A 组冻结基线**（真实 replay，`reports/phase4-tool-ab-real-gemini/`，route=`v2_rawstage2_gemini31`，provider=gemini31，model=gemini-3.1-pro-preview，temperature=0.72，maxTokens=2048，`gemini_validation` cost profile，`DISABLE_FALLBACK=1`，场景 SC1/SC6/SC7 × seed 0/1，共 6 arm 样本）：

| 指标 | 冻结值 |
|------|--------|
| schemaTokenCost | 9208 |
| mustVerify（avgCoverageRatio） | 0.667 |
| sourceRefCompleteness | 0.400 |
| emptyResults | 3 |
| errors | 3 |
| timeouts | 3 |
| stopRate | 0.500（3/6） |
| truncatedResults | 0 |
| invalidToolSelections | 0 |
| parseErrors | 0 |
| evidenceLevelCounts | confirmed_state=2, exact_chapter_span=2 |
| firstValidEvidenceLatencyMs | 2 |

**后续研究红线**：进入「上下文压缩/记忆层」研究后，所有压缩方案必须与 A 组冻结基线做**同模型、同 seed、同场景**对照；任一指标不劣化方可通过，不得以历史 stub 基线或跨模型结果替代对照。

## Phase 1 整改（2026-07-28）

审计发现 P0 回归：风格优化失败时把 Agentic 初稿伪装成优化稿保存（`selectedSource="editorial"` 但实际返回 raw）。Phase 1 整改修复以下问题：

### P0-1：风格失败硬阻断 + provenance 修复
- 删除 orchestrator 中 5 处 raw 回退路径；风格优化失败一律 `hardBlock`，不再回退 `agenticCandidate`。
- blocked 路径 `selectedSource=null`（原先固定 `"raw"`，与 `rawRole="not_deliverable"` 冲突）。
- `hardBlock` 方法新增 `severityOverride` + `gate` 参数（`HardBlockGuidance` 类型）。
- Agentic 初稿只作为 blocked evidence 保留在 trace，不交付、不保存、不提交状态。

### P0-2：Story Preservation 止血
- 恢复阈值：`replacedSimilarityThreshold=0.25`（原被放宽到 0.15）、`lowSimilarityReplacementThreshold=3`（原被提到 8）。
- `knownEntities` 扩展为完整实体表：角色+别名 + `worldKeyTerms`（factions/places/currencies/professions/specialAbilities/levels）。
- `entityCoverage` 从 `characters_only` 改为 `full_entities`（当 `knownEntities` 存在时）。
- "保留人名但整章换剧情"（如交玉玺→喝茶）现在被正确阻断。

### P1：FailureEnvelope 超时重试匹配
- `UnifiedFailureEnvelope.severity` 新增 `"recoverable"`（原仅 preflight|hard|fatal）。
- 新增 `gate` 字段；工具层 `register-tools.ts` 的 `gate === "model_timeout" && severity === "recoverable"` 重试条件现在可达。
- `author-style-optimizer.ts` 新增 `failureKind` 分类（no_guidance/prompt_rejected/empty_result/model_timeout/model_error）。
- Agentic 生成超时也归类为 `recoverable` + `gate=model_timeout`。

### P1：最小风格档案前置检查
- orchestrator 入口在模型调用前检查 `context.styleReferences` 中是否存在 `kind=fingerprint`。
- 缺失时 `severity=preflight` hard block，不浪费 Agentic 预算。evalMode 跳过此检查。

### 失败矩阵测试
- 新增 `tests/phase1-style-failure-matrix.test.mjs`（12 用例）：preflight 阻断、风格优化各 failureKind、Story Preservation 通过/重试/阻断、Agentic 超时。
- 新增 `tests/test-style-fingerprint.mjs` 共享测试夹具。
- 9 个现有测试文件更新为使用 `TEST_STYLE_REFERENCES`（避免 preflight 阻断）。

## Phase 5.1 受控 bounded-canary（2026-08-09）

Phase 5 受控生产接入实现（"guided facade vs 9 工具" 的受控对照，非全量切换）。完成阶段保持默认 9 工具执行面，**未切换生产 active pointer**。

### 新增能力
- `scripts/canary/chapter-canary-runner.mjs`：新增 `--tool-mode / --release-id / --source-run-id / --authorization-id / --environment-fingerprint / --approval-ref / --change-class / --strategy / --complete`。`--complete` 产出 `completion-trace.json`（bounded-canary 完成态 trace）。
- `scripts/canary/completion-trace-adapter.mjs`：把真实运行结果适配为完成态 `CanaryRunTrace`，补齐三项证据——`evidence.toolMode`、`evidence.modelFingerprint`（detectedModel + providers + modelCalls）、`evidence.failureMetrics`（empty/truncated/error/timeout + blockRate/firstPass/recovery），并冻结结果 artifact（`resultArtifactRefs` + SHA-256）。
- `v2/governance/canary-trace-store.ts`：`CanaryRunTrace.evidence` schema 扩展 `toolMode / modelFingerprint / failureMetrics`。
- fail-closed toolMode 解析：runner 与生产 `resolve-tool-mode-from-canary-authorization.ts` 同源；`--tool-mode facade` 仅当授权文件明确声明 `toolMode="facade"` 且未过期才运行，否则抛错拒绝（不在地图外跑 facade）。

### 真实隔离 workspace replay（stub）
- 隔离 workspace `workspaces/phase5-bounded-canary-ws` + `canary-authorization.json`（`toolMode=facade`）。
- `--tool-mode facade --complete` 运行 ch1：`toolMode=facade`（fail-closed 已确认授权）、`verdict=pass`、`observedChapters=1`、`observedCalls=3`、`modelFingerprint.detectedModel=gemini31`、`failureMetrics: empty=0 truncated=1 error=0 timeout=0 blockRate=0`。
- 产物：`reports/chapter-canary/phase5-1-bounded-canary/`（含 `completion-trace.json`）。

### rollback drill（已通过）
- 移除 `canary-authorization.json` 后：`resolveToolModeFromCanaryAuthorization` 返回 `undefined`（fail-closed → 默认 standard）；默认 narrative registry 保持 9 工具。
- `--tool-mode facade` 重跑被 fail-closed 拒绝（exit 1）；`--tool-mode auto` 回落 `standard`（9 工具）正常生成。
- 结论：授权是 facade 的唯一开关，删除即回退 9 专用工具；生产 active pointer 未切换。

## 当前架构

- 章节生成只有 `novel_generate_chapter` 一个公开入口，生产运行时统一主链路为：`Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → FactGuard → 作者风格整章优化 → StoryPreservation → FinalFactRecheck → Completeness → StateCommit → AtomicSave`。
- legacy Stage0-8 正文编排已经物理删除；生产 `dist/`、评测 `dist-eval/`、测试 `dist-test/` 由三个 tsconfig 隔离。
- 生产严格保留 6 个公开工具。代理审批定稿通过 `novel_workspace_manager` 的 `proxy_finalization` action 消费，不新增第 7 个公开工具。
- one-shot raw 不再是生产交付稿；仅在隔离评测中保留。生产 Agentic 失败或作者风格优化失败直接结构化阻断，不静默退回纯模型正文。最终文学评价由用户正文反馈和修改稿承担。

## 2026-07-17 已完成变更

- `MODEL-ROUTING-CLAUDE46-1A`：生产 generation/judge 路由显式化，未知 route fail closed，关键 v2 route 使用 route-level `fallback=[]` 和 provider allowlist。
- `MODEL-ROUTING-CLAUDE46-1B/1D`：Claude 路由统一到 `claude-opus-4-6`；raw/普通 editorial 由 Claude 4.6 生成；GPT 5.5 作为异源 judge；GLM 仅允许显式开发/NovelBench route，不能进入生产默认或 fallback。
- `MODEL-ROUTING-CLAUDE46-1C`：Doubao span 驱动中文校准已达到 `COMPLETE_L0`。全套件 `doubao-span-calibration` 测试通过。Doubao 降为受限中文校准器，仅 `v2_chinese_calibration` 在有 raw span 证据时调用。
- `MODEL-ROUTING-CLAUDE46-1E-fix`：异源 judge 路由从 gpt-5.5 全量切到 gpt-5.6-sol（`v2_opportunity_judge` / `v2_literary_judge`），通过 `NOVELOS_JUDGE_*` env 解析端点。
- `DEAD-SOURCE-CLEANUP-IMPORT-FIX`：已闭环。`34b33a4` 删除 24 个 craft legacy dead code 并解除 type-only 耦合，三构建自洽，clean checkout 不再缺文件。
- `0f6a853`：退休 Phase 7 遗留死引用测试（`trailing-sentence-guard` + `replay-benchmark-learning` 死 import）。
- `1404936`：G7 fail-closed 实现 — `ProxyApprovalOutcome` 增加 `shouldHardBlock`，编排器 hard block `HOLD_FOR_REGENERATION` / `draftSaved=false`。
- `e581aff`：G5 实现 — `evolution:promote/hold/rollback` CLI 命令（bounded canary 推迟 P1）。
- 7.75GB `corpus/` 已从仓库删除，死字段 `config.corpusPath` 已移除；生产生成路径对原始语料零依赖。仓库只保留蒸馏后的运行时数据与评测资产；离线重建数据必须由使用者提供外部语料路径。
- G7 章节代理审批的本地工程链路、pending checkpoint、Review Surface、定稿、反馈、健康归集、生产入口消费和 P0/P1 修复均已达到 `COMPLETE_L0`。真实 `gpt5.6-sol` 调用仍需要独立授权。

## 当前模型职责

`config/model-routing.json` v4.31.0 是唯一运行时真相源：

- Gemini 3.1 Pro Preview：NovelOS Agentic 与作者风格整章优化主写；未传 `writerModel` 时分别使用 `v2_rawstage2_gemini31` / `v2_amplified_gemini31` 和 `gemini_writer_v2`。`fallback=[]`，失败 hard block，不静默切换 Claude 或其他正文模型。
- Claude Opus 4.6：通过显式 `writerModel=claude` 使用独立 raw/editorial 路由；继续负责正式 StyleShaper、Stage 8 final gate 与 character_agent，不是 Gemini 的自动 fallback。
- 生产决策：不再让 AI judge 替用户决定文学质量。GPT judge、opportunity judge、reverse review 仅保留在隔离评测与回放，不进入 `novel_generate_chapter`。
- `AUTHORITATIVE-CONTENT-FREE-EXPRESSION-1`：第 18-20 章的一次序列偏好仅保留为历史实验，不再外推为全局生产策略。固定写前场景解法与 `boundedBestOf3` 已退出生产；普通 raw 是默认基线，候选必须逐章与 raw 比较。
- `METHODOLOGY-STORY-CONTEXT-1`：方法论权限已分为作者/已接受正文/方法论/启发式四类来源与 generation/hard/candidate/review/excluded 五种执行位置。CreativeConstitution 的作品身份、长期承诺、核心冲突和主题问题进入 ChapterContract，`aestheticDirection` 与感官/句式/对白/段落执行规则不进入 raw；无章纲时相关角色按主角与本章叙事信号保守选择，不再灌入全部存量角色。每章 trace 记录 methodology policy 与 raw prompt constraint audit。
- `NARRATIVE-FOCUS-STRATEGIES-1`：post-raw `CraftPhenomenonReport` 增加 `narrative_focus_and_spatial_staging` 第 11 工艺域；只在 opportunityType、craftDomain 与 raw span 兼容时允许 `transition_compression` / `spatial_relationship_staging` / `focal_attention_shift` 三种 candidate-only 策略。它们不进入 raw、不按景别或句长控制正文、不授权候选或 winner。
- gpt-5.6-sol 的 `v2_literary_judge` 已改为 SSE，关系、悬疑、动作三个真实 production-final 运行均完成；但单对比较约 11-15 分钟，尾延迟仍是生产可靠性约束，不能把“传输完成”解释为质量正收益。
- GPT 5.5 / gpt-5.6-sol：`v2_opportunity_judge`、`v2_literary_judge` 等异源判断与结构化节点。
- Doubao Seed 2.1 Pro：受限的 span 驱动中文校准候选，不是 raw 主写，也不是 judge。
- GLM 5.2：只用于显式 `modelTestRoute=glm` 和 NovelBench lab/testing route；生产默认调用数必须为 0。
- Qwen、ERNIE 当前在 `disabled_providers` 中，不得作为可调用生产 fallback 理解。

## 2026-07-19 至 2026-07-20 质量上限证据

- 《心魔界》15 章机器/规则 A/B 与第 18-20 章自然人盲评均为历史实验，只能说明这些样本中的偏好，不能授权其他章节固定采用同一场景结构。15 章报告绝对同档通过率仅 `13.33%`，结论仍是 `NO_GO`。
- `boundedBestOf3` 仅保留为历史评测兼容字段，不再接入公开生产路径。生产只允许机会驱动的 0-2 个 span-supported editorial candidate。
- Gemini v2 已完成 `4` 次 search-depth 尝试：`2` 次满足三候选受控条件，均由 raw 胜出；第二场景候选胜利 `0`、final-gate veto `0`，另外 `2` 次无可引用机会或候选不足。Claude 历史证据同样未显示第二候选正收益。当前状态继续为 `explicit_opt_in_unadmitted`。
- Claude/Gemini 隔离 raw 矩阵的 Claude `10` 胜、Gemini `3` 胜、`5` 无结论/失败仅代表未校准 GPT 裁判输出；完整 production-final challenger 结果同样不能替代人工中文审美。模型比较报告现要求自然人对齐门禁通过后才允许 `recommendedDefault` 非空；当前人类金标样本为 Gemini 胜、GPT 裁判错判 Claude，因此机器矩阵不再产生质量推荐。
- 当前工程已完成单主链路、权威内容契约、机会驱动候选、异源裁判和显式模型选择；固定场景解法与 bounded search 已从生产移除。尚无证据证明系统达到模型能力上限，质量正收益必须继续逐章以 raw 为基线验证。
- `CEILING-CONTINUOUS-CHAPTERS-1` 的第 18-20 章结果保留为历史实验记录：当时自然人选择了 `scene_solution` 序列，但该结果不再具有全局或跨章节生产准入效力。
- 本轮连续实验的匿名人工包位于 `reports/model-comparison/gemini-continuous-ceiling/gemini-limit-continuous-20260720/human-review/`，schema v2 保留 8 维逐章评分、可发布性、预计修改比例、模板重复、AI 腔、连续状态漂移、最终正收益和生产准入字段。后续新的盲测包仍不得提前暴露私有映射。
- 连续实验暴露两项工程结论：其一，历史实验的 `narrative-state-store.json` 对第 18 章只提交了人物 participation，没有提交正文已经发生的“淬腑境”变化；本轮已修复后续生成路径，只有显式 `expectedIrreversibleChange` 同时命中角色、已注册本体层级和变化动词时才暂存 `character.realm`，最终正文还必须完整支持该境界值才提交。B18 只读回放已得到 `character:李一凡:realm=淬腑境初期`、正文 span `122-127`；历史实验状态不追写。其二，未校准 judge 仍同步占用正式交付路径，单章 checkpoint 总时延约 `52-394s`，明显高于 Gemini raw 本身，仍是时延/架构 P1。
- 本轮只确认架构方向与工程回归，不宣称文学质量已经提升。主要质量证据缺口仍是逐章人工偏好、用户实际修改量、冻结集复验、状态提交完整性与绝对可发布率。

## 未完成与阻断

1. `CEILING-BEST-OF-3-1` 已退出生产：Gemini 受控样本中第二候选 `0` 胜，固定候选数不得为凑门槛继续扩大。
2. `CEILING-CONTINUOUS-CHAPTERS-1` 只有一名自然人对一组 3 章序列的整体裁决；该结果不能外推为其他章节类型的生产规则。
3. `CEILING-HUMAN-REVIEW-1` 的机器裁判校准尚未完成：GPT-5.6-sol 与隔离 Gemini reader judge 均曾反向选择 Claude。该证据仍要求继续补足自然人样本、监控误选率，且不能用于推荐全局默认模型；但它不再构成逐章质量选择的全局关闭开关，有效明确的本章比较会选择胜者。
4. gpt-5.6-sol 文学裁判虽已完成连续真实运行，但单对比较尾延迟约 `11-15` 分钟；生产可靠性和严格 JSON schema 长窗口仍需继续治理。
5. G7 最终稿的 Canon/Character/Promise 完整重新派生仍有工程差距；当前不能把 Pattern 以外的空 `StagedStateUpdate` 注入描述成四类状态完整闭环。
6. `final-selector.ts` 虽不在统一生产编排器中，但 `legacy-trace-adapter.ts` 仍导入 `classifyCandidateSource`，需先迁移该依赖再考虑删除。

## 仓库卫生与保护

- 当前工作树包含大量用户/前序代理修改、评测实现、测试和真实模型报告。不得擅自恢复、删除、暂存、提交或覆盖无关改动。
- 当前存在多个 stash；其中包含旧 G7 WIP 和当前模型路由后的 WIP。未获用户明确指示不得 `drop`、`pop` 或改写。
- 不提交 `.env`、API 密钥、真实章节正文或未经授权的付费模型 artifact。
- 原始 `corpus/` 不再属于仓库资产；不要在 README/记忆中继续声称仓库内置 100+ 部小说全文。

## 常用验证

从仓库根目录执行：

```powershell
npm run build
npm run typecheck
npm test
npm run test:eval
npm run smoke
npm run simplicity-gate
git diff --check
```

测试读取编译后的 `dist/`、`dist-eval/`、`dist-test/`，修改 TypeScript 后必须先构建。

2026-07-21 最新验证证据：本轮 `npm run build` 通过；质量赢家策略、路由契约、统一编排与 504 流式回归为 `93/93`；选择核心覆盖率为 line `90.29%`、branch `83.33%`、functions `100%`。全仓 `npm test` 仍被缺失的 `workspaces/xinmo/chapters/chapter-17.md` fixture 阻断（工作区实际只有 `17.md`，其 SHA 与 `raw-manifest.json` 冻结值不一致且不含期望 span；已于 2026-07-23 从 `reports/language-calibration-real-1/chapter-17/raw.md` 备份恢复 canonical `chapter-17.md`，SHA 与 manifest 一致）；`npm run simplicity-gate` 被既有 `v2/core/editorial-candidate-generator.ts` 846 行触发的 800 行门槛阻断，均与本轮选择策略无关。上一轮完整绿色证据为 `2751 total / 2743 pass / 0 fail / 8 skip`。普通 editorial candidate 跟随当前 writer family，默认 Gemini 使用 `v2_amplified_gemini31`。raw 通过 FactGuard 后才加载只读 `MethodologyDiagnosticState`；该状态不进入 raw prompt，排除目标章之后的状态与世界揭示内容，跨章现象和机会必须同时引用 raw span 与快照内合法 `sourceRef`。固定场景规划器、旧多候选生成器、段落节奏硬门与全局场景准入接口已从生产闭包或代码表面物理移除。本地词频/长度扫描只写 diagnostic trace，不能独立授权候选。机会 judge 失败时保留 raw，并通过 `editorialOpportunity.llmFallbackReason` 与模型调用证据留痕；有效明确的逐章 pairwise 结果默认选择质量赢家，pairwise 不可用/不确定则记录对应 `selectionStatus`；置信度候选门槛导出已删除。

### 2026-07-17 测试失败修正

用户先前报告"7 个失败 / 2034 测试"基于基线 `e581aff`。当前 HEAD `e43bc60` 比 `e581aff` 多 3 个 G8 提交（`f4a7efd` RED + `4bf05fe` GREEN release-health-evaluator + `e43bc60` RED release-eligibility-recomputer），新增 37 个测试。重新核查后实际只有 1 个失败：`MODEL-ROUTING-CLAUDE46-1B` 要求 `.env.example` 包含 `CLAUDE_MODEL=claude-opus-4-6`。

根因：用户清理 `.env.example` 时按"model 字段不重复"原则删除了 `CLAUDE_MODEL` 行，但 `CLAUDE_MODEL` 是 `utils/config.ts:650` `modelOverrideEnvMap` 注册的真实运行时 env override（与 `NOVELOS_JUDGE_MODEL` 同类），不是纯文档字段。

修复：`.env.example` 补回 `CLAUDE_MODEL=claude-opus-4-6` 并修正头部注释，明确"env override 类 model 字段在此列示，provider base_url 与默认 model 以 model-routing.json 为准"。修复后 `npm test` 全绿 `2071/2066 pass/0 fail/5 skip`。

用户先前报告的其他 6 个失败（governance-blocker-treatment / preflight-state-store-continuity / story-outline-planner-tool / novelos-m1-eval-harness）在当前 HEAD 均已通过；`novelos-m1-eval-harness.test.mjs` 文件已不存在。

## 真相源优先级

1. `docs/top-tier-chinese-novel-system-development-plan.md`：目标架构与完成定义。
2. `docs/project-memory.md`：当前跨会话快照、保护边界和已知阻断。
3. `docs/remaining-development-dispatch-plan-20260715.md`：任务状态与下一任务。
4. `config/model-routing.json`：模型路由唯一运行时真相源。
5. `AGENTS.md` / `CLAUDE.md` / `README.md`：面向不同使用者的摘要；冲突时服从以上文件和实际代码。
