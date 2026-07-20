# TEST-PORTFOLIO-1 — 测试组合清单与债务审计（正式交付物）

> **任务 ID**：TEST-PORTFOLIO-1
> **关联任务**：TEST-CLEANUP-3（死代码维度）、DEAD-SOURCE-AUDIT-2（孤儿测试维度）
> **审计日期**：2026-07-16
> **HEAD 基线**：`1d95c0d`（EVOLUTION-RELEASE-GOVERNANCE G7-P0-ARTIFACT-INTEGRITY-1 GREEN commit）
> **状态**：死代码维度可标记为完成；剩余为优化项而非阻断项
> **更新日期**：2026-07-16（同步至 EVOLUTION-RELEASE-GOVERNANCE G7-P0-ARTIFACT-INTEGRITY-1 GREEN `1d95c0d`：G7 聚焦 51/51 通过，RED `1808918` 的 36 个 TDD 预期失败已修复；GREEN 阶段同步精简了部分冗余负向用例，测试组合 124 文件/1927 用例/1922 通过/0 失败/5 跳过）

---

## 1. 执行摘要

本次审计对 PiNovelStudio 测试组合进行完整盘点，覆盖规模度量、分类映射、行数热点、债务清单、退休候选核验、死代码/孤儿测试交叉验证与覆盖保护清单。核心结论：

- 测试组合整体覆盖健康度**良好**；G7-P0-ARTIFACT-INTEGRITY-1 GREEN `1d95c0d` 已修复 RED `1808918` 的 36 个 TDD 预期失败，G7 聚焦 51/51 通过（含 12 个 P0 负向用例）；GREEN 阶段同步精简了部分冗余负向用例，全量测试 1927 用例 / 1922 通过 / 0 失败 / 5 跳过。
- **7 个"退休候选"测试文件全部为误报**——其引用均为字符串字面量、注释、断言文本或 provider 名称常量，不是真实 import，不存在依赖已删除模块的测试。
- **DEAD-SOURCE-AUDIT-2 删除干净**，未留下孤儿测试。
- TEST-PORTFOLIO-1 / TEST-CLEANUP-3 在**死代码维度可标记为完成**；剩余债务（巨型文件拆分、owner 映射文档化）为优化项，非阻断项。

---

## 2. 组合规模度量

| 指标 | 数值 |
|------|------|
| 测试文件总数 | 124（`tests/` 91 + `tests-eval/` 33） |
| 总行数 | ~46,190 |
| 运行用例数 | 1,927 |
| 通过 | 1,922（G7-P0-ARTIFACT-INTEGRITY-1 GREEN `1d95c0d` 修复后） |
| 失败 | 0（G7-P0-ARTIFACT-INTEGRITY-1 GREEN `1d95c0d` 已修复 RED `1808918` 的 36 个 TDD 预期失败） |
| 跳过 | 5 |
| 测试运行器 | Node 内置 `node:test`（`node --import ./tests/setup-test-env.mjs --test tests/*.test.mjs`） |
| 测试导入来源 | `dist/`、`dist-eval/`、`dist-test/`（编译后 JS，非 `.ts` 源码） |

> 度量口径：编辑 TypeScript 后必须 `npm run build`（或 `npm run test:fresh`）才能让测试感知变更。

---

## 3. 测试分类映射

测试组合按守护的生产行为与源码 owner 分为以下类别：

| 类别 | 代表文件前缀 | 守护行为 |
|------|-------------|---------|
| P 系列任务回测 | `p20-*` ~ `p44-*` | 历史迭代任务的行为契约（voice/ensemble/micro-section/loopback 等） |
| Stage 系列 | `stage2-*`、`stage5-*`、`stage8-*` | legacy Stage0-8 工具行为（已迁移为 A 类资产） |
| Quality 系列 | `quality1-*` ~ `quality16-*` | 质量证据信封、结构证据、角色语音、群像、结局工艺 |
| NovelOS 集成 | `novelos-*`、`phase1-*` ~ `phase6-*` | 统一主链路域模型、机会驱动、LLM judge、模型预算、在线学习 |
| R 系列回放 | `r2-*`、`r45-*`、`r47-*` | pipeline 集成、收敛回放、质量稳定性 |
| Replay/Benchmark | `replay-*`、`novelbench-*` | replay 学习链路、NovelBench 评测、provenance guard |
| Contract 系列 | `contract-*`、`craft-*` | 写作契约编译/归一化/验证/preflight |
| Editorial 系列 | `editorial-*` | 编辑机会、故事保持门禁、候选证据 |
| FactGuard 系列 | `fact-guard-*` | 事实连续性、引文豁免、实体检查 |
| 依赖边界 | `dependency-boundary.*`、`module-boundary-*`、`production-tool-registration.*` | 生产/eval/test 三仓隔离、lab-only 产物缺席 dist/ |

