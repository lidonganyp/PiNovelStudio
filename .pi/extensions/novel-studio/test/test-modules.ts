/**
 * dist-test 测试编译 barrel（LAB-TEST-RUNTIME-1-REPAIR）
 *
 * dist-test 只编译不依赖 legacy-index 的直接测试源模块（craft/outline-*），
 * 不复制 Stage0-8 编排：legacy-index.ts 不在 dist-test 编译范围。
 *
 * LEGACY-RUNTIME-REMOVAL-1 后：legacy-index.ts 已删除，所有原经
 * dist-test/legacy-index.js barrel 暴露的模块均已改为由本文件直接 import 源模块
 * （见下方各 import 块注释），不再存在 dist-test/legacy-index.js 产物。
 *
 * 仅由 tsconfig.test.json 编译到 dist-test/，不进入 dist/（生产闭包）或
 * dist-eval/（eval 闭包）。
 */

// p17 / outline-event-coverage 测试直接消费的源模块
// （曾经由 dist-test/legacy-index.js barrel 暴露，现直接消费源模块）

// Contract 测试集直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1A）
// craft/contract/* 闭包自包含（仅 sibling + node 内建 crypto/path），
// 不依赖 legacy-index / agents / workflow / Stage0-8，可安全纳入 dist-test。

// Speaker Identifier 测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1B）
// craft/speaker-identifier.ts 无源码级 import，完全自包含，可安全纳入 dist-test。

// DAG 引擎测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1C，1D 修正注释）
// 闭包真相（ESM .js 扩展名解析后）：
//   - dag/agent-node.ts → type-only import dag/types.ts（闭包 2 文件）
//   - dag/validator.ts → value import dag/types-helpers.js + type import dag/types.ts（闭包 3 文件）
//   - dag/types.ts 仅依赖外部 @sinclair/typebox
// 闭包全部留在 dag/，不含 legacy-index / agents / workflow / Stage0-8，可安全纳入 dist-test。

// 纯分析模块测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1D）
// 三个模块均 0 import，完全自包含（闭包各 1 文件），可安全纳入 dist-test。

// 配置/注册表模块测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1E）
// 四个模块均 0 import，完全自包含（闭包各 1 文件），可安全纳入 dist-test。

// 纯本地模块测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1F）
// 三个模块均 0 import，完全自包含（闭包各 1 文件），可安全纳入 dist-test。

// 纯本地模块测试直接消费的源模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1G）
// 两个模块均 0 import，完全自包含（闭包各 1 文件），可安全纳入 dist-test。

// 条件触发配置模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1H）
// utils/conditional-triggers.ts 无源码级 import，完全自包含（闭包 1 文件），可安全纳入 dist-test。

// V2 验收判定模块（LEGACY-LAB-TEST-MODULE-MIGRATION-1I）
// v2/core/positive-acceptance.ts 无源码级 import，完全自包含（闭包 1 文件），可安全纳入 dist-test。

// 确定性 craft 模块（LEGACY-DETERMINISTIC-CRAFT-MIGRATION-1）
// 闭包经 dependency-closure-scanner 验证不含 legacy-index / agents / workflow / lab，可安全纳入 dist-test。
// 2 个 forbidden 模块（event-dialogue-allocator / doubao-naturalizer-prompt）经 scene-continuity-gate
// 拖入 agents/entity-candidate-filter，本次跳过，待依赖链解除后另行迁移。

// 质量报告模块（QUALITY-REPORT-MIGRATION-1）
// 闭包经 dependency-closure-scanner 验证不含 legacy-index / agents / workflow / lab，可安全纳入 dist-test。

// 中文网文范式评分模块（NATURALNESS-REPAIR-MIGRATION-1）
// 闭包经 dependency-closure-scanner 验证不含 legacy-index / agents / workflow / lab，可安全纳入 dist-test。
// #4 CRAFT-AGENT-DEPENDENCY-UNTANGLE-1 已解除 scene-continuity-gate→agents/entity-candidate-filter 与
// type-profile-manager→agents/type-router 两条 forbidden 边，下列同簇模块闭包 forbidden 0。

