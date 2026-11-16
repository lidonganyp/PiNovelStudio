# 生产发行治理（G6）部署与排障 Runbook

> 事故复盘：2026-11-02 线上章节生成报错 `no active production release set；生产运行需先由 user 角色切换 active production pointer 到 status=active_prod 的 release，或设置 PINOVEL_DEV_MODE=1 进入非生产开发模式`（generation_failed · g6_release_gate / runtime）

## 1. 症状

用户在 ainovel.cloud 小说助手中请求生成第一章，runtime 返回 `g6_release_gate` 硬阻断。所有走统一主链路的生成入口（章节生成/续写/改写）全部被拦截；platform-api 本身不经此门禁，不受影响。

## 2. 根因

不是代码 bug，而是**生产治理状态从未部署**。G6 门禁（`.pi/extensions/novel-studio/v2/governance/production-release-gate.ts`）在每次生成前硬校验：

1. active production pointer 存在；
2. 指向的 release manifest `status=active_prod`；
3. 审批 artifact 真实（`reviewTransport=network`、双向 APPROVE_DEV、manifest hash 绑定）；
4. 环境指纹与 manifest 冻结值一致；
5. 行为身份（bundleId + 组件 hash）一致。

这套数据按设计**不进 Git**（`.gitignore` 排除 `config/evolution-release/` 与 `config/production-identity/active.pack.json`），属于部署态。首次部署或 clean checkout 后必须显式建立，否则门禁在第一层（pointer 缺失）即阻断。

## 3. 关键架构事实（AI 必读，勿凭直觉操作）

1. **指纹哈希源码文件，而生产镜像不含源码**。环境指纹（`environment-fingerprint.ts`）与行为快照（`behavior-snapshot.ts`）会哈希 `index.ts`、`tsconfig.*.json`、`novelos/tools/narrative-tools.ts`、`v2/core/context-compiler.ts` 等源码文件；生产镜像（`platform/services/novel-runtime/Dockerfile`）刻意只含 `dist/` 编译产物，不含源码、不含 `.git`、不含 `scripts/`。**在宿主源码树上 capture 的指纹与容器内运行时采集的指纹必然不一致**，release 必须在与容器完全同构的树上采集。
2. **node/npm 版本计入 runtimeFingerprint**。宿主 node 版本若与镜像不同（如宿主 v22 vs 镜像 v20.20.2），指纹也会漂移。治理 CLI 必须在与镜像同版本的 node 容器中执行。
3. **commit 身份靠 `PINOVEL_RELEASE_COMMIT` 注入**。镜像无 `.git`，`getGitHead` 优先读该环境变量；capture 时必须显式注入与 runtime 容器一致的值（compose 中 `PINOVEL_RELEASE_COMMIT`），否则采成宿主 HEAD。
4. **生产晋级审批必须 `reviewTransport=network`**。stub 审批（`--stub-verdict`）只能用于开发链路；晋级 active_prod 时 CLI 与 G6 门禁都强制校验真实网络审批（`NOVELOS_JUDGE_API_KEY/BASE_URL/MODEL`，端点必须 HTTPS 公网，SSRF 白名单校验）。
5. **审批 verdict 不可控时不要反复重试同一 release**。`held` 是软终态，无法回退到 evaluated 重新审批；审判模型判 HOLD 后只能新建 release（新 releaseId）并改进 packetInput 证据（明确基线与候选的优劣对比）后重新走审批。
6. **bootstrap 占位 release 的限制**：`freeze --bootstrap` 要求自引用 rollback + 单 release 注册表 + 无生产指针。若注册表已有其他 release，需先移除再 bootstrap，之后重建正式 release。
7. **晋级 active_prod 的三重证据（R1 变更类也不能免）**：
   - 真实网络审批（APPROVE_DEV）；
   - 四臂评估矩阵（eval-gate 对 R0-R3 一律 mandatory，verdict=pass 且 pass^3=1）；
   - 5 场景生产准入回放（`production-admission-replay.mjs --real`：timeout / retry / factguard-block / atomic-rollback / state-commit-fail 全部 PASS）。
