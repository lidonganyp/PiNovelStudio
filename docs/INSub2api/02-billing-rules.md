# 余额预占、扣费、取消、退款规则（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 的小说功能计费模型。本文件为 Phase 3 计费账本与余额预占实现的真相源。规则必须与 Sub2API 现有充值/支付系统对齐，不绕过其原子性与幂等性。

## 1. 计费对象分类

| 操作类型 | 是否收费 | 说明 |
|---|---|---|
| 手工保存大纲、世界观、角色档案、作者风格档案、章节正文修改 | ❌ 不收费 | 纯本地数据写入，无模型调用 |
| PI 风格对话（用户向 PI 提问、PI 回复） | ✅ 收费 | 每次对话请求计一次模型调用 |
| AI 规划（`novel_plan_story_outline` 高层背景生成） | ✅ 收费 | 按实际模型调用次数累计 |
| 章节生成（`novel_generate_chapter` 统一主链路） | ✅ 收费 | 主链路多次模型调用累计扣费 |
| 作者风格整章优化 | ✅ 收费 | 已包含在章节生成链路内，不单独计费 |
| 内容门禁、本地 Preflight、FactGuard 本地规则检查 | ❌ 不收费 | 本地规则无上游用量 |
| 失败重试（平台技术故障引起） | ❌ 不收费 | 由平台承担，详见 §5 |
| 失败重试（用户输入或内容质量引起） | ✅ 收费 | 计入最高消费上限，详见 §5 |
| 取消任务后已产生的调用 | ✅ 收费 | 已产生上游用量的请求正常结算 |

## 2. 计费单位

- 单位：人民币元（CNY），最小粒度 0.0001 元。
- 单次模型调用费用 = `inputTokens × inputRate + outputTokens × outputRate`，费率由 Sub2API 管理员按上游 Provider/Route 配置，用户不可见。
- 真实 Provider/Route/Model 只出现在管理员数据中，用户账单只显示"对话费用"、"章节生成费用"等聚合条目（详见 [03-model-attribution.md](./03-model-attribution.md)）。

## 3. 余额预占流程（T3-2）

发起章节生成任务前必须完成：

1. **预估费用区间**：
   - 预计输入 token = Σ(各 stage 输入预算，基于历史 trace 中位数)
   - 预计输出 token = Σ(各 stage 输出预算)
   - 预估费用下限 = `预计 token × 费率下界`
   - 预估费用上限 = `预计 token × 费率上界 × 调用次数上限`
2. **最大消费上限**（`maxCharge`）：
   - 默认 = 预估上限 × 1.2（20% 缓冲）
   - 用户可在生成确认页指定更小的 `maxCharge`，不可指定更大的（防透支）
   - 管理员可配置每用户单任务 `maxCharge` 上限
3. **原子检查可用余额**：
   ```sql
   -- 必须在事务中执行
   SELECT available_balance FROM user_balances WHERE user_id = $1 FOR UPDATE;
   -- available_balance = balance - SUM(holds where status='active')
   ```
4. **创建余额预占**：
   - `available_balance >= maxCharge` → 创建 `novel_balance_holds` 记录（status=active，amount=maxCharge）
   - `available_balance < maxCharge` → 返回 `INSUFFICIENT_BALANCE_BEFORE_START`，不进入 Novel Runtime
5. **签名令牌携带 `maxCharge`**：写入 [Phase 2 T2-2 短期任务令牌](../plan202600722.md)，Novel Runtime 据此拒绝超额调用。
6. **任务结束**（完成/取消/失败）：释放未使用额度，按实际用量结算。

> 必须使用数据库事务或等价原子机制（如 Redis + Lua + 持久化补偿），防止并发任务透支。同一用户并发任务受 [Phase 8 并发限制](../plan202600722.md) 约束。

## 4. 扣费流程（T3-3）

每次模型调用产生上游用量后，立即结算：

1. 上游返回 token 用量后，Novel Runtime 通过内部回调向 Sub2API 计费网关上报：
   ```
   POST /api/v1/internal/novel/billing/settle
   { jobId, callId, userId, inputTokens, outputTokens, actualCharge, status, requestId }
   ```
2. Sub2API 在事务中：
   - `UPDATE novel_balance_holds SET settled_amount = settled_amount + $actualCharge WHERE job_id = $jobId`
   - `INSERT INTO novel_generation_calls (...)`
   - 校验 `settled_amount + pending_charges <= maxCharge`，超限则触发 `RESERVED_BUDGET_EXHAUSTED`
3. **幂等性**：`jobId + callId` 必须幂等。重复上报相同 `(jobId, callId)` 不重复扣费，返回首次结果。
4. **不允许余额变为负数**：结算后若 `available_balance < 0`，回滚本次结算并标记任务为余额不足。

## 5. 重试费用归属

