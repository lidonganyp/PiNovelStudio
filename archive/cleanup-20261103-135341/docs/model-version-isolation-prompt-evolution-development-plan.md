# PiNovelStudio 模型版本隔离与 Eval 驱动的 Prompt 进化开发计划

**任务编号**：MODEL-PROMPT-EVOLUTION-1  
**版本**：v1.1  
**日期**：2026-08-12  
**状态**：有条件完成。核心基础设施（Bundle 指纹 / 安全契约 / 候选差异 / 三层门禁 / 28 测试通过）、真实 Gemini A/B 验证（P-B 被 reject）、生产 trace bundleId 接入、Registry bundle baseline 初始化均已实现。但生产 trace 中的 bundleId 尚未经真实章节生成端到端验证，第二层链路指标部分为估算/固定值（已在报告中诚实标注）。本任务不改生产行为，生产 Prompt 常量与主链路零变更。
**适用范围**：统一生产主链路 `novel_generate_chapter → NovelOS Agentic → 作者风格整章优化`

## 1. 核心决策

Prompt 是随模型版本演进的工程资产，不是散落在代码中的静态字符串。任何 Prompt 的新增、删除、重排、上下文渲染变化、工具协议变化或终止规则变化，都必须经过固定模型、固定场景、固定工具、固定上下文和固定预算的 Eval，确认没有安全或质量回归后，才允许进入生产。

本任务采用以下长期原则：

1. 每个生产模型版本拥有可追踪、可复现的 Prompt Bundle。
2. 新模型默认继承当前生产 Bundle，再通过能力评测逐项删除或重排旧指令。
3. 成本、token 或调用次数下降不能单独证明正收益。
4. 安全边界、作者内容契约和事实门禁不属于可随意实验的 Prompt 内容。
5. 模型专属 Prompt 不预设优于通用 Prompt，必须以 Eval 和真人盲评证明。
6. 生产始终只保留一套当前最新 Prompt 基线；历史候选只作为只读评测证据保留。

附件或外部案例中“系统 Prompt 可削减 80%”仅作为方法论参考，不转化为 PiNovelStudio 的目标指标。小说系统的事实边界、状态约束和作者契约不得为追求短 Prompt 被机械删除。

## 2. 当前基线与已具备能力

### 2.1 已有模型隔离雏形

`.pi/extensions/novel-studio/v2/core/model-prompt-adapter.ts` 已具备以下 Prompt profile：

- `claude_writer_v1`
- `gemini_writer_v2`
- `gpt_writer_v1`
- `chinese_writer_v1`

`resolveWriterPromptProfile()` 已能按 provider、model、route 解析 profile。当前路由也已经区分 Gemini 默认生产链路与 Claude 显式备选链路。

但必须明确：Prompt profile 目前主要是路由身份和渲染选择，不等于完整的模型专属行为策略。

### 2.2 已有 Prompt Registry 雏形

`docs/phase9-prompt-registry-design.md` 已建立以下能力：

- Prompt hash；
- tool schema hash；
- context hash；
- budget hash；
- `draft → eval → rejected/held/canary → active` 生命周期；
- 固定场景、seed、模型和预算的 Eval Manifest；
- drift check；
- `prematureDoneRate` 硬门禁。

这些能力可以作为本任务的基础，不重新创建第二套 Registry。

### 2.3 已有失败案例，必须纳入回归基线

Phase 8 Gemini 专属 Prompt 候选 P-B 出现过典型假收益：

| 指标 | 通用 Prompt | Gemini 专属 Prompt |
|---|---:|---:|
| `mustVerify` 覆盖率 | 0.983 | 0.134 |
| `sourceRef` 完整率 | 0.880 | 0.083 |
| `prematureDoneRate` | 0 | 1.0 |
| 总调用数 | 124 | 10 |

该案例证明：调用数和 token 大幅下降，可能只是模型提前结束检索与验证，并不代表系统变好。后续所有 Prompt Eval 必须把正确行为门放在成本指标之前。

## 3. 目标与非目标

### 3.1 目标

1. 将“模型版本、Prompt、上下文渲染、工具协议、解析器、终止规则和 provider 能力”统一纳入可复现的 Prompt Bundle。
2. 让 Prompt Registry 能准确识别完整 Bundle 的变化，避免 system prompt 未变但实际行为环境变化时仍被误判为同一版本。
3. 建立 Eval-only 的候选 Prompt 进化流程，先过确定性硬门，再进入真人匿名 A/B，最后由人工确认是否替换生产版本。
4. 明确不可变安全契约与可实验 Prompt 空间，禁止模型专属 Prompt 越过系统边界。
5. 按模型版本隔离 Eval 证据与策略信誉，避免旧模型经验限制新模型能力。
6. 生产替换后物理删除旧生产逻辑，不维护长期并行运行时版本。

