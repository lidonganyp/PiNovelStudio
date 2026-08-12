# AGENTIC-EVIDENCE-MERGE-1 改造前后基线对照报告

> **对照方法**：使用同一 replay 脚本 + 同一脚手架 workspace，分别在改造前代码（`cd0f3e4`）和改造后代码（`8354204`）上运行 9 章 replay。
> **模型**：gemini-3.1-pro-preview
> **时间**：2026-08-12

## 对照汇总

| 指标 | 改造前（cd0f3e4） | 改造后（8354204） | 变化 |
|---|---|---|---|
| 独立 EvidenceDecision 调用数 | **2** | **0** | **−2（目标 0，达成）** |
| ch1 模型调用数 | 4 | 2 | **−2（−50%）** |
| ch1 输入 token | 9,000 | 5,738 | **−3,262（−36.2%）** |
| ch1 延迟 | 199.5s | 179.2s | **−20.3s（−10.2%）** |
| ch1 输出 token | (见 trace) | (见 trace) | — |
| mustVerify 覆盖 | 0/0（旧代码无覆盖门） | 8/8（100%） | 新增覆盖门 |
| trace 留存率 | 100% (9/9) | 100% (9/9) | 不变 |
| 未分类失败 | 0 | 0 | 不变 |
| 事实硬错误放行 | 0 | 0 | 不变 |

## ch1 逐调用对照（两版均成功的章节）

### 改造前（4 次模型调用）
1. `v2_rawstage2_gemini31` — 18.8s（EvidenceDecision：判断未知点与工具选择）
2. `v2_rawstage2_gemini31` — 8.7s（EvidenceDecision：结构化输出中文化）
3. `v2_rawstage2_gemini31` — 79.7s（NovelOS Agentic 初稿生成）
4. `v2_amplified_gemini31` — 92.3s（作者风格整章优化）

### 改造后（2 次模型调用）
1. `v2_rawstage2_gemini31` — 66.8s（NovelOS Agentic 初稿生成，含内联证据决策）
2. `v2_amplified_gemini31` — 112.4s（作者风格整章优化）

### 关键差异
- 改造前每章固定 2 次 EvidenceDecision 调用（共 27.5s），改造后合并为 0 次
- 改造后 Agentic 初稿调用时间增加（66.8s vs 79.7s），因为内联了证据决策逻辑，但总时间仍减少
- **每章净减少 1 次模型调用 + 1 次独立决策往返**（注：改造前实际减少 2 次调用，因为 EvidenceDecision 分两步执行）

## 改造前 EvidenceDecision 调用明细

| 章 | EvidenceDecision 调用 | 输入 token | 延迟 |
|---|---|---|---|
| ch1 | 2 | ~3,262 | 27.5s |
| ch2 | 2 | ~5,000 | ~20s |
| ch3-9 | 0（preflight 级联） | 0 | 0 |

改造后全部章节 EvidenceDecision 调用 = 0。

## 安全性对照

| 安全面 | 改造前 | 改造后 | 回归？ |
|---|---|---|---|
| FactGuard | 生效 | 生效 | 否 |
| StoryPreservation | 生效（ch2 阻断） | 生效（ch3 阻断） | 否 |
| Preflight 连续性 | 生效 | 生效 | 否 |
| mustVerify 覆盖门 | 不存在 | 新增，8/8 通过 | 增强 |
| 未分类失败 | 0 | 0 | 否 |

## 结论

> **样本口径说明（2026-08-12 补验）**：两版均执行 9 章，但大部分章节因前章失败产生零调用 preflight 级联，可比较的成功章节实际仅 ch1。下述收益基于 **ch1 单样本** 观察，模型存在随机性，**不能据此断定整体正收益**；"至少 9 章同批对照"的整体成本结论尚未满足，需用独立章节快照补验。

1. **每章减少 1 次独立决策往返**：改造前每章固定 2 次 EvidenceDecision 模型调用，改造后合并为 0 次。
2. **ch1 token 下降**：ch1 输入 token 从 9,000 降至 5,738（−36.2%）。单样本观察。
3. **ch1 延迟下降**：ch1 总延迟从 199.5s 降至 179.2s（−10.2%）。单样本观察。
4. **安全边界未削弱**：FactGuard、StoryPreservation、Preflight 全数生效；mustVerify 覆盖门为新增安全能力。

