# AGENTIC-EVIDENCE-MERGE-1 P0 交付物清单

> 时间：2026-08-12  
> 范围：§9 最小交付证据补齐（不宣称整体验收完成）  
> 目录：`reports/agentic-evidence-merge-real/`

## 判定

| 交付项 | 状态 | 归档证据 |
|---|---|---|
| A. 成功直接生成 | ✅ | `traces/ch1-ch1-quality-trace.json` |
| B. 检索后生成 | ✅ | `traces/retrieval-b2-summary.json` + `retrieval-b2-trajectory.jsonl` |
| C. coverage 不足负例 | ✅ | `traces/coverage-ch1-quality-trace.json` + lineage/trajectory |
| D. recoverable envelope | ✅ | `traces/recovery-timeout-ch1-quality-trace.json` |
| 严格 9 章同形态前后基线 | ❌ 未做（P1） | — |
| 文档历史现时态收敛 | ⚠️ 未做（P2） | — |

## 样本明细

### A. 成功直接生成（真实 replay 归档）

- 文件：`traces/ch1-ch1-quality-trace.json`
- `decisionMode=agentic_inline`
- `firstAction=draft`
- `actualRetrievalCalls=0`
- `mustVerify=8/8`

### B. 检索后生成（生产代码路径 + stub 模型，受控）

- 来源：eval-harness b2 + `createAgenticRawCandidateSource` 生产闭包
- 文件：
  - `traces/retrieval-b2-summary.json`
  - `traces/retrieval-b2-trajectory.jsonl`
  - `traces/retrieval-b2-candidate.txt`
- 指标：
  - `decisionMode=agentic_inline`
  - `firstAction=tool_call`
  - `actualRetrievalCalls=2`
  - fixture：`F1-historical-fact`
- 说明：真实 9 章独立快照中模型多数判断上下文充分直接生成；本样本用受控 stub 证明检索路径可执行、可观测、可归档。trajectory 含 `search_narrative_evidence` tool_event。

### C. coverage 不足负例（统一主链路 + V2_FORCE_STUB）

- 文件：
  - `traces/coverage-ch1-quality-trace.json`
  - `traces/coverage-novelos-ch1-399a2889-lineage.json`
  - `traces/coverage-novelos-ch1-399a2889-evidence-plan.json`
  - `traces/coverage-novelos-ch1-399a2889-trajectory.jsonl`
- 结果：`status=blocked`
- 指标：
  - `stopReason=must_verify_coverage_failed`
  - `failureKind=must_verify_coverage_failed`
  - `mustVerifyCount=8`
  - `mustVerifyCoveredCount=5`
  - `coverageResult.passed=false`
  - `unverifiedHighRisk` 含 P0 身份类事实（作者章纲必须包含，但不在 immutableFacts/contextCoveredFacts）
- 可观测性修复：fallback 路径现保留 `firstAction/mustVerify*/coverageResult`，不再清零为 `not_run/0`

### D. recoverable envelope（受控超时）

- 文件：
  - `traces/recovery-timeout-ch1-quality-trace.json`
  - `traces/recovery-timeout-novelos-ch1-1734fb54-*`
- 触发方式：`PINOVEL_MODEL_REQUEST_TIMEOUT_MS=100` + 本地挂起 TCP（或同脚本当前实现）强制模型调用超时
- envelope：
  - `stage=novelos_agentic_generation`
  - `gate=model_timeout`
  - `severity=recoverable`
  - `recoverable=true`
  - `retryPlan.strategy=chapter_level_retry`
- 说明：本样本证明 envelope 级结构与分类可达；因超时预算持续生效，重试后仍失败，**不是**“recoverable → 最终成功”自然样本。HTTP 524/520 自动重试属于调用层，不计入 envelope 恢复率。

## 代码修复（支撑 C/D 可观测）

- `novelos/agent/narrative-agent-loop.ts`：`makeFallback` 保留 turns 的 `firstAction/actualRetrievalCalls/draftModelCalls`
- `novelos/agent/agentic-raw-candidate-source.ts`：`makeFallbackResult` 接受 observed lineage，保留 mustVerify/coverageResult
- `scripts/agentic-evidence-merge-trace-construction.mjs`：
  - 阻断路径从 `failureEnvelopes.evidence.stageResults.novelos` 抽取指标
  - 归档 novelos session（lineage/evidence-plan/trajectory）

## 验证

```text
npm run build  # 通过
node --import ./tests/setup-test-env.mjs --test   tests/agentic-evidence-merge-replay.test.mjs   tests/must-verify-coverage-production-wiring.test.mjs
# 10 pass / 0 fail
node scripts/agentic-evidence-merge-trace-construction.mjs --all
# retrieval/coverage/recovery 三类均产出归档
```

## 仍 blocked 的验收项

1. **§7.8 严格同形态 9 章改造前后基线**（P1）——需在改造前 commit 跑同一 `--independent` 脚本  
2. **§7.10 / 文档现时态收敛**（P2）——`docs/evidence/evidence-decision-prompt-inventory.md` 等历史正文  
3. **真实非受控检索成功 + recoverable→成功** 自然样本：本次用受控构造满足交付物形态；自然触发仍依赖模型/网络非确定性

## 总判定

- 核心实现：Verified complete  
- P0 三类交付 trace：Verified complete（本清单）  
- 整体计划验收：**仍 blocked**（P1/P2 未齐）