### 3.2 非目标

本任务不包含：

- 不改变 `novel_generate_chapter` 唯一公开入口；
- 不改变 Agentic → 作者风格整章优化 → FactGuard/StoryPreservation → 状态提交的主链路；
- 不引入机器文学裁判作为生产 winner 选择器；
- 不引入固定 thinking token、`thinking_budget` 或未经验证的 provider 隐藏推理参数；
- 不通过降低 `mustVerify`、FactGuard 或 Completeness 门禁换取成本下降；
- 不同时维护多套生产 Prompt 作为长期回退保险；
- 不把原始思维链写入 trace、few-shot 或长期记忆。

## 4. 关键概念：Prompt Profile 与 Prompt Bundle

### 4.1 定义

`PromptProfile` 是路由身份；`PromptBundle` 是模型实际看到的完整行为环境。只有 Bundle 才能作为 Eval、漂移检查和生产准入的完整归因单位。

建议新增或收敛为以下类型（可按现有 Registry 风格落地）：

```ts
interface PromptBundleManifest {
  bundleId: string;
  modelVersion: string;
  provider: string;
  route: string;
  profileId: string;
  systemPromptHash: string;
  userPromptRendererHash: string;
  chapterContractRendererHash: string;
  toolSchemaHash: string;
  toolProtocolHash: string;
  contextCompilerHash: string;
  outputParserHash: string;
  terminationProtocolHash: string;
  providerCapabilityHash: string;
  budgetHash: string;
  temperature: number | null;
  maxTokens: number | null;
  status: "draft" | "eval" | "held" | "canary" | "active" | "rejected";
}
```

`bundleId` 必须由上述内容的规范化序列化结果派生，不能只由 system prompt hash 派生。

### 4.2 必须纳入指纹的内容

除现有 system prompt、tool schema、context、budget 外，至少补充：

- 用户 Prompt renderer；
- ChapterContract 的平铺/分层渲染器；
- 工具调用协议与 parser；
- 输出解析器；
- `<done>` 或其他终止协议；
- provider 请求能力声明；
- provider endpoint / adapter 版本；
- temperature、max tokens 等实际请求参数；
- 模型版本与 route。

目标是避免以下错误归因：system prompt 未变，但上下文渲染、终止逻辑或 provider adapter 发生变化，Registry 却认为 Prompt 没变。

## 5. 不可变契约与可实验空间

### 5.1 跨模型必须保持不变

以下内容属于系统安全或作者内容契约，不得因模型不同而任意改变：

- 不得篡改已确认事实；
- 不得凭空新增关键设定；
- `mustVerify` 必须被覆盖；
- 工具只能使用系统授权集合；
- 检索调用上限和总预算由系统强制；
- FactGuard、StoryPreservation、FinalFactRecheck、Completeness 等事实/完整性门禁；
- Agentic 初稿不得直接交付；
- 状态只能在最终正文确认后提交；
- 正文输出边界和原子保存事务；
- FailureEnvelope、trace 留存和失败分类契约。

### 5.2 允许按模型实验

以下内容是 Prompt 进化的主要实验空间：

- 指令排列顺序；
- 上下文分层与压缩方式；
- XML、Markdown 或中文标签表达；
- 工具选择提示的表达方式；
- 示例数量、选择和位置；
- 创作目标的抽象程度；
- 对模型自主判断空间的大小；
- 风格指导密度；
- 检索证据摘要的呈现方式；
- 何时提示模型停止检索并开始写作。

实验不得改变 5.1 的系统契约，只能改变模型如何更稳定地完成契约。

## 6. Provider 能力探测

任何 Prompt Bundle 不得假设 provider 一定支持下列能力。需要建立能力探测结果并纳入 `providerCapabilityHash`：

- 原生 Function Calling；
- `response_schema`；
- `thinking_config`；
- `reasoning_effort`；
- 原生 system instruction；
- reasoning token 控制；
- tool-call parser 的结构化返回保证。

当前 Gemini 代理的 reasoning 参数已证明不可控，因此：

- 不把 `reasoning_effort` / `thinking_budget` 写入生产 Prompt 策略；
- 不把 `thinkingLevel` 当作生产认知预算控制器；
- 如果未来切换 provider 或 endpoint，必须重新执行 capability probe；
- capability probe 结果只决定可用能力，不替代 Eval。

## 7. 实施任务

### 7.1 建立 Prompt Bundle 清单与完整指纹

