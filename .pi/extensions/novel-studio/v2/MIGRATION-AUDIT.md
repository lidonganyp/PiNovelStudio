# P11 迁移旧资产审计报告

> 版本：v2-stub | 日期：2026-07-08
> 规格：`delete/V2质量放大器内核.md` P11「迁移旧资产，不迁移旧控制权」
> **spec 已遗失**（2026-07-16）：`delete/` 目录被 `.gitignore` 忽略且从未被 git 跟踪，SLIMDOWN 清理时遗失，内容不可恢复。本审计报告保留规格引用以维持审计痕迹；P11 设计原则已沉淀于 `docs/top-tier-chinese-novel-system-development-plan.md` 与本文件正文。
> 范围：V2 Quality Amplifier 内核（`.pi/extensions/novel-studio-v2/`）

## 设计原则

P11 的核心是「迁移资产，不迁移控制权」：

- **保留为 library**：13 类资产作为只读/分析能力被 V2 复用，通过 adapter 接入
- **废掉或降权**：7 类资产的 rewrite authority 在 V2 内不被调用

---

## 一、13 类保留资产接入状态

| # | 资产 | 接入方式 | V2 文件 | 状态 |
|---|------|----------|---------|------|
| 1 | workspace/config/角色状态 | `loadWorkspace` + `loadCharacterProfiles` | [legacy-workspace-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-workspace-adapter.ts) | ✅ 已接入 |
| 2 | ChapterSeed | `loadChapterSeed` → `buildChapterSeed`（legacy） | [legacy-workspace-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-workspace-adapter.ts) | ✅ 已接入 |
| 3 | skeleton | ContextCompiler 从 `skeleton.json` 加载 `previousChapterContinuation` + `candidateAnchors` | [context-compiler.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/core/context-compiler.ts) | ✅ 已接入 |
| 4 | detail ledger | ContextCompiler 从 `ChapterSeed.unsettledDetails` 加载 openLoops | [context-compiler.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/core/context-compiler.ts) | ✅ 已接入 |
| 5 | entity checker | `createEntityCheckerProvider`（hard-block 白名单） | [legacy-diagnostics-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-diagnostics-adapter.ts) | ✅ 已接入 |
| 6 | continuity checker | `createSceneContinuityProvider` + `createSkeletonConsistencyProvider` | [legacy-diagnostics-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-diagnostics-adapter.ts) | ✅ 已接入 |
| 7 | anti-AI scanner | `createAntiAiDetectorProvider`（review severity） | [legacy-diagnostics-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-diagnostics-adapter.ts) | ✅ 已接入 |
| 8 | 翻译腔 scanner | `createChineseNaturalnessProvider`（review severity） | [legacy-diagnostics-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-diagnostics-adapter.ts) | ✅ 已接入 |
| 9 | few-shot | `loadFewshotExamples` → `FewshotSelector`（legacy），通过 `fewshotLoader` 回调注入 CandidateGenerator | [legacy-fewshot-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-fewshot-adapter.ts) | ✅ P11 新接入 |
| 10 | 风格指纹 | `loadStyleProfile` → `StyleReference` (kind=fingerprint) | [legacy-workspace-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-workspace-adapter.ts) + [context-compiler.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/core/context-compiler.ts) | ✅ 已接入 |
| 11 | replay matrix | V2 原生 `V2ReplayRunner`（6 类候选矩阵） + `scripts/model-ab-ch17.mjs` 复用 | [v2-replay-runner.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/replay/v2-replay-runner.ts) | ✅ V2 原生 |
| 12 | trace recorder | `createLegacyTraceAdapter` stub（P15 完整实现委托 legacy `QualityTraceRecorder`） | [legacy-trace-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-trace-adapter.ts) | ⚠️ P11 stub，P15 完整 |
| 13 | model routing | `createLegacyModelGenerateFn` → `callWithFallback`（legacy） | [legacy-model-route-adapter.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/adapters/legacy-model-route-adapter.ts) | ✅ 已接入 |
| 14 | PatchQualityComparator 思路 | 提取为 6 个独立 regression-check 函数 | [regression-checks.ts](file:///d:/CODE/PiNovelStudio/.pi/extensions/novel-studio-v2/core/regression-checks.ts) | ✅ P7 已接入（提取而非直用） |

**接入小结**：13/13 全接入（#12 trace recorder 为 P11 stub，P15 完整实现已规划）。

### Adapter 文件清单

V2 通过 4 个 adapter 文件隔离 legacy 依赖：

```
adapters/
├── legacy-workspace-adapter.ts      # #1,2,10 workspace/ChapterSeed/角色/风格
├── legacy-diagnostics-adapter.ts    # #5,6,7,8 4 类 scanner + 11 类其他诊断
├── legacy-model-route-adapter.ts    # #13 model routing
├── legacy-fewshot-adapter.ts        # #9 few-shot（P11 新增）
└── legacy-trace-adapter.ts          # #12 trace recorder（P11 stub，P15 完整）
```

---

## 二、7 类废权资产在 V2 内的调用状态

| # | 废权资产 | V2 内调用情况 | 验证 |
|---|----------|---------------|------|
| 1 | 固定 Stage0-8 作为主架构 | V2 不调用 `novel_generate_chapter` legacy 编排器；用 ContextCompiler → SceneContractPlanner → CandidateGenerator → DiagnosticSuite → CandidateComparator → FinalSelector 替代 | ✅ 无调用 |
| 2 | Stage8→Stage2 默认整章回环 | V2 不 import `stage8-stage2-loopback`；RepairPlanner 默认 `no_op`，`chapter_rewrite` 仅 catastrophic 证据下产出且需 comparator 胜出 | ✅ 无调用 |
| 3 | StyleShaper 自动覆盖正文权 | V2 不 import `style-shaper`；风格通过 `StyleReference` (kind=fingerprint) 作为 prompt 参考注入，不改写正文 | ✅ 无调用 |
| 4 | 对话比例硬门禁 | V2 不 import `chapter-dialogue-ratio-gate`；promptProfile 审计强制 `containsDialogueRatio===false`，control 型 prompt 不发送 | ✅ 无调用 |
| 5 | 段落节奏硬门禁 | V2 不把 `analyzeChapterParagraphRhythm` 作为 gate 调用；仅在 `regression-checks.ts` 作为纯分析函数用于 candidate comparator 的 antiRegression 维度 | ✅ 仅分析用 |
| 6 | 未经 replay 证明的 runtime rule 强制执行权 | V2 加载 `validated-craft-rules.json` 仅作为 `context_hint`（candidate_experience fact）+ ReplayPromotion 状态机输入；不作为强制规则注入 prompt | ✅ 仅上下文提示 |
| 7 | "测试通过 = 小说质量提升"验收口径 | V2 验收必须对比 direct/rawStage2/legacy/v2 amplified 四类基线 + 人工盲评；build/test 通过不等于质量提升 | ✅ 验收口径已重写 |

**废权小结**：7/7 全部在 V2 内无 rewrite authority 调用。

### 关键防污染机制

1. **promptProfile 审计**：CandidateGenerator 在发送 prompt 前审计，control 型 prompt（含对白比例/段落长度/控制清单指令）直接拒绝发送 → 防止 #3, #4 污染
2. **DiagnosticProvider 白名单**：仅 6 类 hard-block provider 可发 fatal/hard；其余 9 类只能发 review/info → 防止旧 gate 越权触发整章重写
3. **RepairPlanner 默认 no_op**：修订优先级 `no_op → sentence_patch → paragraph_patch → bridge_patch → event_patch → event_rewrite`，`chapter_rewrite` 仅 catastrophic 证据 → 防止 #1, #2
4. **PatchQualityComparator 唯一补丁权威**：所有修订必须 A/B 胜出原文才覆盖；退化改写 `accepted=false` 时原文不被覆盖 → 防止 #3
5. **runtime rule 仅作 context_hint**：ReplayPromotion 状态机要求 `sampleSize>=3 && winRate>=0.55` 才晋级为 validated；未晋级规则不强制执行 → 防止 #6

---

## 三、测试覆盖

P11 阶段新增 14 个测试：

- `tests/legacy-fewshot-adapter.test.mjs`：6 测试（空 sceneType、异常吞掉、StyleReference kind、prompt block 措辞、截断）
- `tests/legacy-trace-adapter.test.mjs`：8 测试（record/flush/size、目录创建、自定义 fileName、多记录、写入失败不抛异常）

V2 全量测试：**176 tests, 175 pass, 1 pre-existing failure**（xinmo fixture 工作区状态漂移，与 P11 无关）。

---

## 四、遗留与后续

| 项 | 状态 | 后续任务 |
|----|------|----------|
| trace recorder 完整集成 | P11 stub（最小可写） | Task 15：legacy-trace-adapter 委托 `QualityTraceRecorder` + `QualityTraceDocument` schema 扩展 |
| few-shot 在编排器中激活 | 已在 V2ReplayRunner 注入 | Task 14：V2 编排器完整实现时同样注入 |
| few-shot 检索维度扩展 | 当前仅按 sceneType | 可选：加入 narrativeBeat / conflictLevel / outlineIntent 维度（legacy 已支持） |

---

## 五、结论

P11 迁移完成：

- **13 类保留资产全接入** V2（#12 trace recorder 为 stub，P15 完整）
- **7 类废权资产在 V2 内零 rewrite authority 调用**
- 4 个 adapter 文件隔离 legacy 依赖，V2 主流程不直接 import legacy 业务模块
- 防污染机制（promptProfile 审计 + DiagnosticProvider 白名单 + RepairPlanner 默认 no_op + PatchQualityComparator 唯一权威）多层防御
- 14 个新测试 + 全量 176 测试验证（175 pass + 1 pre-existing fixture failure）

满足规格 P11 验收口径：「13 类保留资产全接入，7 类废权资产在 V2 无调用」。
