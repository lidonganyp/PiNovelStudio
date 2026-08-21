# ENDING-PRESSURE-REAL-1 验收报告

**任务**：P1-5 ENDING-PRESSURE-REAL-1（[delete/任务列表/项目优化20260718.md](file:///delete/任务列表/项目优化20260718.md) L411-432）

## 模式与边界

- 运行模式：`stub`
- **验收状态分层（最终标记，2026-07-19 核验结论）**：
  - **真实质量验收机制**：`COMPLETE_L0` — [`real-quality-acceptance.ts`](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/v2/core/real-quality-acceptance.ts) 中 `verifyEndingPressureReal` + `npm run verify:real-quality --kind ending` CLI（[scripts/real-quality-acceptance.mjs](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/scripts/real-quality-acceptance.mjs)，未通过退出码 2）+ 聚焦测试通过、三构建通过。
  - **离线 stub 端到端可达性**：`COMPLETE_L0 (offline/stub)` — 5 章真实 raw 文本 + 手工构造 `chapter_end_pressure` hypothesis + stub `v2_amplified` 候选 + 反向 A/B + SelectionPolicy raw 兜底；不调用真实模型。
  - **真实模型运行 + 证据防伪 + 文学净正收益**：`REQUIRES_AUTH / Partial` — 仓库中无符合 schema 的五章真实 Claude Opus 4.6 + gpt-5.6-sol evidence 输入文件；provenance 校验只检查字符串/哈希格式，未核验 `tracePath` 存在、request ID 与 trace 对应、响应 hash 与落盘原始响应一致，因此目前仍可伪造。
- `--auth` 状态：未启用，退出码 2，fail-closed，不调用真实模型
- Git HEAD 证据边界：仅记录基准提交，不代表当前脏工作树的完整代码快照
- 冻结 raw manifest hash：`4acaf7e53362647046d6e42c968d37c97e1d8a43ceb5f0463ef4a4010a7b020a`
- 冻结 raw manifest：`D:\CODE\PiNovelStudio\.pi\extensions\novel-studio\scripts\ending-pressure-real-1\raw-manifest.json`

> ⚠️ **REQUIRES_AUTH 边界**：本切片为 offline stub 模式 + 真实 raw 文本 fixture。
> 真实 Claude Opus 4.6 (`v2_amplified`) + gpt-5.6-sol 异源 judge (`v2_literary_judge`) 调用属于 REQUIRES_AUTH，作为后续切片单独提交。
> 本报告不声称已验证真实模型正收益；只验证现有章末压力链路在 5 章真实 raw 文本上的端到端可达性，以及真实质量验收**机制**（fail-closed 校验器 + CLI + 测试套件）已就绪。

## 5 章逐章结果

### chapter-01

- **raw hash**: `aab2c21657d05ebd0b759823c9603964cdad49bd34c6f59789cd1712d0d08829`
- **raw 长度**: 2402 字符
- **章末锚点**: `李一凡找了根勉强安全点的树杈做依靠，然后便沉沉地昏睡过去。`
- **锚点位置**: start=2372, end=2401
- **追加钩子句**: `睡梦中，那草木气息似乎淡了下去，远处隐约传来低沉的呼吸声。`

#### 因果压力 + PatternMemory 钩子检查

- causalEndPressure.value: `昏睡后巢穴附近的未知威胁逼近`
- causalEndPressure.sourceRef: `seed:ch01:environment_danger`
- currentHookType: `approaching_threat`
- recentHookTypes: ["cost_reveal","suspended_action"]
- PatternMemory 检查: ok (近期重复 0 次)

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 3 | 主角行动词密度 1.25/千字 < 1.5 |
| voice_and_naturalness | false | 0 | 感知词项 0 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 chapter_end_pressure）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `李一凡找了根勉强安全点的树杈做依靠，然后便沉沉地昏睡过去。` (start=2372, end=2401)

#### 章末压力候选（EditorialCandidateGenerator · v2_amplified 路由）

- candidateHash: `79f710c8bbd3923658515da4118ab313afb3b38027d6898d6294e612701531aa`
- candidateRoute: `v2_amplified`
- candidateLength: 2431 字符

#### FactGuard 检查

- factGuardPassed: true
- factGuardReason: FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）

#### PairwiseJudge 反向 A/B（JudgeArbitrator）

- judgeRounds: 2
- judgeVerdictFirst: [object Object]
- judgeVerdictReverse: [object Object]
- judgeConflicted: false
- judgeAuditSummary: 两轮一致确认（首轮 winner=null，反向 winner=null）：两轮均判 tie/不确定，保留 raw（首轮 confidence=uncertain）

#### 最终选择（SelectionPolicy）

- finalSelectedSource: `raw`
- finalSelectedCandidateId: `candidate:raw:chapter-01`

#### 退化检查（regression check · 章末追加区域）

- checked: true
- appendedStart: 2402
- appendedEnd: 2431
- appendedExcerpt: `睡梦中，那草木气息似乎淡了下去，远处隐约传来低沉的呼吸声。`
- appendedLength: 29
- rawTextLength: 2402
- candidateTextLength: 2431
- lengthDelta: 29
- appendedInTailRegion: true

### chapter-05

- **raw hash**: `88187cefac1386da0526cfb39cfb64d317b84a41d8d38df08aa006d8f7d9a323`
- **raw 长度**: 3301 字符
- **章末锚点**: `他放下筷子，起身去开门。`
- **锚点位置**: start=3288, end=3300
- **追加钩子句**: `门打开的瞬间，他看清了来人——制服上的徽记，黑水。`

#### 因果压力 + PatternMemory 钩子检查

- causalEndPressure.value: `体制内来客身份未明，敲门声打断早餐`
- causalEndPressure.sourceRef: `seed:ch05:institutional_visitor`
- currentHookType: `identity_mystery`
- recentHookTypes: ["cost_reveal"]
- PatternMemory 检查: ok (近期重复 0 次)

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 3 | 主角行动词密度 0.91/千字 < 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 chapter_end_pressure）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `他放下筷子，起身去开门。` (start=3288, end=3300)

#### 章末压力候选（EditorialCandidateGenerator · v2_amplified 路由）

- candidateHash: `eabaa06bc8157fd66f8ad2e4804a622ac44bb0eb84a7a29a7158b53a0b14264b`
- candidateRoute: `v2_amplified`
- candidateLength: 3326 字符

#### FactGuard 检查

- factGuardPassed: true
- factGuardReason: FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）

#### PairwiseJudge 反向 A/B（JudgeArbitrator）

- judgeRounds: 2
- judgeVerdictFirst: [object Object]
- judgeVerdictReverse: [object Object]
- judgeConflicted: false
- judgeAuditSummary: 两轮一致确认（首轮 winner=null，反向 winner=null）：两轮均判 tie/不确定，保留 raw（首轮 confidence=uncertain）

#### 最终选择（SelectionPolicy）

- finalSelectedSource: `raw`
- finalSelectedCandidateId: `candidate:raw:chapter-05`

#### 退化检查（regression check · 章末追加区域）

- checked: true
- appendedStart: 3301
- appendedEnd: 3326
- appendedExcerpt: `门打开的瞬间，他看清了来人——制服上的徽记，黑水。`
- appendedLength: 25
- rawTextLength: 3301
- candidateTextLength: 3326
- lengthDelta: 25
- appendedInTailRegion: true

### chapter-08

- **raw hash**: `512ef929f7c9a95fc3edb89d0ae796d6ae702e12b39e5dc4ef038bbaaf4f3980`
- **raw 长度**: 1992 字符
- **章末锚点**: `也没有关注到小妖已经很久没有联系过自己了。`
- **锚点位置**: start=1970, end=1991
- **追加钩子句**: `门外传来了脚步声——比约定时间晚了整整三个时辰。`

#### 因果压力 + PatternMemory 钩子检查

- causalEndPressure.value: `队长约定逾期 + 小妖失联双重信号`
- causalEndPressure.sourceRef: `seed:ch08:missed_appointments`
- currentHookType: `suspended_action`
- recentHookTypes: ["cost_reveal","approaching_threat"]
- PatternMemory 检查: ok (近期重复 0 次)

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 2 | 主角行动词密度 1.00/千字 < 1.5 |
| voice_and_naturalness | false | 0 | 感知词项 0 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 chapter_end_pressure）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `也没有关注到小妖已经很久没有联系过自己了。` (start=1970, end=1991)

#### 章末压力候选（EditorialCandidateGenerator · v2_amplified 路由）

- candidateHash: `5aebdd2763d691d3335a0e1c989dedf95cace83daf31edb5a4b7c6d4d621fadc`
- candidateRoute: `v2_amplified`
- candidateLength: 2016 字符

#### FactGuard 检查

- factGuardPassed: true
- factGuardReason: FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）

#### PairwiseJudge 反向 A/B（JudgeArbitrator）

- judgeRounds: 2
- judgeVerdictFirst: [object Object]
- judgeVerdictReverse: [object Object]
- judgeConflicted: false
- judgeAuditSummary: 两轮一致确认（首轮 winner=null，反向 winner=null）：两轮均判 tie/不确定，保留 raw（首轮 confidence=uncertain）

#### 最终选择（SelectionPolicy）

- finalSelectedSource: `raw`
- finalSelectedCandidateId: `candidate:raw:chapter-08`

#### 退化检查（regression check · 章末追加区域）

- checked: true
- appendedStart: 1992
- appendedEnd: 2016
- appendedExcerpt: `门外传来了脚步声——比约定时间晚了整整三个时辰。`
- appendedLength: 24
- rawTextLength: 1992
- candidateTextLength: 2016
- lengthDelta: 24
- appendedInTailRegion: true

### chapter-12

- **raw hash**: `e17de1fbbcd53bf86f12ad7299368238bfb92031b546ccbddcb9f1ec19f0205c`
- **raw 长度**: 2628 字符
- **章末锚点**: `“不错，比我想象的快。”`
- **锚点位置**: start=2585, end=2597
- **追加钩子句**: `那团火，又轻微地动了一下——这一次，是朝他的方向。`

#### 因果压力 + PatternMemory 钩子检查

- causalEndPressure.value: `火团第一次异动后的未知回应`
- causalEndPressure.sourceRef: `seed:ch12:fire_movement`
- currentHookType: `mystery_response`
- recentHookTypes: ["cost_reveal"]
- PatternMemory 检查: ok (近期重复 0 次)

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | false | 8 | 主角行动词密度 3.04/千字 ≥ 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 chapter_end_pressure）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `“不错，比我想象的快。”` (start=2585, end=2597)

#### 章末压力候选（EditorialCandidateGenerator · v2_amplified 路由）

- candidateHash: `8699886410a295cc333f13d645b47e26a544f1ca84ca3f7e0a7f858dd270dcd5`
- candidateRoute: `v2_amplified`
- candidateLength: 2653 字符

#### FactGuard 检查

- factGuardPassed: true
- factGuardReason: FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）

#### PairwiseJudge 反向 A/B（JudgeArbitrator）

- judgeRounds: 2
- judgeVerdictFirst: [object Object]
- judgeVerdictReverse: [object Object]
- judgeConflicted: false
- judgeAuditSummary: 两轮一致确认（首轮 winner=null，反向 winner=null）：两轮均判 tie/不确定，保留 raw（首轮 confidence=uncertain）

#### 最终选择（SelectionPolicy）

- finalSelectedSource: `raw`
- finalSelectedCandidateId: `candidate:raw:chapter-12`

#### 退化检查（regression check · 章末追加区域）

- checked: true
- appendedStart: 2628
- appendedEnd: 2653
- appendedExcerpt: `那团火，又轻微地动了一下——这一次，是朝他的方向。`
- appendedLength: 25
- rawTextLength: 2628
- candidateTextLength: 2653
- lengthDelta: 25
- appendedInTailRegion: true

### chapter-17

- **raw hash**: `33c128340a764f57907fca6a5b5e537df02e634e1d4caf108fb84f100471ad43`
- **raw 长度**: 6492 字符
- **章末锚点**: `像某种宣告。`
- **锚点位置**: start=6486, end=6492
- **追加钩子句**: `口袋里的鳞片微微发烫，仿佛在回应他刚刚想到的那个局。`

#### 因果压力 + PatternMemory 钩子检查

- causalEndPressure.value: `骨节异响暗示力量变化的下一步`
- causalEndPressure.sourceRef: `seed:ch17:bone_sound`
- currentHookType: `power_hint`
- recentHookTypes: ["cost_reveal"]
- PatternMemory 检查: ok (近期重复 0 次)

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | false | 11 | 主角行动词密度 1.69/千字 ≥ 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 chapter_end_pressure）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `像某种宣告。` (start=6486, end=6492)

#### 章末压力候选（EditorialCandidateGenerator · v2_amplified 路由）

- candidateHash: `46c002943d81efa86ea2841b7e4ec3d65d0cbe1b1b64aeedad3053c8a67e0558`
- candidateRoute: `v2_amplified`
- candidateLength: 6518 字符

#### FactGuard 检查

- factGuardPassed: true
- factGuardReason: FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）

#### PairwiseJudge 反向 A/B（JudgeArbitrator）

- judgeRounds: 2
- judgeVerdictFirst: [object Object]
- judgeVerdictReverse: [object Object]
- judgeConflicted: false
- judgeAuditSummary: 两轮一致确认（首轮 winner=null，反向 winner=null）：两轮均判 tie/不确定，保留 raw（首轮 confidence=uncertain）

#### 最终选择（SelectionPolicy）

- finalSelectedSource: `raw`
- finalSelectedCandidateId: `candidate:raw:chapter-17`

#### 退化检查（regression check · 章末追加区域）

- checked: true
- appendedStart: 6492
- appendedEnd: 6518
- appendedExcerpt: `口袋里的鳞片微微发烫，仿佛在回应他刚刚想到的那个局。`
- appendedLength: 26
- rawTextLength: 6492
- candidateTextLength: 6518
- lengthDelta: 26
- appendedInTailRegion: true

## 5 章总体统计（Summary）

- **总章节数**: 5
- **章末压力候选生成数**: 5
- **候选生成通过率（passRate）**: 100.0%
- **FactGuard 通过数**: 5
- **章末区域限制通过数（tailRegionOk）**: 5
- **causalEndPressure.sourceRef 完整数**: 5
- **PatternMemory 钩子检查通过数**: 5
- **非章末候选拒绝数（nonTailRejection）**: 1
- **raw 兜底数（rawFallback）**: 5
- **章末压力候选被选择数**: 0
- **错误数**: 0

## REQUIRES_AUTH 后续切片

### 已完成（机制层 COMPLETE_L0）

- ✅ **真实质量验收机制**：[`real-quality-acceptance.ts`](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/v2/core/real-quality-acceptance.ts) 中 `verifyEndingPressureReal` 提供 fail-closed 校验器（5 章 / 真实 provenance / 反向 A/B / span 边界 / FactGuard / StoryPreservation / PatternMemory 钩子重复 / 章末区域限制 / causalEndPressure.sourceRef / 净正收益判定），`npm run verify:real-quality --kind ending` CLI 在未通过时退出码 2；聚焦测试与三构建通过。
- ✅ 现有 chapter_end_pressure → v2_amplified 链路在 5 章真实 raw 文本上端到端可达（offline/stub）
- ✅ 5/5 章通过 FactGuard，并分别完成匿名反向 A/B
- ✅ 冻结 raw manifest + 完整 SHA-256 前置校验，hash 不匹配立即阻断
- ✅ PatternMemory 钩子重复检查：5 章当前钩子类型在 recentHookTypes 中重复 0 次或 1 次（< 阈值 2），全部通过
- ✅ 章末区域限制：5 章候选追加位置均 ≥ rawText.length * 0.5（章末区域）
- ✅ causalEndPressure.sourceRef 完整：5 章均指向本章因果源（seed:ch{N}:...）
- ✅ 非章末候选拒绝：独立 stub 中部追加候选已被 verifyEndingPressureReal 章末区域检查识别为越界
- ✅ FactGuard 接入（真实 `checkCandidateFactGuard` 调用：6 类硬阻断检查 + 高影响新设定 review 诊断）
- ✅ PairwiseJudge 反向 A/B（两轮 verdict：confidence=uncertain 触发 needsReverseReview，reverseRound 非空）
- ✅ SelectionPolicy raw 兜底（tie 时保留 raw）
- ✅ 非章末候选拒绝证据：`D:\CODE\PiNovelStudio\reports\ending-pressure-real-1\stub-non-tail-rejection.json`

### 仍未完成（真实运行层 REQUIRES_AUTH / Partial）

按 2026-07-19 核验结论，以下三点仍属 `REQUIRES_AUTH / Partial`，未通过完整验收：

1. **仓库中无五章真实 evidence 输入文件**：当前没有符合 `EndingPressureSample` schema 的真实 Claude Opus 4.6 + gpt-5.6-sol evidence 落盘文件；本切片的 stub 候选用人工指定的章末锚点 + 手工追加钩子句，**不是真实模型生成证据**。
2. **provenance 防伪：Layer A `COMPLETE_L0`，Layer B `REQUIRES_AUTH`**：
    - **Layer A 已修复**（`v2/core/real-quality-acceptance.ts:validateRealProvenance`）：tracePath 存在性 + 路径穿越（含符号链接）+ JSON schema 完整性 + generator/judge model 与 trace.llmTimings 一致性。13/13 测试通过。
    - **Layer B 待 REQUIRES_AUTH 切片**：requestId/responseHash 落盘 + 集合 membership 校验。
    - **缺口原因**：`LLMTimingEntry`（`craft/quality-trace-recorder.ts:310-329`）当前不存储 `requestId` 和 `responseHash` 字段；修复需扩展 trace schema + 修改 `api/fallback-manager.ts` 3 个 emit 站点（约 line 553/742/920）+ 修改多个 provider 适配器。后续与真实 gpt-5.6-sol 调用验收合并切片。
3. **文学净正收益证据缺失**：当前 5 章 stub 候选均 tie → SelectionPolicy raw 兜底，`candidateClearWins=0`；未产出 B4 vs B0 真实对比的净正收益证据。

### 后续 REQUIRES_AUTH 切片需要

- 真实 Claude Opus 4.6 调用（`v2_amplified`），落盘 5 章真实 `EndingPressureSample` evidence 文件
- 真实 gpt-5.6-sol 异源 judge（`v2_literary_judge`，反向 A/B），落盘 request ID + 响应 hash + tracePath
- provenance 防伪补齐：`tracePath` 存在性校验 + request ID↔trace 对应 + 响应 hash↔落盘原始响应一致
- 5 章真实样本端到端结果归档
- 正收益证据（B4 vs B0 真实对比）

这些需要用户授权 + API 配额，作为后续 REQUIRES_AUTH 切片单独提交。**在该切片完成并通过 `npm run verify:real-quality --kind ending` 真实 evidence 校验之前，ENDING-PRESSURE-REAL-1 整体不得标记为 `COMPLETE_L0`，只能标记为「机制 COMPLETE_L0 / 真实运行 REQUIRES_AUTH」**。

---

**生成时间**: 2026-08-20T05:17:45.199Z
**脚本**: `scripts/ending-pressure-real-1/run-verification.mjs`
**模式**: stub
**Git HEAD（仅基准提交，不代表脏工作树快照）**: 7e5aaf59f3046ea1e307cc2e5f32664e58c42412