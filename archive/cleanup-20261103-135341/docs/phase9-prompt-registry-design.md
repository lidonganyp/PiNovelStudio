# Phase 9：Prompt 版本管理与评测流程

> **状态**：产品级验收已通过（2026-08-10），当前版本作为稳定生产基线运行，进入生产运营期（2026-08-11）。
> - 生产基线 active_prod：active pointer=rel-prod-104（合法生产审批，reviewTransport=network，审批 `approval-rel-prod-104-1786448975869-e1f76869`，环境指纹 6e1e1387，codeCommit a05d9d9），`PINOVEL_DEV_MODE=0`，暂不启动 canary。rel-prod-104 迁移范围仅含遥测能力（Tool Interface v1 + token telemetry + FailureEnvelope + trace diagnostics），行为不变，production prompt / tool schema / context / budget hash 全部未变，drift check 4/4 通过。
> - 基线回放完成：7/7 hash 一致性通过，registry 已初始化（4 active + 2 rejected P-B）。
> - `verify:prompt-registry` 命令链路全绿：drift check 4/4 + governance tests 20/20 + production smoke 2/2。
> - 真实生产基线（xinmo ch19，2026-08-10，rel-prod-101）：novel_generate_chapter 完整主链路 150.5s，4 次模型调用（Gemini 3.1），budget used=4/soft=6/hard=10（A 组预算），19.md 原子保存 5616 bytes，selectedSource=v2_amplified，trace 完整，narrative-state ch19 hash 217 处引用，无 silent degrade，release gate 通过（devMode=false，releaseId=rel-prod-101，指纹 4e129c8f，approvalRef 齐全）。该基线已由 rel-prod-103 继承。
> - Bounded observation（ch20/ch21，2026-08-11，rel-prod-103）：每章生产验收 + 加固复检全绿。ch20 生产验收 14/14、复检 22/22（5 次模型调用、budget 5/10、narrative ch19→ch20，trace 含 2 条历史 envelope 被复检按本次运行起点正确隔离）；ch21 生产验收 12/12、复检 22/22（4 次模型调用、budget 4/10、narrative ch20→ch21，trace 0 envelope 干净）。两章均无 fallback、预算未 capped、原子保存与状态引用一致、无 silent degrade，证明 rel-prod-103 稳定。
> - 验收证据复检（reverify，2026-08-10）：22/22 PASS — 章节文件/trace/narrative-state 交叉验证全一致，devMode=false + release gate + 原子保存 + 状态提交全部通过，模型路由 Gemini 3.1 Pro Preview，A 组预算 4/10。复检脚本：`scripts/phase9-acceptance-reverify.mjs`。
> **前置**：Phase 8 Stage P 负向结论已确认（P-B Gemini 专属 Prompt 过早终止，prematureDoneRate=1.0）。Stage N 不启动。
> **约束**：registry 是被动观测层，不拦截生产调用；新 Prompt 候选按生命周期流程准入，禁止自动晋级。进入生产运营期后，每次发布前执行 drift check / release gate / reverify，不启动 canary，不开放新的 Prompt/Native 实验。

---

## 1. 动机

### 1.1 Phase 8 的教训

Phase 8 Stage P 的 P-B（Gemini 专属 Prompt）在真实 replay 中表现 catastrophic：

| 指标 | P-A（通用） | P-B（Gemini 专属） |
|------|------------|-------------------|
| mustVerify 覆盖率 | 0.983 | 0.134 |
| sourceRef 完整率 | 0.880 | 0.083 |
| 总调用 | 124 | 10 |
| 空结果 | 0 | 9 |
| prematureDoneRate | 0.0 | 1.0 |

根因：P-B 过度强调"证据充分即输出 `<done>`"，导致模型在检索验证前就过早终止。token 下降（11610 -> 52）是"提前放弃检索"的假收益。

**教训**：Prompt 变更需要版本化管理、预注册门禁和可追溯的评测流程，不能直接在生产中试错。

### 1.2 研究问题

如何建立一套 Prompt 版本管理系统，使：

