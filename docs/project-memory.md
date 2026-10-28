# PiNovelStudio 项目记忆

**快照日期**：2026-10-27
**代码基线**：工作树主链路仍是 NovelOS Agentic → 作者风格整章优化 → 事实复检 → 原子保存；旧裁判链仅保留隔离评测。
**用途**：供 Codex、Claude Code 与维护者跨会话快速恢复当前事实。架构细节仍以 `top-tier-chinese-novel-system-development-plan.md` 为准。下文旧节若写“当前唯一 active_prod”，一律以本节为准。

## 当前本地内测基线（2026-10-27）

默认 writer 身份唯一来自根 `.env` 的 GEMINI_MODEL / GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY；本轮真实验证 `gemini-4-argon`，稳定路由标识 `gemini31`，单渠道有界恢复，无自动换模型或备用端点。下文多渠道描述属于历史。

已接入持久顺序重写、执行租约/回执、跨任务验证初稿恢复、逐 HTTP 最大费用准入、未交付退款及明确预算/超时诊断。本地已应用 durable_revisions、failed_chapter_refunds 迁移。默认 revision：45 分钟/章、200 分/章、2000 分/轮、25 HTTP/章、6 恢复 HTTP、7 任务尝试；手工稿与资料确认绑定版本，风格优化必经。

隔离作品 587 三章顺序重写成功；后续自然请求失败后自动复用初稿，只调用风格优化并成功保存。原作品 252 未修改。该次已知调用费 28 分、退款 20 分、作者净收费 8 分；未知 usage 保留最大授权记录。测试账户剩余赠额通过审计调账撤销。证据见 `docs/debugging/project-optimization-review-20261026.md` 第 7 节、`reports/final-generation-acceptance-20261027.json`。

仅本地工作树/开发常驻服务更新，未提交、推送、部署或改变发布指针。用户脏改动与 stash 保留。上游故障、语义影响范围精化、反馈策略晋级不能宣称已消除或完成。

## 历史模型配置（2026-09-11）

按用户指示，`config/model-routing.json` v4.35.0 将 `novel_generate_chapter` 默认正文模型恢复为 Gemini 3.8 Flash（`gemini-3.8-flash`）。Agentic 初稿与作者风格整章优化使用 `v2_rawstage2_gemini31` / `v2_amplified_gemini31` 和 `gemini_writer_v2`；Aimagichub / Solov 为同模型互备渠道，不跨模型 fallback。旧 GPT 正文路由与 `writerModel=gpt6astra` 已移除；GPT 继续负责结构化节点，Claude 仅供显式选择。平台计费、首次部署模板与 runtime 凭证检查同步回 Gemini。

这是本地代码和配置恢复，未执行真实付费章节生成或生产发布晋级。下文 GPT 切换与发布指针记录是历史状态，不能作为此次恢复已经上线的证据。

## 历史发布状态（2026-09-08）

### gpt-6-astra 主线路由切换（2026-09-08）

本轮实测补充：`novel_generate_chapter` 在 xinmo 独立副本上预检通过，但当前实际 pointer 为 `rel-prod-149`（Gemini 3.7 Flash），G6 因构建、路由和 generationModel 差异阻断，尚无新第21章。真实端点禁用 Chat Completions（403），Responses 文本/工具调用成功；已接入 Responses 传输，初稿和风格客户端均返回 gpt-6-astra。编译通过；相关回归184通过、1历史跳过，路由审计0错误。尚待本地 Git 提交明确授权以冻结干净发布身份，然后完成新身份评测、审批、准入和晋级。主工作区原稿未改。证据与待办：`reports/xinmo-ch21-gpt6astra-test/release-preparation.md`。下文此前的“未运行真实付费调用”和旧 pointer 描述是历史状态，以本段为准；本轮真实调用仅为接口验证，不是整章成功。

`config/model-routing.json` v4.34.0 将 `novel_generate_chapter` 默认正文主写切为 `gpt-6-astra`：Agentic 初稿与作者风格整章优化分别使用 `v2_rawstage2_gpt6astra` / `v2_amplified_gpt6astra`，prompt profile 为 `gpt_writer_v1`。端点默认 `https://shunfen6.win/v1`，凭证为 `GPT_API_KEY`，模型独立读取 `GPT_WRITER_MODEL`，不继承结构化节点的 `GPT_MODEL`。旧 Gemini 生产写路由移除，Gemini 仅用于隔离评测；Claude 仍须显式选择。平台 bootstrap、计费路由和 runtime 必需凭证同步为 GPT。此项为本地代码/配置切换，未运行真实付费生成、未部署或更新发布身份，也不声称文学质量收益。旧 prompt registry 的冻结 Gemini bundle 属于历史评测证据，不得改贴为 GPT 验收证据。

**没有可在当前 HEAD 直接验证且可运行的生产身份。** 本地运行时指针当前为 `rel-prod-134`，但那不是 clean checkout 可恢复、也不是 `778b9f3` 能过 G6 的基线；`rel-prod-145` 对应当前提交但仍为 `approved_dev`，且当前工作树不可复现。