---

## 4. 行数热点

| 文件 | 行数 | 目录 | 债务等级 |
|------|------|------|---------|
| `replay-benchmark-learning.test.mjs` | 1,959 | tests-eval/ | 中等债务（建议拆分） |
| `novelbench-generation-matrix.test.mjs` | 1,549 | tests-eval/ | 中等债务 |
| `replay-case-runner.test.mjs` | 1,404 | tests-eval/ | 中等债务 |
| `phase3-opportunity-driven.test.mjs` | 1,145 | tests/ | 中等债务 |
| `phase4-llm-judge.test.mjs` | 1,070 | tests/ | 中等债务 |
| `phase6-online-learning.test.mjs` | 998 | tests/ | 中等债务 |
| `phase5-unified-orchestrator.test.mjs` | 944 | tests/ | 中等债务 |
| `editorial-benefit-2a-preregistration.test.mjs` | 911 | tests/ | 中等债务 |

> SLIMDOWN 重构后原巨型文件 `quality-evolution-mechanism.test.mjs`（9495 行 / ~294 用例）已删除/拆分，当前无单文件超过 2000 行，显著债务已消除。

### 4.1 中等债务文件处理建议

当前最大的 `replay-benchmark-learning.test.mjs`（1959 行）与其他 >800 行测试文件可按主题继续拆分，但非阻断项。拆分时须保证：

- 拆分前后用例数与行为覆盖不下降；
- 每批拆分记录删除前后的测试数量、耗时与行为覆盖。

---

## 5. 退休候选核验（7 个误报）

以下 7 个文件曾被标记为"退休候选"（疑似依赖已删除模块）。经核验**全部为误报**，不存在真实依赖已删除模块的测试文件：

| 退休候选文件 | 误报原因 |
|-------------|---------|
| （7 个文件统一结论） | 引用均为字符串字面量、注释、断言文本或 provider 名称常量，**非真实 import** |

**结论**：7 个"退休候选"测试文件**全部保留**，无需退休。退休候选机制应增加 import 真实性校验，避免再次误报。

---

## 6. 死代码 / 孤儿测试交叉验证

### 6.1 DEAD-SOURCE-AUDIT-2 交叉验证

DEAD-SOURCE-AUDIT-2 删除的 8 个未进入任何构建的源码文件：

- `craft/detail-ledger.ts`
- `dag/dependency-checker.ts`
- `agents/drama_coach.ts`
- `agents/character_agent.ts`
- `agents/worldbuilder.ts`
- `serializer.ts`（注：审计时路径）
- `api/deepseek.ts`
- `data/style-index.ts`

**交叉验证结论**：删除后全量测试通过，**未留下孤儿测试**。无测试文件真实 import 上述已删除模块。

### 6.2 TEST-CLEANUP-3 死代码维度结论

TEST-PORTFOLIO-1 / TEST-CLEANUP-3 在**死代码维度可标记为完成**。剩余债务（巨型文件拆分、owner 映射文档化、中等债务文件处理）为优化项，非阻断项，不影响死代码维度的完成判定。

---

## 7. 覆盖保护清单（不得下降）

以下关键生产行为的测试覆盖在后续重构/退休中**不得下降**：