1. 每个 Prompt 版本有唯一 hash 指纹（prompt + toolSchema + context + budget）。
2. Prompt 变更经 draft -> eval -> canary -> active 生命周期准入，禁止自动晋级。
3. 评测使用固定场景/seed/模型/门禁，结果可复现。
4. prematureDoneRate 作为门禁指标，防止"提前放弃检索"的假收益。
5. Registry 是被动观测层，不改变生产行为。

---

## 2. 架构设计

### 2.1 被动观测层原则

Registry **不拦截、不替代**生产 Prompt 调用。生产路径继续直接引用硬编码常量：

- `NOVELOS_SYSTEM_PROMPT`（`novelos/agent/agentic-raw-candidate-source.ts`）
- `STYLE_SYSTEM_PROMPT`（`v2/core/author-style-optimizer.ts`）
- `WRITER_ADAPTER_SYSTEM_PROMPT`（`v2/core/model-prompt-adapter.ts`）

Registry 只做：
- **快照**：从生产常量计算 hash，记录版本元数据。
- **追踪**：记录生命周期状态转换和评测结果。
- **指针**：记录每个 slot 的 active 版本（只读引用，不注入生产）。

**基线回放证明**：7/7 hash 一致性检查通过，registry 的 hash 与直接从常量计算的 hash 完全匹配。

### 2.2 数据模型

```
PromptRegistry
├── schema: "pinovel-prompt-registry/v1"
├── version: "1.0.0"
├── versions: PromptVersion[]
│   └── PromptVersion
│       ├── versionId: string        (如 "novelos_agentic-v1")
│       ├── slot: PromptSlot         (novelos_agentic | style_optimizer | writer_adapter | retrieval_eval)
│       ├── version: number          (slot 内序号)
│       ├── label: string            (人类可读标签)
│       ├── modelRoute: string       (如 "narrator_primary")
│       ├── writerProfile?: string   (如 "gemini_writer_v2")
│       ├── hashes: PromptHashes
│       │   ├── promptHash: string       (SHA-256 of system prompt)
│       │   ├── toolSchemaHash: string   (SHA-256 of sorted tool names)
│       │   ├── contextHash: string      (SHA-256 of compiler names)
│       │   └── budgetHash: string       (SHA-256 of budget config)
│       ├── status: PromptVersionStatus (draft | eval | rejected | held | canary | active)
│       ├── statusHistory: StatusTransition[]
│       ├── evalManifestId?: string
│       ├── evalReportPath?: string
│       ├── rejectedReason?: string
│       └── createdAt / updatedAt: ISO
└── productionPointers: ProductionPointer[]
    └── ProductionPointer
        ├── slot: PromptSlot
        ├── activeVersionId: string
        └── pinnedAt: ISO
```

### 2.3 生命周期状态机

```
                    ┌─────────┐
                    │  draft  │ ← 新建候选
                    └────┬────┘
                         │ manual: 进入评测
                         ▼
                    ┌─────────┐
              ┌─────│  eval   │─────┐
              │     └────┬────┘     │
              │          │          │
     eval-gate│    eval-gate│    eval-gate│
     门禁失败  │    门禁通过  │    不确定   │
              ▼          ▼          ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │rejected │ │ canary  │ │  held   │
         └─────────┘ └────┬────┘ └────┬────┘
                          │           │
                   manual │    manual │
                   确认生效 │    返工/重评│
                          ▼           ▼
                    ┌─────────┐  ┌─────────┐
                    │ active  │  │  draft  │
                    └────┬────┘  └─────────┘
                         │ manual: 回滚
                         ▼
                    ┌─────────┐
                    │  held   │
                    └─────────┘
```

**铁律**：
- `canary -> active` 必须 `actor="manual"`，禁止 eval-gate 自动晋级。
- `eval-gate` 只能触发 `eval -> rejected` 或 `eval -> canary`。
- `rejected` 是终态，不可转换。
- `active -> held` 是回滚操作，可重新进入 draft 或 eval。

### 2.4 Hash 指纹

每个版本记录 4 类 hash，任何维度变更都可通过 hash diff 检测：

