# 数据版本与发布治理 —— Wave 0 真相源盘点基线报告（DG-0）

> **⚠ 已过时声明（2026-08-15）**：本报告为 DG-0 于 2026-08-13 的只读盘点快照，下文「唯一生产基线 rel-prod-106」等表述仅反映当日状态。当前（2026-08-15 核验）：唯一 `active_prod` = **rel-prod-109**（2026-08-14 晋级，完整行为身份）；rel-prod-106 为 held（仅审计读取，rollback 重新激活路径已禁用）；旧 active（rel-000 / rel-prod-100 / 101 / 102）已 retired。仍未决：rel-prod-109 真实 workspace 回放证据；可复现性已于 2026-08-15 验证为**不可复现**（freeze 发生在脏主树，需干净基线重新 capture 新 releaseId），详见 `docs/project-memory.md` GOVERNANCE-CLOSEOUT 节。

**日期**：2026-08-13
**状态**：DG-0 完成（只读盘点，未修改生产代码 / 未修改 active pointer / 未迁移策略证据）
**范围**：`active` / `active_dev` / `active_prod` / `bundleId` / `modelVersion` 的读写入口盘点 + 实际生产基线 capture + owner map

---

## 1. 结论摘要

| 项 | 实际值（以运行时文件为准） |
|---|---|
| 唯一生产基线 releaseId | **`rel-prod-106`** |
| 生产指针文件 | `config/evolution-release/active-production.json → rel-prod-106`（actor=user，switchedAt 2026-08-11T13:06:20.459Z） |
| 开发指针文件 | `config/evolution-release/active-development.json → rel-prod-106`（actor=system） |
| 审批 artifact | `approval-rel-prod-106-1786453322293-39a4f675`（reviewTransport=network，reviewerModel=gpt5.6-sol-proxy，finalVerdict=APPROVE_DEV） |
| codeCommit | `eeb0ed354fd4572c5e97fdaf171dd049bcdb70e1` |
| environmentFingerprint | `063651bf73fa6a4cf3c88e28aa4632528eb5d99d9e28e4d0800db34a2c6843a8` |
| changeClass | R1 |
| pointer 切换链 | rel-prod-102 → rel-prod-103 → rel-prod-104 → rel-prod-106（**跳过 rel-prod-105**） |

**关键结论**：生产基线只有一个 active pointer（rel-prod-106），但存在 **文档漂移** 与 **多套独立 active 语义**，DG-0 需要锁定以下唯一真相源：

```text
config/evolution-release/active-production.json
  -> releaseId: rel-prod-106
  -> config/evolution-release/releases/rel-prod-106/manifest.json   (唯一可执行行为身份)
```

---

## 2. 实际生产基线 capture（rel-prod-106）

从 `releases/rel-prod-106/manifest.json` 提取的当前唯一生产行为身份：

```json
{
  "schemaId": "pinovel.evolution-release",
  "schemaVersion": 1,
  "releaseId": "rel-prod-106",
  "status": "active_prod",
  "parentReleaseId": "rel-prod-104",
  "rollbackReleaseId": "rel-prod-104",
  "supersedesRef": null,
  "changeClass": "R1",
  "claims": ["memory 层为唯一最新生产版本（版本收敛原则）…"],
  "environmentFingerprint": "063651bf73fa6a4cf3c88e28aa4632528eb5d99d9e28e4d0800db34a2c6843a8",
  "codeCommit": "eeb0ed354fd4572c5e97fdaf171dd049bcdb70e1",
  "artifactRefs": [
    ".pi/extensions/novel-studio/dist/index.js",
    ".pi/extensions/novel-studio/dist/v2/core/final-state-commit.js",
    ".pi/extensions/novel-studio/dist/v2/core/memory/memory-transaction.js",
    ".pi/extensions/novel-studio/dist-test/v2/governance/production-release-gate.js",
    ".pi/extensions/novel-studio/dist-test/v2/governance/environment-fingerprint.js"
  ],
  "approvalRef": "approval-rel-prod-106-1786453322293-39a4f675",
  "createdAt": "2026-08-11T12:47:05.661Z",
  "activatedAt": null
}
```

**缺失字段（对照计划 §4 目标数据模型）**：当前 manifest 尚无 `bundleId`、`modelVersion`、`promptBundleHash`、`modelRoutingHash`、`toolSchemaHash`、`contextCompilerHash`、`qualityPolicyHash`、`recoveryPolicyHash`、`knowledgeSnapshotHash`、`runtimeFingerprint`、`strategyEvidencePartition[]`、`evalProtocolVersion`。这些是 DG-1 的扩展目标。

---

## 3. 发现的问题（DG-0 需要解决/记录）

| 编号 | 问题 | 影响 | 归属波次 |
|---|---|---|---|
| D1 | `docs/project-memory.md` 仍声称"active production pointer 已切换到 rel-prod-103"，实际为 rel-prod-106 | 文档漂移，存在两个相互冲突的生产基线声明 | DG-0（本波次修正） |
| D2 | `EvolutionReleaseManifest` 缺 §4 全部组件 hash / bundleId / modelVersion / evalProtocolVersion 字段 | 无法把一次生产运行绑定到不可变行为环境 | DG-1 |
| D3 | `config/prompt-registry.json` 有独立 `productionPointers[].activeVersionId` + `versions[].status=active` 语义，但**生产路径不读取**（该 registry 由 `novelos/eval/prompt-registry.ts` 管理，属 eval-only） | 独立 active 语义，与 manifest 无绑定 | DG-6（标记为 manifest 引用 / audit-only） |
| D4 | `config/model-routing.json` 有独立 `model_strategy.writer_admission.default_writer`、`human_override.status=active` 语义，**生产路径读取** | 独立 active 语义，未与 manifest 绑定 | DG-6（纳入 modelRoutingHash） |
| D5 | `workspaces/{id}/strategy-policy.json` 分区键仅 `modelVersion`（缺 bundleId / evalProtocolVersion） | 策略信誉可跨 Bundle / 跨 Eval 协议污染 | DG-4 |
| D6 | `sub2api/deploy/novel/model-routing.json` 是第二份 model-routing 配置 | 部署侧独立配置，需明确是否进入生产读路径 | DG-0 记录 / DG-6 审计 |
| D7 | `releases/` 缺 `rel-prod-105` 目录，switch 链 104 → 106 跳号 | 发布序列不连续，审计需记录 | DG-0 记录 |