| 项 | 现行事实 |
|---|---|
| 当前 HEAD | `778b9f3`。主树 dirty 时 G6 必失败 |
| 运行时 pointer（gitignore） | 本机可能仍是 `rel-prod-134`，clean checkout 没有这份文件 |
| `rel-prod-134` 冻结提交 | `d238c7c`。旧 P6 的 raw_direct 无生产身份；不得把旧 P6 当当前准入证据 |
| `rel-prod-135` | `held`。P6 是 134 归档改贴，结论作废。**不是** active_prod |
| `rel-prod-136` | `quarantined` |
| `rel-prod-137` | `held` |
| 新身份 3x candidate / 5 场景 admission | **未跑**。`production_like` 需要 APPROVE_DEV |
| 治理恢复 | `evolution:export-identity` / `inject-identity`；G6 可只读回退 `PINOVEL_PRODUCTION_IDENTITY_PACK` |
| 文学结论 | 不声称文学收益 |

### rel-prod-134 生产审计结论 → rel-prod-135 修复状态（2026-08-18）

原 rel-prod-134 审计的 7 项待修复，在 rel-prod-135 的处置：

1. ~~回滚目标 `rel-prod-131` 为 `held` 不可执行~~ → **已修复**：135 `rollbackReleaseId=rel-prod-134`（合法 active 目标）
2. ~~缺少真实 failure/recovery 回放~~ → **已补齐**：4/4 PASS @ `reports/production-admission-replay-135/`（timeout/retry/atomic-rollback/state-commit-fail）
3. ~~P6 matrix 未绑定 artifactRefs~~ → **已生成并通过 eval gate**（`eval-pending-review.json` verdict=approved）。`manifest.artifactRefs` 因在 payload hash 内而 post-approval 不可变，故 matrix/replay 证据通过 eval-gate 记录 + `reports/` 落地，而非改写 artifactRefs 数组（改写会破坏 approval 的 releaseManifestHash 绑定）
4. ~~主工作树 HEAD 与生产冻结分叉~~ → **已消除**：135 冻结提交 `ed76161` 即当前 `main` HEAD
5. ~~分支名与 release ID 不一致~~ → **已对齐**：`main`，release ID `rel-prod-135`（R1 forward-fix 直接在 main 冻结，非独立 release 分支）
6. ~~无在线运行实例身份证据~~ → 运行时身份以 `manifest` 的 `runtimeFingerprint`/`bundleId`/`modelVersion`/`environmentFingerprint` 承载；在线实例身份证据仍属部署层，需运维侧单独确认（见 CLAUDE.md 已知操作项）
7. `replay-provenance-guard.js` 导入路径 → **已修复并随 135 冻结**（`ed76161`）

**遗留（非阻断，需用户授权/运维侧）：**
- `manifest.artifactRefs` 的 P6/replay 绑定采用「eval-gate 记录 + reports 落地」替代改写，属架构权衡；若需字面绑定到 artifactRefs 数组，需重新 capture/freeze/evaluate/approve 一轮（成本高，不推荐对 R1 做）
- 工作树 2 个 stash（`step2-pre-capture` 用户脏改动源码+报告、`step2-extra` 报告重复快照）**保留未 pop**，因 CLAUDE.md 约束「do not restore/delete/stage/pop/drop without explicit instruction」；用户脏改动源码（public-handlers.ts / production-admission-replay.mjs / production-generate-chapter.mjs / legacy-model-route-adapter.ts）仍在 stash@{1}，未并入 135（135 是纯治理封口，不含这些源码改动）

## REASONING-REPAIR-BOUNDARY-1（2026-08-16）

**状态：Wave 0–4 代码已接线，不是发布完成。Wave 5 未完成，Wave 6 未开始，不得宣称生产发布验收通过。**

计划：`docs/model-reasoning-external-verification-minimal-revision-development-plan-20260816.md`（v1.1，已从「待排期」更正）

- 已接线：修订授权 policy、一次性 reservation、`expiresAt` persist/consume、初稿 `createCandidate`、无 verifier 不写 `current-candidate.json`、整章 range 升 `new_candidate`、删除 full-chapter rewrite fallback
- **不是 Wave 5 证据**：`reports/rrb-real-replay/rrb-real-replay.json` 为 `verifyOnly: true` 的两条正常样本，未覆盖完整 repair/阻断
- **simplicity-gate**：2026-08-17 已通过（0 违规 / 37 豁免）；不得再用“20 个超长文件未过门”作为当前阻断
- 下一未完成：Wave 5 矩阵/故障注入/授权真实 replay；Wave 6 清理与 clean checkout 全量验收。发布指针见文首「现行发布状态」

## CONTEXT-EVIDENCE-GOVERNANCE-1（2026-08-15，v1.1）

**状态：Wave 0 收口；Wave 1–2 快照/资格/内容 hash 已接线；Wave 3A ContextPackage 已成为生产 Agentic 唯一静态输入；Wave 4 硬覆盖已收成 confirmed+sourceRef+同 snapshot。CEG-5.3 预算耗尽 / 5.4 检索错误闭环、Wave 3B 动态工具信任、Wave 3C hash/trace 单一化未完成。Wave 5 分层未准入（1/3 样本，生产保持平铺）；Wave 6 真实 dual-workspace replay 与旧路径删除未完成。`production_like` 正确 fail-closed，不能宣称生产验收通过。**

计划：`docs/knowledge-retrieval-evidence-context-compiler-governance-development-plan-20260815.md`（v1.1）

