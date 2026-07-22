# 小说用户权限矩阵与页面清单（T0-2）

冻结 `PINOVEL-SUB2API-INTEGRATION-1` 的小说功能权限模型。本文件为 Phase 2 实现 `novel.*` 权限的真相源。

## 1. 权限清单

小说功能采用独立权限命名空间 `novel.*`，与 Sub2API 现有用户/API Key 权限解耦。

| 权限码 | 含义 | 默认授予对象 |
|---|---|---|
| `novel.access` | 进入 `/novel` 功能页与查看自己的小说项目 | 启用小说功能的付费用户 |
| `novel.project.create` | 新建小说项目 | 启用小说功能的付费用户 |
| `novel.outline.edit` | 编辑 CreativeConstitution、世界观、角色档案、故事大纲、作者风格档案 | 项目所有者 |
| `novel.generate` | 发起章节生成任务、消费余额 | 项目所有者 |
| `novel.feedback` | 提交章节反馈、用户修改稿 | 项目所有者 |
| `novel.admin.view` | 管理员查看任意用户小说项目（必留审计） | 平台管理员 |
| `novel.admin.disable` | 管理员禁用某用户的小说功能 | 平台管理员 |
| `novel.admin.refund` | 管理员对小说任务发起退款/调账 | 平台管理员 |

> V1 不提供：协作者角色、跨用户共享、公开发布、文件上传、URL 导入。这些列入非目标（plan §5）。

## 2. 用户可见页面清单

`/novel` 前端功能页结构（Phase 5 T5-1）：

| 路由 | 名称 | 所需权限 |
|---|---|---|
| `/novel` | 小说项目列表 | `novel.access` |
| `/novel/new` | 新建小说向导 | `novel.access` + `novel.project.create` |
| `/novel/projects/:id` | 项目工作台 | `novel.access`（项目归属校验在数据层） |
| `/novel/projects/:id/constitution` | CreativeConstitution 与世界观编辑器 | `novel.outline.edit` |
| `/novel/projects/:id/characters` | 角色档案编辑器 | `novel.outline.edit` |
| `/novel/projects/:id/outline` | 故事大纲编辑器 | `novel.outline.edit` |
| `/novel/projects/:id/style` | 作者风格档案 | `novel.outline.edit` |
| `/novel/projects/:id/chat` | PI 风格对话区 | `novel.access` + `novel.generate`（对话扣费） |
| `/novel/projects/:id/chapters` | 章节列表与正文编辑器 | `novel.access` |
| `/novel/projects/:id/chapters/:n/generate` | 章节生成任务进度 | `novel.generate` |
| `/novel/projects/:id/feedback` | 用户反馈入口 | `novel.feedback` |
| `/novel/billing` | 余额与充值入口 | `novel.access`（充值走 Sub2API 现有支付） |

## 3. 用户禁止访问的资源

小说用户默认不能访问 Sub2API 的以下资源（与是否拥有 `novel.*` 无关，由路由层强制）：

- ❌ 模型列表页（`/admin/models`、`/api/v1/models`）
- ❌ Provider 信息页
- ❌ 上游账户管理（OAuth 账号池、API Key 池）
- ❌ 通用 API Key 管理页（用户只能拿到小说对话/生成所用的内部会话，不能拿到可调通用模型的 Key）
- ❌ 原始用量日志与 token 明细
- ❌ 管理员 Prompt Audit 页
- ❌ 内部生成 Trace 路径
- ❌ 任意上游模型直连端点

## 4. 项目归属校验

所有 `/api/v1/novel/projects/:id/*` 路由在数据层强制附加 `WHERE owner_user_id = $currentUserId`，不依赖前端传入的 userId。详见 [04 数据保留与租户隔离](./05-data-retention.md) 与 [Phase 4 T4-3](../plan202600722.md)。

管理员通过 `novel.admin.view` 访问用户项目时：
- 必须记录审计日志（adminUserId、targetUserId、projectId、accessedAt、action）
- 不得修改用户正文（只读）
- 用户可在自己的审计页看到管理员访问记录

## 5. 权限撤销与功能开关

- 管理员禁用某用户小说功能（`novel.admin.disable`）后：
  - 进行中的生成任务立即停止下一次模型调用（详见 [02-billing-rules.md](./02-billing-rules.md) §6）
  - 已生成章节保留只读访问
  - 余额不自动退还，由管理员决定是否调账
- Sub2API 全局小说功能开关（plan §8）关闭时：
  - `/novel` 全部页面返回 503 + 维护说明
  - 进行中任务按取消流程处理（已产生用量正常结算）
  - 不影响 Sub2API 其他 API 服务与充值