## 补验脚本修复（2026-08-12）

评审发现两个 P1 缺陷，已在 `scripts/agentic-evidence-merge-replay.mjs` 修复并新增单测（`tests/agentic-evidence-merge-replay.test.mjs`，8 项通过）：

1. **阻断分类重复计数**：原 `hardBlocked` 把所有非成功且不可恢复章节计入，已包含 preflight 级联，报告相加出现重复计数。现 `classifyBlocks()` 让 hardBlocked / preflightCascade / recoverableBlocks 三类互斥且依据 stage/severity 归因，三类相加 === 阻断总数。
2. **恢复率仅检查最后一个 envelope**：原 `extractTraceMetrics()` 只返回 `lastEnvelope`，非最后一项的可恢复记录被漏掉。现返回全部 `failureEnvelopes` + `hasRecoverableFailure`，`computeRecovery()` 遍历全部 envelope 统计，成功章节的中间可恢复失败也被计入。

## 检索路径与 coverage 负例

### 检索路径
Agentic ReAct 循环中的检索路径是非确定性的：模型在判断上下文充分时直接生成（`firstAction=draft, retrieval=0`），在判断需要补充信息时调用检索工具（`firstAction=tool_call, retrieval>0`）。

在多轮 replay 中，第 2 轮 ch1 曾出现 `firstAction=tool_call, retrieval=1`（控制台日志：`ch1 ok (152712ms) text=4694 firstAction=tool_call retrieval=1 mv=0/0`），证明检索路径在改造后代码中可用。大多数运行中模型判断上下文充分直接生成，这是预期行为。

### coverage 阻断负例
coverage 门在生产 replay 中始终通过（8/8），因为 `immutableFacts` 从 config 直接注入 `contextCoveredFacts`，按设计始终覆盖。coverage 门是安全网，仅在 context 编译遗漏关键事实时触发。

阻断行为由 5 个单元测试覆盖（`must-verify-coverage-gate-2.test.mjs`）：
- 不同人物相同谓语不匹配（"林婉儿的真实身份" vs "叶尘的真实身份"）
- 相同领域不同事实不匹配（"心法、功法是修士的修炼传承" vs "法宝是修士的重要对敌道具"）
- 相同人物相同事实正例匹配
- 主语包含关系正例匹配
- 不同人物不误判 P0

### 自动恢复率
本次所有 replay 运行均未发生 `model_timeout` 等可恢复失败（`recoverableBlocked=0`），因此 85% 自动恢复率门槛未被压力测试。恢复率报告为 N/A 是正确口径。

## 9 章独立快照对照（2026-08-12）

为解决串行运行被前章失败级联污染的问题，改造后新增 `--independent` 独立快照模式：每章从干净 workspace 重建并以第 1 章语义独立生成。运行结果（[报告](agentic-evidence-merge-replay.md)）：

| 指标 | 改造后独立快照（9 章） |
|---|---|
| 成功章节 | **8/9（88.9%）** |
| 阻断 | 1（story_preservation hard block）；preflight 级联 0、可恢复 0 |
| 独立 EvidenceDecision 调用 | **0** |
| trace 留存率 | 100%（9/9） |
| 未分类失败 | 0 |
| mustVerify 覆盖 | **64/64（100%）** |
| 事实硬错误章节 | 0 |
| 成功章节模型调用 | 2-3 次/章 |
| 单章输入 token | 4,696–9,731 |
| 总输入 token / 总延迟 | 69,201 / 1,723.5s |

**对照口径说明**：本表为改造后独立快照形态的"进入模型调用的成功章节"成本证据。改造前基线（cd0f3e4）为串行形态（仅 ch1 可比较：4 次调用、9k token、199.5s），与独立快照形态非同批运行，严格"同形态同批对照"需在改造前代码上跑同一 `--independent` 脚本。已确认的 ch1 逐调用收益（4→2 次、9,000→5,738 token、199.5s→179.2s）仍有效。

