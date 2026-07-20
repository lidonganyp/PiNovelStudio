# MODEL-ROUTING-CLAUDE46-1 — Claude Opus 4.6 生产主力路由切换派工卡
**日期**：2026-07-17
**总状态**：`COMPLETE_L0`（1A/1B/1C/1D 完成）/ `REQUIRES_AUTH`（1E 真实模型 canary）
**开发负责人**：1A/1B/1C/1D 已完成
**验收负责人**：Codex
**架构真相源**：`docs/top-tier-chinese-novel-system-development-plan.md`
**唯一章节入口**：`novel_generate_chapter`
## 1. 决策与目标态
本任务把统一主链路的模型职责调整为：
| 能力 | 正式模型 | 约束 |
|---|---|---|
| raw 正文生成 | Claude Opus 4.6 | 唯一正式主写；失败时 hard block，不静默切换其他正文模型 |
| 普通 editorial candidate | Claude Opus 4.6 | 仅有 span 支持的编辑机会时生成 0-2 个候选 |
| 中文校准 candidate | Doubao Seed 2.1 Pro | 仅处理有正文 span 证据的翻译腔、中文不自然、对白口吻问题；只能作为候选 |
| opportunity judge | GPT 系异源 judge | 不得由 Claude 或 Doubao 自审 |
| pairwise judge / reverse review | GPT 系异源 judge | 匿名 A/B、反向复判、span 证据；冲突或失败保留 raw |
| GLM 5.2 | 开发验证 | 只允许显式 `modelTestRoute=glm` / NovelBench lab route；不得进入生产默认或 fallback |
所有 Claude 路由统一切换到配置模型 ID `claude-opus-4-6`。如果当前服务端实际模型 ID 不同，开发不得猜测或静默替换；应提交端点支持证据并报告 blocker，由用户确认准确 ID 后继续。
## 2. 不变量
1. 不新增第二条生成主链路，不恢复 `legacy | quality_amplifier_v2` 双模式。
2. 不新增公开章节生成入口；正文仍只能由 `novel_generate_chapter` 产生。
3. raw 永远是基线。编辑、校准、裁判失败或结果不明确时保留 raw。
4. Doubao 校准文本不得直接覆盖 raw；必须经过 FactGuard、语言风险复检、匿名 pairwise judge 和 SelectionPolicy。
5. Claude 不得同时担任同一候选对的生成者和文学裁判。
6. GLM 不得因缺路由、未知路由或 fallback 配置错误被生产链路隐式选中。
7. 模型版本变化后，策略信誉继续按 `modelVersion + strategyId` 隔离；不得继承 Doubao/Claude 4.8/GLM 的旧信誉分区。
8. 不修改用户 `.env`、密钥、base URL 或现有私有凭据；只允许更新 `.env.example` 和代码内非秘密默认值。
## 3. 子任务 A：路由契约与 fail-closed 修复
**任务 ID**：`MODEL-ROUTING-CLAUDE46-1A`
**状态**：`COMPLETE_L0`（RED `20bd860` / GREEN `85242c5`）
### Objective
把生产 generation、judge、开发验证三类调用从隐式 provider 推断改为可审计的显式路由，并消除“未知 route 默认落到 GLM”的生产风险。
### Scope
- `config/model-routing.json`
- `.pi/extensions/novel-studio/api/fallback-manager.ts`
- `.pi/extensions/novel-studio/utils/config.ts`
- `.pi/extensions/novel-studio/v2/adapters/legacy-model-route-adapter.ts`
- `.pi/extensions/novel-studio/v2/core/unified-entry.ts`
- `.pi/extensions/novel-studio/v2/core/unified-orchestrator.ts`
- `.pi/extensions/novel-studio/v2/core/orchestrator-types.ts`
- 相关路由测试
### Required Changes
1. 新增或补齐下列生产路由，路由对象必须显式包含 `provider`、`model`、`fallback`：
   - `v2_rawstage2` → Claude / `claude-opus-4-6` / `fallback=[]`
   - `v2_amplified` → Claude / `claude-opus-4-6` / `fallback=[]`
   - `v2_chinese_calibration` → Doubao / `doubao-seed-2-1-pro-260628` / `fallback=[]`
   - `v2_opportunity_judge` → GPT 异源 judge / `fallback=[]`
   - `v2_literary_judge` → GPT 异源 judge / `fallback=[]`