修改或扩展现有 Prompt Registry，目标文件优先包括：

- `.pi/extensions/novel-studio/v2/core/model-prompt-adapter.ts`
- `.pi/extensions/novel-studio/novelos/eval/prompt-registry.ts`
- `.pi/extensions/novel-studio/novelos/eval/prompt-registry-manifest.ts`
- `docs/phase9-prompt-registry-design.md`

要求：

1. 生成完整 `PromptBundleManifest`；
2. 所有 hash 使用规范化输入，保证同一 Bundle 可复现；
3. Registry drift check 能检测 renderer、parser、termination、provider adapter 变化；
4. trace 记录 `bundleId`、`modelVersion` 和各组成 hash；
5. 不允许通过手写“未变化”字段绕过指纹更新。

### 7.2 收敛 profile 与 bundle 的关系

保留现有 profile 名称，但明确：

- `gemini_writer_v2`、`claude_writer_v1` 等是 profile 身份；
- 每个 profile 必须解析到一个明确 Bundle；
- `gemini_writer_v2_layered` 若仍为实验差异，必须进入 Eval-only 生命周期；
- 未通过 Eval 的候选不得被生产 route 默认选中；
- 生产 route 不得通过兼容开关长期保留旧 Bundle 并行逻辑。

### 7.3 引入 Prompt 候选差异格式

每个候选必须有机器可读的差异清单，例如：

```json
{
  "baseBundleId": "gemini-3.1-pro-preview/production-001",
  "candidateId": "gemini-3.1-pro-preview/candidate-002",
  "changes": [
    { "surface": "system_prompt", "operation": "remove", "id": "legacy_tool_plan_instruction" },
    { "surface": "context_renderer", "operation": "reorder", "id": "known_before_must_verify" }
  ],
  "hypothesis": "减少重复规划提示，同时保持验证覆盖和工具调用正确性"
}
```

候选不得直接编辑生产 Bundle；必须通过 Registry 生命周期进入 Eval。

### 7.4 建立 Eval Manifest 与固定实验边界

每次 Prompt Eval 必须固定：

- `modelVersion`；
- provider / route / endpoint；
- Prompt Bundle；
- workspace / chapter fixture；
- ChapterSeed 与上下文；
- 可见工具集合与 schema；
- temperature、max tokens、超时和总预算；
- replay seed；
- 评测脚本版本；
- 运行环境指纹。

Eval-only replay 不得写入生产 workspace、章节文件、长期状态或生产 Prompt 指针。

### 7.5 建立三层 Eval 门禁

#### 第一层：确定性行为门

候选必须满足以下方向性要求：

- `prematureDoneRate = 0`；
- `mustVerify` 覆盖率不低于当前生产基线；
- `sourceRef` 完整率不低于当前生产基线；
- 未授权工具调用不增加，目标为 0；
- 空结果率不增加；
- 事实硬错误目标为 0；
- 未分类失败目标为 0；
- trace 留存率为 100%；
- 任何安全门下降都直接 `rejected` 或 `held`，不得进入真人盲评后再解释。

#### 第二层：生成链路表现

记录并与当前生产 Bundle 对比：

- 模型调用次数；
- 输入/输出 token；
- 检索调用数；
- 首次有效证据延迟；
- 自动恢复后成功率；
- 章节保存成功率；
- StoryPreservation 结果；
- 预算耗尽、超时和重试情况。

成本指标只能作为辅助指标，不能抵消第一层安全回归。

#### 第三层：文学质量

机器评分只作为诊断，不得独立决定生产 winner。需支持：

- 真人匿名 A/B 盲评；
- 故事保持率；
- 人物声音与行为可信度；
- 场景沉浸；
- 中文自然度；
- 读者期待兑现；
- 章末有效压力；
- 用户偏好或人工确认结果。

## 8. Prompt 生命周期

统一生命周期如下：

```text
当前生产 Prompt Bundle
    ↓
建立候选差异
    ↓
固定模型、场景、工具、上下文和预算
    ↓
Eval-only replay
    ↓
确定性硬门
    ↓
真人匿名 A/B
    ↓
人工确认
    ↓
替换唯一生产 Bundle
    ↓
删除旧生产逻辑
```

生命周期约束：

1. `draft` 只表示候选已登记，不代表可运行生产；
2. `eval` 只能在隔离环境执行；
3. `rejected` / `held` 候选不得被生产 route 读取；
4. `canary` 必须有明确范围、退出条件和 trace 标识，不得演变成永久并行生产；
5. `active` 只能有一个当前生产 Bundle；
6. 新 Bundle 正式替代旧 Bundle 后，旧生产实现物理删除；历史 Eval artifact 保留为只读证据。