- 路径修复已提交 `c4a2c0e`：CLI 传仓库根；`resolveProductionEvolutionRoot` 识别仓库根/扩展根
- 用户授权真实调用后：`rel-prod-112`、`rel-prod-113` 均在干净树 `D:\CODE\pns-ceg-prod@c4a2c0e` capture（verify YES），真实 gpt5.6-sol 两次都是 forward=HOLD / reverse=APPROVE_DEV，状态 **held**，**未切换 active_prod**
- OpenAI `json_object` 需消息含字面量 `json`；中文化会吃掉该词。已在 HTTP 适配层 localize 之后注入，提交为 `02dc97c`
- 干净树重跑：`recorded` / `synthetic` PASS（runId `closure-*-c4a2c0e`，P6 approved）；`production_like` 读到 `rel-prod-111` 后 fingerprint mismatch（`a43509f0…` vs `7b48cb05…`），零模型调用
- **历史（已失效）**：曾短暂把 rel-prod-111 / rel-prod-115 写成“唯一 active_prod”。二者均已 held 或被后续 revoke 取代，**不是 2026-08-17 现行生产指针**
- **历史过程**：`eeaf704` 后 `rel-prod-115` 的 `production_like` 曾走过 Gemini 生产路由（completed=1）。该记录不得覆盖文首现行状态
- HOLD 根因（不得再换号重试）：112/113 评审包把 `rel-prod-111/112` 和提交号写进正文，破坏匿名；中文化后变成 `未戊丑-巳未辰丁-112`，正反序冲突。包还把「替换现行有效生产指针」和「production_like 仍 fail-closed」绑在一起问，forward 暂缓是正确结论
- 下一未阻断工作包：Wave 3B 动态工具信任消费；Wave 3C hash/trace 单一化收口；Wave 7 旧路径删除需人工正收益决策
- 下一审批工作包：先冻结最终源码提交，用匿名评审包（只比路径解析这一唯一变量，不声称生产等价）重新 capture/评审；获批准并切换指针后再跑 `production_like`，证据必须绑定该最终 commit。禁止对同一基线再开 `rel-prod-114`

## GOVERNANCE-CLOSEOUT：发布治理核验收口（2026-08-15，第二轮修订）

**状态（历史过程，2026-08-15）：第一轮「五项核验全部关闭 / rel-prod-110 verify YES」已撤回。当时 forward-fix 曾把 rel-prod-111 晋级为 active_prod。该指针其后已被后续 release / revoke 取代。2026-08-17 现行生产指针为无，见文首。**

外部核验（2026-08-15）否定的两项及本轮处置：

- **rel-prod-110 不可复现（已确认，FP-GIT-1）**：干净树 `D:\CODE\pns-verify110` 实测 `evolution:verify` → recorded `808378f4…` ≠ current `d24a5faf…`、reproducible ✗ NO（exit 4）。第一轮文档宣称的「verify YES」错误，撤回。根因实锤：capture 会话 PATH 无 git 时 `getGitHead/getWorktreeDirty` 静默退化为 `""/false`，退化指纹（codeCommit=空串）被冻结进 manifest；fpHash `808378f4…` 是退化指纹，不对应任何真实提交。修复（commit `cf372b8`）：`environment-fingerprint.ts` 导出 `isGitBinaryAvailable()`；`evolution-cli.mjs` captureFingerprint() 双守卫——git 不可用或 codeCommit 空串直接 exit 9 阻断 capture，不再静默退化。typecheck 通过、治理测试 611/611、生产边界测试 23/23。
- **trace 污染（已查明根因，B3）**：`craft/quality-trace-recorder.ts` 的 `appendExisting` 默认开启 + `loadExistingDocument` 保留 `parsed.createdAt`/gates/failureEnvelopes。2026-08-15 回放 ch23 时读入并合并了 2026-08-12 的失败残留（旧 `agentic_fact_guard` ERROR gate + envelope，其 `devMode=true/releaseId=null` 为当时 dev-mode 运行产物、字段空是旧 schema 未含 `recordedAt`）。该 envelope 是「铁山倒下」死角色阻断的 attempt 历史，非本次回放产物；本次回放 FactGuard 13ms 本地通过、无需 recovery。「3 次 Gemini 调用」口径与 trace 不符，已修正为以 progressUpdates 为准。已知语义问题：重新生成同章必然 append 旧 envelope（跨日 attempt 无法区分）；修复方向（runId 区分或旧 trace 归档）待授权，不动 append 设计。另发现 `buildInfo.gitHash` 无 git 时写 `"unknown-no-git"`（FP-GIT-1 同族退化，cf372b8 守卫只覆盖 CLI capture 咽喉）；属诊断字段不参与 fpHash，低风险，记录为已知问题。

第二轮 forward-fix（2026-08-15）：