| Hash | 计算内容 | 变更含义 |
|------|---------|---------|
| promptHash | system prompt 字符串的 SHA-256 | Prompt 文本变更 |
| toolSchemaHash | 9 个叙事工具名（排序 join）的 SHA-256 | 工具集变更（增删/重命名） |
| contextHash | 12 个上下文编译器名（排序 join）的 SHA-256 | 上下文编译配置变更 |
| budgetHash | NovelOS budget + orchestrator SOFT/HARD 的 SHA-256 | 预算配置变更 |

当前生产 hash（基线回放计算）：

| Hash | 值 |
|------|---|
| toolSchemaHash | `1a6dddf02234e8bd` |
| contextHash | `231f6970cf8d110e` |
| budgetHash | `5e66798af7a5163a` |

---

## 3. 评测 Manifest

### 3.1 固定维度

| 维度 | 固定值 |
|------|--------|
| 场景 | BASELINE_SCENARIOS（8 类，含高风险 SC8） |
| seed | 3 批 × 3 seed（seed 0-8） |
| 模型 route | narrator_primary（gemini31, fallback=[]） |
| 温度 | 0.72 |
| maxTokens | 2048 |
| 工具 | 9 专用工具（NARRATIVE_TOOL_NAMES） |
| 上下文 | 完整注入（12 个编译器） |
| 预算 | A 组（SOFT=6/HARD=10, maxTurns=10/maxToolCalls=20） |

### 3.2 门禁

| 门禁 | 阈值 | 类型 |
|------|------|------|
| mustVerify 覆盖率不降级 | >= A - 0.05 | 硬门 |
| sourceRef 完整率不降级 | >= A - 0.05 | 硬门 |
| 非法调用不恶化 | <= A | 硬门 |
| 空结果不恶化 | <= A | 硬门 |
| 停止率不降级 | >= A - 5% | 硬门 |
| **prematureDoneRate** | **<= 0.0** | **硬门（Phase 9 新增）** |
| token 成本获益 | < A x 0.9 | 加分项 |
| 首证据延迟不恶化 | <= A + 1ms | 加分项 |

### 3.3 prematureDoneRate 诊断

Phase 8 P-B 的根因是"过早终止"——模型在检索验证前输出 `<done>`。Phase 9 将此行为提升为显式门禁指标：

**判定标准**（满足任一即为 premature）：
1. 模型输出终止标记（stopped=true）但有效证据数 = 0 -> "无有效证据即 done"
2. 总调用 = 0 且结果为空/错误/超时 -> "直接放弃检索"
3. mustVerify 覆盖率 < 0.1 且 totalCalls < 3 -> "检索计划未执行"

**门禁**：`prematureDoneRate <= 0.0`（不允许任何过早终止）。

Phase 8 真实 replay 的 prematureDoneRate：
- P-A（通用）：0.0（0/9）-> PASS
- P-B（Gemini 专属）：1.0（9/9）-> FAIL

---

## 4. 基线回放结果（2026-08-10）

### 4.1 Hash 一致性

| Hash | 直接计算 | Registry | 一致 |
|------|---------|----------|------|
| novelos_agentic promptHash | fab363a154538ac8 | fab363a154538ac8 | ✓ |
| style_optimizer promptHash | 83c11299b5554407 | 83c11299b5554407 | ✓ |
| writer_adapter promptHash | 85fcaf8de7e357ce | 85fcaf8de7e357ce | ✓ |
| retrieval_eval promptHash | 17e9500271e5f840 | 17e9500271e5f840 | ✓ |
| toolSchemaHash | 1a6dddf02234e8bd | 1a6dddf02234e8bd | ✓ |
| contextHash | 231f6970cf8d110e | 231f6970cf8d110e | ✓ |
| budgetHash | 5e66798af7a5163a | 5e66798af7a5163a | ✓ |

**结论**：Registry 是被动观测层，hash 从生产常量直接计算，不拦截或修改任何生产调用。

### 4.2 Registry 初始状态

| Slot | Version | Status | Label |
|------|---------|--------|-------|
| novelos_agentic | v1 | active | 通用 NovelOS Agentic 系统 Prompt（生产基线） |
| style_optimizer | v1 | active | 通用作者风格优化系统 Prompt（生产基线） |
| writer_adapter | v1 | active | 通用 Writer Adapter 系统 Prompt（生产基线） |
| retrieval_eval | v1 | active | 通用检索决策 Prompt（评测基线） |
| retrieval_eval | v2 | **rejected** | Phase 8 P-B: Gemini 专属检索 Prompt |
| novelos_agentic | v2 | **rejected** | Phase 8 P-B: Gemini 专属生成 Prompt |