// #4 解依赖后迁移：3 个 craft 模块闭包 forbidden 0（51 唯一模块）。

// LEGACY-SOURCE-OWNER-ZERO-1：从 legacy-index.ts 抽取的 5 个纯 helper。
// 闭包经 dependency-closure-scanner 验证 forbidden 0（无 legacy-index/agents/workflow/lab 依赖），
// 纳入 dist-test 供 7 个测试消费者迁移其 import（不再走 dist-test/legacy-index.js）。
// LEGACY-RUNTIME-REMOVAL-1 后 legacy-index.ts 已删除，本文件直接 import 源模块。

// Phase 2a：narrator.ts 的 Stage 2 纯函数 helper 已抽离到 craft/narrator-stage2-helpers.ts。
// 闭包仅 dag/types + craft/* 兄弟模块（forbidden 0：无 legacy-index/agents/workflow/lab 依赖），
// 独立纳入 dist-test，供后续退役 NarratorAgent 类后测试消费者直接 import（不再经 narrator.js re-export）。

// Phase 2a step 2：narrator.ts 退役为 thin re-export shim 后，原经 narrator.ts 闭包进入 dist-test
// 的 quality-contract-compiler 不再被传递编译；3 个测试消费者直接 import，须显式纳入 barrel。

// 知识检索 / Few-shot 选择器模块（KNOWLEDGE-CRAFT-OWNERSHIP-1）
// 闭包经 dependency-closure-scanner 验证不含 legacy-index / agents / workflow / lab，可安全纳入 dist-test。

// v2 核心 + 适配器 + replay 模块（V2-CORE-MIGRATION-1）
// 闭包经 dependency-closure-scanner 验证不含 legacy-index / agents / workflow / lab，可安全纳入 dist-test。
// 9 入口合计唯一闭包 41 模块 forbidden 0：candidate-comparator(4) / editorial-plan-planner(12) / repair-planner(2) /
// replay-promotion(2) / legacy-diagnostics-adapter(5) / legacy-fewshot-adapter(3) / legacy-state-adapter(3) /
// v2-replay-runner(36) / v2-eval-report(37)。

// LEGACY-LAB-BUILD-DELETE-1 (#10)：原 lab/lab-test-modules.ts barrel 已随 lab/ 目录删除。
// 下列 19 个模块曾在 #9e 加入 lab barrel 以保持原 lab 构建编译；#10 删除 lab 构建后，
// 它们既非生产闭包也非 NovelBench/eval 闭包成员，仅被测试消费，故迁入 dist-test barrel。
// 闭包此前已通过原 lab 构建编译验证（无 legacy-index/workflow 残留阻断），此处维持原状。

// governance-blocker-treatment 测试动态加载 failure-envelope-reporter；该模块原经 eval/replay-runner
// 闭包进入原 lab 构建，#10 后 eval/* 迁往 dist-eval，故在此显式纳入 dist-test 以保留测试可达性。
// 闭包仅 + quality-trace-recorder + failure-envelope，均已在 dist-test。

// EVOLUTION-RELEASE-GOVERNANCE-1A：演进发布治理基础（manifest + 状态机 + 注册表 + 指针存储 + 环境指纹）。
// 5 个模块闭包经审查自包含（仅 node 内建 crypto/fs/path + 同目录 sibling），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// 生产入口（dist/）与 eval 闭包（dist-eval/）在 1A 阶段均不消费本目录——治理基础仅由测试消费，
// 待 1B/1C/生产入口绑定阶段再按需经 tsconfig.prod.json / tsconfig.eval.json 显式纳入对应闭包。
// environment-fingerprint.ts 刻意自包含（不从 novelbench/ 或 eval/ import），满足
// "不得让生产代码依赖 eval 模块" 硬约束。
import "../v2/governance/evolution-release-types.js";
import "../v2/governance/evolution-release-schema.js";
import "../v2/governance/evolution-release-registry.js";
import "../v2/governance/release-pointer-store.js";
import "../v2/governance/environment-fingerprint.js";