| 重试原因 | 费用归属 | 说明 |
|---|---|---|
| 平台技术故障（网关 5xx、模型超时、网络抖动、Sub2API 内部错误） | 平台承担 | 不从用户预占额度扣费；已产生上游用量的由平台与上游结算 |
| 模型 schema 错误、parser 错误（gate 级 retry_gate） | 平台承担 | 属于平台责任（提示词或 schema 设计问题） |
| Anti-AI、segment_contract、style 等 gate 触发的 rewrite_event | 用户承担 | 由用户内容质量或风格选择引起，计入 maxCharge |
| 用户主动重试、修改后重新生成 | 用户承担 | 计入 maxCharge |

## 6. 取消与退款规则

### 6.1 用户取消（生成中）

- 用户点击"取消任务"或调用 `POST /api/v1/novel/generations/:id/cancel`：
  1. Sub2API 标记任务 `status=cancelled`
  2. 通过 Novel Runtime 内部通道停止当前 stage 完成后的下一次模型调用
  3. 等待当前模型调用完成（不可中断已发出的上游请求，避免上游账户异常）
  4. 结算已完成的全部调用（正常扣费）
  5. 释放预占剩余额度
  6. 不保存未完成章节为正式章节
  7. 不提交长期叙事状态

### 6.2 余额不足自动停止

触发条件（详见 plan §3-4）：
- `INSUFFICIENT_BALANCE_BEFORE_START`：任务启动前余额不足
- `RESERVED_BUDGET_EXHAUSTED`：任务运行中预占额度耗尽
- `BALANCE_CHANGED_DURING_JOB`：任务运行中并发任务/调账导致余额变负

处理：
1. 立即停止下一次模型调用（当前 stage 完成后不再发起）
2. 不保存未完成章节为正式章节
3. 不提交长期叙事状态
4. 已产生用量正常结算
5. 释放未使用预占额度
6. 向用户返回：充值入口、已产生费用、本次未完成章节定位

### 6.3 管理员调账与退款

- 管理员凭 `novel.admin.refund` 权限可对某次任务发起全额或部分退款：
  - 退款原因必填（平台故障 / 用户体验 / 投诉处理 / 其他）
  - 退款记录在 `novel_billing_adjustments` 表
  - 退款金额回写用户余额，不删除原始 `novel_generation_calls` 记录
  - 必须留审计日志（adminUserId、targetUserId、jobId、amount、reason、adjustedAt）

### 6.4 退款限制

- 余额不能因退款变为负数
- 同一 `(jobId, adjustmentId)` 幂等
- 退款不退还已扣费的上游真实成本（由平台承担），只回写用户余额

## 7. 账本表结构（Phase 3 T3-1）

```sql
-- 生成任务主表
CREATE TABLE novel_generation_jobs (
  job_id            TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  chapter_number    INTEGER NOT NULL,
  status            TEXT NOT NULL,  -- running/completed/failed/cancelled/insufficient_balance
  max_charge        NUMERIC(12,4) NOT NULL,
  settled_amount    NUMERIC(12,4) NOT NULL DEFAULT 0,
  estimated_min     NUMERIC(12,4),
  estimated_max     NUMERIC(12,4),
  started_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  outcome_type      TEXT,  -- no_editorial/factguard_block/story_preservation_block/completed
  CONSTRAINT chk_balance CHECK (settled_amount <= max_charge)
);

-- 余额预占表
CREATE TABLE novel_balance_holds (
  hold_id    TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES novel_generation_jobs(job_id),
  user_id    TEXT NOT NULL,
  amount     NUMERIC(12,4) NOT NULL,
  settled_amount NUMERIC(12,4) NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,  -- active/released/settled
  created_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);

-- 单次模型调用账本（脱敏，无 Provider/Route）
CREATE TABLE novel_generation_calls (
  call_id        TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES novel_generation_jobs(job_id),
  user_id        TEXT NOT NULL,
  internal_stage TEXT NOT NULL,  -- chat/outline/agentic_raw/style_optimizer/fact_recheck 等
  request_id     TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  actual_charge  NUMERIC(12,4) NOT NULL,
  status         TEXT NOT NULL,  -- success/failed/cancelled
  started_at     TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ NOT NULL,
  UNIQUE(job_id, call_id)  -- 幂等
);

-- 调账与退款
CREATE TABLE novel_billing_adjustments (
  adjustment_id   TEXT PRIMARY KEY,
  job_id          TEXT REFERENCES novel_generation_jobs(job_id),
  user_id         TEXT NOT NULL,
  amount          NUMERIC(12,4) NOT NULL,  -- 正数退款，负数补扣
  reason          TEXT NOT NULL,
  admin_user_id   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
);
```

> 真实模型/Provider/Route 字段只在 Sub2API 管理员侧的 `model_call_attribution` 表（详见 [03-model-attribution.md](./03-model-attribution.md)），不出现在面向用户的账本表。

## 8. 验收指标（来自 plan §9）

| 指标 | 要求 |
|---|---:|
| 账本与模型调用差异 | 0 |
| 重复扣费 | 0 |
| 余额负数 | 0 |
| 支付回调幂等率 | 100% |
| `jobId + callId` 幂等率 | 100% |
| 余额不足情况下产生新模型调用 | 0 |
| 余额不足情况下保存正式章节 | 0 |
| 失败章节污染长期叙事状态 | 0 |