**自动恢复（运行时观测）**：本次 9 章运行时出现 2 次底层 HTTP 网关错误（ch2=524、ch5=520），均由模型调用层自动重试（attempt=1→2）恢复成功，最终 8/9 成功。这两次属 **HTTP 调用层重试**，不产生 FailureEnvelope（`hasRecoverableFailure=false`），因此恢复率 N/A 为正确口径。envelope 级（`severity=recoverable` / `gate=model_timeout`）的可恢复后成功样本在真实 replay 中未自然触发，其统计正确性由 `computeRecovery` 单测保障（遍历全部 envelope，含中间位置可恢复记录）。

## 多轮 replay 运行汇总

| 轮次 | 代码版本 | 成功 | EvidenceDecision | mustVerify | 检索路径 |
|---|---|---|---|---|---|
| 1 | 改造后（旧脚本） | 7/9 | 0 | 0/0（无 immutableFacts） | 无 |
| 2 | 改造后（旧脚本） | 2/9 | 0 | 0/0 | **ch1 retrieval=1** |
| 3 | 改造后（脚本修复后） | 0/9 | 0 | 0/0 | 无（FactGuard 误报级联） |
| 4 | 改造后（+immutableFacts） | 2/9 | 0 | **16/16（100%）** | 无 |
| 5 | **改造前（cd0f3e4）** | 1/9 | **2** | 0/0（旧代码无覆盖门） | 无 |
| 6 | 改造后（最终版） | 2/9 | 0 | 16/16（100%） | 无 |
| 7 | 改造后（独立快照） | 8/9 | 0 | 64/64（100%） | 无（2 次 HTTP 重试成功） |

## §9 三条 auditable trace 交付物状态（2026-08-12）

评审要求的三类生产级 auditable trace 已通过 `scripts/agentic-evidence-merge-trace-construction.mjs` 构造完成，归档于 `reports/agentic-evidence-merge-real/traces/`。三条 trace 均为受控环境生成（retrieval/coverage 使用 stub 模型 + eval-harness fixture，recovery 使用本地 HTTP 挂起服务器 + 100ms 请求超时），**非真实生产模型调用**。

| # | trace 类型 | 归档路径 | 关键证据字段 | 验证状态 |
|---|---|---|---|---|
| 1 | 检索后生成 trace | `traces/retrieval-b2-summary.json` + `traces/retrieval-b2-trajectory.jsonl` + `traces/retrieval-b2-candidate.txt` | `firstAction="tool_call"`, `actualRetrievalCalls=2`, `decisionMode="agentic_inline"` | ✓ 有效 |
| 2 | coverage 不足阻断 trace | `traces/coverage-ch1-quality-trace.json` + `traces/coverage-novelos-ch1-69df0c31-lineage.json` | `coverageResult.passed=false`, `mustVerifyCount=8`, `mustVerifyCoveredCount=5`, `unverifiedHighRisk=2 项 P0`, `gate="unverified_high_risk_facts"`, `severity="hard"` | ✓ 有效 |
| 3 | envelope 级 recoverable failure trace | `traces/recovery-timeout-ch1-quality-trace.json` + `traces/recovery-timeout-novelos-ch1-3c574c4f-lineage.json` | `gate="model_timeout"`, `severity="recoverable"`, `recoverable=true`, `lineage.failureReason="Fallback chain timeout: exceeded 100ms total budget"` | ✓ 有效 |