// DATA-VERSION-RELEASE-GOVERNANCE DG-1：统一行为身份与 bundleId 派生。
// 纯函数模块（仅 node:crypto + sibling canonicalize），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
import "../v2/governance/behavior-bundle.js";

// DATA-VERSION-RELEASE-GOVERNANCE DG-2：生产级行为快照捕获与独立校验。
// 纯 node 内建（crypto/fs/path/child_process）+ sibling behavior-bundle，
// 不依赖 legacy-index / agents / workflow / lab / novelbench，可安全纳入 dist-test。
import "../v2/governance/behavior-snapshot.js";

// DATA-VERSION-RELEASE-GOVERNANCE DG-4：策略证据按完整行为环境分区。
// 纯函数模块（0 import），不依赖 legacy-index / agents / workflow / lab / novelbench，
// 可安全纳入 dist-test。strategy-policy-store.ts 已 import 本模块进入 dist/ 与 dist-eval/ 闭包；
// 此处显式纳入 dist-test/ 供测试直接 import 分区键派生与污染检测纯函数。
import "../v2/learning/strategy-evidence-partition.js";

// DATA-VERSION-RELEASE-GOVERNANCE DG-5：发布生命周期与权限收敛（纯函数权限决策层）。
// 仅 type-only 依赖 evolution-release-types，不依赖 legacy-index / agents / workflow /
// lab / novelbench，可安全纳入 dist-test。
// 运行时绑定（transitionStatus / pointer switchActive / canary 执行层）由 DG-6 / DG-7
// 完成单一基线迁移时显式接入；本阶段先固化规则并测试。
import "../v2/governance/release-lifecycle-permissions.js";

// EVOLUTION-RELEASE-GOVERNANCE-1B：系统版本代理审批（ReleaseProxyApproval）。
// 4 个模块闭包自包含（仅依赖 1A governance sibling + node 内建），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// 1B 阶段使用 stub caller（不调用真实 gpt5.6-sol）；真实模型调用为 REQUIRES_AUTH。
import "../v2/governance/release-proxy-approval-schema.js";
import "../v2/governance/approval-packet-builder.js";
import "../v2/governance/release-proxy-approval-registry.js";
import "../v2/governance/proxy-approval-caller.js";

// EVOLUTION-RELEASE-GOVERNANCE-1C：proxy-review runner 端到端。
// 闭包经审查自包含（仅依赖 1A/1B governance sibling + node 内建），可安全纳入 dist-test。
// runStubProxyReview 不调用模型（stub only）；runRealProxyReview 无授权卡时抛 REQUIRES_AUTH。
import "../v2/governance/proxy-review-runner.js";

// EVOLUTION-RELEASE-GOVERNANCE-1C：授权卡 + Provider Runner（真实 provider runner 本地 stub 端到端 + 授权边界）。
// 2 个模块闭包自包含（仅依赖 1A/1B governance sibling + node 内建），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// 1C 阶段真实 gpt5.6-sol 调用仍 REQUIRES_AUTH（仅交付授权边界，真实 API 集成为后续工程切片）。
import "../v2/governance/authorization-card.js";
import "../v2/governance/proxy-approval-provider-runner.js";

// EVOLUTION-RELEASE-GOVERNANCE-G6：生产入口发行治理门禁。
// 闭包自包含（仅依赖 1A governance sibling + node 内建），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// 同时也由生产入口（v2/core/unified-entry.ts）import 进入 dist/，实现 G6 生产入口绑定。
import "../v2/governance/production-release-gate.js";

