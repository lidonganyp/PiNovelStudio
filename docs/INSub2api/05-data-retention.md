# 数据保留与用户删除规则（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 的数据保留周期、租户隔离与用户删除流程。本文件为 Phase 4 T4-3（租户隔离）与 Phase 8 管理后台的真相源。

## 1. 数据分类与保留周期

| 数据类别 | 存储位置 | 默认保留周期 | 删除时机 |
|---|---|---|---|
| 用户余额、充值记录、调账记录 | Sub2API `user_balances` / `payment_orders` / `novel_billing_adjustments` | 永久（或符合 Sub2API 财务合规周期） | 用户注销账户时按财务规则处理 |
| 小说项目元数据 | `novel_projects` | 永久（直至用户删除项目） | 用户删除项目 / 注销账户 |
| CreativeConstitution、世界观、角色档案、大纲、作者风格档案 | `novel_documents` + 对象存储 | 永久（直至用户删除） | 用户删除项目 / 注销账户 |
| 章节正文与版本 | `novel_chapters` + `novel_document_versions` + 对象存储 | 永久（直至用户删除） | 用户删除项目 / 注销账户 |
| 长期叙事状态（CanonState/CharacterState/PromiseLedger/PatternMemory） | `novel_documents`（type=long_term_state） | 与项目同生命周期 | 用户删除项目 / 注销账户 |
| 生成任务记录 | `novel_generation_jobs` | 365 天 | 365 天后自动归档 |
| 单次模型调用账本（脱敏） | `novel_generation_calls` | 365 天 | 365 天后自动归档 |
| 模型归属记录（含真实 Provider/Model） | `model_call_attribution` | 365 天 | 365 天后自动归档（仅管理员） |
| 余额预占记录 | `novel_balance_holds` | 90 天（任务结束 + 90 天） | 90 天后自动清理 |
| 安全事件 | `novel_guard_events` | 180 天 | 180 天后自动归档 |
| 用户反馈与修改稿 | `novel_feedback` | 永久（直至用户删除项目） | 用户删除项目 |
| 内部 Trace（PiNovelStudio `workspaces/{id}/traces/*.json`） | 对象存储（临时目录已清理） | 30 天 | 30 天后自动清理 |
| 临时 Workspace（生成时物化） | `services/novel-runtime` 临时目录 | 任务结束立即删除 | 任务完成/失败/取消后立即删除 |

> 保留周期为默认值；管理员可在 Sub2API 后台为不同租户/套餐调整，但不得短于上述最小值（合规要求）。

## 2. 用户删除流程

### 2.1 删除单个小说项目

用户调用 `DELETE /api/v1/novel/projects/:id`：

1. 校验项目归属（`WHERE id = $1 AND owner_user_id = $currentUserId`）
2. 软删除：`UPDATE novel_projects SET deleted_at = NOW() WHERE id = $1`
3. 软删除关联：`novel_documents`、`novel_chapters`、`novel_feedback` 同步软删除
4. 异步任务删除对象存储中的正文/版本文件（标记 `deleted_at` 后 7 天执行硬删除，留恢复窗口）
5. 失败的项目清理任务必须记录 `novel_cleanup_tasks`，管理员可重试
6. 删除索引与缓存（Redis 中项目相关 key）
7. 不退还已消费的余额（项目删除不触发退款）

### 2.2 注销账户

用户调用 Sub2API 现有注销账户流程时，小说功能联动：

1. 标记所有 `novel_projects` 为软删除
2. 异步任务删除对象存储中的全部小说内容
3. `novel_generation_jobs` / `novel_generation_calls` / `novel_balance_holds` / `novel_guard_events` / `model_call_attribution` 中的 `user_id` 替换为脱敏 hash（保留聚合统计，断开与真实用户身份的关联）
4. 余额按 Sub2API 财务规则处理（退款/转赠/没收，由 Sub2API 决定）
5. 注销完成后 30 天内仍可由管理员通过审计日志查询历史归属，30 天后审计日志中的 userId 也替换为脱敏 hash

## 3. 租户隔离铁律（T4-3）

| 规则 | 实现位置 |
|---|---|
| 所有项目查询必须强制附加当前 `userId` | `backend/internal/novel/repository/*.go` 的所有 SQL/Ent 查询 |
| 禁止使用用户提交的路径 | DTO 不接受 `path` 字段；对象存储 key 由后端按 `userId/projectId/...` 规则生成 |
| 禁止跨用户复用 Workspace | `services/novel-runtime` 创建临时目录时校验 `projectId` 归属，签名令牌携带 `projectId` |
| 管理员查看用户正文必须记录审计日志 | `novel_admin_access_logs` 表（adminUserId, targetUserId, projectId, accessedAt, action, ipAddress） |
| 删除项目时同步处理对象存储、索引和缓存 | §2.1 流程 |

### 3.1 越权访问测试（Phase 9 必过）

- 用户 A 创建项目 P_A，用户 B 创建项目 P_B
- 用户 A 用 P_B 的 ID 访问 → 必须返回 404（不是 403，避免泄露存在性）
- 用户 A 用 P_B 的 ID 调用生成 → 必须返回 404
- 用户 A 用伪造的 `X-Novel-Project-Id` 头 → 必须以 Cookie 会话中的 userId 为准，忽略伪造头
- 路径穿越：`/api/v1/novel/projects/../users/B/projects` → 必须 404
- IDOR：枚举 projectId → 全部 404

## 4. 对象存储 Key 命名规则

```
novel/{userId}/{projectId}/documents/{documentType}/{version}.json
novel/{userId}/{projectId}/chapters/{chapterNumber}.md
novel/{userId}/{projectId}/chapters/{chapterNumber}/versions/{versionId}.md
novel/{userId}/{projectId}/feedback/{feedbackId}.json
```

- Key 中的 `userId` 必须来自服务端会话，不接受用户输入
- 上传时校验 Content-Type 与大小限制（V1 单文件 ≤ 5MB，章节正文 ≤ 200KB）
- 删除时按 prefix 批量删除（`novel/{userId}/{projectId}/`）

## 5. 备份与恢复

- PostgreSQL：每日全量 + WAL 连续归档，保留 30 天
- 对象存储：跨区复制 + 版本控制，保留 30 天可恢复
- Redis：仅缓存，无持久化要求；故障后从 PostgreSQL 重建
- 恢复演练：plan §10 要求发布前完成数据恢复演练

> 备份恢复不得违反租户隔离：恢复单个用户数据时不影响其他用户；恢复整个数据库后所有 `novel_*` 表的 `deleted_at` 软删除标记必须保留。

## 6. 数据导出（GDPR/合规）

用户可调用 `GET /api/v1/novel/export` 导出自己的全部小说数据（ZIP 包）：

- 仅含 `userId = $currentUserId` 的数据
- 不含 `model_call_attribution`（管理员数据）
- 不含 `novel_guard_events`（安全数据，仅管理员可见）
- 导出请求限频（每用户每天 1 次）
- 导出文件临时签名 URL，有效期 24 小时

## 7. 关键指标

```text
novel_data_cleanup_lag_seconds          # 软删除后实际硬删除延迟
novel_object_storage_orphan_count       # 孤儿对象（DB 已删，对象存储残留）数
novel_cross_user_access_blocked_total   # 越权访问阻断数
novel_admin_access_total                # 管理员查看用户正文次数
```