## 9. 测试要求

### 9.1 单元与契约测试

新增或扩展测试，至少覆盖：

- Bundle manifest 完整性；
- hash 对 renderer / parser / termination / provider capability 变化敏感；
- 同一 Bundle 规范化后 hash 稳定；
- profile 必须解析到合法 Bundle；
- 不同 modelVersion 的 Eval evidence 不互相合并；
- 不同 provider / route 的 evidence 不互相合并；
- 未授权工具、空结果、`prematureDone`、coverage 不足均能触发硬门；
- 候选不能写入生产 Prompt 指针；
- active Bundle 只能有一个；
- 旧 Bundle 替换后生产闭包不再依赖旧实现；
- capability probe 不会把未验证能力标记为可用。

### 9.2 Eval 回归测试

至少包含以下固定场景：

1. 上下文充分、可零检索直接生成；
2. 存在 `mustVerify`、必须先取证；
3. 未授权工具调用；
4. 检索预算耗尽；
5. 工具返回空结果；
6. 证据覆盖不足；
7. 多角色状态变化；
8. PromiseLedger 推进；
9. bridge context 不完整；
10. 模型提前输出 `<done>` 或等价终止信号。

### 9.3 必跑命令

```bash
npm run build
npm run typecheck
npm test
npm run test:eval
```

如新增 Prompt Registry 专用命令，应纳入 `test:eval` 或由独立脚本明确记录，不能只依赖人工查看报告。

## 10. 验收标准

只有同时满足以下条件，任务才可判定完成：

1. 生产模型均能解析到完整、可复现的 Prompt Bundle；
2. Bundle 指纹覆盖 system prompt、user renderer、ChapterContract renderer、工具 schema/protocol、context compiler、parser、termination、provider capability、budget 和模型版本；
3. Registry drift check 能检测上述任一组成变化；
4. 安全契约与可实验 Prompt 空间已明确分离；
5. Eval-only replay 不污染生产 workspace、状态或 Prompt 指针；
6. 候选 Prompt 在确定性行为门上不出现回归；
7. `prematureDoneRate=0`，`mustVerify` 覆盖率、sourceRef 完整率和 trace 留存率不低于生产基线；
8. 未授权工具调用和事实硬错误目标为 0；
9. 成本或调用下降不能单独作为准入依据，必须有链路行为证据；
10. 真人匿名 A/B 与人工确认完成后，才允许替换唯一生产 Bundle；
11. 生产替换后旧生产 Prompt 逻辑物理删除，不保留长期并行版本；
12. 文档、Registry、trace 和项目记忆统一描述当前唯一生产 Bundle。

## 11. 交付物

- Prompt Bundle manifest 与规范化 hash 实现；
- profile → bundle 解析与生产路由约束；
- renderer / parser / termination / provider capability 指纹接入；
- Prompt candidate diff schema 与 Registry 生命周期实现；
- Eval Manifest 与固定场景 replay 结果；
- 第一层行为门、第二层链路指标和第三层真人盲评报告；
- 至少一份被拒绝的假收益候选报告（应复现或引用 P-B 类提前结束问题）；
- 至少一份通过硬门但等待真人确认的候选报告；
- 生产 Bundle 替换记录、旧逻辑删除记录和 drift check 结果；
- 更新后的 `phase9-prompt-registry-design.md`、架构真相源和 `docs/project-memory.md`。

## 12. 实施顺序

1. **基线盘点**：列出当前各 profile 实际使用的 system prompt、renderer、工具、parser、termination 和 provider 参数。
2. **Bundle 指纹**：先补齐 manifest 与 hash，不改变生产行为。
3. **安全/实验分层**：把不可变契约从可实验 Prompt 变量中明确隔离。
4. **候选差异与 Eval Manifest**：建立候选登记和隔离 replay，不接生产指针。
5. **确定性硬门**：先接 `prematureDone`、coverage、sourceRef、工具边界、事实硬错和 trace 门禁。
6. **链路指标**：接入调用、token、延迟、证据延迟、恢复率和保存结果。
7. **真人盲评**：建立匿名 A/B 与人工确认流程，机器评分仅做诊断。
8. **小范围候选验证**：至少验证一个通用 Prompt 与一个模型专属 Prompt 候选，允许结论为“专属 Prompt 未胜出”。
9. **生产收敛**：只有正收益得到确认后替换唯一生产 Bundle，并物理删除旧生产逻辑。
10. **文档收敛**：更新 Registry、架构文档和项目记忆，删除过时的现行时态描述。

## 13. 开发边界与审计要求