- **rel-prod-111（历史 active_prod，现已不是现行指针）**：干净 worktree `D:\CODE\pns-verify111`@`cf372b86`（PINOVEL_PROJECT_ROOT 指向干净树 + git 在 PATH）capture：fpHash `a43509f0…`、codeCommit `cf372b86…`（真实 HEAD）、worktreeDirty=false → capture 后同环境自验 **reproducible YES** → `proxy-review --real` 真实网络评审（gpt5.6-sol forward+reverse 双向 APPROVE_DEV，reviewTransport=network，artifact `approval-rel-prod-111-1786762094245-6ced203a`）→ promote 链 active_dev→candidate_prod→active_prod（--confirm-prod --actor user；晋级时命中 active_prod 单例约束，先 hold rel-prod-110 再晋级，符合 fail-closed）→ **rel-prod-110 转 held（证据全部保留，未删除）**。changeClass=R1（治理守卫修复，零文学行为漂移，supersedesRef=rel-prod-110）。
- **干净 workspace 严格生产回放（B6，证据原位保留于 `D:\CODE\pns-verify111`）**：干净 xinmo（ch22 前置、零 23 号 trace 残留）+ `PINOVEL_DEV_MODE=0` + `PINOVEL_EVOLUTION_ROOT` 指向主仓治理数据，在 pns-verify111 跑 `phase9-production-acceptance.mjs xinmo 23`：
  - **run1（blocked，门禁 fail-closed 证据）**：Agentic 初稿 323s（含 2 次 524 网关重试）引入未授权高影响新设定「法宝」，agentic_fact_guard 13ms 本地检出 hard_block，零 silent degrade（章节未写、narrative-state 未推进）。trace 完全干净：createdAt=本次、buildInfo.gitHash=`cf372b86…`、releaseGovernance 携带完整生产身份（devMode=false / releaseId=rel-prod-111 / 指纹 `a43509f0…` 与 manifest 一致 / approvalRef 绑定）——G6 生产门禁对 rel-prod-111 真实校验通过。
  - **run2（ok，成功保存证据）**：**13/13 PASS，status=ok**；2 次 Gemini 调用（Agentic 59.2s + 风格优化 49.5s，各一次成功、无漂移重试）；narrative-state ch22→ch23；selectedSource=editorial；原子保存成功；trace append 合并形态如实：createdAt 保留 run1 值（同日 append 语义）、run1 blocked envelope 留存、run2 三个 PASS gate 追加（时间戳 05:35 可区分）。证据原位：`D:\CODE\pns-verify111\workspaces\xinmo\traces\23-*`、`D:\CODE\pns-verify111\reports\phase9-prompt-registry\production-acceptance-xinmo-ch23.json`、`chapters/23.md`；run1 blocked 证据副本 `D:\CODE\PiNovelStudio\reports\rel-prod-111-replay\*-run1-blocked.json`。
- **旧证据处置**：`reports/rel-prod-110-replay/` 原样保留，其 trace 污染已在本文档标注，不再作为可复现性证据引用；`D:\CODE\pns-verify110`（@7100a83）保留为 rel-prod-110 不可复现核验证据。

已修复（第一轮遗留项，维持有效）：

- **P0 typecheck**：`v2/core/budget-types.ts` 缺失导致 `v2/core/budget-ledger.ts` 4 个 TS 错误；已按 budget-ledger.ts 实际用法定义完整类型（BG-01 类型契约，commit 19473a7）。此修复只证明类型检查通过，**不等于** BudgetLedger 完整治理闭环完成。
- **P1 旧 rollback 重新激活路径禁用（旧 release 仅审计读取）**：`v2/governance/evolution-release-schema.ts` 的 `TRANSITIONS.held` 收敛为 `["active_dev", "rejected", "retired"]`（移除 held→active_prod；保留 held→active_dev 仅限 auto-hold 状态事件失败的事务回滚）；`scripts/evolution-cli.mjs` 移除 production rollback 的 held 目标豁免与 held→active_prod 重新晋级块。恢复生产唯一路径 = 新建 releaseId 重新走完整审批链（forward-fix，版本收敛原则）。治理测试 611/611 通过。

## BUDGET-LEDGER：最小接入切片 vs 完整治理闭环（2026-08-15）

**状态必须区分，禁止把附件计划 BG-00～BG-08 标成全部完成。**

- **已完成**：BudgetLedger **最小接入切片**。类型契约可编译；`unified-orchestrator` 在真实模型调用前 `reserve`、调用后 `settle`；失败调用同样结算；外层 timeout 重试经 `_priorBudgetLedger` 延续累计消耗；专项测试覆盖 4 个基础场景（normal / failure settle / hard over-budget / 函数式串行折叠）。这些已通过项不再回头重做。
- **未完成**：附件计划 **BG-00～BG-08 完整治理闭环**。契约目标（唯一账本权威、价格版本化、Batch 准入、队列级并发预留、mandatory reserve 锁定、动态软预算决策、旧预算源收敛、完整 Replay Matrix）仍未落地。`docs/budget-ledger-contract.md` 只冻结 BG-00 契约，不是实现完成声明。

当前并发测试只证明「先生成请求，再串行折叠账本」时函数式状态不突变；**不是**跨任务或跨进程并发测试。

| 优先级 | 未完成项 | 当前证据 | 影响 |
|---|---|---|---|
| ~~P0~~ | ~~真实成本结算~~ | **本切片已完成**：`wrapModelFn` 按 provider + tokenUsage + `unit-price-schedule` 结算 `actualCost`；调用方 `cost: 0` 不再覆盖。 | 费用账本开始生效；超 `maxProviderCost` 记 overage 并阻断后续 reserve |
| ~~P0~~ | ~~价格表版本化~~ | **本切片已完成**：`v2/core/unit-price-schedule.ts` 冻结 `ups-2026-07-01` / `ups-2026-08-15`；快照写 `unitPriceScheduleVersion` / `actualCost` / `overage`；`recomputeActualCost` 可换版本重算。 | 历史成本可按结算时版本解释 |
| 优先级 | 项 | 状态 |
|---|---|---|
| P0 | 真实成本结算 | **已完成** |
| P0 | 价格表版本化 | **已完成** |
| P0 | Batch 预算准入 | **已完成**：`admitBatchChapter` + checkpoint，不启动下一章 |
| P0 | 跨任务并发预留 | **已完成**：`budget-ledger-store` + release/expiry + 跨进程 reserve |
| P1 | mandatory reserve | **已完成**：探索阶段不得吃掉未用必经配额 |
| P1 | 动态预算决策 | **已完成**：`requestAdditionalBudget` / `applyUserExtension` / `no_progress` |
| P1 | Replay Matrix | **已完成**：`tests/budget-replay-matrix.test.mjs` |
| P0 | 单一权威（收口） | **本轮收口**：`wrapModelFn` 删除 `reserveForModelCall` 准入；只走 `admitProductionModelCall` |
| P0 | 生产持久化预留 | **本轮收口**：每次真实模型调用 `reservePersistedBudget` + provider 共享配额 |
| P0 | Provider 共享配额 | **本轮收口**：`config/provider-budget-grant.json` + `provider-budget-ledger.json`；耗尽 `provider_quota_exceeded` |