2. `fallback-manager` 必须优先消费 route-level `fallback`；只有路由未声明该字段时才能继承 provider-level fallback。
3. 未知 route、缺失 `agent_routing`、缺 provider 或缺 model 时必须返回结构化配置错误并 fail closed；禁止再默认返回 GLM。
4. 为生产正文路由增加 provider allowlist：
   - `v2_rawstage2`、`v2_amplified` 只允许 `claude`
   - `v2_chinese_calibration` 只允许 `doubao`
   - judge 路由只允许配置的异源 judge provider
5. `modelTestRoute=glm` 继续使用 `nb4_generate_glm + nb4_judge_glm` 双轨锁定，且只能由显式开发参数触发。
6. 默认生产路径必须显式传入独立的 `generationModelGenerate` 与 `judgeModelGenerate`，不能再让两者仅靠同一个默认函数隐式分流。
7. trace `modelCalls` 必须记录语义 route、实际 requestedRoute、provider、model 和 failurePhase，能够证明生成与裁判异源。
### RED Tests
先增加失败测试，至少覆盖：
- 未知 route 不再落到 GLM，而是抛出配置错误。
- 生产 raw/editorial 路由不能调用 Doubao、GLM 或 GPT。
- 中文校准路由不能调用 Claude、GLM 或 GPT。
- judge 路由不能调用 Claude、Doubao 或 GLM。
- route-level `fallback=[]` 时 provider-level fallback 不得生效。
- 默认生产调用的 generation/judge trace provider 不同。
- 显式 `modelTestRoute=glm` 时所有生成和判断调用仍锁定 GLM，且 `fallback=[]`。
### Acceptance
- 所有生产 route 都能从 `agent_routing` 唯一解析到预期 provider/model。
- 未知 route 的实际 API 调用次数为 0。
- GLM 只出现在命名明确的 testing/lab route 中。
- `modelCalls` 可证明 Claude generation 与异源 judge 分轨。
- 不改变 raw fallback、FactGuard、最终状态提交和原子保存语义。
## 4. 子任务 B：Claude 4.6 全项目 Claude 路由切换
**任务 ID**：`MODEL-ROUTING-CLAUDE46-1B`
**状态**：`COMPLETE_L0`（RED `cc5fe6b` / GREEN `d3cc205`）
### Objective
把项目中仍在正式使用或显式测试的 Claude Opus 4.8 配置统一迁移到 Claude Opus 4.6，并让统一主链路以 Claude 4.6 生成 raw 与普通 editorial candidate。
### Scope
- `config/model-routing.json`
- `config/model-routing.recommendation.json`（只更新当前事实或明确标成历史，不得伪造实验结论）
- `.env.example`
- `AGENTS.md`
- Claude 路由相关单元测试
### Required Changes
1. 更新 `providers.claude`、`providers.claude_backup` 的显示名和默认 model。
2. 更新所有实际 Claude route 的 model，包括但不限于：
   - `narrator_primary`
   - `narrator_testing_claude`
   - `style_shaper`
   - `stage5_style_shaper`
   - `stage8_final_gate`
   - `character_agent`
   - `v2_direct_claude`
   - `v2_rawstage2`
   - `v2_amplified`
