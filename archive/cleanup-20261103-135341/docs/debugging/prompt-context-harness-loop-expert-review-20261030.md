# Prompt、上下文、Harness、Agent Loop 与专家群联合核查问题清单

日期：2026-10-30  
项目：`D:/CODE/PiNovelStudio`  
用途：交给后续 AI 实施整改；本文仅记录审查结果和方案，未修改实现代码。

## 1. 结论与审查边界

本次改动的方向对工程有益：补全提示词结构、压缩工具历史、增加工具入参校验、运行日志与退出预算，以及将专家职责拆分为可审阅的资料。但当前不能判定“完全符合规范、无隐藏问题、已证明提高小说质量”。已发现运行预算失效、实验范文进入生产、上下文预算绕过、工具契约缺口等问题；专家群还存在加载、工具名称、模型继承、交接格式与实际运行时不一致的问题。

审查范围为本地未提交修改及其直接依赖，包含前几轮 Prompt / 上下文 / Harness / Loop 核查，以及本轮新增专家群。未执行提交、暂存、恢复、清理、安装插件或付费模型调用。本轮只新增本文档。

**用户已确认的产品边界：蒸馏知识可以进入生产；good/bad 原文范文只用于离线实验。此项无需再次询问。**

课程来源：腾讯云课程的 [原始页面](https://cloud.tencent.com/edu/learning/course-4767-84816-84843) 与用户标注的 [第三章页面](https://cloud.tencent.com/edu/learning/course-4767-84815-84836)。用户页面证据明确涉及 Prompt 五要素、上下文四来源、Harness 五必备件、Agent Loop 四环节。

浏览器正文读取被工具的自动审批策略拒绝，因此未完整取得课程全文。本文依据用户提供的课程主题证据、项目 `AGENTS.md`、当前实现、已安装 PI 文档及离线验证审查，不能作为“课程全文逐条比对已完成”的证明。拒绝来自工具自动审批，不是缺少用户授权。

审查期间专家资料由 20 份变为 17 份，最终结构校验以最新的 **10 个专家定义、17 份领域资料**为准。后续 AI 修改前必须重新读取工作树；本文行号是审查时定位锚点。

以下位置以仓库根目录为基准。为便于阅读，表中 `EXT/` 统一代表 `.pi/extensions/novel-studio/`；这只是本文路径缩写，不是新增目录。

## 2. 汇总清单

P1：影响生产边界、预算或能力可用性，应优先处理。P2：功能、契约、可复现性和规范缺陷。状态区分“已复现”“静态确认”“待接入风险”；待接入风险不表示当前已发生生产事故。

| ID | 级别 | 状态 | 问题 | 建议顺序 |
|---|---|---|---|---|
| R01 | P1 | 已复现 | Loop 耗尽预算后仍可能继续调用模型，部分出口无失败信封 | 第一批 |
| R02 | P1 | 已复现 | good/bad 实验原文可进入正式章节上下文 | 第一批 |
| R03 | P2 | 已复现 | 外部知识在安全裁剪后追加，绕过上下文总预算 | 第一批 |
| R04 | P2 | 静态确认 | 单章必填字段在 schema 转换和运行校验中丢失 | 第一批 |
| R05 | P2 | 已复现 | 非法枚举值携带正文时，校验日志可输出全文 | 第一批 |
| R06 | P2 | 静态确认 | 默认测试依赖被忽略的本地数据，干净检出不可复现 | 第一批 |
| R07 | P2 | 静态确认 | 生产 user prompt、恢复指令和示例仍不满足项目规范 | 第二批 |
| R08 | P2 | 已复现/策略风险 | 无关知识仅靠章节阶段加分即可入选 | 第二批 |
| R09 | P1 | 检查失败 | Prompt registry 当前生产指针与实际内容漂移 | 发布前 |
| R10 | P1 | 静态确认 | 专家定义尚无当前配置下可发现、可派发的加载通路 | 专家第一批 |
| R11 | P1 | 静态确认 | 专家工具名、`model: inherit` 与已装 PI 示例契约不兼容 | 专家第一批 |
| R12 | P2 | 静态确认 | 专家资料的 17 条声明及 17 条正文链接均无法按普通相对路径解析 | 专家第一批 |
| R13 | P2 | 静态确认 | 专家职责要求调用或写入，但工具白名单不支持 | 专家第二批 |
| R14 | P2 | 静态确认 | 章节契约专家输出不能直接被实际接口消费，评分还能放过必需项缺失 | 专家第二批 |
| R15 | P2 | 静态确认 | 交付质检专家误用 status、路径、失败信封和 severity 契约 | 专家第二批 |
| R16 | P2 | 静态确认 | 风格专家要求生成正文改写，并夹带机械配额 | 专家第二批 |
| R17 | P2 | 静态确认/接入前条件 | 10 个专家正文均未采用项目规定的 Prompt 五要素 | 专家第二批 |
| R18 | P2 | 待接入风险 | 专家意见的权威、文件权限、上下文预算与运行预算尚无强制边界 | 专家上线前 |

## 3. 前几轮核查：具体问题与方案

### R01 / P1：预算耗尽不等于实际终止 Loop

**位置**：`EXT/novelos/runtime/runtime.ts:376`、`:460`、`:493`、`:542`；`EXT/novelos/runtime/budget-policy.ts`；项目锁定的 `@earendil-works/pi-agent-core@0.80.6` 的 `agent-loop.js`。

**问题与证据**：

- 累计耗时在 `turn_end` 才计入，此时本轮 `afterToolCall` 的终止判断已执行；core 内部下一轮不会重新进入外层 `runtime.prompt()` 的预算检查。
- 离线真实 runtime + 模型替身复现：`maxLatencyMs=5`，首轮模型耗时约 20ms 后工具成功，仍进入第二次模型调用；预算已耗尽，但轨迹没有相应 FailureEnvelope。
- 不存在的工具、参数校验失败及 `beforeToolCall` 阻断属于 immediate result，不经过 `afterToolCall`；`maxTurns=3` 的离线场景仍出现 6 次模型调用。这不只是“不计连续错误”，还暴露总步数退出缺少统一执行边界。
- core 0.80.6 对同批工具结果使用“全部 terminate”判定。阈值恰在最后一个工具触发时，前面的结果未标终止，仍可能进入下一模型轮。两工具连续失败达到阈值的场景已复现。
- 当前“工具失败且任一预算耗尽”都会记录成 `tool_error_streak`；例如 maxTurns 已耗尽但仅一次工具失败，也可能被误归因为达到连续失败阈值。

**修改方案**：沿用 core agentLoop，在适配层的真实模型调用边界统一检查 turn、toolCall、耗时、错误预算，并将停止信号传至整个运行；同批次达到停止条件时禁止下一轮。失败信封统一写入且幂等，保留真实耗尽原因。耗时限制应有运行级截止机制，并与单请求超时区分。不要自建另一套 ReAct 主循环，也不要只增大默认上限。

**验收**：使用实际 runtime 与 core、替身模型测试“仅文本多轮、成功工具、参数失败、不存在工具、策略阻断、多工具最后一个触阈值、超时”；断言实际模型调用次数、停止原因和失败轨迹。达到阈值后不能再发起下一次模型请求；成功工具应清零连续失败，其他预算耗尽不得误报错误连击。

### R02 / P1：离线范文通道泄漏到生产

**位置**：`EXT/v2/core/external-knowledge-base.ts:456`、`:494`；`EXT/v2/core/unified-entry.ts:2489`。

**触发与影响**：`PINOVEL_EXTERNAL_KB=0` 同时设置 `PINOVEL_EXTERNAL_EXCERPTS=good|bad`，仍返回原文前三段；生产统一入口接收该选集。原文未做相关性筛选。这违反用户已确认的用途，也违反生成正文 prompt 不提供可仿写范文的项目约束。

**修改方案**：将原文实验选择器移至隔离评测入口；生产选择器只返回蒸馏条目。生产不应因设置实验环境变量而开启原文通道；可以显式拒绝误配置或忽略并留痕。不要把 good/bad 重新包装成生产 P4 参考项。

**验收**：生产入口覆盖 KB 开/关与 excerpts good/bad/未设置的组合，生产 ContextPackage 和模型实参不得含实验原文或 `excerpts_*` 项；隔离实验仍能显式加载其固定 fixture。

### R03 / P2：新增知识绕过统一上下文预算

**位置**：`EXT/v2/core/context-package-production.ts:155`、`:187`。

**问题与证据**：`safety` 已通过裁剪后，`extraReferenceItems()` 再追加最多 `3×520` 字外部知识，编译时不复核预算，也不更新原裁剪报告。离线构造预算已耗尽的 safety 结果后，追加 520 字参考项仍返回 `ok:true`，报告仍只计原有预算。既有 fewshot 等附加项也有相同结构缺口，本次新通道扩大了影响。

**修改方案**：所有真正交给模型的附加项应在统一安全裁剪前进入 manifest；按 P4 优先级参与预算，完整记录 delivered/dropped 及原因。按实际最终消息估算必要的包装开销，保留 P0/P1，保护项超限继续 fail-closed。

**验收**：预算刚好用满、仅剩一条空间、保护项超限、fewshot 与外部知识同时存在；最终渲染输入不得无报告超限，dropped 能解释所有被省略条目。

### R04 / P2：单章条件必填字段未在执行入口强制校验

**位置**：`EXT/tools/register-tools.ts:400`；`EXT/tools/legacy-tool-wrapper.ts:13`；`EXT/tools/tool-input-validation.ts`；`EXT/craft/workspace-preflight-checker.ts:493`。

**问题**：schema 将 `chapterId/chapterNumber` 放入 `allOf/if/then`，但 TypeBox 转换丢弃该条件，运行校验器也不解析；handler 没有补齐相应校验。单章缺 `chapterNumber` 可进入后续流程，`chapterNumber > 1` 为 false，前置检查误走首章分支，并可能构造 `chundefined` 路径。尚未证明最终错误正文能保存，不能把风险写成已发生的数据损坏。

**修改方案**：在单章 handler 进入文件、审计、模型副作用前显式校验条件必填、正整数章号及非空 ID；batch 各 action 按现有分支契约校验。保留条件 schema 的模型可见表达，避免转换后静默弱化。可以用现有 TypeBox 能力，不需新增校验框架。

**验收**：单章缺字段/无效章号返回 `input_contract_violation`，handler 后续依赖调用次数为零；batch resume/status/cancel 仍可仅携带该分支所需字段，不被单章必填要求误伤。

### R05 / P2：错误日志的 actual 字段泄漏大段输入

**位置**：`EXT/tools/tool-input-validation.ts` 的 enum 分支 `actual: String(value)`；`EXT/tools/legacy-tool-wrapper.ts:70`；`EXT/utils/harness-logger.ts:57`。

**问题与证据**：logger 按 text/prose/draft 等键摘要，但正文若误填到 `mode` 或 `writerModel`，校验器将其完整放进 `violations[].actual`，随后写入 stderr。已离线复现全文输出；不是只有正常正文键才需要脱敏。

**修改方案**：校验错误中的 actual 使用类型、长度和有界摘要；对未知长字符串和嵌套值统一限长，避免 logger 任意键绕过正文保护。返回给调用方的错误内容也应有界。不要删除必要的错误定位信息。

**验收**：拦截 stderr，向非法枚举字段注入长正文、换行、嵌套对象，断言不出现完整正文和超限字符串，仍能定位工具、字段、期望枚举与错误类型。

### R06 / P2：默认测试依赖被 git 忽略的真实知识数据

**位置**：`EXT/tests/external-knowledge-base.test.mjs:135`、`:170`；根目录 `.gitignore:99`。

**问题**：默认测试直接读取 `data/external-distilled/slices.json`、`excerpts-good.json`、`excerpts-bad.json`，并强断言真实切片至少 10 条；这些文件被 `data/*` 忽略。本机数据齐全时测试通过，不代表干净检出可通过。

**修改方案**：普通测试使用临时目录和自包含小型 fixture，不依赖个人语料；需要真实数据的验收拆成显式离线命令，声明输入来源、版本、哈希与缺失处理。不要为通过测试把整库原文纳入版本控制。

**验收**：不加载本机 data 的隔离环境运行默认测试通过；真实数据验收缺文件时给出明确说明，不将其算作质量提升证据。

### R07 / P2：Prompt 五要素整改不完整，并引入具体正文示例

**位置**：`EXT/v2/core/author-style-optimizer.ts:24`、`:55`、`:449`、`:464`。

**问题**：system prompt 已有五要素，但实际拼装的 user 指令未按固定五标题组织；部分恢复指令仍是英文。新增示例包含可模仿的具体正文改写，不符合生成正文类 prompt 只能提供抽象正反例的要求。“逐句做同义改写”还可能诱导无必要的全面替换，与表达自由和定性优化目标有张力；这一点属于待评测的质量风险，未证明已造成文学退化。

**修改方案**：以所有真实生产模型调用边界为审计面，覆盖 system、user、重试/续写/恢复分支；按顺序输出 `【角色】【指令】【约束】【示例】【输出格式】`。将正文示例换成抽象对照，将优化目标写为保留有效表达、必要时调整表达，不设逐句替换义务。保留作者风格整章优化必经阶段，不得改成跳过优化。

**验收**：对实际捕获的模型实参做结构检查，覆盖恢复分支及中文边界；人工复核抽象示例、无机械配额；Prompt 修改按 R09 走真实评测与晋级。

### R08 / P2：检索相关性阈值被阶段加分单独穿透

**位置**：`EXT/v2/core/external-knowledge-base.ts:26`、`:34`、`:361`；生产调用 `EXT/v2/core/unified-entry.ts:2489`。

**问题与证据**：最低分 0.08，阶段精确匹配加分 0.15，生产调用未传 `sceneType`；字面相关性为零的候选可以仅凭 opening 等常见阶段入选。离线用“股市暴跌”查询选中战斗刀剑切片。当前测试还固定了类似排序预期，测试通过不能证明检索合适。

**修改方案**：将内容相关性或有效场景兼容作为入选前提，再对已相关候选做阶段/情绪加权；缺 sceneType 时不能虚构场景匹配。保留 Top-K、确定性排序与丢弃原因。不同评分尺度不能直接照搬另一通道的阈值 10。

**验收**：构造跨题材负例、同阶段无关例、同义相关例；不相关集合应返回空，相关候选可稳定召回。后续用真实章节与用户评价验证收益，不能只凭检索命中数。

### R09 / P1：当前 Prompt registry 漂移，不能视为可直接发布

**位置**：`config/prompt-registry.json:1038` 及 active production pointers；`EXT/scripts/prompt-registry-drift-check.mjs`；`EXT/novelos/eval/prompt-registry-drift-check.ts`。

**证据与归因边界**：前几轮针对当前构建运行的 basic 与 bundle drift 检查均为 4/4 槽位失败。部分路由/模型身份漂移可能先于本次改动，不能把全部漂移归因于新 Prompt；但当前工作树不是已验证的生产登记状态。普通测试启用 `PINOVEL_DEV_MODE=1`，不能据此证明生产发布门通过。

**修改方案**：逐槽核对实际 prompt、预算配置、模型身份、bundle fingerprint 与 draft 内容，先补齐当前真实 draft；收集真实评测与用户授权后再走已有晋级流程，active 只指向最终被批准的一套版本。不能直接重写 active hash、伪造评测证据或绕过 release gate。

**验收**：批准后的实际生产内容与 registry/hash/bundle 一致，basic/bundle drift 均通过；生产发布门在非 devMode 下验证。若评测或人工授权未完成，明确保留为待晋级，不能把“修改 hash 后检查绿”算验收完成。

## 4. 专家群新增核查：具体问题与方案

### R10 / P1：当前专家群只有定义资产，没有已接通的运行入口

**位置**：`.pi/agents/README.md:3`、`:84`；`.pi/settings.json:3`；`EXT/index.ts:75`、`:85`。

**证据**：当前项目与用户 PI settings 加载 novel-studio，入口注册现有工具，未发现 `.pi/agents` 的加载/派发实现；`.pi/extensions/workspaces` 为空，用户自动加载扩展目录亦未发现相关实现。已安装 PI 的 subagent 是 `examples/extensions/subagent` 示例，需要另行接入；该示例默认 `agentScope=user`，项目专家还需 project/both 范围。README 所称“可被 PI 派发”“改完即生效”缺少当前运行证据。此结论针对已检查的持久化配置，未声称能排除用户另行用临时 CLI 参数加载扩展。

**修改方案**：明确采用一种项目本地加载/派发机制，提供可检查的角色发现、调用与结果回传。优先复用现有 PI 能力，不能仅改 README 宣称已实现。若暂不接入，README 应如实标“设计资产、尚未可派发”。保持唯一章节生成主链路，专家派发器不得成为第二个生成入口；不得为整改擅改全局 PI 配置或静默安装远程扩展。

**验收**：离线加载能发现恰好 10 个唯一角色；未知角色 fail-closed；替身执行器完成 director → 单个专家 → 结构化回传，并记录角色、任务、结果、错误。清晰记录实际启动方式和项目范围，无需调用真实模型即可验证。

### R11 / P1：模型继承与工具名称不符合已安装 PI 的示例契约

**位置**：10 个 `.pi/agents/<role>.md` 的 frontmatter；`.pi/agents/README.md:23`、`:26`。

**证据**：10 个定义均写 `model: inherit` 与 `Read/Grep/Glob`。已装 PI 0.84.3 的示例 loader 原样接收这些字符串；派发时 `agent.model` 非空会变成 `--model inherit`，不会继承当前配置。示例文档要求省略 model 才继承。PI 内置工具名为小写 `read/grep/find` 等，示例不会把 `Read/Grep/Glob` 转换为相应名称。示例 loader 也不消费自定义的 skills/knowledge/display，字段被忽略不能证明附属能力生效。

**修改方案**：先确定 R10 采用的 loader，再以其真实契约规范所有角色。若采用当前官方示例语义，省略 model 以继承，改用实际注册的工具名；对自定义扩展工具也验证子进程是否加载、是否受到白名单限制。若保留显式 inherit，必须由项目适配器明确解析，并覆盖测试。skills 与 knowledge 要有实际加载或按需读取实现，不能靠未知字段自动生效。

**验收**：捕获派发参数，确认没有 `--model inherit`；未指定模型时继承父会话身份与思考配置；每个声明工具均能解析为已注册工具，未知工具拒绝加载。实际依赖版本与锁文件一致，不因宿主 0.84.3 与项目 core 0.80.6 不同而直接升级项目。

### R12 / P2：全部知识文件入口相对路径错误

**位置**：例如 `.pi/agents/novel-director.md:27`、`:106`；其他 9 个角色同类声明；`.pi/agents/README.md:85`。

**证据**：使用 YAML 解析器读取最新 10 个 frontmatter，列出 17 条 knowledge 声明；按定义文件所在目录解析时全部不存在。正文 17 个 `knowledge/*.md` 链接也全部失效。例如 `.pi/agents/novel-director.md` 的链接指向 `.pi/agents/knowledge/director-playbook.md`，实际文件是 `.pi/agents/novel-director/knowledge/director-playbook.md`。现有 17 份文件的 basename 与声明相符，主要错误在路径基准。不能声称宿主存在未实现的特殊路径规则。

**修改方案**：统一以定义文件目录为相对路径基准，改为 `<role>/knowledge/<file>.md`，同时更新 frontmatter、正文与 README 模板；或者在选定的 loader 中明确一种可验证的解析规则。防止路径逃逸和任意外部文件引用，不整库塞进 prompt。

**验收**：自动校验每条声明和 Markdown 链接存在、位于允许目录、没有重复/遗漏；当前 17/17 应可解析。缺资料时报告具体角色与路径，不能继续宣称领域资料已加载。

### R13 / P2：职责与工具权限相互矛盾

**位置**：`.pi/agents/novel-director.md:10`、`:68`、`:71`；`.pi/agents/chapter-intent-builder.md:10`、`:46`、`:64`；`.pi/agents/world-builder.md:43`、`:62`。

**问题**：director 工作流要求调用 `novel_generate_chapter` 和 `novel_strategy_feedback`，工具列表均未包含，也无实际专家派发能力；chapter-intent-builder 要求调用 preflight，却没有该工具；world-builder 要落盘 canon 与 config，却只有读取工具。无权执行的步骤可能被编成“已完成”，或迫使父代理在没有明确契约时越权代办。

**修改方案**：逐角色建立任务与能力矩阵。建议专家只交提案/诊断，由有权的协调层完成预检、唯一生成工具调用、用户反馈记录及受控配置变更。world-builder 提交带来源的变更提案，经用户确认及现有授权路径应用；不要直接给所有专家 write/bash 或章节/状态写权限。反馈只能来自真实用户评价，不能将 reader-proxy 的意见伪装成用户反馈。

**验收**：每条“调用/落盘”步骤都有真实授权执行者；专家未获授权时返回 pending/denied，不报告完成；director 的 dry-run 路径能走通，且不会直接写正文、长期状态或 `.env`。

### R14 / P2：自定义章节契约缺少可执行交接，数值总分可掩盖缺项

**位置**：`.pi/agents/chapter-intent-builder.md:5`、`:67`；其 `knowledge/chapter-seed-contract.md`、`knowledge/seed-quality-rubric.md:13`；`EXT/tools/register-tools.ts:311`；`EXT/craft/chapter-seed-builder.ts:1056`、`:1128`。

**问题**：专家声明输出能由工具直接消费，实际是自定义 Markdown 表格，未提供 `chapterId` 等完整调用身份，也无明确持久化/转换步骤。现有公开工具接收 `outline` 字符串等实际字段；已有作者章节契约分支读取 `series/chN-outline-explicit.md`，通过显式解析器解析事件，其 available 依赖 events 非空。把专家现有模板直接保存或塞入 outline 不能等价于实现映射，也不能保证 FACT/OOC/PROMISE ID 被正式消费。不能据此断言所有生成分支都要求该文件；问题是“直接可消费”的承诺没有对应适配。

评分卡又规定五项各 0–2 分、总分 ≥8 可生成，因此某项 0 分仍可过关，与定义中“必需项缺失即 blocked”矛盾；没有历史承诺的新书也不应被迫编造 PROMISE ID。

**修改方案**：以现有 tool schema、ChapterSeed/authorContract 为唯一契约，明确专家提案到既有输入的映射、身份字段、权威来源和有权执行者。适配器只转换已有作者内容，不凭空补造剧情/事实；必要的接口调整须测试消费链路，不能另建平行 Seed 版本。必需字段/事实冲突先做布尔检查，评分只作建议；历史承诺可明确“不适用”，不能用总分绕过必填。

**验收**：以专家格式 fixture 经过真正的 adapter → 现有 parser/builder → ContextPackage，断言意图、事实、章末目标与已确认承诺实际到达；缺任一必需项失败；新书无承诺不伪造 ID；不可解析时不触发正文模型，不把契约文当章节交付。

### R15 / P2：质检专家使用了错误的公开返回契约

**位置**：`.pi/agents/quality-gate-runner.md:41`、`:60`、`:62`；其 `knowledge/gate-runbook.md:26`、`:51`；`.pi/agents/novel-director.md` 的交付字段说明。实际契约见 `EXT/v2/core/unified-entry.ts:2843`、`:2876`、`:2887` 与 `EXT/craft/failure-envelope.ts:18`。

**证据**：

- 专家使用 `status=success` 判断可交付，真实公开结果是 `status=ok`，会把正常成功误判失败。
- 章节路径和 trace 路径位于 `stageResults.chapterFilePath`、`stageResults.tracePath`；失败是顶层单数 `failureEnvelope`。专家要求顶层 chapterPath/tracePath/failureEnvelopes，wrapper 不会替其重命名。
- 公开 `FailureEnvelope` severity 为 preflight/recoverable/hard_block，手册混用了内部 UnifiedFailureEnvelope 的 hard/fatal。内部/公开之间确有映射，不能假定两者同形。
- 只看状态、正文、优化标志不足以覆盖预览、持久化失败、最终保存和状态提交证据。

**修改方案**：专家及 director 使用公开真实结果契约，必要时增加小型结果摘要适配器，字段必须有来源；区分内部信封与公开信封。核对 `isPreviewRun`、必经阶段、最终文件与返回正文一致性、tracePersistence、状态提交及失败信封。诊断输出不能自行“修复”状态为成功，缺证据应标未确认。

**验收**：使用真实形状的 ok、blocked、error、preview、trace 写入失败/降级、状态提交异常 fixture；正常成功可识别，失败和预览不会当正式交付；不得把 blocked candidate 正文复制入 chapters。此处是专家消费契约问题，未证明生产保存逻辑已因此损坏。

### R16 / P2：风格专家越过“不直接撰写正文”边界，并含机械配额

**位置**：`.pi/agents/style-guardian.md:43`、`:61`、`:80`；`.pi/agents/style-guardian/knowledge/style-diagnosis.md:9`。

**问题**：专家要求生成 span 级改写候选、改前/改后正文，而项目规定正文由统一主链路产出，专家 README 也声明不写正文。“不覆盖”不能自动满足“不直接生成正文”。知识表把“每段至多一个比喻”列为定性指导，实为段落级机械配额。

**修改方案**：专家保留片段定位、证据、偏离原因和抽象编辑意图，不生成替代正文；实际表达修改通过既有授权生成/修订链路。将数量配额改为依语境判断的定性指导。作者确认后的风格观察才进入档案；提案不直接变成生产 Prompt 强约束。

**验收**：专家输出 fixture 不含新写的替代正文；资料与生产 prompt 不含比喻/对白/段长等机械配额；需要修文时明确交接至现有合法路径，无新生章节写入口。

### R17 / P2：专家 Prompt 未采用强制五要素结构

**位置**：10 个 `.pi/agents/<role>.md` 正文；`.pi/agents/README.md:85`。

**证据**：当前使用“一、人设 / 二、核心能力 / 三、工作流程 / 四、输出规范 / 五、领域资料”，结构校验为 0/10 含完整固定五标题。它们一旦作为实际生产 system prompt 派发，就不满足项目规定。README 的“正文五节齐全”并不是 Prompt 五要素合规检查；当前未接通运行不代表已在生产违规执行。

**修改方案**：以五个规定标题整理专家 prompt，领域资料移入按需参考说明；将实际模型边界的 user 任务包也纳入结构检查。仅重排必要内容，保留角色有价值的能力，不用“补空标题”掩盖职责/输出矛盾。未知字段或附属技能是否实际注入，必须由 R10/R11 的实现决定。

**验收**：10 个实际渲染后的角色 prompt 及任务消息按固定顺序包含五要素；示例与职责一致，无机械规则、正文范文和越权步骤。若进入既有 registry 管控范围，按 R09 登记，不伪造晋级。

### R18 / P2：专家接入前需补齐意见权威、权限与预算边界

**位置**：`.pi/agents/world-builder.md:43`、`:62`；`.pi/agents/continuity-auditor.md:56`、`:61`；`.pi/agents/chapter-intent-builder.md:57`；`.pi/agents/foreshadow-keeper.md`；选定的专家 loader/dispatcher（目前缺失）。

**风险**：continuity-auditor 将自己的 blocking 标注描述为“必然 FactGuard 阻断”；world-builder 直接把新增设定固化为权威；章节专家读取完整 narrative-state-store，风格专家读取多章全文。当前这些是定义中的要求，尚未证明已运行或发生泄漏；但若直接接入通用文件工具，生产 NovelOS 的字段白名单、工具结果 trust、压缩上下文和 budget 并不会自动覆盖另一个 PI 子进程。

**修改方案**：专家意见默认 proposal/reference，必须携带来源、定位和确认状态；既有作者批准事实与机器事实检查仍是权威，不把模型的 OOC/伏笔优先级推断自动升级为硬门或 CanonState。区分诊断角色与创作角色：受控诊断可取必要原文片段，但不得赋予通用全盘读取。通过工作包按字段与范围提供状态，默认排除 `.env`、凭据、章节/状态直接写入；明确每次专家调用的 token、模型调用数、耗时、取消、错误和 trace。不能用 Markdown“不得”替代工具层限制，也不能把多专家对话全量回灌生产上下文。

**验收**：越界路径读取/写入拒绝并留痕；参考文本中的指令不能改变权限或硬事实；未经确认的新事实不会入 CanonState；诊断不构成文学裁判；多专家有界运行且可取消，返回结果保留来源与省略报告。已有小说生产 Loop 的限制不能被另一个宿主进程绕过。

## 5. 专家逐角色覆盖表

| 专家 | 已核查材料 | 主要整改关联 |
|---|---|---|
| novel-director | 定义、director-playbook | R10–R13、R15、R17–R18；生成/反馈/派发职责要可执行 |
| world-builder | 定义、world-building-checklist | R10–R13、R17–R18；canon 只交受控提案 |
| character-designer | 定义、character-card-template | R10–R12、R17–R18；人物假设不能自动成为硬事实 |
| plot-architect | 定义、plot-architecture | R10–R12、R17–R18；保持高层结构职责和唯一生成链路 |
| foreshadow-keeper | 定义、promise-ledger、plant-payoff-patterns | R10–R12、R14、R17–R18；召回优先级与作者承诺区分 |
| chapter-intent-builder | 定义、chapter-seed-contract、seed-quality-rubric | R10–R14、R17–R18；真实输入映射与必需项检查 |
| style-guardian | 定义、style-diagnosis、style-fingerprint-fields | R10–R12、R16–R18；保留定性诊断，移除越权改文和配额 |
| continuity-auditor | 定义、continuity-checklist、timeline-extraction-rules | R10–R12、R17–R18；报告疑点，不能承诺替代 FactGuard |
| reader-proxy | 定义、reader-proxy-rubric、hook-and-payoff-catalog | R10–R12、R17–R18；读者假设为建议，不代替用户反馈 |
| quality-gate-runner | 定义、gate-runbook、failure-envelope-catalog | R10–R13、R15、R17–R18；按真实返回与持久化证据判断 |

通用缺陷在所有受影响角色中均应整改，不能只改表中示例角色。

## 6. 对项目收益的判断

值得保留的改动方向包括：工具入参校验前置、结构化失败与日志分工、工具历史压缩、显式省略信息、蒸馏知识的相关检索与上限、连续工具失败的独立预算、专家职责拆分以及带来源的诊断。这些都能降低工程不确定性。

目前收益的限制是：预算配置还没有覆盖真实退出边界；知识通道有污染与预算缺口；专家定义尚未形成可执行且受控的协作。专家越多不自动意味着质量更好，还会增加调用开销、意见冲突与错误放大。建议保留按需调用模式，先让单个专家的输入、输出、权限和证据闭合，再证明多专家协作的额外收益。

文学质量提升仍缺真实证据。`reports/ending-pressure-real-1/verification-report.md` 与 `reports/language-calibration-real-1/verification-report.md` 均声明 stub 模式；它们可以证明部分离线流程可达，不能用于声明本次生产 Prompt 或专家群优于原链路。

## 7. 已完成验证与限制

前几轮完成的验证：

- 根目录 fresh `npm run build` 通过。
- 94 项定向测试及 34 项 author-style 相关测试通过，共 128 项；覆盖 context-management-compaction、external-knowledge-base、loop-exit-mechanisms、tool-input-contract、batch-generation-contract/integration、dependency-boundary、retrieval-budget-runtime、tool-visibility-runtime、registry-governance 及 author-style 表达/恢复/旧指导/策略测试。
- 使用 `node --import ./tests/setup-test-env.mjs --test --test-isolation=none ...` 避开当前沙箱子进程 spawn EPERM；测试通过不抵销 R01 等额外复现场景。
- registry basic/bundle drift 当前各 4/4 槽位失败。
- 平台 Vitest 在默认方式与调整 runner 后均因启动阶段 spawn EPERM 未能执行，不能记作断言失败，也不能记作通过。

本轮专家验证：

- 用已安装 YAML 解析器实际解析 10 个 frontmatter；角色数量 10、knowledge 声明 17、不可解析声明 17、正文不可解析资料链接 17、符合完整固定五标题的定义 0。
- 最终知识文件数 17，未发现最终 frontmatter 与实际文件 basename 的缺漏；早期 20 份状态不用于最终计数。
- 读取项目及用户 PI settings、入口注册、自动发现扩展目录，并核对本机已安装 PI 0.84.3 示例 loader/dispatcher 文档和源码。
- 未运行专家真实模型调用、正式章节生成、付费评测或平台 E2E；未证明小说质量正收益。本轮仅写文档，因此不重复整套构建测试。

额外环境观察：git 提示 alternates 指向不存在的 `D:/CODE/sub2api/.git/objects`，但本次 status/diff 仍可工作。它不属于本次修改的已证明回归，不应由后续 AI 顺手修改全局/仓库 git 配置；如影响后续操作再单独定位。

## 8. 交给实施 AI 的执行要求

1. 首先重读当前工作树及本文涉及文件。保留用户未提交、已暂存、未跟踪修改与 stash，不执行 reset/checkout 恢复、批量删除、全量格式化或无关整理。本文是审查快照，若用户后续已修复某项，核实后更新其状态，勿覆盖新工作。
2. 先处理 R01–R06 的执行与隔离缺陷，补最小但有意义的复现/回归；R01 必须测真实 runtime/core 接线，不能只测预算计数器。
3. 处理 R07–R08；登记真实 Prompt draft，再按 R09 完成发布准备。需要真实评测或用户晋级授权时明确停在该边界，不绕过门禁；离线修改和可复现验证应先完成。
4. 将 R10–R12 作为专家可运行性的前置条件，选择一种项目本地接入方案。将 R13–R18 作为接入验收条件，先验证单专家再验证协作；不擅自安装远程插件、修改用户全局 settings 或调用收费模型。
5. 保持 `novel_generate_chapter` 为唯一章节生成入口、Agentic 初稿后必经作者风格整章优化、事实复检与最终状态事务。禁止恢复旧 Stage0–8、原文生产通道、文学机器 judge、跨模型 fallback、代理直接写正文或未经确认提交长期状态。
6. 遵守单一最新版本原则，不新增 legacy/新版并行运行、第二套 Seed/配置真相或常驻模式开关。不因整改引入 zod/ajv/日志或遥测框架。
7. 每项交付须列出实际修改文件、根因、验证命令与结果、剩余限制。完成后按 R01–R18 回填“已修复/已验证/待外部证据”，不要用“build 通过”替代质量验收，也不要伪造 active hash、晋级授权或评测结果。

专家群接入方式尚未确定。实施 AI 可以先在现有 PI 和项目约束内形成一个最小可审查方案并完成离线验证；若方案确实需要改变公开工具面、放宽写权限或修改用户环境，应把具体差异与原因交给用户确认，不能默认扩大权限。

## 9. 整改回填（2026-10-30）

状态口径：**已修复（离线验证）** = 代码/文档已改并有可复现断言；**已验证（真实链路离线）** = 已通过现有真实解析/构建链路；**待外部证据** = 需真实评测或用户授权，未晋级、未伪造。全部验证未调用付费模型、未改全局 PI 配置、未执行提交/恢复/stash 操作。

| ID | 状态 | 实际修改文件 | 根因与做法 | 验证结果 | 剩余限制 |
|---|---|---|---|---|---|
| R01 | 已修复（离线验证） | `novelos/runtime/runtime.ts`、`novelos/runtime/budget-policy.ts`、`tests/loop-exit-mechanisms.test.mjs` | 预算只在工具回调判定、`recordLatency` 无调用方、immediate result 绕过 `afterToolCall`。改为在真实模型调用边界复检 turn/toolCall/墙钟/连续失败，统一写幂等 FailureEnvelope，并按真实耗尽原因归因。 | 真实 runtime + 模型替身：`maxTurns` / 墙钟 / 工具不存在 / 同批最后一项触阈值 / 单次失败不误归因，断言实际模型调用次数与停止原因。 | 未跑真实模型长跑；上限取值仍需真实章节耗时校准。 |
| R02 | 已修复（离线验证） | `v2/core/external-knowledge-base.ts`、`v2/core/unified-entry.ts`、`tests/external-knowledge-base.test.mjs` | 生产选择器在 `allowExcerpts=false` 时忽略 `PINOVEL_EXTERNAL_EXCERPTS` 并留痕，原文通道只在隔离评测显式开启。 | 生产入口 KB 开/关 × excerpts good/bad/未设置组合断言无 `excerpts_*` 项；隔离评测 `allowExcerpts=true` 仍可加载 fixture。 | 未证明引入蒸馏知识对文学质量的正收益。 |
| R03 | 已修复（离线验证） | `v2/core/context-package-production.ts`、`v2/core/context-safety.ts`、`tests/external-knowledge-base.test.mjs` | 附加参考项在统一裁剪前进入 manifest，按 P4 参与预算并记录 delivered/dropped，不再“裁剪后追加”。 | 预算用满 / 仅剩一条空间 / 保护项超限；开关打开只新增 P4 槽，权威槽与预算逐项不变。 | 未做超长真实 chapter 的端到端 token 计量。 |
| R04 | 已修复（离线验证） | `tools/register-tools.ts`、`tools/tool-input-validation.ts`（新增）、`tools/legacy-tool-wrapper.ts` | TypeBox→JSON Schema 转换丢弃 `allOf/if/then` 条件，handler 无补齐校验。改为单章显式校验章号/ID，batch 分支保持原契约，违反即 `input_contract_violation` 且不执行 handler。 | 缺 `chapterNumber` / 空或穿越 `chapterId` / 0、小数、负数章号均在 handler 前阻断；batch resume/status/cancel 不被误伤。 | 条件必填仅覆盖已知分支；新增分支需补对应用例。 |
| R05 | 已修复（离线验证） | `tools/tool-input-validation.ts`、`utils/harness-logger.ts`（新增）、`tests/tool-input-contract.test.mjs` | 校验 `actual: String(value)` 与 logger 键名白名单都会泄漏长正文。改为类型 + 长度 + 有界摘要，logger 对任意超长字符串统一限长。 | 长正文/换行/嵌套对象注入非法枚举字段后，stderr 无完整正文且仍可定位工具、字段、期望枚举、错误类型。 | 未覆盖所有未来新增日志字段。 |
| R06 | 已修复（离线验证） | `tests/external-knowledge-base.test.mjs`、`scripts/verify-external-knowledge-data.mjs`（新增） | 默认测试读取被 `.gitignore` 忽略的 `data/external-distilled/`。改为临时目录自包含 fixture；真实数据改为显式离线命令（来源、sha256、结构摘要、缺失说明、退出码 0/2）。 | `node scripts/verify-external-knowledge-data.mjs`：slices 10 条、excerpts 6/4 条、loader ok；结论明确“仍需真实章节 replay 与用户评价才算质量证据”。 | 本机有数据不代表干净检出可复现；该命令只核对输入，不是质量证据。 |
| R07 | 已修复（离线验证） | `v2/core/author-style-optimizer.ts`、`tests/author-style-expression-only.test.mjs` | user 指令未按五要素、恢复指令英文、示例含可仿写正文。改为全部生产分支（首次/整章/续写/`fact_guard`/`completeness` 恢复）按固定五标题中文组织，示例改抽象对照，删除“逐句同义改写”义务。 | 捕获各分支模型实参文本做结构断言：五要素顺序、恢复与续写均中文、无机械配额、保留事实边界与完整输出要求。 | 未做真实模型 A/B，不宣称质量提升；Prompt 变更按 R09 待晋级。 |
| R08 | 已修复（离线验证） | `v2/core/external-knowledge-base.ts`、`tests/external-knowledge-base.test.mjs` | 阶段加分可单独穿透相关性阈值。改为内容相关性/有效场景兼容为入选前提，再对已相关候选做阶段/情绪加权；缺 `sceneType` 不虚构匹配。 | 跨题材负例返回空、同阶段无关例排除、同义相关例稳定召回；确定性排序与丢弃原因保留。 | 阈值仍是启发式，需真实章节 + 用户评价确认收益。 |
| R09 | 待外部证据（待晋级） | `scripts/prompt-registry-draft-current.mjs`（新增）、`config/prompt-registry.json` | active 指针与真实内容漂移属发布登记问题。逐槽核对 active/actual/bundle，为 4 槽补齐“当前真实基线”draft（novelos_agentic-v7 / style_optimizer-v6 / writer_adapter-v6 / retrieval_eval-v7），不改进 active、不写评测证据。 | 只读报告：4 槽 `hashMatch=false`、`latestDraft matchesActual=true`；`--write` 判定无需新增。 | basic/bundle drift 仍按设计 fail-closed；须真实评测 + 用户授权后晋级，本轮回填不代表发布门通过。 |
| R10 | 已实现（离线验证，未接入宿主） | `novelos/experts/expert-registry.ts`、`novelos/experts/expert-dispatcher.ts`、`test/test-modules.ts`、`.pi/agents/README.md` | 专家只有定义、无可发现/可派发通路。新增项目内最小注册表 + 注入式 executor 派发器，只进 `dist-test`，不注册公开工具、不成为第二生成入口。 | 真实 agents 目录发现 10 个唯一角色零 error；未知角色 `unknown_expert`；director→单专家结构化回传；预算/取消/路径/工具越权均有明确状态。 | 未接入 PI 子进程自动派发（README 已如实标注），真实模型派发需另行授权。 |
| R11 | 已修复（离线验证） | 10 个 `.pi/agents/*.md`、`.pi/agents/README.md`、`novelos/experts/expert-registry.ts` | `model: inherit` 会被当作模型名、大写工具名不匹配实际注册名。改为省略 `model` 继承、只声明 `read/grep/find(/ls)` 与实际 `novel_*` 工具，未知工具与 `model: inherit` 直接报 error。 | 10/10 `model=null`、工具全部可解析、每个专家无 `novel_generate_chapter`/写工具；不合规模板夹具报 error。 | 宿主侧子进程是否加载扩展工具仍需接入时验证。 |
| R12 | 已修复（离线验证） | 10 个 `.pi/agents/*.md`、`.pi/agents/README.md` | knowledge 声明与正文链接以定义文件同目录为基准失效。统一改为 `<role>/knowledge/<file>.md`，并把按需参考资料收敛为每角色一份主手册。 | 10/10 声明与正文链接存在、位于允许目录、无重复/逃逸；路径校验拒绝 `.env`/`chapters/`/长期状态/目录外。 | 若未来需要拆分独立资料，须先改校验与 README 规则。 |
| R13 | 已修复（离线验证） | `.pi/agents/novel-director.md`、`world-builder.md`、`character-designer.md`、`foreshadow-keeper.md`、`chapter-intent-builder.md`、`plot-architect.md`、`.pi/agents/README.md` | 定义要求调用/落盘但工具白名单不支持，易被编成“已完成”。建立职责矩阵：专家只交提案/诊断，落盘、预检、唯一生成调用、用户反馈由有权协调层执行，需未授权动作时输出 `pending_parent_action`。 | 派发器拒绝 `.env`/章节/状态写入与未声明工具；每个专家工具集不含生成入口与写工具。 | 真实“父代理执行提案”的审批流仍需在接入时实现并验证。 |
| R14 | 已验证（真实链路离线） | `novelos/experts/chapter-contract-bridge.ts`、`.pi/agents/chapter-intent-builder.md`、其 `knowledge/chapter-seed-contract.md`、`tests/expert-chapter-contract.test.mjs` | 自定义契约无法被真实接口消费，评分总分可掩盖缺项。改为必需项布尔检查（评分仅建议）、禁止编造 FACT/PROMISE、无事件拒绝生成显式章纲；输出格式对齐真实消费者。 | 专家 fixture → `validate` → `toExplicitOutlineMarkdown` → 现有 `parseExplicitOutline` → `buildChapterSeed`：`authorChapterContract.available=true`，`mustInclude`/`eventSummaries`/`relevantCharacters`/`endingTarget` 实际到达；缺项、编造 ID、新书 PROMISE、无事件均阻断。 | 尚未把该转换挂到协调层的自动写入步骤（当前由父代理/人工写入 `series/chN-outline-explicit.md`）。 |
| R15 | 已修复（离线验证） | `novelos/experts/expert-result-summary.ts`、`.pi/agents/quality-gate-runner.md`、其 `knowledge/gate-runbook.md` | 专家用 `success`、顶层路径、复数信封、内部 severity。改为只读摘要适配器：`status="ok"`、`stageResults.chapterFilePath`/`tracePath`、单数 `failureEnvelope`、`isPreviewRun`、`stateCommit`、公开三值 severity。 | ok/blocked/error/preview/stateCommit 未提交/文件缺失或为空/severity 非法 全用例；`success`/顶层路径/复数信封一律判不可交付。 | 真实 `tracePersistence` 降级证据仍靠 trace，不在摘要内推断。 |
| R16 | 已修复（文档核对） | `.pi/agents/style-guardian.md`、其 `knowledge/style-diagnosis.md` | 专家要求 span 级改前/改后正文并含“每段至多一个比喻”配额。改为片段定位 + 证据 + 抽象编辑意图（调整方向/必须保留/禁止新增），表达修改交既有授权链路；比喻改为随场景强度定性判断。 | 人工核对：无替代正文、无量化配额、无新生写入口。 | 尚无自动断言锁定“专家输出不含替代正文”，接入前应补。 |
| R17 | 已修复（离线验证） | 10 个 `.pi/agents/*.md`、`.pi/agents/README.md` | 专家正文结构为“人设/能力/流程/规范/资料”，不符合强制五要素。改为【角色】【指令】【约束】【示例】【输出格式】，参考资料改按需说明。 | 10/10 定义按固定顺序含五标题；任务包渲染同样五要素。 | 专家 prompt 未进入 registry 管控，未登记即不涉及晋级。 |
| R18 | 已实现边界（离线验证） | `novelos/experts/expert-dispatcher.ts`、`expert-registry.ts`、`expert-result-summary.ts`、`.pi/agents/*.md` | 多专家若直接接入通用文件工具，会绕过生产白名单/trace/预算。用派发器强制：工具白名单、路径拒绝、每次调用预算（次数/墙钟/提示词/输出）、显式省略报告、可取消；专家意见默认 proposal/reference。 | 越权工具/路径 denied 并留痕；输出超限声明 `output_budget_truncated`；预算耗尽与取消有状态；未知角色 fail-closed。 | 未接入 PI 子进程真实运行，token/trace 计量未接到宿主；多专家协作收益未验证。 |

统一验证命令（cwd = `.pi/extensions/novel-studio`）：

```bash
npm run build
node --import ./tests/setup-test-env.mjs --test --test-isolation=none tests/expert-registry.test.mjs tests/expert-dispatcher.test.mjs tests/expert-chapter-contract.test.mjs tests/expert-result-contract.test.mjs tests/dependency-boundary.test.mjs tests/loop-exit-mechanisms.test.mjs tests/tool-input-contract.test.mjs tests/external-knowledge-base.test.mjs tests/context-management-compaction.test.mjs tests/author-style-expression-only.test.mjs tests/author-style-recovery-feedback.test.mjs tests/author-style-legacy-guidance.test.mjs
```

结果：三目标构建退出码 0；12 个测试文件共 **110 项全部通过**（0 失败）。另有两条显式离线验收命令：`node scripts/verify-external-knowledge-data.mjs`（退出码 0，且自述非质量证据）与 `node scripts/prompt-registry-draft-current.mjs`（只读，4 槽 draft 已对齐实际、active 保持待晋级）。

仍未完成、必须由真实评测或用户授权推进的部分：R09 晋级与发布门（basic/bundle drift 保持 fail-closed）、R07 真实模型 A/B、R10/R18 真实子进程派发接入与 trace/token 计量、R16 的“专家输出不含替代正文”自动断言。以上均未伪造 hash、评测结果或晋级授权，也未以“build 通过”替代文学质量验收。

## 10. 复审遗留项（2026-10-30，第二轮）

### 10.1 已修复：生产外挂知识检索的“阶段匹配但零相关”兜底

**根因**：`v2/core/external-knowledge-base.ts` 的结构化兜底只按 `chapter_phase` 与总分筛选，不要求 `entry.eligible` 或最低字面相关性；`v2/core/unified-entry.ts` 生产调用点显式 `allowStructuralFallback: true`。因此 query=`股市暴跌债券收益率`、`chapterPhase=opening`、`literalScore=0` 仍会选中 opening 阶段的小说战斗切片并标 `structural_fallback`，违反“低于相关性阈值的候选不得进入 prompt”。

**做法**：生产调用点改为 `allowStructuralFallback: false`（显式关闭，不依赖默认值）；`external-knowledge-base.ts` 头注释与三处选项注释改为“仅隔离实验可用、生产不得开启”；保留机制供隔离实验，若确需启用按例外登记并单独验证收益。

**验证**：`tests/external-knowledge-base.test.mjs` 新增 2 项断言 —— ①生产守卫：源文件中不得出现 `allowStructuralFallback: true`、必须显式 `false`；②复现用例：上述查询在生产默认下 `items.length=0`、`selectionMode=none`、`structuralFallbackIds=[]` 且全部候选记入 `droppedByRelevanceIds`。该文件 21/21 通过；`npm run build` 三目标退出码 0；`dependency-boundary` + `context-management-compaction` 30/30 通过。

### 10.2 仍需用户决策的三项（未改动代码）

| 项 | 现状证据 | 未完成原因 | 需要的决定 |
|---|---|---|---|
| Prompt Registry 4/4 fail-closed | `npm run verify:prompt-registry` 退出码 1：4 槽 promptHash/budgetHash/bundle 全漂移，且 `modelVersion gemini-3.8-flash → gemini-4-argon`、`route novelos_agentic → v2_rawstage2_gemini31`、`maxTokens 2048 → 16384` 属身份漂移；`node scripts/prompt-registry-draft-current.mjs` 显示 4 槽 `latestDraft matchesActual=true`（draft 已就绪，active 未动） | 晋级需真实 replay/evaluation + 用户授权，不得凭 draft 伪造晋级 | 是否授权真实评测，或先跑确定性 harness |
| 专家群未接入 PI 生产运行时 | `.pi/settings.json` 仅加载 novel-studio；`index.ts` 只注册 6 个公开工具；专家模块只进 `dist-test`；`.pi/agents/README.md` 自述未接入 | 接入会改变公开工具面与宿主派发权限，属用户环境变更 | 保持离线资产，还是接入宿主并新增派发面 |
| 章节契约桥无生产 handoff | `chapter-contract-bridge.ts` 仅被测试引用；`batch-generation-handler.ts` 仍要求预置 `series/chN-outline-explicit.md` | 需要“提案→确认→授权写入→生成→trace 记来源”新流程与写入权限 | 是否建立该正式流程 |

以上三项均未做任何代码或配置改动，避免在无授权前提下扩权或伪造证据。

### 10.3 用户决策与执行结果（2026-10-30，EXPERT-HOST-HANDOFF-1）

| 项 | 用户决策 | 本轮执行 |
|---|---|---|
| Prompt Registry | **保持 fail-closed，等真实评测** | 未改 `config/prompt-registry.json`，未改 active、未伪造 promptHash/budgetHash/bundle fingerprint；4 槽 draft 继续留在 draft 区，晋级前置条件不变 |
| 专家群接入 | **立即接入宿主侧派发面** | 新增 `handlers/expert-handoff-handler.ts`，经现有 `novel_workspace_manager` 暴露 `list_experts` / `dispatch_expert` / `handoff_chapter_contract`，**不新增第 7 个公开工具**（`platform/.../tool-whitelist.ts` 与 `register-tools.ts` 的 6 工具契约不变） |
| 章节契约桥 | **实现正式 handoff 流程** | `handoff_chapter_contract`：preview 只校验并返回章纲文本/目标路径/hash（零写入）；commit 要求 `confirm=true` + `confirmedBy`，原子写 `series/ch{N}-outline-explicit.md`，并落 `*.provenance.json`（expertRole / proposalHash / confirmedBy / confirmedAt / 消费方 / trace 引用）；目标已存在且内容不同时必须显式 `overwrite=true` |

如实边界：

- `dispatch_expert` 只返回**宿主可执行的专家任务包**（system prompt + task message + 只读工具白名单 + 预算），扩展自身**不调用模型、不写文件**；`executionMode="execute"` 在生产无授权执行器时 fail-closed，不静默假装已派发。
- PI 宿主仍无原生专家自动派发：专家需由调用方显式 `dispatch_expert`，再由宿主用自身模型执行任务包；专家输出仍是提案。
- 生产 trace 中的来源记录方式：`series/ch{N}-outline-explicit.md` 会进入 `authorChapterContract.sourceIds`，provenance 侧车记录专家角色与提案 hash。

验证：`npm run build` 三目标退出码 0；`tests/expert-production-handoff.test.mjs` 7/7；回归 `production-tool-registration`、`audit-fixes-negative`、`public-tool-integration-repairs`、`workspace-manager-proxy-finalization`、`dependency-boundary`、4 个 expert 测试共 97 项中 1 项仅因 dist 文件数守卫需随合法新增模块上调（已同步改为 361），其余全部通过。