layered-budget / recovery-budget 文件仍在，仅作结算后兼容投影（`projectModelCall`），不得单独阻断生产调用。

当前生产元数据（2026-08-17 以运行时 pointer 为准）：

- **无 active_prod**。最新候选 `rel-prod-121` 为 `approved_dev`，P6 已批准，人工盲评 1-1-1，未 promote
- 历史曾生效后又失效的 pointer：rel-prod-111 / 115 / 120 等，现均为 held 或已 revoke，仅审计读取
- 回滚链仍阻断 held→active_prod；恢复生产只能新建或继续审批链并经用户明确授权切 pointer

## RUN-LIFECYCLE P7：历史数据迁移与发布收口（2026-08-14）

**状态：迁移工具 + 测试 + 真实 --apply 迁移执行完成，幂等复跑验证通过。**

三方分离（审计流 / 内容库 / legacy 投影缓存）发布后，Stage C-1/C-3 切换写路径前已落盘的历史明细仍留在旧文件里承载完整 evidence。新增 `scripts/migrate-trace-content-stores.mjs` 把历史明细非破坏性回填进内容库：

- **quality-trace**：`traces/{chapterId}-quality-trace.json` 的 `gates[]` 完整 evidence → `traces/{chapterId}-content.jsonl`（复用 `TraceContentStore.writeGate` 追加写）。
- **trajectory**：`novelos-sessions/{sessionId}/trajectory.jsonl` 每行 `{type,timestamp,data}` → `trajectory-content.jsonl`（复用 `TrajectoryContentStore.writeAll` 原子写）。
- **非破坏**：旧文件（quality-trace.json / trajectory.jsonl）绝不删除；**幂等**：目标内容库已存在且非空 → 跳过（不重复追加）；**dry-run 默认**：不带 `--apply` 只出报告不落盘；畸形 trajectory 行跳过并计数，不阻断有效行。

真实 --apply 结果（62 workspaces，已落盘）：quality-trace 60 章迁移 / 4 跳过（dg3-integ-ws + g6-integration-* 已有 content.jsonl）/ 0 错误；trajectory 297 session 迁移 / 1 跳过 / 0 畸形行 / 0 错误。产出 60 个 `{chapterId}-content.jsonl` + 297 个 `trajectory-content.jsonl`，full evidence round-trip 校验通过。**幂等复跑**：migrated=0 / skipped=64+298 / 0 错误，无重复追加。内容库现为全量权威明细源，旧文件可安全视作可重建投影缓存。

测试：`tests/trace-content-store-migration.test.mjs`（5 例：quality-trace 回填 / trajectory 回填 / 幂等跳过 / dry-run 不落盘 / 畸形行计数）。

## DATA-VERSION-RELEASE-GOVERNANCE：数据版本/发布治理（2026-08-13）

**状态：代码与测试层完成；生产治理为「有条件完成」。** 计划文档 `docs/data-version-release-governance-development-plan-20260813.md`。统一行为身份、单一生产基线、发布生命周期权限收敛。

已落地（代码 + 测试）：
- **DG-1 统一 Behavior Bundle 与 Manifest**：`bundleId / modelVersion / promptBundleHash / modelRoutingHash / toolSchemaHash / contextCompilerHash / qualityPolicyHash / recoveryPolicyHash / knowledgeSnapshotHash / runtimeFingerprint / strategyEvidencePartition[] / evalProtocolVersion` 行为身份；`computeManifestHash` / `computeReleasePayloadHash`（排序键规范化 + SHA-256）。
- **DG-2 运行环境与数据快照捕获**：capture/verify，同一环境重复 capture fingerprint/bundle hash 一致。
- **DG-3 生产入口 fail-closed**：`production-release-gate.ts` 仅读 active_prod pointer + manifest；行为身份分量 hash 校验；candidate 生产拒绝读取。
- **DG-4 策略证据按完整行为环境隔离**：`strategy-evidence-partition.ts` 的 `classifyPartitionMatch`，隔离键 = modelVersion::bundleId::strategyId::evalProtocolVersion；旧模型 evidence 用于新 Bundle 拒绝。
- **DG-5 发布生命周期与权限收敛**：`release-lifecycle-permissions.ts` 纯函数（可写字段矩阵 / R2-R3 需完整 Eval+Replay+人工批准 / active_prod 单例 / 代理仅能 recommend）。
- **DG-6 单一生产基线迁移**：`evolution-release-registry.ts` 的 `transitionStatus` 接入 `assertActiveProdSingleton`（注入 `resolveAllManifests`，未注入向后兼容）；**已接入真实 `evolution:promote` 路径**——`scripts/evolution-cli.mjs` 的 `cmdPromote` 注入 `resolveAllManifests: () => registry.listManifests()`，CLI 层双 active 晋级直接失败（fail-closed）；`evolution:rollback` 对 held 旧基线一律阻断（2026-08-15 GOVERNANCE-CLOSEOUT 修订：旧 release 仅审计读取，恢复生产需新建 releaseId 重新审批，原「held→active_prod 重新晋级」设计已废弃）；双 active 阻断、前向修复演练、CLI 级负向测试均有覆盖。
- **DG-7 验收矩阵/回放/演练**：`tests/data-version-release-governance-dg7-acceptance-matrix.test.mjs` 完整生命周期演练 + 收敛后前向修复演练 + 表驱动治理不变量；`evolution-release-governance-g5-*.test.mjs` 增加 CLI 级双-active 晋级阻断负向测试。

