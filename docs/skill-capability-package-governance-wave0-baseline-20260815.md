# Capability Package Governance — Wave 0 基线报告

**任务**：`CAPABILITY-PACKAGE-GOVERNANCE-1` / CPG-0.5  
**日期**：2026-08-15  
**范围**：只读盘点；本报告不改变用户在途文件。

## 1. 独立 status / loader / hash / trace / budget / release 读取点

| 资产 | 生产读取点 | status 真相源 | hash / 准入 | 迁移 owner |
|---|---|---|---|---|
| PromptPatternLibrary | `unified-entry.ts` 调用 `loadPromptPatternLibrary`；生产不再把 resolution 注入 raw | `pattern.status`（active/candidate/dormant/retired） | `sampleSize>=8` + `validatedWinRate>=0.55` + experiment provenance | `adaptPromptPatternToPackage` → Package Registry |
| PortableCraftGene | `unified-entry` 透传 `craftGenes`；`buildRawPrompt` 无稳定生产消费点 | 无统一 status | 反模仿/长度校验 | `adaptCraftGeneToPackage` |
| EditorialStrategyRegistry | 作者风格优化策略选择 | 无 Package status | Thompson Sampling 仍在策略引擎 | `adaptEditorialStrategyToPackage`；选择器不搬迁 |
| MethodologyPolicy | `compileMethodologyApplicationReport` | `authority/role/enforcement` | raw 越权 violation | 扩展 `eval_only`，保持唯一枚举 |
| NovelOS tools | `narrative-tools.ts` 9 工具白名单 | 工具 allowlist | Tool Protocol / 信任边界 | Runtime `grantedTools` 交集，不改公开 `novel_*` |
| BudgetLedger | `reserveBudget` | reservation / settle | 硬上限 fail-closed | Package 只做子配额 |
| BehaviorBundle | `behavior-bundle.ts` + `production-release-gate.ts` | `bundleId` + 组件 hash | 任一组件变化改 bundleId | 新增 `capabilityPackageSetHash` |
| Release gate | `evaluateProductionReleaseGate` | `active_prod` + approvalRef | fingerprint + bundle 一致性 | 缺 Package Set hash fail-closed |
| ContextDeliveryLedger | CEG 交付血缘 | action 事件 | `contextPackageHash` / `modelInputHash` | Package ledger 只引用，不复制 |

## 2. 已确认缺口（实施前）

1. 无统一 `CapabilityPackageManifest`。
2. Prompt Pattern 按 `active` 选取，未分离 eligible/relevant。
3. `loadPromptPatternLibrary` 缺失时回退为空，不区分 required/optional。
4. Craft Gene 无生产消费闭环。
5. 无跨 Package 的 selected/activated/delivered/consumed 语义。
6. BehaviorBundle 无 `capabilityPackageSetHash`。
7. Package 要求未统一走 `lookupStrict()`。
8. 无依赖图 / 冲突槽 / 工具 grant / 子预算对象。
9. 无 Skill 专项 Eval Matrix。

## 3. 术语冻结

- `admitted` ≠ `eligible` ≠ `selected` ≠ `activated` ≠ `delivered_to_model` ≠ `consumed`
- `delivered_to_model` 需要 `modelInputHash`
- `consumed` 需要授权工具调用或通过 Output Contract 的结构化产物
- `active` 只表示 release 准入，不表示本章自动加载