3. `model_strategy.narrator_primary` 改为 `claude-opus-4-6`；`best_of_n_config` 不得继续把 Doubao 声明为唯一正式正文模型。
4. 更新 `model_analysis`、迁移说明和人类可读路由摘要，删除“Doubao 是 Stage 2 正式主写”的当前态陈述；历史 migration note 可保留但必须明确为历史。
5. `.env.example` 增加 `CLAUDE_MODEL=claude-opus-4-6`；不得修改真实 `.env`。
6. 更新所有硬编码断言，禁止仅做字符串批量替换而遗漏 provider/allowlist/fallback 语义。
### Acceptance
- 非历史说明、冻结 artifact 和测试 fixture 中，不再存在把 `claude-opus-4-8` 当作当前正式模型的断言。
- 默认 raw 和普通 editorial 的实际 modelVersion 为 Claude Opus 4.6 分区。
- Claude 4.6 不继承 Claude 4.8、Doubao 或 GLM 的策略信誉。
- 生产正文路由失败时 hard block 或保留已存在 raw，不静默切换其他正文模型。
## 5. 子任务 C：Doubao span 驱动中文校准候选
**任务 ID**：`MODEL-ROUTING-CLAUDE46-1C`
**状态**：`COMPLETE_L0`（RED `a4fb78c` / GREEN `e6f2b66`）
### Objective
把 Doubao 从正文主写降为受限中文校准器：只有存在可引用 raw span 的中文语言风险时才生成局部候选，并由异源 judge 决定是否值得替换 raw。
### Scope
- `.pi/extensions/novel-studio/v2/core/language-risk-library.ts`
- `.pi/extensions/novel-studio/v2/core/editorial-opportunity-judge.ts`
- `.pi/extensions/novel-studio/v2/core/editorial-hypothesis.ts`
- `.pi/extensions/novel-studio/v2/core/editorial-strategy-registry.ts`
- `.pi/extensions/novel-studio/v2/core/editorial-candidate-generator.ts`
- `.pi/extensions/novel-studio/v2/core/regression-checks.ts`
- `.pi/extensions/novel-studio/v2/core/unified-orchestrator.ts`
- 相关 trace/types/tests
### Required Changes
1. 复用现有 `LanguageRiskLibrary` 的 `riskId + span + confidence + suggestedScope` 证据，不新增无证据的全章自然化开关。
2. 只有 `voice_and_naturalness` 类 hypothesis 且至少一个有效 raw span 时，才允许选择 `v2_chinese_calibration`。
3. 校准 prompt 只允许修改证据 span 及必要的最小邻接上下文；禁止整章自由重写、改剧情、改事实、改人物动机或补新事件。
4. Doubao 输出仍是普通 editorial candidate，必须依次经过：
   - candidate completeness
   - FactGuard / StoryPreservation
   - `evaluateChineseNativeRewriteAllowance`
   - 语言风险 before/after 对比
   - 匿名 pairwise judge + reverse review
   - SelectionPolicy
5. 校准候选至少满足：目标风险不增加、总翻译腔命中数不增加、无新增 critical issue、无事实退化；否则拒绝并保留 raw。
6. 没有有效 span、Doubao 超时/失败、输出越界、judge 冲突或无明确胜出时，均不得覆盖 raw。
7. trace 必须记录：触发 risk spans、route/provider/model、修改范围、before/after 风险、拒绝原因和最终选择。
### RED Tests
- 无语言风险 span 时 Doubao 调用次数为 0。
- 只有普通结构/角色编辑机会时，candidate 仍由 Claude 4.6 生成。
- 有翻译腔 span 时仅对应候选走 Doubao。
- Doubao 整章重写或修改 span 外文本时被拒绝。
- 校准后翻译腔命中增加时被拒绝。
- Doubao 候选胜出但 judge 证据缺 span 时仍保留 raw。
- judge 正反两轮冲突时保留 Claude raw。
### Acceptance
- Doubao 永远不是默认 raw provider。
- Doubao 永远不是 judge provider。
- Doubao 校准调用率由真实语言风险机会决定，不是每章固定调用。
- 所有被交付的 Doubao 校准候选都有 raw span、胜因 span 和反退化证据。
## 6. 子任务 D：GLM 开发隔离与配置守卫
**任务 ID**：`MODEL-ROUTING-CLAUDE46-1D`
**状态**：`COMPLETE_L0`（RED `cc5fe6b` / GREEN `d3cc205`）
### Objective
保证 GLM 5.2 只做开发阶段验证，不能因默认值、fallback、缺失路由或生产配置漂移进入正式章节调用。
### Required Changes
1. 保留 `scripts/invoke-generate-chapter.mjs` 的开发默认 `modelTestRoute=glm`，但日志必须明确 `development route lock`。
2. 公开工具未传 `modelTestRoute` 时不得触发任何 GLM route。
3. 新增配置扫描测试：生产 stage/agent route、production best-of、生产 fallback 不得包含 GLM。
4. `nb4_*_glm`、`nb5_*_glm`、`reference_analyzer_glm` 和 `narrator_testing_glm` 必须标注 lab/testing，且 `fallback=[]`。
5. 未知 route fail closed，禁止以 GLM 作为兼容默认值。
### Acceptance
- 默认生产 stub/集成测试中 GLM 调用次数为 0。
- 显式 GLM 开发锁仍覆盖 raw、editorial、opportunity judge、pairwise/reverse/arbitration 全部模型调用。
- route 漂移时测试失败，而不是自动修复或静默 fallback。
## 7. 子任务 E：真实 canary 与正式晋级
**任务 ID**：`MODEL-ROUTING-CLAUDE46-1E`
**状态**：`REQUIRES_AUTH`
此阶段包含真实 Claude/Doubao/GPT 调用和费用，开发不得自行启动。必须由用户另行确认 workspace、case、调用预算和端点可用性。
### Preregistration
- 冻结不少于 5 个、建议 10 个跨类型章节 case。
- 每个 case 固定输入、seed、上下文、字数预算、模型版本和 judge 路由。
- 对照臂：当前冻结 Doubao raw 或已接受 raw；实验臂：Claude 4.6 raw。
- 中文校准消融：Claude raw vs Claude raw + opportunity-driven Doubao calibration。
- A/B 标签随机并做反向复判；不得暴露模型身份。
- judge 与生成模型异源；高价值样本需 `validated_human_proxy` 或自然人复核。
### Promotion Gate
只有同时满足以下条件才可把任务标记为正式晋级完成：
1. Claude 4.6 raw 在 eligible case 上无事实 hard regression。
2. 盲测结果不是 `evidence_split`，且 Claude 4.6 至少达到预登记的明确胜出门槛。
3. Doubao 校准没有出现无 span 覆盖、整章重写或事实污染。
4. judge 反向复判冲突率、超时率、截断率和单章调用成本在预算内。
5. trace 能证明 production generation=Claude、calibration=Doubao（条件触发）、judge=异源、GLM=0。
6. 任何 unclear/tie/conflict 都保留 raw，不得为达到晋级结果追加 reviewer 或更换 case。
### Recovery
- Claude 不可用：raw 生成 hard block，返回结构化 FailureEnvelope；不回退 Doubao/GLM。
- Doubao 不可用：跳过中文校准并保留 Claude raw，记录 warning。
- judge 不可用：保留 Claude raw，记录 warning；不让 Claude 自审。
- canary 负向或证据分裂：保持代码能力但不宣称质量晋级，冻结 artifact，另开修复任务。
## 8. 开发提交要求
1. 严格按 TDD：先提交 RED，再提交 GREEN；不得把失败测试和实现揉成不可审计的一次提交。
2. 不提交真实密钥、`.env`、章节正文或未经授权的真实调用 artifact。
3. 不顺手修改发布治理、代理审批或其他无关模块。
4. 不运行真实章节生成；静态阶段只使用 stub、mock、fixture 和现有冻结 artifact。
5. 开发完成后提交以下核验材料：
   - 修改文件清单
   - RED/GREEN 测试名与结果
   - 路由解析矩阵
   - 默认生产调用 trace fixture
   - GLM 隔离负向测试
   - `git diff --check`
   - 三构建、focused tests、smoke、dependency boundary 结果
