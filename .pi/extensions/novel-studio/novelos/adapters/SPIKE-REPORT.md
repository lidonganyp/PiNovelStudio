# OPT-8.2 Spike Report — pi-agent-core 可复用性验证

**日期**：2026-07-11
**结论**：✅ `@earendil-works/pi-agent-core@0.80.6` 可复用，全部 6 项能力通过。NovelOS Runtime 委托 pi-agent-core，不自建 loop。

---

## 验证方法

**测试文件**：`tests/novelos-spike-pi-agent-core.test.mjs`（8 用例，无真实 LLM API key，用 scripted StreamFn 确定性模拟）

**运行命令**：
```bash
cd .pi/extensions/novel-studio
node --import ./tests/setup-test-env.mjs --test tests/novelos-spike-pi-agent-core.test.mjs
```

**结果**：`tests 8 / pass 8 / fail 0 / duration 624ms`

---

## 6 项能力验证结果

| # | 能力 | 状态 | 证据 |
|---|------|------|------|
| 1 | 独立创建 stateful agent（不依赖 PI 外层 session） | ✅ | `new Agent({sessionId, initialState, ...})` 创建后 `agent.sessionId` 自主管理；transcript 非空含 user/assistant/toolResult |
| 2 | 完成至少两轮真实 tool call（model → tool → model） | ✅ | streamFn 被调用 ≥2 次；query_canon 执行 ≥1 次；第 2 轮 context 含 toolResult；最终 assistant 含文本 |
| 3 | 接收 tool/turn 事件流 | ✅ | subscribe 收到 agent_start/agent_end/turn_start/turn_end/tool_execution_start/tool_execution_end；turn_start ≥2 |
| 4a | context transform 在每次 LLM 调用前被调用 | ✅ | transformContext 被调用 ≥2 次（每轮 LLM 调用前） |
| 4b | steering 可在运行中注入消息 | ✅ | `agent.steer({role:"user",...})` 注入的消息出现在最终 transcript |
| 4c | prepareNextTurn stop hook 被调用 | ✅ | prepareNextTurnWithContext 被调用 ≥1 次；运行结束后 isStreaming=false |
| 4d | abort() 提供 bounded stop | ✅ | abort 后 isStreaming=false，stopReason=aborted（50ms） |
| 5 | NovelOS 自主管理 session（无 PI UI 交互） | ✅ | 全程无 PI Host / PI UI 依赖，在 node --test runner 中运行 |
| 6 | 在无 UI 测试 runner 中运行 | ✅ | node --test 原生运行，无需 PI 扩展宿主 |
| 桥接 | project ModelGenerateFn → StreamFn | ✅ | createProjectStreamFn 桥接输出含 project 模型层文本与 route 标记 |

---

## 核心发现：streamFn abort 契约

**关键发现**：pi-agent-core 的 `runLoop`（`agent-loop.js:194-198`）调用 streamFn 时传入 `options.signal`，但 EventStream 本身**不自动响应 abort**。streamFn 必须自行监听 signal 并在 abort 时：

1. push 一个 `{type:"done", reason:"aborted", message}` 事件（message 的 stopReason="aborted"）；
2. 调用 `stream.end(message)` 结束流。

否则 agent loop 的 `for await (const event of response)` 会**永久挂死**在空流上。

**生产影响**：`createProjectStreamFn`（`pi-agent-core-adapter.ts`）已实现此契约：
- 检查 `signal.aborted`（已 abort 时立即结束）；
- `signal.addEventListener("abort", finishAborted)`（运行中 abort 时结束）；
- modelGenerate 结果到达时若已 aborted 则丢弃（防过期结果污染）。

