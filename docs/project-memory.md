# PiNovelStudio 项目记忆

**快照日期**：2026-07-21  
**代码基线**：`e43bc60`（含 G8 RED+GREEN：release-health-evaluator + release-eligibility-recomputer 测试先行）  
**用途**：供 Codex、Claude Code 与维护者跨会话快速恢复当前事实。架构细节仍以 `top-tier-chinese-novel-system-development-plan.md` 为准，任务状态仍以 `remaining-development-dispatch-plan-20260715.md` 为准。

## 当前架构

- 章节生成只有 `novel_generate_chapter` 一个公开入口，运行时只有统一主链路：`raw → editorial opportunity → 0-2 candidates → heterogeneous pairwise judge → selection → final recheck → state commit → atomic save`。
- legacy Stage0-8 正文编排已经物理删除；生产 `dist/`、评测 `dist-eval/`、测试 `dist-test/` 由三个 tsconfig 隔离。
- 生产严格保留 6 个公开工具。代理审批定稿通过 `novel_workspace_manager` 的 `proxy_finalization` action 消费，不新增第 7 个公开工具。
- raw 是内部基线与安全回退。Gemini 自由生成 raw；只有存在 raw span 证据的编辑机会时才生成 0-2 个 candidate。固定场景搜索不进入生产，机器文学裁判在自然人对齐前只提供 advisory evidence，不能替换 raw；长期叙事状态只允许依据最终选定正文提交。

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

`config/model-routing.json` v4.29.0 是唯一运行时真相源：

- Gemini 3.1 Pro Preview：默认 raw 正文与普通 editorial candidate 主写；未传 `writerModel` 时使用 `v2_rawstage2_gemini31` / `v2_amplified_gemini31` 和 `gemini_writer_v2`。`fallback=[]`，失败 hard block，不静默切换 Claude 或其他正文模型。
- Claude Opus 4.6：通过显式 `writerModel=claude` 使用独立 raw/editorial 路由；继续负责正式 StyleShaper、Stage 8 final gate 与 character_agent，不是 Gemini 的自动 fallback。
- 默认切换依据：2026-07-20 自然人直接对比明确选择 Gemini，认为其中文感、小说语感、场景沉浸明显高于 Claude。同一保存样本的 GPT 5.6 正反复判误选 Claude；加入读者体验主判后仍未对齐；隔离 Gemini reader judge 也误选 Claude。因此两个 AI judge 都未通过当前自然人金标，文学输出只作事实、结构、span 和风险证据，不能自动覆盖 Gemini raw。自动双写和跨模型候选位仍未准入。
- `AUTHORITATIVE-CONTENT-FREE-EXPRESSION-1`：第 18-20 章的一次序列偏好仅保留为历史实验，不再外推为全局生产策略。固定写前场景解法与 `boundedBestOf3` 已退出生产；普通 raw 是默认基线，候选必须逐章与 raw 比较。
- `METHODOLOGY-STORY-CONTEXT-1`：方法论权限已分为作者/已接受正文/方法论/启发式四类来源与 generation/hard/candidate/review/excluded 五种执行位置。CreativeConstitution 的作品身份、长期承诺、核心冲突和主题问题进入 ChapterContract，`aestheticDirection` 与感官/句式/对白/段落执行规则不进入 raw；无章纲时相关角色按主角与本章叙事信号保守选择，不再灌入全部存量角色。每章 trace 记录 methodology policy 与 raw prompt constraint audit。
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
3. `CEILING-HUMAN-REVIEW-1` 的机器裁判校准尚未完成：GPT-5.6-sol 与隔离 Gemini reader judge 均曾反向选择 Claude。至少补足 3 个自然人样本并通过一致率门槛前，机器胜率只能作诊断，不能自动选择文学候选或推荐默认模型。
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

2026-07-21 最新验证证据：`npm run build`、`npm run typecheck`、`npm run simplicity-gate` 通过；方法论故事上下文与表达自由聚焦套件 `46/46`；完整 `npm test` 为 `2777 total / 2769 pass / 0 fail / 8 skip`。固定场景规划器、旧多候选生成器、段落节奏硬门与全局场景准入接口已从生产闭包或代码表面物理移除。本地词频/长度扫描只写 diagnostic trace，不能独立授权候选；机会 judge 失败时保留 raw。机器文学自动选择默认 fail-closed，只有显式通过自然人对齐授权时才可开启；置信度候选门槛导出已删除。

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
