# 生产身份包

`active-production.json`、release manifest 和审批 artifact 仍是运行时状态，默认不进 Git。

clean checkout 恢复生产身份的方式：

1. 在已有治理根执行 `node scripts/evolution-cli.mjs export-identity --out config/production-identity/active.pack.json`
2. 部署时设置 `PINOVEL_PRODUCTION_IDENTITY_PACK` 指向该 pack，或执行 `inject-identity --pack <path>`
3. G6 在 pointer 缺失时只读回退 pack，不改治理目录

身份包必须与目标 release manifest 的冻结提交、构建产物、路由指纹和工作树状态完全一致。把旧 release 的 pack 注入当前 checkout 只能恢复对应 pointer，不能让当前提交通过 G6；任何代码、路由或构建变更都必须重新 capture / 审批 / 四臂 P6。
