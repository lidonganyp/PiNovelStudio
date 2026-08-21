# LANGUAGE-CALIBRATION-REAL-1 验收报告

**任务**：P1-4 LANGUAGE-CALIBRATION-REAL-1（[delete/任务列表/项目优化20260718.md](file:///delete/任务列表/项目优化20260718.md) L383-407）

## 模式与边界

- 运行模式：`stub`
- 验收状态：`COMPLETE_L0 (offline/stub)`
- 真实模型与正收益状态：`REQUIRES_AUTH`
- `--auth` 状态：未启用，退出码 2，fail-closed，不调用真实模型
- Git HEAD 证据边界：仅记录基准提交，不代表当前脏工作树的完整代码快照
- 冻结 raw manifest hash：`902a480df8ec02ae6cafddb425d972b2e52aec70dcb54b328dc0de3d27e3c91e`
- 冻结 raw manifest：`D:\CODE\PiNovelStudio\.pi\extensions\novel-studio\scripts\language-calibration-real-1\raw-manifest.json`

> ⚠️ **REQUIRES_AUTH 边界**：本切片为 offline stub 模式 + 真实 raw 文本 fixture。
> 真实 Doubao Seed 2.1 Pro (`v2_chinese_calibration`) + gpt-5.6-sol 异源 judge (`v2_literary_judge`) 调用属于 REQUIRES_AUTH，作为后续切片单独提交。
> 本报告不声称已验证真实模型正收益；只验证现有中文校准链路在 5 章真实 raw 文本上的端到端可达性。

## 5 章逐章结果

### chapter-01

- **raw hash**: `aab2c21657d05ebd0b759823c9603964cdad49bd34c6f59789cd1712d0d08829`
- **raw 长度**: 2402 字符
- **span excerpt**: `心脏还在胸腔里疯狂跳动`
- **span location**: start=70, end=81

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 3 | 主角行动词密度 1.25/千字 < 1.5 |
| voice_and_naturalness | false | 0 | 感知词项 0 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 voice_and_naturalness）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `心脏还在胸腔里疯狂跳动` (start=70, end=81)

#### 校准候选（EditorialCandidateGenerator）

- candidateHash: `651ffb0cb56ad29ed6543ff0973ec8025c61daf67fef85d7d68d43de485328a9`
- candidateRoute: `v2_chinese_calibration`
- candidateLength: 2402 字符

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

#### 退化检查（regression check）

- checked: true
- beforeSpanExcerpt: `心脏还在胸腔里疯狂跳动`
- afterSpanExcerpt: `心脏还在胸腔里剧烈跳动`
- spanChanged: true
- rawTextLength: 2402
- candidateTextLength: 2402
- lengthDelta: 0

### chapter-05

- **raw hash**: `88187cefac1386da0526cfb39cfb64d317b84a41d8d38df08aa006d8f7d9a323`
- **raw 长度**: 3301 字符
- **span excerpt**: `隐约感到一个黝黑的洞口`
- **span location**: start=2344, end=2355

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 3 | 主角行动词密度 0.91/千字 < 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 voice_and_naturalness）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `隐约感到一个黝黑的洞口` (start=2344, end=2355)

#### 校准候选（EditorialCandidateGenerator）

- candidateHash: `31c3736fd93b5f2714d8394b01510b0febfe90f08c186809e0f395b54b094e19`
- candidateRoute: `v2_chinese_calibration`
- candidateLength: 3302 字符

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

#### 退化检查（regression check）

- checked: true
- beforeSpanExcerpt: `隐约感到一个黝黑的洞口`
- afterSpanExcerpt: `隐约察觉到一个黝黑的洞`
- spanChanged: true
- rawTextLength: 3301
- candidateTextLength: 3302
- lengthDelta: 1

### chapter-08

- **raw hash**: `512ef929f7c9a95fc3edb89d0ae796d6ae702e12b39e5dc4ef038bbaaf4f3980`
- **raw 长度**: 1992 字符
- **span excerpt**: `内心的激动慢慢安静来下`
- **span location**: start=431, end=442

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | true | 2 | 主角行动词密度 1.00/千字 < 1.5 |
| voice_and_naturalness | false | 0 | 感知词项 0 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 voice_and_naturalness）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `内心的激动慢慢安静来下` (start=431, end=442)

#### 校准候选（EditorialCandidateGenerator）

- candidateHash: `a143c3402b56e723778c073dbe24a71810b864e21dcd12ef5c29cf618434b7cc`
- candidateRoute: `v2_chinese_calibration`
- candidateLength: 1992 字符

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

#### 退化检查（regression check）

- checked: true
- beforeSpanExcerpt: `内心的激动慢慢安静来下`
- afterSpanExcerpt: `内心的激动慢慢安静下来`
- spanChanged: true
- rawTextLength: 1992
- candidateTextLength: 1992
- lengthDelta: 0

### chapter-12

- **raw hash**: `e17de1fbbcd53bf86f12ad7299368238bfb92031b546ccbddcb9f1ec19f0205c`
- **raw 长度**: 2628 字符
- **span excerpt**: `隐约感到一股威压涌来`
- **span location**: start=1976, end=1986

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | false | 8 | 主角行动词密度 3.04/千字 ≥ 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 voice_and_naturalness）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `隐约感到一股威压涌来` (start=1976, end=1986)

#### 校准候选（EditorialCandidateGenerator）

- candidateHash: `89b5472f128502ae587e53c5526e3316db240cea85a78eac3f45cfa586386ffd`
- candidateRoute: `v2_chinese_calibration`
- candidateLength: 2629 字符

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

#### 退化检查（regression check）

- checked: true
- beforeSpanExcerpt: `隐约感到一股威压涌来`
- afterSpanExcerpt: `隐约察觉到一股威压涌`
- spanChanged: true
- rawTextLength: 2628
- candidateTextLength: 2629
- lengthDelta: 1

### chapter-17

- **raw hash**: `33c128340a764f57907fca6a5b5e537df02e634e1d4caf108fb84f100471ad43`
- **raw 长度**: 6492 字符
- **span excerpt**: `李一凡注意到他收紧的下颌线`
- **span location**: start=162, end=175

#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）

| opportunityType | triggered | evidenceSpanCount | reason |
|---|---|---|---|
| chapter_end_pressure | false | 0 | 章末区域已含钩子信号 |
| character_choice | false | 11 | 主角行动词密度 1.69/千字 ≥ 1.5 |
| voice_and_naturalness | false | 1 | 感知词项 1 < 3 |
| reader_payoff | false | 0 | 无开放承诺可评估 |
| information_dramatization | false | 0 | 未命中长说明段词项信号 |
| ensemble_function | false | 0 | 相关角色 1 < 3 |

#### EditorialHypothesis（手工构造 voice_and_naturalness）

- hypothesesGenerated: 1
- evidenceSpans:
  - excerpt: `李一凡注意到他收紧的下颌线` (start=162, end=175)

#### 校准候选（EditorialCandidateGenerator）

- candidateHash: `663e59ad8a0aeceb83b5bd185855a34e4e17417bb564371afb26c748b2f0386c`
- candidateRoute: `v2_chinese_calibration`
- candidateLength: 6491 字符

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

#### 退化检查（regression check）

- checked: true
- beforeSpanExcerpt: `李一凡注意到他收紧的下颌线`
- afterSpanExcerpt: `李一凡看见他收紧的下颌线。`
- spanChanged: true
- rawTextLength: 6492
- candidateTextLength: 6491
- lengthDelta: -1

## 5 章总体统计（Summary）

- **总章节数**: 5
- **校准候选生成数**: 5
- **候选生成通过率（passRate）**: 100.0%
- **FactGuard 通过数**: 5
- **越界拒绝数（spanBoundary）**: 1
- **raw 兜底数（rawFallback）**: 5
- **校准候选被选择数**: 0
- **错误数**: 0

## REQUIRES_AUTH 后续切片

本切片（stub 模式）已验证：
- ✅ 现有 voice_and_naturalness → v2_chinese_calibration 链路在 5 章真实 raw 文本上端到端可达
- ✅ 5/5 章通过 FactGuard，并分别完成匿名反向 A/B
- ✅ 冻结 raw manifest + 完整 SHA-256 前置校验，hash 不匹配立即阻断
- ✅ span 边界检查：独立 stub 越界候选已被生成器拒绝并保存结构化证据
- ✅ FactGuard 接入（真实 `checkCandidateFactGuard` 调用：6 类硬阻断检查 + 高影响新设定 review 诊断）
- ✅ PairwiseJudge 反向 A/B（两轮 verdict：confidence=uncertain 触发 needsReverseReview，reverseRound 非空）
- ✅ SelectionPolicy raw 兜底（tie 时保留 raw）

- ✅ 越界拒绝证据：`D:\CODE\PiNovelStudio\reports\language-calibration-real-1\stub-boundary-rejection.json`

后续 REQUIRES_AUTH 切片需要：
- 真实 Doubao Seed 2.1 Pro 调用（`v2_chinese_calibration`）
- 真实 gpt-5.6-sol 异源 judge（`v2_literary_judge`，反向 A/B）
- 5 章真实样本端到端结果归档
- 正收益证据（B4 vs B0 真实对比）

这些需要用户授权 + API 配额，作为后续 REQUIRES_AUTH 切片单独提交。

---

**生成时间**: 2026-08-20T05:19:28.451Z
**脚本**: `scripts/language-calibration-real-1/run-verification.mjs`
**模式**: stub
**Git HEAD（仅基准提交，不代表脏工作树快照）**: 7e5aaf59f3046ea1e307cc2e5f32664e58c42412