8. **身份包回退机制**：pointer 缺失时 G6 只读回退 `config/production-identity/active.pack.json`（runtime 容器已只读挂载该目录）。`export-identity` 导出后无需重启容器即生效。
9. **密钥值不参与指纹 hash**（secretEnvStates 仅审计元数据），密钥轮换不会导致指纹漂移；但 `GEMINI_MODEL`、`GOOGLE_GEMINI_BASE_URL`、`PINOVEL_MODEL_REQUEST_TIMEOUT_MS` 参与指纹，capture 时必须与 runtime 容器环境一致。

## 4. 标准操作流程（SOP）

### 4.1 复刻冻结树

```bash
mkdir -p /opt/pinovel-frozen
docker cp platform-novel-runtime:/app/pnovel/. /opt/pinovel-frozen/
# 复制治理 CLI 与其依赖的 dist-test（镜像已 prune scripts）
cp /root/PiNovelStudio/.pi/extensions/novel-studio/scripts/evolution-cli.mjs /opt/pinovel-frozen/.pi/extensions/novel-studio/scripts/
cp -r /root/PiNovelStudio/.pi/extensions/novel-studio/dist-test /opt/pinovel-frozen/.pi/extensions/novel-studio/
```

### 4.2 在同版本 node 容器中执行治理命令

统一环境变量（与 runtime 容器一致）：

```bash
export PINOVEL_RELEASE_COMMIT=<与 platform/.env 一致的冻结提交>
export GEMINI_MODEL=<与 platform/.env 一致>
export GOOGLE_GEMINI_BASE_URL=<与 platform/.env 一致>
export PINOVEL_MODEL_REQUEST_TIMEOUT_MS=300000
export GEMINI_API_KEY=<任意非空值，不参与指纹>
```

命令序列（在 `node:20-alpine` 容器内、冻结树扩展目录下，需 `apk add git`）：

```bash
# 1. 占位回滚目标（注册表须为空）
node scripts/evolution-cli.mjs capture --release-id rel-000 --rollback rel-000
node scripts/evolution-cli.mjs candidate --release-id rel-000 --metadata-file <meta.json>
node scripts/evolution-cli.mjs freeze --release-id rel-000 --bootstrap
node scripts/evolution-cli.mjs evaluate --release-id rel-000
node scripts/evolution-cli.mjs proxy-review --release-id rel-000 --stub-verdict APPROVE_DEV
# 2. 正式 release
node scripts/evolution-cli.mjs capture --release-id <rel-id> --rollback rel-000
node scripts/evolution-cli.mjs candidate --release-id <rel-id> --metadata-file <meta.json>
node scripts/evolution-cli.mjs freeze --release-id <rel-id>
node scripts/evolution-cli.mjs evaluate --release-id <rel-id>
# 3. 真实网络审批（需授权卡 + eval-input 证据 + NOVELOS_JUDGE_* 环境）
node scripts/evolution-cli.mjs proxy-review --release-id <rel-id> --real --card <card.json> --eval-input <input.json>
# 4. 晋级链
node scripts/evolution-cli.mjs promote --release-id <rel-id> --target active_dev
node scripts/evolution-cli.mjs promote --release-id <rel-id> --target candidate_prod --confirm-prod --actor user --reason <理由>
node scripts/evolution-cli.mjs promote --release-id <rel-id> --target active_prod --confirm-prod --actor user \
  --eval-evidence-root <四臂证据根> --admission-replay <准入回放报告.json>
# 5. 导出身份包并同步回源码仓
node scripts/evolution-cli.mjs export-identity --out /work/config/production-identity/active.pack.json
cp /opt/pinovel-frozen/config/production-identity/active.pack.json /root/PiNovelStudio/config/production-identity/
cp -r /opt/pinovel-frozen/.pi/extensions/novel-studio/config/evolution-release /root/PiNovelStudio/.pi/extensions/novel-studio/config/
```

### 4.3 验证（独立于修改动作）

```bash
# 容器内直接调用 G6 门禁（应输出 G6 GATE PASS 与 releaseId/指纹/审批引用）
docker exec platform-novel-runtime node /tmp/g6-verify.mjs
# 端到端：容器内生产模式真实生成一章，检查章节落盘与 trace 中 releaseGovernance（devMode=false）
```

## 5. 常见错误与规避