- **生产指针**：4 个 slot 全部指向 v1（通用 Prompt），不动。
- **Rejected 候选**：2 个 P-B 版本，拒绝原因记录了 Phase 8 真实 replay 数据和根因分析。

---

## 5. 新 Prompt 候选准入流程

### 5.1 流程

1. **创建**：`createEvalCandidate(slot, version, label, route, systemPrompt)` -> draft
2. **评测**：`transitionStatus(version, "eval", reason)` -> 关联 manifest -> 运行 replay
3. **门禁**：eval-gate 评估
   - 硬门全通过（含 prematureDoneRate）-> `transitionStatus(version, "canary", reason, "eval-gate")`
   - 硬门未通过 -> `transitionStatus(version, "rejected", reason, "eval-gate")`
   - 不确定 -> `transitionStatus(version, "held", reason, "manual")`
4. **Canary**：受控接入观察（需设计 canary 机制，当前仅记录状态）
5. **晋级**：`transitionStatus(version, "active", reason, "manual")` -> 手动确认
6. **生效**：`setProductionPointer(registry, slot, versionId)` -> 更新指针

### 5.2 禁止事项

- ⛔ 禁止 `canary -> active` 由 eval-gate 自动触发。
- ⛔ 禁止跳过 eval 直接 canary/active。
- ⛔ 禁止不记录 rejectedReason 的 rejected 转换。
- ⛔ 禁止 registry 拦截或替代生产 Prompt 调用。

---

## 6. 实现产物

| 文件 | 作用 |
|------|------|
| `novelos/eval/prompt-registry.ts` | Registry 核心：类型、hash 计算、生命周期状态机、文件 I/O |
| `novelos/eval/prompt-registry-manifest.ts` | 评测 manifest：固定场景/seed/模型/门禁/报告路径 |
| `novelos/eval/premature-done-diagnostic.ts` | prematureDoneRate 诊断：三类判定 + 门禁集成 |
| `scripts/prompt-registry-baseline-replay.mjs` | 基线回放 CLI：快照 -> P-B rejected -> dry-run -> hash 验证 -> 报告 |
| `config/prompt-registry.json` | Registry 文件（6 个版本：4 active + 2 rejected） |
| `reports/phase9-prompt-registry/baseline-registry-report.json` | JSON 报告 |
| `reports/phase9-prompt-registry/baseline-registry-report.md` | Markdown 报告 |

### 6.1 生产代码变更（最小化）

- `agentic-raw-candidate-source.ts`：`NOVELOS_SYSTEM_PROMPT` 添加 `export`（零行为变更）
- `author-style-optimizer.ts`：`STYLE_SYSTEM_PROMPT` 添加 `export`（零行为变更）
- `model-prompt-adapter.ts`：提取 `WRITER_ADAPTER_SYSTEM_PROMPT` 常量并 `export`（零行为变更）

### 6.2 eval-only 模块

所有 Phase 9 新增模块只注册在 `tsconfig.eval.json`，不进入 `tsconfig.prod.json`（生产构建）。

---

## 7. 与 Phase 5-8 的关系

| 维度 | Phase 5 | Phase 6 | Phase 7 | Phase 8 | Phase 9 |
|------|---------|---------|---------|---------|---------|
| 研究问题 | 工具接口 | 上下文 | 预算 | Prompt/协议 | 版本管理 |
| 结论 | 9 专用工具 | 不压缩 | A 组预算 | P-B 负向 | 基线回放通过 |
| 固定维度 | - | 工具+预算 | 上下文+工具 | 工具+上下文+预算 | 工具+上下文+预算+Prompt |
| 产物 | 工具集冻结 | 上下文策略 | 预算策略 | P-B rejected | Registry + 生命周期 |

> Phase 9 是 Phase 8 负向结论后的流程治理：把 Prompt 变更从"试错"升级为"版本化管理 + 预注册门禁 + 可追溯评测"。生产基线不变，新候选按流程准入。

