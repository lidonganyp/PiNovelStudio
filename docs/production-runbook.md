# 生产运行手册

**核对日期**：2026-09-08

## 1. 发布前检查

在仓库根目录执行：

```powershell
npm install
npm run build:prod --workspace novel-studio
npm run typecheck --workspace novel-studio
```

需要验证完整目标时执行 `npm run build`，它会同时生成 `dist/`、`dist-eval/`、`dist-test/`。

路由和生产边界检查：

```powershell
node .pi/extensions/novel-studio/scripts/audit-route-isolation.mjs
cd .pi/extensions/novel-studio
node --import ./tests/setup-test-env.mjs --test tests/dependency-boundary.test.mjs
```

生产发布治理检查（只读）：

```powershell
npm run evolution:status --workspace novel-studio
npm run evolution:health --workspace novel-studio -- --all
```

从 `evolution:status` 读取当前 production release ID 后执行：

```powershell
npm run evolution:verify --workspace novel-studio -- --release-id <active-production-release-id>
```

正式运行必须满足：`active-production.json` 或已密封的 production identity pack 解析到 `status=active_prod` 的 release；release 绑定真实双向 `APPROVE_DEV` 网络审批、行为身份和当前环境指纹。工作树、路由、提示词、工具 schema 或 `dist/` 变化后，G6 会以 `stage=g6_release_gate` 阻断，必须在同一干净基线重新 capture/verify/审批。`PINOVEL_DEV_MODE=1` 仅用于开发/测试/评测，不是生产旁路。

生产密钥只能放在仓库根目录 `.env`，不得写入文档、代码或提交记录。`.env.example` 只提供变量名和示例值。

## 2. 生成前预检

对目标 workspace 先调用公开工具 `novel_preflight_workspace`。重点确认：

- `config.json`、角色档案和风格档案齐全；
- 第 2 章起上一章正文与 `narrative-state-store.json` 连续；
- ChapterSeed 有可生长内容；
- 模型 timeout 和章节预算有效。

G6 发布门禁在此之前由统一入口自动执行；门禁不通过时不会调用模型。随后，若 workspace 预检返回 `passed=false`，也不要调用模型；修复返回的 `fixInstructions` 后重新预检。

## 3. 正式生成

正式写章只调用 `novel_generate_chapter`。PI 工具调用示例：

```text
novel_generate_chapter --workspaceId xinmo --chapterId ch18 --chapterNumber 18
```

命令行生产 harness（用于隔离验证，不绕过正式入口）：

```powershell
node .pi/extensions/novel-studio/scripts/production-generate-chapter.mjs xinmo ch18 18 --project-root=D:\CODE\PiNovelStudio
```

省略 `writerModel` 或传 `--writer-model=gpt6astra` 使用默认 gpt-6-astra；只有用户明确选择时才传 `--writer-model=claude`。正文使用 `GPT_API_KEY` / `GPT_BASE_URL`，`GPT_WRITER_MODEL` 默认 gpt-6-astra；`GPT_MODEL` 仅控制其他 GPT 节点。不要在生产入口传 `modelTestRoute`、`boundedBestOf3`、`qualityExperiment` 或 mock 字段。

当前 GPT 端点禁用 `/chat/completions`；`providers.gpt.request_options.api=responses` 指定 `/responses` 传输，保留 NovelOS 的 ReAct 文本编排。JSON 输出通过 `text.format` 请求；空文、拒绝、未完成和截断响应均阻断。使用相同 GPT 端点的审批传输沿用此配置，模型身份仍读取其独立配置。

## 4. 成功判定

不要只看工具返回的 `status=ok`。同时检查：

- 章节文件已写入 `workspaces/{id}/chapters/`；
- `stageResults.productionFlow.mode` 为 `agentic_style_full_pipeline`；
- Agentic、作者风格优化、Story Preservation、FinalFactRecheck、Completeness 均有结果；
- `selectedSource` 为最终优化稿，非未优化 Agentic 初稿；
- `narrative-state-store.json` 的最终正文 hash 与章节文件一致；
- trace 存在且没有未解释的失败 envelope。
- `stageResults.releaseGovernance` 与 trace 中的 `releaseId`、`environmentFingerprint`、`approvalRef` 与当前部署 release 一致。

## 5. 失败处理

优先读取返回结果中的 `failureEnvelope`，再打开对应 trace。处理原则：

| 情况 | 处理 |
|---|---|
| `severity=preflight` | 按 `fixInstructions` 补齐 workspace，再重试 |
| `severity=recoverable` 且 `gate=model_timeout` | 工具层按预算自动重试一次；仍失败则人工稍后重试 |
| Agentic 验证、风格优化、Story Preservation、FinalFactRecheck、Completeness 失败 | 视为阻断，不交付初稿；修复输入或重新生成 |
| 原子保存/状态提交失败 | 检查 trace；系统应回滚章节文件，不要手工拼接正文和状态 |
| GPT 线路鉴权、配额或网络失败 | 本次运行阻断，不静默切换其他模型；确认 API 后重新发起运行 |
| `stage=g6_release_gate` / 指纹不匹配 | 停止生成；回到干净发布基线重新 capture/verify/审批，不设置开发旁路冒充生产 |

## 6. 生产与评测的边界

生产链路不调用文学 judge，也不接受 `modelTestRoute`。需要模型对比、固定候选或回放时，使用 `dist-eval/`、NovelBench 和对应 eval 脚本；评测产物只能作为人工决策材料，不能直接覆盖 `config/model-routing.json`。
