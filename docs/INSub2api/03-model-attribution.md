# 模型调用归属与计费网关规则（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 的 LLM 调用归属与计费网关强制规则。本文件为 Phase 1 T1-3（统一模型出口）与 Phase 3（计费）的实现真相源。

## 1. 铁律

> 所有 PI 对话、小说规划、章节生成、风格优化产生的 LLM 调用，**必须**经过 Sub2API 计费网关。

具体表现为：

1. PI 与 PiNovelStudio 不直连任何模型厂商域名。
2. PI 与 PiNovelStudio 不读取 `.env` 中的 `GLM_*` / `DEEPSEEK_*` / `QWEN_*` / `CLAUDE_*` / `GPT_*` / `ARK_*` / `ERNIE_*` 等密钥。
3. 所有模型调用统一指向服务端配置的 `SUB2API_INTERNAL_LLM_BASE_URL`。
4. 未配置内部网关时必须 **fail closed**（拒绝生成，不回退到直连模型厂商）。
5. 失败后不允许自动切换到 fallback 模型厂商域名（route-level fallback 仍可由 Sub2API 网关内部决策，但出口域名唯一）。

## 2. 配置位置与可见性

| 配置项 | 位置 | 前端可见 | Workspace 可覆盖 | 用户可覆盖 |
|---|---|---|---|---|
| `SUB2API_INTERNAL_LLM_BASE_URL` | 服务端 env / Secret Manager | ❌ | ❌ | ❌ |
| `SUB2API_INTERNAL_LLM_API_KEY` | 服务端 env / Secret Manager | ❌ | ❌ | ❌ |
| `SUB2API_INTERNAL_LLM_TIMEOUT_MS` | 服务端 env（默认 300000） | ❌ | ❌ | ❌ |
| `NOVEL_TASK_TOKEN_HMAC_KEY` | 服务端 env / Secret Manager | ❌ | ❌ | ❌ |
| PiNovelStudio `config/model-routing.json` | 服务端镜像内只读 | ❌ | ❌ | ❌ |

> PiNovelStudio 现有 `config/model-routing.json` v4.31.0 的 Route 概念（如 `v2_rawstage2_gemini31`、`v2_amplified_gemini31`）继续作为 PiNovelStudio 内部 stage 路由决策依据，但其指向的实际 Provider/Model 必须由 Sub2API 网关解析。PiNovelStudio 侧只声明"我要走 v2_rawstage2_gemini31 这条 Route"，Sub2API 网关将其映射到合法商业上游。

## 3. 调用链路与归属字段

```text
浏览器
  └─ POST /api/v1/novel/generations
       (Cookie: sub2api_session; X-CSRF-Token)
       │
       ▼
Sub2API Go 后端
  ├─ 鉴权 → 解析 userId
  ├─ 格式校验 → Content Moderation / Prompt Guard
  ├─ 余额预占（事务）
  ├─ 签发短期任务令牌（含 userId/projectId/jobId/capabilities/maxCharge/nonce/expiresAt）
  └─ 内部调用 Novel Runtime
        │  (Header: X-Novel-Task-Token: <signed>; X-Sub2api-Internal-Call-Id: <uuid>)
        ▼
Novel Runtime (Node.js, 内网)
  ├─ 校验任务令牌签名、过期、nonce、capabilities
  ├─ 加载 PI + PiNovelStudio 6 工具
  └─ 所有模型调用统一通过 Sub2APIInternalLlmClient
        │  (Header: Authorization: Bearer <internal-key>;
        │          X-Sub2api-Task-Token: <signed>;
        │          X-Sub2api-User-Id: <userId>;
        │          X-Sub2api-Job-Id: <jobId>;
        │          X-Sub2api-Call-Id: <uuid>;
        │          X-Sub2api-Route-Hint: v2_rawstage2_gemini31)
        ▼
Sub2API 计费网关
  ├─ 校验内部 Key 与任务令牌一致性（防绕过）
  ├─ 选择合法商业上游账户
  ├─ 调用上游模型
  ├─ 记录 token 用量、actualProvider、actualModel、actualRoute
  ├─ 写入 model_call_attribution（管理员表）
  └─ 返回结果 + 用量给 Novel Runtime
        │
        ▼
Novel Runtime 把每次调用计量通过内部回调上报：
  POST /api/v1/internal/novel/billing/settle
  { jobId, callId, userId, inputTokens, outputTokens, actualCharge, status, requestId }
```