---

## 8. 后续治理（已实现）

### 8.1 Hash Drift 自动检查

**模块**：`novelos/eval/prompt-registry-drift-check.ts` + `scripts/prompt-registry-drift-check.mjs`

CI 和发布门禁校验：从当前生产常量重新计算 4 类 hash（prompt / toolSchema / context / budget），与 registry 中 active 版本记录的 hash 对比。发现漂移 -> exit code 1（hard block）。

**CI 集成**：在 `npm test` 前运行 `node scripts/prompt-registry-drift-check.mjs`。

**Fail-closed 设计**：
- registry 文件缺失 -> `loadRegistry` 抛错 -> drift check 返回 `passed=false`
- registry JSON 损坏 -> JSON.parse 抛错 -> drift check 返回 `passed=false`
- schema 不匹配 -> `loadRegistry` 抛错 -> drift check 返回 `passed=false`
- active 版本不存在 -> `getActiveVersion` 返回 null -> slot `passed=false`

### 8.2 Manifest 版本化

**函数**：`computeManifestVersion(scenarios, seeds, modelRoute, temperature, maxTokens, gateConfig)`

由固定维度（场景 ID + seed + route + 温度 + maxTokens + 门禁配置 + 工具 schema hash）计算 SHA-256 前 16 hex。任一固定维度变更 -> `manifestVersion` 变更，保证历史 replay 可复现。

`EvalManifest` 新增 `manifestVersion` 字段，所有 manifest factory 函数自动计算并填充。

### 8.3 Bounded Canary 设计（复用现有 governance 基础设施）

**原则**：不造第二套晋级系统。Prompt registry 的 canary 流程直接复用 `v2/governance/` 下的现有模块。

**现有基础设施**（`v2/governance/`）：

| 模块 | 作用 | Prompt registry 复用方式 |
|------|------|------------------------|
| `canary-policy.ts` | 纯函数决策矩阵（changeClass x healthStatus -> strategy） | Prompt 变更分类为 R0-R3，经 `decideCanaryStrategy` 决定 skip/direct_promote/bounded_canary/shadow_required |
| `canary-trace-store.ts` | FS 持久化 canary run trace（append-only） | Prompt canary run 的 workspace/chapter/modelCalls/failureMetrics 写入 trace |
| `canary-promotion-gate.ts` | 三重验证（completion + binding + artifacts） | 验证 Prompt canary 的 trace 完成态、releaseId/workspaceId/fingerprint 绑定、chapter trace artifact hash |
| `production-release-gate.ts` | G6 生产门禁（pointer + manifest + fingerprint + canary evidence） | Prompt 版本晋级到 active_prod 时，G6 门禁验证 canary 证据链 |

**Prompt 候选 -> Canary 流程**：

```
1. Prompt 候选通过 Phase 8 全部硬门（含 prematureDoneRate）
   -> registry 中 status: eval -> canary（actor=eval-gate）

2. canary 策略决策：
   - Prompt 变更分类为 R2（中风险：改变模型行为但不改变工具/上下文/预算）
   - healthStatus = healthy（门禁全通过）
   -> decideCanaryStrategy 返回 bounded_canary

3. bounded canary 执行：
   - 选定单个 workspace 受控接入新 Prompt
   - 使用 systemPromptOverride 注入（eval-only 字段，permitSystemPromptOverride=true）
   - 生成 N 章正文，收集 chapter trace + failureMetrics
   - 写入 canary-trace-store（append-only，不可覆盖）

4. canary 晋级门禁：
   - evaluateCanaryPromotionGate: 验证 trace 完成态 + 绑定 + 策略匹配
   - evaluateCanaryCompletionLink: 验证源 trace 链接
   - verifyCanaryResultArtifacts: 验证 chapter trace 文件 hash + 结构

5. 手动晋级：
   - canary 证据通过 -> transitionStatus(version, "active", reason, "manual")
   - setProductionPointer(registry, slot, versionId)
   - 禁止 eval-gate 自动触发 canary -> active
```

**当前状态**：没有通过评测的新 Prompt 候选，canary 暂不启动。此设计为未来候选通过门禁后的执行路径。

### 8.4 端到端治理测试