**项目 ModelGenerateFn 限制**：项目 `ModelGenerateFn` 签名不接受 AbortSignal（只接受 `timeoutMs`），所以桥接无法真正取消在途的 HTTP 请求——只能结束 stream 让 agent loop 前进，并丢弃过期结果。这是 bounded trade-off：模型调用本身的取消仍靠 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS`，agent 层的取消靠本桥接的 signal 监听。

---

## API 表面（已验证可用）

### Agent 类（`@earendil-works/pi-agent-core`）

| API | 用途 |
|-----|------|
| `new Agent(options)` | 创建 stateful agent |
| `agent.prompt(text)` | 发起一轮 prompt |
| `agent.waitForIdle()` | 等待运行结束 |
| `agent.subscribe(listener)` | 订阅事件流（agent_start/end, turn_start/end, message_*, tool_execution_*） |
| `agent.steer(message)` | 运行中注入 steering 消息 |
| `agent.abort()` | bounded stop（触发 abortController.abort） |
| `agent.signal` | 当前 run 的 AbortSignal（也传给 streamFn options） |
| `agent.state` | AgentState（messages, isStreaming, streamingMessage, pendingToolCalls, errorMessage） |
| `agent.sessionId` | 自主管理的 session ID |

### AgentOptions 关键字段

- `initialState`：systemPrompt / model / thinkingLevel / tools
- `convertToLlm`：AgentMessage[] → LLM Message[]（NovelOS 用 identity）
- `streamFn`：模型调用桥接（用 createProjectStreamFn）
- `transformContext`：每轮 LLM 调用前对 messages 变换
- `prepareNextTurnWithContext`：stop hook（可替换 context/model 或返回 undefined 自然停止）
- `sessionId`：自主管理

### AgentTool（`typebox` schema）

- `name` / `description` / `label`
- `parameters`：typebox `TSchema`（`Type.Object({...})`）
- `execute(toolCallId, params, signal?, onUpdate?)` → `{content, details, isError?, terminate?}`
- `details` 携带 `sourceRef` + `evidenceLevel`（NovelOS 工具协议要求）

### 类型依赖

- pi-agent-core imports `TSchema` / `Static` from `"typebox"`（v1.1.38，pi-agent-core 的直接依赖）
- NovelOS 已把 `"typebox": "1.1.38"` 加为直接依赖（dependency hygiene，避免依赖传递可见性）
- pi-ai 的 `createAssistantMessageEventStream` 从 `"@earendil-works/pi-ai/compat"` 导入

---

## 回退判定：未触发

5 种有证据阻断均未出现：
- ❌ Node/模块系统不兼容 — Node v25.2.1 满足 >=22.19.0，ESM 正常加载
- ❌ API 无法接入项目模型层 — createProjectStreamFn 桥接成功
- ❌ 强依赖 PI Host 状态 — Agent 完全自主，无 PI 依赖
- ❌ 无法 bounded stop — abort 契约已实现验证
- ❌ 生产依赖冲突 — typebox 已显式声明，无冲突

**不回退**。NovelOS Runtime（`novelos/runtime/runtime.ts`）将委托 pi-agent-core Agent。

---

## 交付物

| 文件 | 说明 |
|------|------|
| `tests/novelos-spike-pi-agent-core.test.mjs` | 8 用例 spike 测试（全绿） |
| `novelos/adapters/pi-agent-core-adapter.ts` | 生产 adapter：createProjectStreamFn + createNovelOSAgent + 类型 re-export |
| `novelos/adapters/SPIKE-REPORT.md` | 本报告 |

## 残余风险

- **ModelGenerateFn 不接受 AbortSignal**：在途 HTTP 请求无法真正取消，只能靠 timeoutMs + 丢弃过期结果。如需更强取消语义，需扩展 ModelGenerateInput 加 signal 字段（M1 不做，记为后续优化）。
- **typebox vs @sinclair/typebox**：项目同时有 `typebox@1.1.38`（pi-agent-core 用）和 `@sinclair/typebox@^0.34.49`（项目旧依赖）。NovelOS 工具 schema 必须用 `typebox`（与 pi-agent-core 一致），不得混用，否则 TSchema 类型不兼容。
