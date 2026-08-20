# 对账

金额单位一律是**分（整数）**。预占不扣 `users.balance`，逐调用结算才扣。

## 恒等式

对每个用户：

```
users.balance == Σ payment_orders.amount(status=paid) + Σ novel_billing_adjustment.amount − Σ novel_generation_call.actual_charge
available     == users.balance − Σ (active hold.amount − hold.settled_amount)
```

合并式：

```
Σ充值 + Σ调账 − Σ已结算调用 − Σ在途预占 == available
```

开发计划原 DoD 把「在途预占」写进了与 `users.balance` 的等式。Phase 2 实现是「预占只占用可用额度」，因此与账面余额相等的是「充值 + 调账 − 已结算」，在途预占进入 available。

## 脚本

```bash
cd platform
pnpm ledger:reconcile
pnpm ledger:reconcile -- --user-id 12
```

零差额退出码 0；任一用户不平退出 1，并打印该用户的分项。

CI 中 `p8-concurrent.e2e.spec.ts` 覆盖：

- 同一用户 5 路并发生成：产品约束为 1 个 running job，恰好 1 成功 + 4 个 409，hold 不超扣
- 余额 1000 分、5 路 300 分预占：成功额合计 ≤ 1000，恒等式成立

## 人工抽查

1. 任抽一笔 `novel_generation_call`：`actual_charge` 必须等于快照单价按 token 向上取整到分
2. 调账只能追加：`novel_billing_adjustment` 无 update/delete 入口
3. 费率变更后旧调用的 `rate_snapshot` 不变