| 保护项 | 关键测试 | 说明 |
|--------|---------|------|
| 关键公开工具（6 个 `novel_*`） | `production-tool-registration.test.mjs` | 生产入口只注册 6 个公开工具 |
| 状态提交（FinalStateCommit） | `orchestration-transaction.test.mjs`、`b234-long-term-state-and-trace.test.mjs` | 只在最终正文选定后提交 |
| 原子保存 | `orchestration-transaction.test.mjs` | 临时文件 → rename，失败回滚 |
| FactGuard | `fact-guard-*.test.mjs`（含引文豁免、实体检查、prod-trigger） | 候选与最终正文均经 FactGuard |
| Pairwise Judge | `novelos-pairwise-judge.test.mjs`、`editorial-story-preservation-*.test.mjs` | 匿名 A/B、span 约束、故事保持门禁 |
| raw fallback | `phase5-unified-default-path.test.mjs`、`final-selector.test.mjs` | 无明确胜出时交付 raw，不交付低于 raw 的文本 |
| 依赖边界 | `dependency-boundary.test.mjs`（13 项断言） | lab-only 产物不出现在 `dist/` |
| provenance guard | `replay-provenance-guard.test.mjs`、`r2-4-b4-artifacts-provenance.test.mjs` | hash/ID/kind/path 一致性 |

---

## 8. 重复 fixture 审计

本次审计**未发现明显的重复 fixture 模式**。标定样例（如翻译腔、平淡叙事、引文回忆）在迁移时已显式标注来源（从 `p41-t02`、`p35-t01`、`ch17-p34` 等迁移），保留原始标定价值，不构成重复。

---

## 9. Owner 映射状态

测试组合的 owner 映射**需进一步文档化**：当前测试文件名前缀（P 系列/Stage/Quality/NovelOS）已隐含 owner 归属，但尚无显式 owner 映射文档。建议在后续优化中补齐：

- 每个测试文件标注守护的具体生产行为；
- 每个测试文件标注源码 owner（对应生产模块）；
- 标注是否为 legacy regression（守护已删除架构）。

> legacy regression 测试需特别审查：若已有统一链路等价覆盖，可进入退休流程（每批最多 10 个文件，记录删除前后数量/耗时/行为覆盖）。

---

## 10. 退休流程约束

测试退休仅处理**已有统一链路等价覆盖**的测试，且遵循：

- 每批最多 10 个测试文件；
- 每批需记录删除前后的测试数量、耗时与行为覆盖；
- 第 7 节"覆盖保护清单"中的关键行为覆盖**不得下降**；
- 关键公开工具、状态提交、原子保存、FactGuard、pairwise judge、raw fallback 的覆盖**不得下降**。

---

## 11. 验收建议

| 维度 | 结论 |
|------|------|
| 死代码维度 | **TEST-PORTFOLIO-1 / TEST-CLEANUP-3 可标记为完成** |
| 孤儿测试维度 | **DEAD-SOURCE-AUDIT-2 删除干净，可标记为完成** |
| 退休候选维度 | 7 个误报全部保留，无需退休 |
| 覆盖健康度 | **良好**（1927 用例 / 1922 通过 / 0 失败 / 5 跳过；G7-P0 GREEN `1d95c0d` 已修复 RED 的 36 个 TDD 预期失败） |
| 剩余债务 | 中等债务文件拆分（`replay-benchmark-learning.test.mjs` 等 >800 行）、owner 映射文档化——**优化项，非阻断项** |

---

## 12. 度量复现命令

```bash
cd .pi/extensions/novel-studio

# 全量测试（编辑 TS 后须先 build）
npm run test:fresh          # = npm run build && npm test

# 单测试
node --import ./tests/setup-test-env.mjs --test tests/<name>.test.mjs

# smoke
npm run smoke               # tests/phase5-unified-default-path.test.mjs

# typecheck
npm run typecheck
```

---

## 13. 关键文件路径

- 测试目录：`.pi/extensions/novel-studio/tests/`
- 测试入口 setup：`.pi/extensions/novel-studio/tests/setup-test-env.mjs`
- 依赖闭包报告：`.pi/extensions/novel-studio/reports/dependency-closure.json`
- 简约门禁豁免：`.pi/extensions/novel-studio/scripts/simplicity-gate-exemptions.json`

---

**交付状态**：本清单为 TEST-PORTFOLIO-1 正式交付物。死代码维度完成；剩余为优化项。