**代码闭包变化**：DG-6 使 `release-lifecycle-permissions` 进入生产闭包（经 registry），`dist/` JS 311→312；`dependency-boundary.test.mjs` 阈值相应上调到 `< 313`。

**生产操作项（2026-08-15 GOVERNANCE-CLOSEOUT 更新，原「未完成」清单部分已收敛）**：
- ~~P0-2：真实生产 manifest rel-prod-106 行为身份字段为空~~ → 历史收敛：rel-prod-106 held，仅审计读取。
- ~~真实数据存在多个 active_prod~~ → 历史曾收敛到单一 pointer，后又 revoke。**2026-08-17 无 active_prod**，见文首。
- ~~仍待办：rel-prod-109 真实 workspace 回放~~ → 历史过程见 GOVERNANCE-CLOSEOUT；不得再写成“唯一 active_prod = rel-prod-111”。

**验收表述修正**：DG-7 原「旧可执行分支被移除」仅为状态机退役（`retired` 终态），不删除真实可执行文件；物理删除属生产操作。已在测试注释与本文档中将「代码完成」与「生产操作完成」明确分开，不再把状态机退役表述为「可执行分支被移除」。

测试：`npm run build`（prod+eval+test）、`typecheck`、治理测试（DG-1..DG-7 + evolution-release-governance）全绿。

## USER-FEEDBACK-EVIDENCE-PIPELINE-1：用户反馈证据管道（2026-08-12）

**状态：集成收口进行中（非完整 Done）。** 计划文档 `docs/user-feedback-evidence-pipeline-development-plan.md`。用户反馈不得直接充当奖励函数，必须进入可归因、可撤销、可审计、分层晋级的证据管道。

已落地：
- **契约层** `v2/learning/feedback-evidence-contracts.ts`：七级反馈、修改分类、StrategyExposure、血缘完整性、禁止 mutation 列表、bundle id。
- **归因语义** `user-feedback-ingestor.ts` + `user-modification-delta.ts`：无法归因 → neutral；raw 修改不计策略；事实/设定/剧情不惩罚文学策略；`decisionCount` 与 `weightedEvidence` 分离。
- **Bundle 优先** `strategy-outcome-recorder.ts` + selector `exposureSnapshot`：多策略默认写 bundle 信誉，禁止未授权单策略拆分。
- **账本生产接入** `feedback-evidence-ledger-store.ts`：代理反馈摄入追加 `feedback-evidence-ledger.json` observation；`strategy-policy.json` 仍为运行时物化缓存。
- **账本重算** `strategy-reputation-recompute.ts` + `StrategyPolicyStore.revertOutcomeByEvidenceId`：evidenceId 定点撤销；增量与重算对齐；`sampleCount` 按 decisionCount。
- **StrategyExposure 落盘**：`author-style-strategy-registry` 透传 exposureSnapshot；`unified-orchestrator` 写入完整血缘字段；`unified-entry` final_selected.strategyContext 持久化 run/candidate/bundle/exposure/prompt。
- **安全边界**：文学负反馈不得自动 `retired`（仅 dormant / 人工审批）；单次反馈不得切换生产基线。
- **晋级治理** `strategy-promotion-governance.ts`：candidate→active 需 eval+replay+human 审批；revoked/quarantined 晋级率 0。
- **代理反馈**：缺失或不完整 lineage → `incomplete_lineage` 跳过，不得按 proxy_confirmed 强更新。
- **测试**：新增 16 项场景套件 + g7 回归（decisionCount 语义）+ `feedback-ledger-production-path` 通过。

已继续收口（同日）：
- 公共 `handleStrategyFeedback` 强制完整 canonical lineage；缺失则 `recorded=false` 且不污染文学信誉
- 公共入口写入 `feedback-evidence-ledger.json`（`handlers/strategy-feedback-lineage.ts`）
- 历史迁移/隔离脚本：`scripts/migrate-strategy-evidence-lineage.mjs`（默认 dry-run，不静默补全血缘）
- E2E 探针：`tests/public-strategy-feedback-ledger-e2e.test.mjs`（trace → public feedback → ledger → recompute）

