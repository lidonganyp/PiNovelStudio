# rel-prod-104 生产迁移声明

> 迁移日期：2026-08-11
> releaseId：rel-prod-104
> parentReleaseId：rel-prod-103
> changeClass：R1
> approvalRef：approval-rel-prod-104-1786448975869-e1f76869
> approvalTransport：network（真实 gpt5.6-sol 网络代理审批）
> environmentFingerprint：6e1e1387539001e6164a93f5113e30c66f806b56ee3bc00f54af1c14ace9017f
> codeCommit：a05d9d92e9226f8f5cd109fe4a25edb1fdc86617

## 1. 迁移范围

本次迁移仅包含已经验证的安全能力：

| 能力 | 验证状态 |
|------|---------|
| Tool Interface Contract v1 加固 | baseline v2 + 7/7 测试通过 |
| 9 个专用工具保持默认 | baseline v2 确认（每章固定工具集） |
| input/output/reasoning/cached token 与耗时遥测 | LLMTimingEntry 扩展 + 单元测试通过 |
| FailureEnvelope 遥测 | 治理方案 Phase 1 整改 + 测试通过 |
| 相关 trace 和诊断能力 | baseline v2 的 9 条 trace 完整记录 |

## 2. 行为不变声明

迁移前后生产行为完全不变，仅新增遥测能力：

| 维度 | rel-prod-103 行为 | rel-prod-104 行为 | 变更 |
|------|------------------|------------------|------|
| 上下文参数 | 完整 A 参数 | 完整 A 参数 | 无 |
| D_pm/D_sl/D_pm_sl 压缩 | 不启用 | 不启用 | 无 |
| reasoning_effort/thinking_budget | 不启用 | 不启用 | 无 |
| maxItems/maxChars | 不调整 | 不调整 | 无 |
| 模型调用预算 | soft=6/hard=10 | soft=6/hard=10 | 无 |
| production prompt | 不调整 | 不调整 | 无 |
| Gemini 路由 | v2_rawstage2_gemini31 / v2_amplified_gemini31 | 同左 | 无 |
| fallback=[] | 保持 | 保持 | 无 |
| 统一主链路编排 | Preflight → ContextCompiler → NovelOS Agentic → 作者风格整章优化 → 事实复检 → 状态提交 → 原子保存 | 同左 | 无 |
| 长期状态事务 | CanonState/CharacterState/PromiseLedger/PatternMemory | 同左 | 无 |

**新增能力（不影响行为）**：
- `LLMTimingEntry` 新增 `reasoningTokens` / `cachedTokens` 字段（从 OpenAI-compatible API 响应提取，当前代理返回 null，字段预留）
- `FailureEnvelope` 结构化阻断证据（`stage`/`gate`/`severity`/`reason`/`evidence`/`recoverable`/`retryPlan`）
- trace 记录新增 token 细分和失败信封

## 3. 门禁验证

| 门禁 | 结果 |
|------|------|
| prod build（tsconfig.prod.json → dist/） | ✓ 通过 |
| eval build（tsconfig.eval.json → dist-eval/） | ✓ 通过 |
| test build（tsconfig.test.json → dist-test/） | ✓ 通过 |
| 全量测试（2783 tests） | ✓ 2777 pass / 6 skipped / 0 fail |
| Phase 5 smoke test（PINOVEL_DEV_MODE=0） | ✓ 2/2 pass |
| dependency-boundary test（PINOVEL_DEV_MODE=0） | ✓ 23/23 pass |
| G6 production binding test | ✓ pass |
| launch readiness test | ✓ pass |
| governance blocker treatment test | ✓ pass |
| 环境指纹可复现性 | ✓ reproducible=YES |
| 真实 gpt5.6-sol 网络代理审批 | ✓ APPROVE_DEV（forward + reverse） |
| 状态迁移完整性 | ✓ draft → candidate → frozen → evaluated → approved_dev → active_dev → candidate_prod → active_prod |

## 4. 状态迁移历史

```
draft → candidate → frozen → evaluated → approved_dev → active_dev → candidate_prod → active_prod
```

- capture：采集环境指纹 6e1e1387，创建 draft manifest
- candidate：绑定 parent rel-prod-103 manifest 作为元数据
- freeze：冻结为不可变
- evaluate：frozen → evaluated（1C 最小实现）
- proxy-review：真实 gpt5.6-sol 网络代理审批，finalVerdict=APPROVE_DEV
- promote active_dev：actor=user
- promote candidate_prod：actor=user，--confirm-prod
- promote active_prod：actor=user，--confirm-prod，R1 direct policy（无需 canary）
- production pointer 切换：rel-prod-103 → rel-prod-104

## 5. 回滚信息

- rollbackReleaseId：rel-prod-103
- 回滚命令：`node scripts/evolution-cli.mjs rollback --kind production --actor user --reason "rollback to rel-prod-103"`

## 6. Gemini reasoning-control capability probe 结论

capability probe 已结束。当前 `api.solov.cc` 第三方 OpenAI-compatible 代理不支持 reasoning_effort/thinking_budget 控制。此结论仅限定于当前代理端点，不扩大解释为 Gemini 原生 API 不支持。未来更换 provider 或 endpoint 时再重新探测。

不再继续投入 reasoning control 参数实验。下一步进入 "Prompt 版本管理与 eval 流程" 模块。
