# 上游模型商业授权记录（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 使用的上游模型商业授权情况。本文件为 Phase 10 发布前的合规前置项；任何上游模型接入必须先在本文件登记授权来源，再进入 `config/model-routing.json` 与 Sub2API 网关 Provider 配置。

## 1. 授权原则

1. **使用具有合法商业授权的上游模型渠道**（plan §1 冻结决策 2）。
2. 不使用破解、逆向、共享个人订阅、OAuth 令牌盗用、灰产拼车等非法渠道。
3. 不使用未授权的"镜像站"、"中转站"、"低价代充"渠道。
4. 每个上游 Provider 必须有可追溯的商业合同或自助开通的付费账户记录。
5. 接入新 Provider 前必须经法务/合规审核，登记到本文件后才可配置到生产 `config/model-routing.json`。

## 2. 上游模型登记表

> 下表为计划阶段的初始登记。实际接入时由平台运营方填入真实账户信息（不写入仓库，仅写入 Secret Manager 与本文件的脱敏版本）。

| PiNovelStudio Route | 计划用途 | 上游 Provider | 商业账户类型 | 授权来源 | 接入状态 |
|---|---|---|---|---|---|
| `v2_rawstage2_gemini31` | NovelOS Agentic 生成初稿 | Google AI Studio / Vertex AI | 商业付费账户 | Google AI Studio 商业条款 / Vertex AI 合同 | 待接入 |
| `v2_amplified_gemini31` | 作者风格整章优化 | Google AI Studio / Vertex AI | 商业付费账户 | Google AI Studio 商业条款 / Vertex AI 合同 | 待接入 |
| `v2_rawstage2` | Claude 显式备选初稿 | Anthropic | 商业付费账户（Anthropic API Console） | Anthropic Commercial Terms | 待接入 |
| `v2_amplified` | Claude 显式备选优化 | Anthropic | 商业付费账户 | Anthropic Commercial Terms | 待接入 |
| `v2_chinese_calibration` | 隔离评测/历史局部校准 | 字节火山方舟（Doubao） | 商业付费账户 | 火山方舟服务协议 | 待接入 |
| `v2_opportunity_judge` / `v2_literary_judge` | 隔离评测/回放（生产 0 调用） | OpenAI | 商业付费账户 | OpenAI Enterprise Terms | 待接入 |
| `novel_critic` 结构化检查 | 本地规则 + GPT 5.5 | OpenAI | 商业付费账户 | OpenAI Enterprise Terms | 待接入 |
| `style_shaper` / `stage5_style_shaper` / `stage8_final_gate` / `character_agent` | Claude Opus 4.6 | Anthropic | 商业付费账户 | Anthropic Commercial Terms | 待接入 |
| `narrator_testing_glm` / `style_shaper_testing_glm` / `chinese_naturalizer_glm` | 仅开发验证 / NovelBench lab | 智谱（GLM） | 商业付费账户 | 智谱开放平台服务协议 | 仅开发/NovelBench,不进生产 |

## 3. 生产路由白名单（来自 PiNovelStudio AGENTS.md，与 config/model-routing.json v4.31.0 同步）

**生产路径调用**（用户可见，计费）：

- `v2_rawstage2_gemini31` / `v2_amplified_gemini31` → Gemini 3.1 Pro Preview（默认 `writerModel`，`gemini_writer_v2`，失败 hard block，不静默切换）
- 显式 `writerModel=claude` → `v2_rawstage2` / `v2_amplified` → Claude Opus 4.6（`claude_writer_v1`，`fallback=[]`，不作为 Gemini 的自动备援）

**生产路径 0 调用**（仅隔离评测/回放）：

- `v2_chinese_calibration` → Doubao Seed 2.1 Pro
- `v2_opportunity_judge` / `v2_literary_judge` → gpt-5.6-sol

**禁止进入生产**：

- GLM 5.2：仅允许显式 `modelTestRoute=glm` / NovelBench lab route
- Qwen、ERNIE：当前 disabled

## 4. Provider 接入审核清单

新接入 Provider 时必须完成：

- [ ] 商业账户已开通并验证可调用
- [ ] 商业条款/服务协议已存档（链接或本地副本路径写入本文件）
- [ ] 法务确认条款允许"作为商业 SaaS 服务的下游模型使用"（即允许 PiNovelStudio 用户通过 Sub2API 间接调用）
- [ ] 数据处理协议（DPA）已签署（如 Provider 提供）
- [ ] 数据驻留与跨境传输合规确认
- [ ] 上游成本与计费费率已配置到 Sub2API 管理后台
- [ ] Provider 故障/限流时的 fallback 策略已定义（route-level fallback，非用户可见）
- [ ] 接入 PR 已更新本文件登记表
- [ ] 接入 PR 已更新 `config/model-routing.json`（仅 PiNovelStudio 侧 Route→Provider 映射）
- [ ] 接入 PR 已更新 Sub2API 网关 Provider 配置（实际账户、API Key 进 Secret Manager，不进仓库）

## 5. 授权变更与撤销

- 上游 Provider 修改商业条款、限流策略或模型版本时，必须重新审核
- 撤销某 Provider 接入时：
  1. 从 Sub2API 网关 Provider 配置移除
  2. 从 `config/model-routing.json` 移除对应 Route 或标记 disabled
  3. 本文件登记表"接入状态"列改为"已撤销"+ 撤销日期
  4. 已产生的历史调用记录保留（按 [05-data-retention.md](./05-data-retention.md) 保留周期）
  5. 不影响已生成章节的合法性

## 6. 商业授权证据留存

下列证据由平台运营方在 Secret Manager 或离线档案中留存，不在本仓库：

- Google AI Studio / Vertex AI 商业合同 PDF
- Anthropic Commercial Terms 接受记录 + 账户开通截图
- OpenAI Enterprise 合同
- 火山方舟服务协议
- 智谱开放平台服务协议
- 各 Provider 的 DPA（如适用）

> 本仓库只保留授权来源的脱敏描述（Provider 名 + 条款名 + 接入状态），不保留账户 ID、API Key、合同原文。