## 4. 调用计量字段（每条模型调用必含）

由 Sub2API 计费网关在响应头或响应体中返回，Novel Runtime 必须接收并上报：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | string | 上游请求唯一 ID（用于幂等与对账） |
| `inputTokens` | int | 输入 token 数 |
| `outputTokens` | int | 输出 token 数 |
| `actualCharge` | numeric | 实际扣费金额（CNY） |
| `actualProvider` | string | 真实 Provider（仅管理员可见，不返回用户） |
| `actualModel` | string | 真实模型版本（仅管理员可见） |
| `actualRoute` | string | PiNovelStudio Route 名（如 `v2_rawstage2_gemini31`，仅管理员可见） |
| `status` | string | success/failed/cancelled |
| `startedAt` | timestamp | |
| `completedAt` | timestamp | |

Novel Runtime 上报给 Sub2API 计费网关的 `settle` 请求只含脱敏字段（不含 Provider/Model/Route）；Provider/Model/Route 由 Sub2API 网关自己写入管理员表 `model_call_attribution`。

## 5. 管理员归属表（仅在 Sub2API 管理员侧）

```sql
CREATE TABLE model_call_attribution (
  attribution_id    TEXT PRIMARY KEY,
  call_id           TEXT NOT NULL,  -- 关联 novel_generation_calls.call_id
  job_id            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  internal_stage    TEXT NOT NULL,  -- PiNovelStudio Route 名
  requested_route   TEXT NOT NULL,  -- 如 v2_rawstage2_gemini31
  actual_provider   TEXT NOT NULL,  -- 如 anthropic / google / openai
  actual_model      TEXT NOT NULL,  -- 如 claude-opus-4.6 / gemini-3.1-pro-preview
  upstream_account  TEXT NOT NULL,  -- 上游账户标识（脱敏）
  input_tokens      INTEGER NOT NULL,
  output_tokens     INTEGER NOT NULL,
  upstream_cost     NUMERIC(12,6),  -- 真实上游成本（仅管理员）
  user_charge       NUMERIC(12,4),  -- 向用户实际扣费
  status            TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_attribution_user ON model_call_attribution(user_id, started_at);
CREATE INDEX idx_attribution_job  ON model_call_attribution(job_id);
```

> 此表不出现在用户视图、不出现在 `novel_generation_calls`（脱敏表）、不出现在前端响应。

## 6. 验收指标（来自 plan §9）

| 指标 | 要求 |
|---|---:|
| LLM 经 Sub2API 比例 | 100% |
| 无用户归属的模型调用 | 0 |
| 账本与模型调用差异 | 0 |
| 用户响应暴露模型或 Route | 0 |
| 未配置内部网关时仍发起调用 | 0（fail closed） |
| 用户可调用 Shell/代码执行 | 0 |
| 非法网络出口 | 0 |

## 7. 网络出口白名单（基础设施层）

Novel Runtime 容器/进程的网络出口只允许：

| 目标 | 端口 | 用途 |
|---|---|---|
| `sub2api-backend` (内网) | 8080 | 调用 Sub2API 计费网关 |
| `sub2api-backend` (内网) | 5432/6379 | 仅当 Novel Runtime 直读 DB 时（V1 不允许，全部经后端） |
| `object-storage` (内网) | 9000 | 上传章节产物（V1 由 Sub2API 后端代为上传，Novel Runtime 不直连） |

其他全部 deny。从基础设施层阻止 Novel Runtime 访问：

- `api.openai.com` / `api.anthropic.com` / `generativelanguage.googleapis.com` / `ark.cn-beijing.volces.com` 等模型厂商域名
- `*.github.com` / `*.npmjs.org` 等代码托管与包仓库
- 任意公网 IP

> 即使代码层 fail closed 失效，基础设施层网络白名单也阻止越权出口。两层防护缺一不可。