## 9. 本地核验命令
开发应根据实际测试文件名补充 focused 命令，至少执行：
```powershell
npm run build
npm run typecheck
npm run test
npm run test:eval
npm run smoke
git diff --check
```
优先增加并单独运行以下聚焦测试组：
- model routing runtime
- fallback route-level override
- unknown route fail-closed
- Claude generation / heterogeneous judge split
- Doubao calibration span boundary
- GLM production isolation
- strategy modelVersion isolation
- dependency boundary
## 10. Codex 核验清单
Codex 收到开发结果后按以下顺序验收：
1. 检查工作树与提交范围，排除用户既有改动和无关文件。
2. 检查 route-level fallback 是否真正被运行时代码消费，而非只写在 JSON。
3. 检查生产默认 generation/judge 是否实际分轨。
4. 检查未知 route 是否 fail closed，GLM 是否彻底退出生产隐式默认。
5. 检查 Doubao 是否只在有 span 的中文校准 hypothesis 中调用。
6. 检查 raw fallback、FactGuard、SelectionPolicy、state commit 和 atomic save 不变量。
7. 运行 focused tests → build/typecheck → broader tests → smoke/dependency boundary。
8. 未获得真实调用授权前，最高只声明 `COMPLETE_L0`，不得声明质量正收益或正式 canary 晋级。
## 11. 完成定义
- `1A/1B/1C/1D` 全部通过 `COMPLETE_L0`：Claude 4.6 主写、异源 judge、GLM 隔离、Doubao span 驱动受限中文校准候选的静态路由与边界保护完成。
- `1E` 真实 canary 通过：可声明“Claude Opus 4.6 正式晋级为生产主力，Doubao 条件式中文校准生效”。
- `AGENTS.md` 与运行时配置只在对应实现已落地并通过核验后，才能更新为新的当前事实。