| 错误 | 原因 | 规避 |
|---|---|---|
| 宿主树 capture 后容器内指纹不匹配 | 指纹哈希源码而镜像无源码 | 一律在容器复刻冻结树上 capture |
| capture 的 codeCommit 是宿主 HEAD | 未注入 PINOVEL_RELEASE_COMMIT | 显式注入与容器一致的值 |
| freeze 报 rollback target 状态不符 | rel-000 未走到 approved_dev | 先把 rel-000 走完 evaluate + stub 审批 |
| freeze --bootstrap 报 one-release registry | 注册表已有多个 release | bootstrap 时注册表只留 rel-000 |
| 真实审批判 HOLD | packetInput 证据未体现候选优于基线 | 新建 release，证据中明确基线故障/候选恢复的量化对比 |
| promote 报 reviewTransport=network | 用了 stub 审批 | 生产晋级必须 --real 网络审批 |
| held 后想重审同一 release | held 是软终态 | 只能新建 release 重走链路 |
| 授权卡 REQUIRES_AUTH | allowedReleaseIds 未覆盖新 releaseId | 每个新 release 更新授权卡 |
| 容器内跑 scripts 报 production build missing | 脚本不在扩展 scripts/ 目录导致 EXTENSION_ROOT 解析错误 | 脚本必须放在 `.pi/extensions/novel-studio/scripts/` 下执行 |

## 6. 何时需要重做本流程

- 重新构建 runtime 镜像（dist 产物变化 → buildArtifactHash/runtimeFingerprint 漂移）；
- 修改扩展源码、config/model-routing.json、quality-gates.json、capability-package-set.json 等被指纹覆盖的文件；
- 更换 GEMINI_MODEL / GOOGLE_GEMINI_BASE_URL / 超时配置；
- 升级镜像 node 版本。

仅轮换 API 密钥、重启容器不需要重做（密钥值不参与指纹）。

## 7. 本次事故的实际产物（2026-11-02）

- active production release：`rel-prod-20261102-r2`（R1，fingerprint `480c9ce1…`，bundleId `007da2b2…`）
- 审批：`approval-rel-prod-20261102-r2-1793606271839-ca4edb81`（network，APPROVE_DEV）
- 身份包：`config/production-identity/active.pack.json`（packHash `9dc76fa9…`）
- 治理目录：`.pi/extensions/novel-studio/config/evolution-release/`（含 rel-000 与 rel-prod-20261102-r2；rel-prod-20261102 为 HOLD 后废弃的首次尝试，仅审计保留）
- 验证：容器内 G6 门禁 PASS；生产模式端到端生成第一章成功（4383 字节正文，trace 含完整生产身份）

## 8. 第二轮修复：runtime 服务 projectRoot 漂移（2026-11-02 18:00）

### 根因
runtime 服务调用扩展时把 `_projectRoot` 设为临时工作区 `/var/lib/novel-runtime/workspaces/{jobId}`（workspace-manager 物化，仅复制 capability-package-set.json，不含身份包/治理目录）。G6 门禁从 projectRoot 出发解析 identityPackPath/evolutionRoot/fingerprintRoot，临时根下均不存在，且容器未设置对应环境变量 → 服务上下文中门禁报 `no active production release set`。

### 修复（不改代码、不动 PINOVEL_DEV_MODE=0）
`platform/docker-compose.yml` runtime 服务：
1. environment 新增：
   - `PINOVEL_EVOLUTION_ROOT=/app/pnovel/.pi/extensions/novel-studio/config/evolution-release`
   - `PINOVEL_PRODUCTION_IDENTITY_PACK=/app/pnovel/config/production-identity/active.pack.json`
   - `PINOVEL_FINGERPRINT_ROOT=/app/pnovel`
2. volumes 新增治理目录只读挂载：`../.pi/extensions/novel-studio/config/evolution-release:/app/pnovel/.pi/extensions/novel-studio/config/evolution-release:ro`
3. `docker compose up -d runtime` 重建容器。

### 验证
- 容器内以临时 projectRoot（模拟 workspace-manager 物化场景）调用 `evaluateProductionReleaseGate`：ok=true、devMode=false、releaseId=rel-prod-20261102-r2、指纹 480c9ce1… 与 active release 一致；
- 线上 https://ainovel.cloud/projects/1/workbench 重新生成第一章成功；runtime 日志确认任务正常物化与清理，无 g6 报错。

### 注意
- 治理目录（pointer/release/审批）与身份包同属部署状态，必须随 compose 挂载进容器；新增 release 或切换指针后无需重建容器（只读挂载实时可见），但若修改 compose 挂载路径则需重建。