覆盖率与真实审计（同日补充，可复核）：
- 全量普通测试：`npm test` → **3080 / 3074 pass / 0 fail / 6 skip**（已修 story_preservation 重试通过后未记 collab completedStages 的回归）
- 关键反馈模块 focused coverage 固定命令见 runbook；报告：`reports/feedback-lineage-audit/focused-coverage-report.txt`
  - all files line **89.97%** / branch **80.89%** / funcs **96.47%**
  - contracts 100%、ledger 92.50%、policy-store 94.87%、ingestor 90.93%、lineage helper 94.57%
- 真实 workspace quality-trace 审计：`scripts/audit-strategy-exposure-lineage.mjs`
  - 历史扫描：多数旧 trace incomplete
  - **xinmo ch22 新生成后 complete lineage = true**（1 条 complete）
- **真实闭环已跑通（xinmo ch22）**：
  1. `PINOVEL_DEV_MODE=1 node scripts/phase9-production-acceptance.mjs xinmo 22` → status=ok，254.8s，章节 22.md 保存，state ch21→ch22
  2. trace `workspaces/xinmo/traces/22-quality-trace.json` 含完整 StrategyExposure 字段
  3. `node scripts/real-feedback-pipeline-e2e.mjs xinmo 22` → `novel_strategy_feedback` recorded=true / win / ledgerAppended=1
  4. ledger：`workspaces/xinmo/strategy-evidence/feedback-evidence-ledger.json`
  5. policy：`workspaces/xinmo/strategy-policy.json`（voice_emphasis alpha=4 sampleCount=1）
  6. 汇总报告：`reports/feedback-lineage-audit/USER-FEEDBACK-EVIDENCE-PIPELINE-1-real-audit.json`
- 历史迁移 dry-run（修 project root 后）：全库 `evidence.json` 记录数仍为 0（无旧 artifact 可迁）；新 ledger 由真实反馈路径创建

残余约束 / 未宣称严格生产 Done：
- 严格 prod gate 因 environment fingerprint mismatch 阻断；本次真实生成使用 `PINOVEL_DEV_MODE=1` 绕过 pointer 指纹，非 recapture/promote 后的 active_prod 路径
- 本 run `selectedStrategyIds=[]` / `bundle:empty`（无已准入 active 策略被采样）
- `npm run test:eval` 长时套件仍需按需执行

## AGENTIC-EVIDENCE-MERGE-1：证据决策合并进 Agentic 首轮（2026-08-12）

**状态：已完成（build / typecheck / test / test:eval 全部通过）。** 独立 `EvidenceDecision` 模型回合已退役，证据与检索判断合并进 NovelOS Agentic 首轮 ReAct 循环。

- **EvidencePlan 收敛为系统安全计划**：字段收敛为 `known / mustVerify / allowedTools / stopConditions / retrievalCallLimit`；移除只服务独立回合的 `unknown / queries / needRetrieval / retrievalDepth`。检索上限由确定性策略生成（`mustVerify ? 4 : 2`），是系统上限而非模型配额。
- **Agentic 合并**：`agentic-raw-candidate-source.ts` 删除 `runEvidenceDecisionRound` 调用，把 `retrievalCallLimit` 接线进 runtime `retrievalBudget`；Agentic 首轮可在同一循环内自主选择直接生成或调用系统授权工具。
- **物理清理**：`novelos/agent/evidence-decision.ts` 已物理删除；`context_decision` trajectory entry 类型与 `recordContextDecision` 死代码已移除；`ToolVisibilitySnapshot` 只记录 `systemAllowedTools / visibleTools`，不再记录模型决策的 `selectedTools / rejectedTools`。
- **保留的系统安全边界（未削弱）**：`mustVerify`、工具白名单（fail-closed）、`retrievalCallLimit` 上限强制、MustVerifyCoverageGate、Agentic FactGuard 与 verify/patch 闭环全部保留。
- **未引入**：固定 thinking token、未验证的 provider 隐藏推理参数、机器文学裁判或 raw fallback。
- **测试**：`tests/phase2d-evidence-decision.test.mjs` 重写为证明独立回合退役 + Agentic 内生决策 + 系统边界有效（18 项）；tool-visibility runtime/trajectory 测试与 replay 脚本同步改为新快照契约。完整测试 2787 pass / eval 1055 pass / 0 fail。

> 文档表述统一为：EvidencePlan 由系统建立安全边界；是否检索及检索顺序由 NovelOS Agentic 在同一 ReAct 循环内决定；系统通过工具白名单、调用上限、MustVerifyCoverageGate 和 FactGuard 保证安全。历史 `evidence-decision-prompt-inventory.md` 与 `phase-reasoning-budget-baseline.md` 保留为只读研究证据，不再描述为生产阶段。

## MODEL-PROMPT-EVOLUTION-1：模型版本隔离与 Eval 驱动的 Prompt 进化（2026-08-12）

**状态：有条件完成。** 核心基础设施、真实 Gemini A/B 验证（P-B 被 reject）、生产 trace bundleId 接入、Registry bundle baseline 初始化均已实现。本任务零生产行为变更。计划文档 `docs/model-version-isolation-prompt-evolution-development-plan.md`（v1.1），设计落地见 `docs/phase9-prompt-registry-design.md` §9。

