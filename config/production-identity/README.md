# 生产身份包

`active-production.json`、release manifest 和审批 artifact 仍是运行时状态，默认不进 Git。

clean checkout 恢复生产身份的方式：

1. 在已有治理根执行 `node scripts/evolution-cli.mjs export-identity --out config/production-identity/active.pack.json`
2. 部署时设置 `PINOVEL_PRODUCTION_IDENTITY_PACK` 指向该 pack，或执行 `inject-identity --pack <path>`
3. G6 在 pointer 缺失时只读回退 pack，不改治理目录

当前 HEAD `3e4dcc0` 与 `rel-prod-134` 冻结提交 `d238c7c` 指纹不一致。注入 134 pack 只能恢复 pointer，不能让本提交通过 G6。新的可运行生产身份需要新的 capture / 审批 / 四臂 P6。