---

## 4. Owner Map（允许读取 / 允许写入 / 仅审计）

这是 DG-0 的核心交付物。**生产行为身份的唯一真相源是 active-production 指针 → manifest**，其余配置/证据一律不得独立承担"生产 active"语义。

### 4.1 发行指针（Evolution Release Pointer）

| 资源 | 当前位置 | 允许读取 | 允许写入 | 仅审计 |
|---|---|---|---|---|
| `active-production.json` | `config/evolution-release/` | 生产 gate（`production-release-gate.ts:evaluateProductionReleaseGate` 的 readActive）；指针 store `readActive` | 仅 `actor==="user"` 经 `release-pointer-store.ts:switchActive/rollback`（生产指针） | 历史经 `rollback-history-production.jsonl` |
| `active-development.json` | 同上 | 开发路径 readActive | `actor==="system"` 或 `user`（开发指针） | `rollback-history-development.jsonl` |

**强约束**：生产指针切换只能由有权限的用户操作，写入 append-only 历史；代理只能产生准入建议，不能自行切换 production pointer。

### 4.2 发行 Manifest 与状态机

| 资源 | 允许读取 | 允许写入 | 仅审计 |
|---|---|---|---|
| `releases/{id}/manifest.json` | 生产 gate（load manifest）；registry `loadManifest` | 仅 `evolution-release-registry.ts:writeManifest/transitionStatus`（frozen 后禁止原地修改） | 旧 manifest 保留为审计对象，禁止作为默认生产输入 |
| `releases/{id}/state-events.jsonl` | registry `loadStateEvents` | registry `recordStateEvent`（append-only） | 状态迁移审计 |
| `releases/{id}/approvals/` | 生产 gate 校验审批 artifact 绑定 | 审批流程写入（proxy review） | 审批 artifact 双向绑定证据 |

### 4.3 行为身份（bundleId / modelVersion / 组件 hash）

| 资源 | 允许读取 | 允许写入 | 仅审计 |
|---|---|---|---|
| `bundleId` | trace 读者 / eval 回放 | `production-bundle-hash.ts:computeProductionBundleHash`（确定性派生，禁止手写） | trace `bundleId` + `bundleHashDimensions` |
| `modelVersion` | 策略选择器 / trace | 由策略选择结果派生（`authorStyleStrategySelection.modelVersion`） | trace `strategyContext.modelVersion`；strategy-policy 分区 |
| 组件 hash（prompt/路由/工具/上下文/质量/恢复/知识快照） | 生产 gate 校验 | 由 capture 流程确定性派生（DG-2） | manifest 字段 |

### 4.4 独立配置（应降级为 manifest 引用组成部分）

| 资源 | 当前独立 active 语义 | 归属 |
|---|---|---|
| `config/prompt-registry.json` | `productionPointers[].activeVersionId`、`versions[].status=active` | **audit-only**（生产路径不读取；DG-6 标记为 manifest 引用） |
| `config/model-routing.json` | `model_strategy.writer_admission.default_writer`、`human_override.status=active`、`stage_routing`/`agent_routing` | **manifest 引用组成部分**（DG-2 捕获为 `modelRoutingHash`；DG-6 删除生产独立 active 选择） |
| `workspaces/{id}/strategy-policy.json` | `partitions[modelVersion][strategyId].status` | **分区键扩展**（DG-4 加入 bundleId + evalProtocolVersion） |
| `sub2api/deploy/novel/model-routing.json` | 部署侧 model-routing 副本 | **audit-only**（DG-6 确认不进生产读路径） |

---

## 5. 唯一真相源声明

生产运行只能消费以下链路，不得扫描目录或分别读取多个独立 active 配置：

```text
novel_generate_chapter
  -> evaluateProductionReleaseGate (fail-closed)
  -> active-production.json -> releaseId=rel-prod-106
  -> releases/rel-prod-106/manifest.json  (status=active_prod)
  -> [DG-1 起] bundleId / modelVersion / 组件 hash / evalProtocolVersion / strategyEvidencePartition
```

任何独立 active 读取点（Prompt Registry `productionPointers`、Model Routing `default_writer`、Strategy Policy `partitions[modelVersion]`）必须迁移到 manifest 引用或扩展分区键后，方可在 DG-6 中删除其独立生产语义。

---

## 6. 本波次文档修正

- [x] `docs/project-memory.md`：修正"active production pointer 已切换到 rel-prod-103"为 rel-prod-106，并记录唯一真相源。
- [ ] 发布治理运行手册：随 DG-3（生产入口 fail-closed）完成后补充指针损坏/双 active/hash 漂移的恢复流程。

## 7. 下一步（Wave 1：DG-1 + DG-2）

DG-0 已锁定真相源。进入 Wave 1：扩展 manifest schema（加入 bundleId/组件 hash/evalProtocolVersion/strategyEvidencePartition）、建立规范化序列化与确定性 hash 规则、生产级 capture/verify。