**测试文件**：`tests/phase9-registry-governance.test.mjs`

验证项：
1. **eval/test 不能修改 production pointer**：`setProductionPointer` 只能指向 `status=active` 的版本；eval-gate 不能触发 `canary -> active`。
2. **Hash 漂移阻断**：修改 prompt 内容后，`runDriftCheck` 返回 `passed=false`。
3. **Registry 损坏 fail-closed**：缺失/损坏/schema 不匹配的 registry 文件导致 `loadRegistry` 抛错。
4. **Manifest 版本化**：固定维度变更时 `manifestVersion` 变化。
5. **Premature done 门禁**：`prematureDoneRate > tolerance` 时门禁 `passed=false`。

---

## 9. 模型版本隔离与 Eval 驱动的 Prompt 进化（MODEL-PROMPT-EVOLUTION-1，2026-08-12）

> **任务**：`docs/model-version-isolation-prompt-evolution-development-plan.md`（v1.0，2026-08-12）。
> **状态**：t1 基线盘点、t2 Bundle 指纹、t3 安全/实验分层、t4 候选差异与 Eval Manifest、t5 确定性硬门 + 链路指标、t6 测试（28/28 pass）均已实现。本任务只补齐**完整 Bundle 指纹 + Eval 门禁 + 候选差异**基础设施，**不改变任何生产调用行为**；生产 Prompt 常量、路由与主链路零变更。真人盲评与生产收敛（t7 之后的生产替换）需真实模型 replay，待模型配额恢复/切换 provider 后进行。

本节把 Phase 9 的「system prompt / toolSchema / context / budget」4 类 hash，扩展为**完整 Prompt Bundle 指纹**，使 renderer、parser、termination、provider capability、模型版本等任何行为环境变化都能被 Registry 精确识别，避免「system prompt 未变但实际行为环境已变」的错误归因。

### 9.1 Prompt Profile 与 Prompt Bundle 的区分

- **PromptProfile**（`gemini_writer_v2` / `claude_writer_v1` 等）是**路由身份**；`resolveWriterPromptProfile()` 按其解析渲染与路由选择。
- **PromptBundle** 是**模型实际看到的完整行为环境**，是 Eval、漂移检查和生产准入的完整归因单位。`bundleId` 由完整内容规范化序列化后的 hash 派生，**不能只由 system prompt hash 派生**。

### 9.2 PromptBundleManifest（`novelos/eval/prompt-bundle-manifest.ts`）

```ts
interface PromptBundleManifest {
  bundleId: string;                 // 由下方全部 hash 规范化派生
  modelVersion: string;
  provider: string;
  route: string;
  profileId: string;
  systemPromptHash: string;         // system prompt
  userPromptRendererHash: string;   // 用户 prompt renderer
  chapterContractRendererHash: string; // ChapterContract 平铺/分层渲染器
  toolSchemaHash: string;           // 工具 schema
  toolProtocolHash: string;         // 工具调用协议
  contextCompilerHash: string;      // 上下文编译器
  outputParserHash: string;         // 输出解析器
  terminationProtocolHash: string;  // <done> 等终止协议
  providerCapabilityHash: string;   // provider 能力声明
  budgetHash: string;               // 预算
  temperature: number | null;
  maxTokens: number | null;
  status: BundleStatus;             // draft | eval | held | canary | active | rejected
}
```

- `computeBundleManifest(content, status)` 对每个组成字段计算规范化 SHA-256，再合并派生 `bundleId`。同一 Bundle 输入恒产生同一 `bundleId`；任一组成变化即改变 `bundleId`。
- `prompt-bundle-fingerprint-collector.ts` 的 `collectProductionBundleFingerprint()` 从生产常量（`NOVELOS_SYSTEM_PROMPT`、renderer、parser、工具名、budget、provider capability 声明表）自动采集内容，无需手写 hash，杜绝「手写未变化字段」绕过指纹。

### 9.3 不可变安全契约与可实验空间（`novelos/eval/prompt-security-contract.ts`）