**trace 构造方式说明**：
- **retrieval trace**：使用 eval-harness b2 模式（`createAgenticRawCandidateSource` 生产代码 + stub 模型），fixture `F1-historical-fact` 触发模型调用检索工具。stub 模型非真实生产模型，trace 仅证明 ReAct 循环中检索路径可达，不证明真实模型的检索决策质量。
- **coverage trace**：受控 workspace（`agentic-evidence-merge-trace`），显式 outline 注入 4 个 `authorMustInclude` 事实，其中 2 个 P0（"叶尘的真实身份是上古剑修转世"、"天机宗追杀叶尘是因为他的前世身份"）不在 `immutableFacts` 中，触发 `must_verify_coverage_failed`。编排器在 Agentic 内部重试耗尽后升级为 `hard_block`。
- **recovery trace**：启动本地 HTTP 服务器接受请求但不响应（挂起 fetch），设置 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS=100` + `candidateTimeoutMs=100` 触发 `fetchWithTimeout` 的 `AbortController`，生成 `"Fallback chain timeout: exceeded 100ms total budget"` 错误消息。该消息通过 `streamFn catch → assistant.errorMessage → runAgentTurns.modelErrorMessage → makeFallback.failureReason → lineage.failureReason → classifyFailureKind` 链路被识别为 `model_timeout`，编排器据此生成 `severity=recoverable` envelope。

**已知限制**：
1. 三条 trace 均为受控环境生成，**非真实生产模型调用 trace**。真实生产级 trace 需在真实模型 quota 恢复后补齐。
2. recovery trace 使用 7 个 candidate session 目录（`recovery-timeout-novelos-ch1-{3c574c4f,aa900479,5e097983,e16aadb5,d95ea0fd,954332f6,a0ebe648}`），反映构造过程中的多次重试；最终成功生成 envelope 的 session 为 `3c574c4f`。
3. coverage trace 的 `hard_block` severity 是编排器在 Agentic 内部重试耗尽后的最终状态；coverage 门内部 envelope 标记 `recoverable=true, retryPlan="agent_loop_retry_with_explicit_must_verify_prompt"`，但编排器未将其作为可恢复失败处理（当前实现：coverage 失败 = hard block）。

## 验收状态（2026-08-12 最终口径）

> **实现完成；真实 replay 交付物待补齐。**

### 已确认达成

- ✅ 独立 EvidenceDecision 调用数 = 0（目标 0）
- ✅ 阻断分类互斥：hard / preflight / recoverable 三类相加 === 阻断总数
- ✅ mustVerify 覆盖门：64/64（100%），事实硬错误放行 = 0
- ✅ trace 运行时读取：9/9
- ✅ 三条 auditable trace 已构造并归档（retrieval / coverage / recovery）
- ✅ replay 脚本多场景化：9 个不同 CHAPTER_SCENARIOS（碎星剑觉醒/暗流涌动/神秘来客/尘心诀的代价/青鱼嘴之战/面具之下/海外来客的真相/三方会盟/封印松动）
- ✅ trace 归档持久化：`archiveChapterTrace()` 每章运行后立即复制到 `reports/agentic-evidence-merge-real/traces/`，共 15 份归档文件
- ✅ 单测覆盖：42 项（replay 统计/分类 8 项 + failureReason 传递/超时识别 14 项 + 其他 20 项）

### 仍存在的关键缺口

1. **改造前后非同形态对照**：改造前基线（cd0f3e4）为串行形态，改造后为独立快照形态；严格"同形态同批对照"需在改造前代码上跑同一 `--independent` 脚本。当前仅 ch1 逐调用对照有效（4→2 次、9,000→5,738 token、199.5s→179.2s）。
2. **三条 trace 为受控环境生成**：retrieval/coverage 使用 stub 模型，recovery 使用本地 HTTP 挂起服务器；**非真实生产模型调用 trace**。真实生产级 trace 需在真实模型 quota 恢复后补齐。
3. **524/520 HTTP 自动重试缺乏持久化证据**：本次运行中 ch2/ch5 的 HTTP 网关错误（524/520）由模型调用层自动重试恢复，但未产生 FailureEnvelope（`hasRecoverableFailure=false`），无持久化原始日志或 trace 字段。仅作为运行观察，不作为可回放证据。
4. **envelope 级 recoverable failure 后成功的真实样本未自然触发**：recovery trace 为受控构造（本地 HTTP 挂起 + 100ms 超时），非真实模型超时后重试成功的生产样本。其统计正确性由 `computeRecovery` 单测保障（遍历全部 envelope，含中间位置可恢复记录）。

### 待补齐交付物（需真实模型 quota 恢复后执行）

- [ ] 真实生产级检索后生成 trace（真实模型 firstAction=tool_call, retrieval>0）
- [ ] 真实生产级 coverage 不足阻断 trace（真实模型 mustVerify 未覆盖）
- [ ] 真实 envelope 级 recoverable failure 后成功 trace（真实模型超时后 chapter_level_retry 成功）
- [ ] 改造前代码（cd0f3e4）上跑同一 `--independent` 脚本，完成严格同形态同批对照