// EVOLUTION-RELEASE-GOVERNANCE-G7：正式章节代理审批（ChapterProxyApproval）。
// schema/registry 切片（3 个模块）+ runner 切片（4 个模块）闭包自包含（仅依赖 node 内建
// crypto/fs/path + sibling 类型导入），不依赖 legacy-index / agents / workflow / lab /
// novelbench，可安全纳入 dist-test。
// 与 1B ReleaseProxyApproval 物理隔离：独立 schemaId / verdict 枚举 / registry 目录，
// 禁止用单章胜负直接证明系统版本晋级，也禁止用 release 审批替代逐章内容审批。
// G7 阶段使用 stub caller（不调用真实 gpt5.6-sol）；真实模型调用为 REQUIRES_AUTH。
// 代理不得直接提交长期状态或覆盖正式章节文件（本模块仅持久化 artifact，不写章节）。
import "../v2/governance/chapter-proxy-approval-schema.js";
import "../v2/governance/chapter-proxy-approval-registry.js";
// G7-Runner 切片：章节级匿名 A/B packet builder + stub caller + executor + 端到端 runner。
// 4 个模块闭包自包含（仅依赖 1B/G7 schema sibling + node 内建 crypto），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// runStubChapterProxyReview 不调用模型（stub only）；runRealChapterProxyReview 无授权卡时抛 REQUIRES_AUTH。
import "../v2/governance/chapter-proxy-approval-packet-builder.js";
import "../v2/governance/chapter-proxy-approval-caller.js";
import "../v2/governance/chapter-proxy-approval-executor.js";
import "../v2/governance/chapter-proxy-approval-runner.js";

// G7-Checkpoint 切片：代理审批稿 pending checkpoint（计划 §6.3 / §12.2）。
// 闭包自包含（仅依赖 node:fs / node:path），不依赖 legacy-index / agents / workflow /
// lab / novelbench，可安全纳入 dist-test。
// 同时由 v2/core/orchestrator-commit-save.ts import 进入 dist/（生产闭包），
// 实现 commitAndSave 守护：用户最终确认前 FinalStateCommit 和正式章节保存均不得执行。
// 落盘到 workspaces/{id}/chapter-approvals/ 隔离目录，不写正式 chapters/。
import "../v2/governance/chapter-proxy-approval-draft-checkpoint.js";

// G7-Finalization：用户定稿操作（accept/accept_with_edits/reject/inspect/rollback）。
// 依赖 draft-checkpoint（clearPendingProxyDraft + getPendingSentinel）+ types（ChapterProxyApprovalArtifact）。
// 已通过 review-surface-cli.ts value import 进入生产闭包（dist/），供 CLI/handler 消费；
// 同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/chapter-proxy-approval-finalization.js";

// G7-Feedback：用户反馈记录器（append-only feedback.jsonl + 代理判断偏差）。
// 闭包自包含（仅依赖 node:fs / node:path）；已通过 review-surface-cli.ts 进入生产闭包（dist/）；
// 同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/chapter-proxy-approval-feedback-recorder.js";

// G7-Finalization-Entry：定稿真实调用链入口（checkCandidateFactGuard -> commitAndSave -> feedback）。
// 依赖 finalization + draft-checkpoint + feedback-recorder + core/orchestrator-factguard + core/orchestrator-commit-save。
// 已通过 review-surface-cli.ts 进入生产闭包（dist/）；同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/chapter-proxy-approval-finalization-entry.js";

// G7-Finalization-Trigger：反馈摄入/健康归集生产触发时机（计划 §0.2 / §12.2）。
// 把 runFinalization -> ingestProxyApprovalFeedbackToStrategy -> aggregateReleaseHealth 封装为
// 单一生产触发入口（用户定稿完成事件）。闭包自包含（仅依赖 governance sibling）。
// 已通过 review-surface-cli.ts 进入生产闭包（dist/）；同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/chapter-proxy-approval-finalization-trigger.js";

// G7-Feedback-Ingestor：用户反馈接入策略证据（计划 §12.2 line 587）。
// 把 feedback.jsonl 中的用户决策记录转化为 UserFeedbackIngestor evidence，
// 写入 strategy-policy.json；闭包自包含（仅依赖 governance sibling + learning sibling）。
// 已通过 review-surface-cli.ts 进入生产闭包（dist/）；同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/chapter-proxy-approval-feedback-ingestor.js";