- **10 条不可变安全契约**（`IMMUTABLE_RULES`）：不得篡改已确认事实、不得凭空新增关键设定、`mustVerify` 必覆盖、工具仅授权集合、检索/预算上限系统强制、事实/完整性门禁、Agentic 初稿不得直接交付、状态仅最终确认后提交、正文输出边界与原子保存、FailureEnvelope/trace 契约。
- **可实验表面**：`user_prompt_renderer`（实验主载体）、指令顺序、上下文分层、标签表达、示例数量/位置等。
- **系统边界表面**：`tool_schema`、`context_compiler`、`system_prompt`、`termination_protocol`、`output_parser` 等。
- `validateCandidateSurfaces(changedSurfaces)` 拦截系统边界变化并映射到契约规则；未知表面 **fail-closed** 拦截。

### 9.4 Prompt 候选差异（`novelos/eval/prompt-candidate-diff.ts`）

```json
{
  "baseBundleId": "gemini-3.1-pro-preview/production-001",
  "candidateId": "gemini-3.1-pro-preview/candidate-002",
  "changes": [
    { "surface": "user_prompt_renderer", "operation": "reorder", "id": "known_before_must_verify" }
  ],
  "hypothesis": "减少重复规划提示，同时保持验证覆盖和工具调用正确性",
  "modelVersion": "gemini-3.1-pro-preview",
  "provider": "gemini",
  "route": "gemini_writer_v2"
}
```

- `diffManifests(base, candidate, hypothesis)` 自动从两份 manifest 推导变更集。
- 系统边界变化自动标记为**敏感**（requireManualConfirm）；`remove` / `weaken` 操作同样标记敏感。候选携带模型身份，不同 modelVersion / provider / route 的 evidence 不互相合并。

### 9.5 三层 Eval 门禁（`novelos/eval/prompt-eval-gates.ts`）

- **第一层：确定性行为门**（`evaluateDeterministicHardGate`）：`prematureDoneRate`、未授权工具、事实硬错、未分类失败默认=0（绝对安全门，任一 >0 即 reject）；`trace留存率`=1.0；coverage / sourceRef 相对基线不降级（降级→reject）。相对指标降级但无绝对安全门违规→`held`（人工复查）。
- **第二层：生成链路指标**（`compareLinkMetrics`）：模型调用、token、检索调用、首证据延迟、恢复率、保存结果等。成本类恶化仅**标记不阻断**，不能抵消第一层安全回归。
- **第三层：文学质量**：真人匿名 A/B + 人工确认（机器评分仅诊断，不决定生产 winner）。本任务未实现真实盲评运行，需真实模型 replay。

### 9.6 Registry 集成与 Bundle 级漂移检查

- `prompt-registry.ts` 的 `PromptVersion` 新增 `bundleManifest?: PromptBundleManifest`；`createProductionSnapshot` / `createEvalCandidate` 可携带 bundleManifest（候选不接生产指针）。
- `prompt-registry-drift-check.ts` + `scripts/prompt-registry-drift-check.mjs` 新增 `runBundleDriftCheck`：从实现源码采集完整 Bundle 指纹，与 registry 基线对比。语义：**仅当存在 bundle 基线且发生真实漂移才 hard block**；无基线（未接入）为告警不阻断。CLI 支持 `--route / --provider / --model-version / --temperature / --max-tokens` 覆盖身份。

### 9.7 测试（`tests-eval/model-prompt-evolution.test.mjs`，28/28 pass）

覆盖 t2-t6：同一 Bundle 确定性 bundleId、hash 对 renderer/parser/termination/provider capability 变化敏感、10 条安全契约、系统边界拦截、diffManifests 自动推导、绝对安全门 reject / 相对降级 held、链路成本指标不抵消安全门、10 固定场景→硬门映射、createProductionSnapshot/createEvalCandidate 携带 bundleManifest。

### 9.8 边界与后续

- 本任务**不改生产行为**：生产仍直接引用硬编码 Prompt 常量；Registry 仍是被动观测层。
- 尚未完成（需真实模型 replay，待配额恢复或切换 provider）：真实 Prompt 候选 Eval replay、真人匿名 A/B、生产 Bundle 替换与旧逻辑物理删除。
- 版本收敛原则持续生效：生产替换后旧生产 Prompt 逻辑物理删除，不维护多套并行运行时版本。