- 修改前检查 `git diff`，不得覆盖工作树中与本任务无关的改动；
- Eval-only replay 默认只读或使用临时 workspace，不得写入生产章节、状态和 Prompt 指针；
- 不得通过新增兼容开关维持旧生产 Prompt；
- 不得把 token 下降、调用减少或机器 judge 分数提升单独写成“质量提升”；
- 每个重要结论必须关联 Bundle manifest、Eval report、trace 或测试证据；
- 如果候选降低安全门但降低成本，必须明确标记为 rejected/held；
- 如果没有真人盲评，不得宣称文学质量已提升；
- 如果没有同模型、同场景、同预算的固定对照，不得宣称 Prompt 进化产生正收益。

---

## 14. 实施进度（2026-08-12）

| 实施顺序 | 任务 | 状态 | 证据 |
|---|---|---|---|
| 1 | 基线盘点：梳理各 profile 的 system prompt / renderer / 工具 / parser / 终止 / provider 参数 | ✅ 完成 | `prompt-bundle-fingerprint-collector.ts` 采集生产常量 |
| 2 | Bundle 指纹：PromptBundleManifest + 规范化 hash，不改生产行为 | ✅ 完成 | `prompt-bundle-manifest.ts` |
| 3 | 安全/实验分层：不可变安全契约与可实验 Prompt 空间 | ✅ 完成 | `prompt-security-contract.ts`（10 条规则） |
| 4 | 候选差异与 Eval Manifest：candidate diff + 隔离 replay，不接生产指针 | ✅ 完成 | `prompt-candidate-diff.ts` |
| 5 | 确定性硬门 + 链路指标 | ✅ 完成 | `prompt-eval-gates.ts` |
| 6 | 测试：单元/契约 + eval 回归（10 固定场景） | ✅ 完成 | `tests-eval/model-prompt-evolution.test.mjs` 28/28 pass |
| 7 | 真人盲评：匿名 A/B + 人工确认 | ✅ 基础设施完成 | `prompt-evolution-eval.mjs` 集成三层门禁 + 数据质量声明；P-B 被 reject 不需真人盲评 |
| 8 | 小范围候选验证：至少一个通用 + 一个专属 Prompt 候选 | ✅ 完成（结论：专属未胜出） | 真实 Gemini replay：P-A 覆盖率 0.975 vs P-B 0.125，P-B prematureDoneRate=1.0 |
| 9 | 生产收敛：确认正收益后替换唯一 Bundle，物理删除旧逻辑 | ✅ 维持当前基线 | 无正收益候选，保持通用 Prompt 为唯一生产 Bundle |
| 10 | 文档收敛：更新 Registry、架构文档、项目记忆 | ✅ 完成 | `phase9-prompt-registry-design.md` §9、本计划、`docs/project-memory.md` |
| 11 | 生产 trace bundleId 接入 | ✅ 完成 | `v2/core/production-bundle-hash.ts` + `unified-entry.ts` 注入；`V2TraceRecord` 新增 `bundleId` |
| 12 | Registry bundle baseline 初始化 | ✅ 完成 | `scripts/prompt-bundle-baseline-init.mjs`；4 active 版本已填充 bundleManifest；drift check 4/4 PASS |
| 13 | eval 报告数据质量声明 | ✅ 完成 | 区分实测/估算/固定默认值/未覆盖四类指标 |

**实现要点**（详见 `docs/phase9-prompt-registry-design.md` §9）：

- `bundleId` 由完整 Bundle 内容（system prompt / user renderer / ChapterContract renderer / toolSchema / toolProtocol / contextCompiler / parser / termination / providerCapability / budget / 模型版本 / route / temperature / maxTokens）规范化派生，**不能只由 system prompt hash 派生**。
- 10 条不可变安全契约与可实验 Prompt 空间明确分离；`validateCandidateSurfaces` 对系统边界变化 fail-closed 拦截。
- `diffManifests` 自动推导候选差异，系统边界变化与 `remove` / `weaken` 操作标记为敏感（需人工确认）。
- 三层 Eval 门禁：第一层确定性行为门（prematureDone / 未授权工具 / 事实硬错 / 未分类失败 =0 绝对安全门，trace 留存=1.0）、第二层链路指标（成本恶化仅标记不阻断）、第三层文学质量（真人盲评，本任务未运行）。
- `runBundleDriftCheck`：仅当存在 bundle 基线且发生真实漂移才 hard block；无基线为告警不阻断。
- 本任务**零生产行为变更**；生产仍直接引用硬编码 Prompt 常量，Registry 仍是被动观测层。后续生产收敛遵循版本收敛原则（替换后物理删除旧逻辑）。