// G7-Release-Health-Aggregator：release 健康报告归集（计划 §12.2 line 587）。
// 只读聚合 feedback.jsonl + strategy-policy.json 快照，生成 release 健康报告。
// 闭包自包含（仅依赖 governance sibling + learning sibling）；不写入任何文件。
// 已通过 review-surface-cli.ts 进入生产闭包（dist/）；同时保留 dist-test/ 编译供测试直接 import。
import "../v2/governance/release-health-aggregator.js";

// G8-Release-Health-Evaluator：release 健康判定纯函数（计划 §8 Phase G8）。
// 基于 ReleaseHealthReport + 阈值 + 当前 status 判定健康状态与决策建议（不自动执行）。
// 闭包自包含（仅依赖 governance sibling：release-health-aggregator + evolution-release-types + thresholds）；
// 纯函数、无副作用、不调模型、不读写文件。
// 进入 dist-test/ 供测试直接 import；后续 G8 CLI 接入时由 scripts/evolution-cli.mjs 拉入对应闭包。
import "../v2/governance/release-health-thresholds.js";
import "../v2/governance/release-health-evaluator.js";

// G8-Release-Eligibility-Recomputer：strategy revoke 后 release eligibility 重算（计划 §8 Phase G8）。
// 纯函数，检查 strategyReputations 中是否有 revoked 策略，返回 eligibility + suggestedAction。
// 闭包自包含（仅依赖 governance sibling：release-health-aggregator + release-health-thresholds）。
import "../v2/governance/release-eligibility-recomputer.js";

// G8-Release-Health-Actions：auto-hold 执行 + retired 建议生成（计划 §8 Phase G8 §2.5）。
// executeAutoHold 调 transitionStatus("held") + recordStateEvent（带副作用）；
// generateRetiredSuggestion 是纯函数，只生成建议文本不自动执行。
// 闭包自包含（仅依赖 governance sibling：release-health-evaluator + evolution-release-registry）。
import "../v2/governance/release-health-actions.js";

// G5-P1-Bounded-Canary：bounded canary 决策矩阵 + workspace 授权 + trace 存储 + 执行器
// （计划 §G5 line 380-395）。
// 4 个模块闭包自包含（仅依赖 governance sibling + node 内建 crypto/fs/path），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
// G5 P1 READY_LOCAL：不调模型、不生成章节正文、不提交长期状态；
// 仅写 workspacePath/canary-runs/ trace 文件，不触碰正式章节文件；
// bounded_canary 策略必须有显式 workspace 级授权才能执行（REQUIRES_AUTH fail-closed）；
// shadow_required/bounded_canary 均写 shadowPendingRealRun=true 声明性 trace，真实双生成推迟 P2。
import "../v2/governance/canary-policy.js";
import "../v2/governance/canary-workspace-authorization.js";
import "../v2/governance/canary-trace-store.js";
import "../v2/governance/canary-actions.js";
import "../v2/governance/canary-promotion-gate.js";

// EVAL-REPLAY-ACCEPTANCE-LOOP P6：离线回放证据门禁 + fixture 冻结采集。
// 闭包自包含（eval-fixture-contract 零依赖；deterministic-grader 仅依赖 fixture-contract；
// fixture-capture type-only 依赖 governance/evolution-release-types），
// 不依赖 legacy-index / agents / workflow / lab / novelbench，可安全纳入 dist-test。
// eval-evidence-gate 只读不写、绝不修改 production pointer（治理边界与 canary gate 一致）；
// 同时纳入 tsconfig.eval.json 编译到 dist-eval/ 供 eval 基础设施消费。
import "../v2/core/eval-fixture-contract.js";
import "../v2/core/eval-deterministic-grader.js";
import "../v2/core/eval-fixture-capture.js";
import "../v2/core/eval-replay-matrix.js";
import "../v2/governance/eval-evidence-gate.js";