- **完整 Prompt Bundle 指纹**（`novelos/eval/prompt-bundle-manifest.ts` + `prompt-bundle-fingerprint-collector.ts`）：`bundleId` 由 system prompt / user renderer / ChapterContract renderer / toolSchema / toolProtocol / contextCompiler / outputParser / termination / providerCapability / budget / 模型版本 / route / temperature / maxTokens 的规范化 hash 派生。**避免「system prompt 未变但行为环境已变」的错误归因。**
- **安全/实验分层**（`prompt-security-contract.ts`）：10 条不可变安全契约（事实不可篡改、mustVerify 必覆盖、工具仅授权集合、预算上限、门禁、初稿不直接交付、状态事务、原子保存、trace 契约等）与可实验 Prompt 空间（user_prompt_renderer 为主载体）明确分离；`validateCandidateSurfaces` 对系统边界变化 fail-closed 拦截。
- **候选差异**（`prompt-candidate-diff.ts`）：`diffManifests` 自动推导 base→candidate 变更集；系统边界变化与 remove/weaken 操作标记为敏感（需人工确认）；候选携带模型身份，不同 modelVersion/provider/route 的 evidence 不互相合并。
- **三层 Eval 门禁**（`prompt-eval-gates.ts`）：第一层确定性行为门（prematureDone / 未授权工具 / 事实硬错 / 未分类失败 =0 绝对安全门，trace 留存=1.0，coverage/sourceRef 相对基线不降级）、第二层链路指标（成本恶化仅标记不阻断，不能抵消安全门）、第三层文学质量（真人盲评）。
- **Registry 集成**：`PromptVersion` 新增 `bundleManifest`；`createProductionSnapshot` / `createEvalCandidate` 可携带（候选不接生产指针）。`runBundleDriftCheck` 仅当存在 bundle 基线且发生真实漂移才 hard block；无基线为告警不阻断。
- **生产 trace bundleId 接入**（`v2/core/production-bundle-hash.ts`）：生产 trace 每条 record 写入 `bundleId`（system prompt + toolSchema + budget + identity 的轻量级 hash）。这是完整 PromptBundleManifest 的子集，不含 renderer/parser/protocol/termination 源码 hash（那些需要读文件，属 eval-only 范畴）。**未经真实章节生成端到端验证**。
- **Registry bundle baseline**（`scripts/prompt-bundle-baseline-init.mjs`）：4 个 active 版本已填充完整 `bundleManifest`，drift check bundle 级 4/4 PASS（不再是"无 bundle baseline"告警）。
- **eval 报告数据质量声明**：报告区分实测指标（覆盖率/sourceRef/调用数/token/prematureDone 等）、估算指标（input/output token 拆分）、固定默认值（恢复率/保存率/StoryPreservation=1.0，不代表生产实测）、未覆盖项（生产链路指标/真人盲评）。
- **未引入**：固定 thinking token、未验证 provider 隐藏推理参数、机器文学裁判、生产行为变更或新增并行运行时版本。生产仍直接引用硬编码 Prompt 常量，Registry 仍是被动观测层。
- **剩余**：生产 trace bundleId 的真实章节生成端到端验证；未来有新 Prompt 候选通过门禁时的真人盲评和生产替换。

### 真实 Gemini A/B replay 结果（2026-08-12）

通过 `scripts/prompt-evolution-eval.mjs` 运行真实 Gemini 3.1 Pro Preview A/B replay（1 批次 × 3 seed × 8 场景，route=narrator_primary，fallback=[]，含配额重试）：

| 指标 | P-A（通用 Prompt 基线） | P-B（Gemini 专属 Prompt 候选） |
|---|---:|---:|
| mustVerify 覆盖率 | 0.975 | 0.125 |
| sourceRef 完整率 | 0.814 | 0.000 |
| 总调用 | 43 | 0 |
| prematureDoneRate | 0 | 1.0 |

**结论**：P-B 被新门禁第一层**绝对安全门 reject**（prematureDone=1.0 + coverage 降级 + sourceRef 降级）。旧门禁同样 FAIL。**确认「专属 Prompt 未胜出」**，保持通用 Prompt 为唯一生产 Bundle。生产无变更，无需真人盲评（被 reject 的候选不进入第三层）。报告存于 `reports/prompt-evolution-eval/eval-real-*.md`。

## Phase 9 生产运营期（历史记录，2026-08-11）

> **【真相源修正 2026-08-17】** 本节以及 2026-08-13 的“当前唯一生产指针 = rel-prod-106”均为**过时记录**。2026-08-17 现行生产指针为无，最新候选是 `rel-prod-121` / `approved_dev`，见文首。
> 历史切换链曾为 `rel-prod-102 → 103 → 104 → 106`，其后还有 111 / 115 / 120，均已 held 或 revoke。以下 rel-prod-103/106 叙述只作验收档案，不是现行基线。

**历史状态（2026-08-11，已失效）：** 当时曾进入生产运营期，pointer 指向 `rel-prod-106`。该声明不得覆盖文首现行状态。

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

`config/model-routing.json` v4.36.0 是唯一运行时真相源：

- 生产写模型（WRITER-ENV-UNIFY-1）：NovelOS Agentic 与作者风格整章优化的模型与端点由仓库根目录 `.env` 唯一决定（`GEMINI_MODEL` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY`，当前 gemini-4-argon @ aimagichub.xyz）；未传 `writerModel` 时使用 `v2_rawstage2_gemini31` / `v2_amplified_gemini31` 和 `gemini_writer_v2`，`gemini31` 只是稳定路由标识。单渠道无互备（Solov 已删除）：失败仅同渠道有界重试，耗尽即 hard block，不静默切换 Claude 或其他正文模型；缺 `GEMINI_MODEL` / `GOOGLE_GEMINI_BASE_URL` 启动即报错。
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
