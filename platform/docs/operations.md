# 运维：备份恢复与常见故障

## 备份

每日各一份，保留 7 天。

```bash
# PostgreSQL（金额与业务真相源）
docker exec platform-postgres pg_dump -U platform -d platform -Fc > backup/platform-$(date +%Y%m%d).dump

# 工作区文件（章节正文落盘目录，runtime volume）
docker run --rm -v platform_novel_workspaces:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/workspaces-$(date +%Y%m%d).tar.gz -C /data .
```

`AES_MASTER_KEY` **不要**写入数据库备份。丢失主密钥则无法解密 `model_providers.api_key_encrypted`，必须同时把主密钥放在独立的密钥保险库。

## 恢复

```bash
docker exec -i platform-postgres pg_restore -U platform -d platform --clean --if-exists < backup/platform-YYYYMMDD.dump
docker run --rm -v platform_novel_workspaces:/data -v "$PWD/backup:/backup" alpine \
  tar xzf /backup/workspaces-YYYYMMDD.tar.gz -C /data
docker compose up -d
```

恢复后跑一次对账：`pnpm ledger:reconcile`。

## 常见故障

| 现象 | 排查 |
|---|---|
| `api` 起不来，日志 `production requires PAYMENT_MODE=live` | 生产 env 仍是 stub；改 `PAYMENT_MODE=live` 并补商户凭证 |
| `api-bootstrap` 失败 | 缺 `BOOTSTRAP_ADMIN_*` / `BOOTSTRAP_GPT_API_KEY` / GPT 费率分值 |
| 生成 402 / `insufficient_balance` | 用户可用余额 < 预估 `maxCharge`；管理台调账或让用户充值 |
| 生成 409「已有进行中的生成任务」 | 每用户同时只允许 1 个章节生成；等当前任务结束或查 `novel_generation_jobs` |
| 支付通知不入账 | 核对验签、订单金额、`PAYMENT_NOTIFY_BASE_URL` HTTPS、查单补偿是否把单标 expired |
| runtime 不监听 | `NOVEL_REQUIRED_PROVIDER_KEYS`（当前 `GPT_API_KEY`）注入失败；看 runtime 日志 |
| 管理台 403 | 账号 `role` 不是 `admin`；用 seed/bootstrap 管理员登录 |
| 注册 403「当前未开放注册」 | 管理台关闭了 `registration_enabled` |

进程内支付查单补偿每小时跑一次（`NODE_ENV=test` 不启动）。通知丢失时可等补偿，或在管理台核对订单状态。