// G7-Finalization-Handler-Prod-Binding：用户定稿消费链 handler（计划 §12.2 line 587）。
// 方案："其他"——保持 6 公开工具契约，通过 novel_workspace_manager action="proxy_finalization"
// 委托 handleChapterProxyFinalization。handler 由 tools/workspace-manager-handler.ts import
// 进入生产闭包（dist/）；同时保留 dist-test/ 编译供测试直接 import。
import "../handlers/chapter-proxy-finalization-handler.js";

// Modules needed by governance/preflight tests via dist-test/
import "../craft/failure-envelope.js";
import "../craft/failure-envelope-reporter.js";
import "../craft/workspace-preflight-checker.js";
import "../craft/quality-trace-recorder.js";

// IMMUTABLE-FACTS-COMPILER-1：本章硬事实编译 + 高影响新设定来源授权检查。
// 闭包自包含（仅依赖 node 内建 + sibling types.js type-only import），可安全纳入 dist-test。
// 同时由 v2/core/orchestrator-factguard.ts import 进入 dist/（生产闭包），
// 实现 FactGuard 接入"高影响新设定来源授权"检查。
import "../v2/core/immutable-facts-compiler.js";

// USER-PREFERENCE-CONSUMPTION-1：用户偏好规则按需检索 + raw/editorial 边界。
// 闭包自包含（仅依赖 node 内建），可安全纳入 dist-test。
// 后续切片由 ContextCompiler / buildRawPrompt / buildEditorialPrompt 接入生产闭包。
import "../v2/core/preference-rule-retriever.js";

// HUMAN-RUBRIC-1 / USER-REVISION-DELTA-1：人工评价契约与用户最终修订证据。
import "../v2/core/human-rubric.js";
import "../v2/core/user-revision-delta.js";
import "../v2/core/real-quality-acceptance.js";
import "../v2/core/methodology-diagnostic-state.js";
import "../v2/core/scene-solution-search.js";
import "../v2/core/prompt-pattern-library.js";
import "../v2/core/positive-gain-candidate-generator.js";
import "../v2/core/candidate-generator.js";
import "../v2/core/scene-contract-planner.js";
import "../craft/anti-ai-auto-patch.js";

// PHASE-0-TOOL-BASELINE-1：工具基线盘点与观测。
// - tools/tool-capability.ts：纯静态能力清单，无运行时引用，仅被测试消费，故显式纳入 dist-test。
// - trajectory/tool-metrics-tracer.ts：已由 agentic-raw-candidate-source 进入 prod 闭包，
//   同时保留 dist-test/ 编译供测试直接 import（Phase 0 观测指标纯函数）。
import "../novelos/tools/tool-capability.js";
import "../novelos/trajectory/tool-metrics-tracer.js";

// MEMORY-RECORD 长期记忆层（MEMORY-2/3/4/5/6）。
// memory-factory / memory-record / memory-transaction / memory-hash 已随
// final-state-commit（生产闭包）进入 dist/；此处补充 memory-compression /
// memory-lifecycle / memory-retrieval / index barrel 到 dist-test/ 供测试消费。
// 闭包自包含（仅 node:buffer + sibling memory-record），不依赖 legacy-index /
// agents / workflow / lab / novelbench，可安全纳入 dist-test。
import "../v2/core/memory/memory-compression.js";
import "../v2/core/memory/memory-lifecycle.js";
import "../v2/core/memory/memory-retrieval.js";
import "../v2/core/memory/index.js";

// CONTEXT-EVIDENCE-GOVERNANCE-1 Wave 0：契约/映射表/A 基线常量。
// 纯类型 + 常量，无 I/O；Wave 0 不进入生产读取/排序路径。纳入 dist-test 供契约测试消费。
import "../v2/core/evidence-governance-contracts.js";

// Marker export to prevent tree-shaking from removing side-effect imports
export const TEST_MODULES_LOADED = true;