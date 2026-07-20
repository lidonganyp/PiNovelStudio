---
name: novel-ai-fullauto-blueprint
description: |
  AI 全程托管型网文大纲优化与章节节拍工程化 Skill。
  当小说全程由 AI 编写、用户不参与改稿时调用此 Skill，
  把"读者体验"翻译成可由 PiNovelStudio 49 个工具实时校验的工程指标。

  核心交付：v4.0 爽文向 outline 重构 + 工具杠杆启用配置 +
  钩子/装逼/打脸模板库 + 副本/场景设计卡 + 卷读者指南 +
  人物关系图 + arc-registry 初始化。

  触发条件：
    - "全程 AI 生成"/"用户不改稿"
    - "优化大纲，按 AI 友好方式"
    - "把读者体验拉满"/"把追更率拉到最高"
    - "改造为爽文" + "AI 自动生成"
    - 已有 workspace 但大纲过于文学/克制/反爽文倾向

  反例（不要触发）：
    - 用户明确要"亲自改稿/逐章核验" → 用 novel-chapter-revision
    - 初始化新 workspace → 用 novel-init
    - 只是写一章 → 直接 novel_generate_chapter
---

# Novel AI Full-Auto Blueprint — AI 全程托管型大纲工程化

## 一、设计哲学（不可违背）

> **AI 不试图写得好，AI 只精准踩节拍。**
>
> 钩子在第几秒响、装逼在第几段炸、悬念在第几章兑、人物在第几卷转——
> 全部锁死成可验证指标，由 PiNovelStudio 49 个工具实时校验。
>
> 这是 AI 连载小说唯一能赢的打法：**用工程化的节奏感，碾压人类作者的天赋发挥。**

---

## 二、适用判定（先做这一步）

执行 Skill 前先确认四件事，**任一不满足请用户先调整方向再回来**：

| 必备条件 | 检查方式 |
|---|---|
| 用户明确说"全程 AI 生成，不参与改稿" | 用户原话 |
| workspace 已存在（有 config.json + 角色档案） | `ls workspaces/{id}/` |
| 已有/即将有 outline.md（哪怕是文学向旧版本） | 读 series/outline.md |
| 用户接受"爽文骨架 + 悬疑/言情/玄幻外壳"定位 | 用户确认 |

> ⚠️ 不适用：纯文学向、用户参与改稿型、短篇/中篇（< 50 章）、非线性叙事实验作品。

---

## 三、AI 全自动场景的 12 条硬约束

### A. 结构层

1. **每章必须章内闭环**：本章问题本章解决 + 留 1 个新钩子。AI 跨章悬念衰减快。
2. **子情境单元长度固定**：副本/案件/任务/局，每个 3-5 章。**6 章以上必水**。
3. **同台对话角色 ≤ 3 人**。4+ 群像声线必崩。

### B. 角色层

4. **卷一主角基本独行**（最多 1 个工具人盟友），减少认知负荷。
5. **每角色固化 voiceFingerprint**：单句口头禅 / 平均句长 / 标点偏好 / 思维节奏 / 隐性局限。Stage 5/8 voice_blacklist_scan 强制验证。
6. **关键挂壁角色用"注释格式"出场**（半透明/系统/档案残页）。AI 写半透明角色对话必崩。

### C. 伏笔层

7. **伏笔三级 + 总量上限**：章内不限 / 卷内 5-15 章 / **跨卷 ≥30 章上限 6 条**。
8. **主伏笔 ≤ 12 条**。合并近似项，砍掉 AI 无法维护的细枝末节。

### D. 信息释放

9. **信息门禁 ≤ 4 维**。多维门禁导致 Stage 1.5/1.6 反复阻断。
10. **取消"代码片段穿插正文"机制**，改为**档案残页/系统消息/物件铭文**（可控文本块）。

### E. 爽点节奏

11. **爽点模板枚举抽签**：8 钩子 + 6 装逼 + 4 打脸，禁止 AI 自由发挥。
12. **每 5 章一次大爽点**，对接 fatigue_check 节奏。

---

## 四、Skill 主流程（八步）

### Step 0：诊断旧大纲

读 `workspaces/{id}/series/outline.md` 和 `config.json`，按下面 11 条病灶清单逐项打勾：

- [ ] 主角不是命运中心 / 否认主角光环
- [ ] 金手指有持续代价（不可作为升级资源）
- [ ] 大反派登场超过总章节数 70%
- [ ] 信息门禁超过 4 维
- [ ] 单个事件单元 ≥ 6 章
- [ ] 章末钩子只是"留问题"而非装逼/打脸/反派/反转
- [ ] 二、三、四阶段章数 ≥ 25/30/40
- [ ] 无明确碾压/打脸/收编/升级链
- [ ] 跨卷伏笔 ≥ 7 条
- [ ] 主伏笔 ≥ 15 条
- [ ] 同台角色经常 ≥ 4 人

向用户**口头汇报命中条款**，**得到"开始执行"再继续**。

### Step 1：归档旧 outline + 写 v4.0 outline.md

```bash
mkdir -p workspaces/{id}/_archive
mv workspaces/{id}/series/outline.md workspaces/{id}/_archive/outline-v{旧版本}.md
```

写新 outline.md，固定 13 节结构，**模板见 `templates/outline-v4-template.md`**：

1. 设计哲学（不可违背原则）
2. 基本信息（章数/字数/风格指纹/视角）
3. 不可违背事实（Canon ≤ 6 条）
4. 五阶段结构（节奏加速版，附中盘三大必爆事件）
5. 五卷情绪曲线（EmotionMetronome 锁定）
6. 爽点骨架四条主链（碾压/打脸/收编/升级）
7. AI 生成约束（工程化指标表）
8. 主伏笔账本（≤ 12 条，标注跨卷数）
9. 信息释放权限（≤ 4 维 × 5 卷矩阵）
10. PiNovelStudio 工具杠杆启用清单（7 条）
11. 用户层体验放大器（6 条）
12. 章节粗略大纲（卷内事件提示，非生成前置）
13. 章节质量门（每章生成后必检 6 项）

### Step 2：写场景模板库 `series/scene-templates.md`

5 张表 + 各卷可用编号，**模板见 `templates/scene-templates-template.md`**：

```
H1-H8  章末钩子（装逼/反派打脸/副本预告/队友卧槽/真相一瞥/危机/反转/同盟）
B1-B6  装逼（一句话破规则/反向/降维/砍价/沉默碾压/反客为主）
S1-S4  打脸（看不起→真香 / 报价→反报价 / 围攻→单破 / 嘴硬→系统反馈）
D1-D5  子情境骨架（措辞陷阱 / 触发顺序 / 反向规则 / 设计意图 / 透明陷阱）
A1-A8  破局动作类型（FatigueCheck 连用 ≤ 2 章）
```

### Step 3：写设计卡模板 `series/design-card-template.md`

8 项精简卡片 + **卷一可生成示例**（防 AI 起手摸不到节奏）。模板见 `templates/design-card-template.md`。

### Step 4：写卷一读者指南 `series/volume-1-guide.md`

固定 4 节：本卷追什么 / 新概念术语表 / 兑现承诺 / 不会告诉你的。
模板见 `templates/volume-guide-template.md`。

### Step 5：初始化 `series/character-network.md`

固定 3 节：当前章末状态表 / 本卷关系演进预期 / 不可违背的关系规则。
**关系状态严格枚举**：陌生 / 接触 / 怀疑 / 试探 / 合作 / 同盟 / 敌对 / 反水。
模板见 `templates/character-network-template.md`。

### Step 6：改造 config.json（7 块）

详见 `playbooks/config-mutation-playbook.md`。要点：

- `genre` 改为 "X 流爽文"，原类型挪到 subGenres
- `brainholePreferences.aggressiveness` 0.25 → 0.35
- `brainholePreferences.maxInjectionsPerChapter` 1 → 2
- `brainholePreferences.enabledPatterns` 增加 `face-slap` / `flex-moment`
- `qualityGates.minSatisfactionDensity` 上调（建议 0.0003）
- `qualityGates.maxOppressionLength` 下调（建议 3000）
- `qualityGates` 新增 `chapterEndEmotionMin: 7` / `hookDensityMin: 1.0`
- `volumes[]` 每卷必填 `chapters` / `emotionCurve` / `coreGoal` / `availableHookTemplates` / `availableActionTypes`
- 新增顶层 `readerExperienceEnhancers`（杠杆 1-7 配置）
- 新增顶层 `sceneTemplates`（指向模板库路径）
- 新增顶层 `aiGenerationConstraints`（12 条硬约束的数值映射）
- 新增顶层 `archivePageBudget`（取代 codeFlashBudget，injectChapters 抽样 6 次）

### Step 7：初始化 `series/arc-registry.json`

让 ClosureTracker 接管 12 条主伏笔 + 5-7 条主弧线。
模板见 `templates/arc-registry-template.json`。

### Step 8：跑预检 + 同步角色档案 voiceFingerprint

```
novel_preflight_workspace { workspaceId, chapterId: 下一章号, chapterNumber }
```

预期：`status: passed`，seedReadiness `score: 100`。

如果角色档案缺 P1-1 音色八维，补一段"v4.0 快索口头禅 summary"（单句口头禅/平均句长/标点偏好/思维节奏/隐性局限）。

---

## 五、PiNovelStudio 工具杠杆（7 条）

这是本 Skill 的核心增量，决定读者体验上限：

| 工具 | 启用时机 | 杠杆 |
|---|---|---|
| `debt_ledger` | 每章末 | 形成"问题-答案-新问题"链式追更钩子（番茄/起点核心命脉） |
| `reader_expectation` | **第 1 章起**（不是默认的第 5 章） | 黄金三章直接对齐读者期待 |
| `fatigue_check` | 每 5 章 +
| 工具 | 启用时机 | 杠杆 |
|---|---|---|
| `fatigue_check` | 每 5 章 + 模板抽签 | 阻止连续 3 章同类破局动作，30 章后仍有新鲜感 |
| `voice_blacklist_scan` | Stage 5/8 | 5 角色声线不串味，读者记得住人才会追更 |
| `three_clocks` | 每章末 | 故事/读者/元时钟三线对齐，给读者长篇时间感 |
| `mid_chapter_check` | 第 20 章起 | 锁定中盘三大必爆事件（30/60/90 章），防中段崩盘 |
| `rotting_ending_detector` | **第 120 章起（提前 30 章）** | 烂尾感不是倒数 5 章累积，是倒数 30 章累积 |
| `closure_tracker` | 全程 | 接管 12 条主伏笔账本，AI 跨卷不漂移 |

---

## 六、用户层体验放大器（6 条）

工具之外的 markdown 文件机制，对 AI 全自动场景特别有效：

### 1. 每章开头钩子句（≤25 字）
紧贴前章末事件，单句陈述，钉住读者翻页。ChapterSeed 强制字段 `openingHookSentence`。
> 示例："昨晚他差点死在自己的尸检报告里，今晚他要去见那个签名的人。"

### 2. 章末"作者的话"（80-120 字）
每章末自动追加三段式：下章钩子提示（不剧透）+ 点破章内隐藏伏笔（增加"原来如此"快感）+ 一句吐槽/自嘲/互动。
> 配置位置：`config.json` `readerExperienceEnhancers.authorNoteAppendAtChapterEnd: true`

### 3. 每卷开头读者指南 `volume-N-guide.md`
追什么 / 新概念 / 承诺 / 不告诉你的。让回坑读者 30 秒续上。

### 4. 每 10 章阶段性回顾 `recap-NN.md`
三栏式：林觉做过的事 / 林觉失去的东西 / 林觉欠下的债（与 debt_ledger 对齐）。

### 5. 五卷情绪曲线锁死
写在 outline.md §5，让 emotion_metronome 每章对齐。禁止"平淡过渡章"。

### 6. 人物关系图增量维护
每章 Stage 4 后增量更新 `character-network.md`，AI 生成时强制读取，防止莫名其妙突然信任。

---

## 七、最终交付清单（执行完应该看到）

### 修改的文件（6 个）
1. `workspaces/{id}/series/outline.md`（v4.0 重写，13 节）
2. `workspaces/{id}/config.json`（7 块改造）
3. `workspaces/{id}/series/arc-registry.json`（接管 12 主伏笔 + 5-7 弧线）
4. `workspaces/{id}/characters/*.md`（每个加 v4.0 voiceFingerprint summary）
5. `workspaces/{id}/_archive/outline-v{旧}.md`（归档）
6. `workspaces/{id}/chapters/chapter-XX.md`（已落盘章节追加"作者的话"）

### 新建的文件（4 个）
1. `workspaces/{id}/series/scene-templates.md`（5 张抽签表）
2. `workspaces/{id}/series/design-card-template.md`（8 项 + 卷一示例）
3. `workspaces/{id}/series/volume-1-guide.md`（4 节读者指南）
4. `workspaces/{id}/series/character-network.md`（3 节关系图）

### 预检验证
```
novel_preflight_workspace { workspaceId, chapterId: 下一章号, chapterNumber }
→ status: passed
→ seedReadiness.score: 100
```

---

## 八、关键工程化指标（执行完应达到）

| 指标 | 数值 | 验证工具 |
|---|---|---|
| 每章字数 | 2800-4500 | wordBudget |
| 每章钩子密度 | ≥ 1.0/2000字 | Stage 6.5 硬门禁 |
| 每章末情绪强度 | ≥ 7/10 | EmotionMetronome |
| 同台说话角色 | ≤ 3 人 | EnsembleCognitiveLoad |
| 同种破局动作连用 | ≤ 2 章 | FatigueCheck |
| 跨卷伏笔总数 | ≤ 6 条 | ClosureTracker |
| 单个子情境长度 | 3-5 章 | DesignCard |
| AI 腔密度 | < 1.8% | Stage 8 AntiAI |
| 风格匹配偏差 | < 30% | Stage 8 StyleShaper |

---

## 九、附录与模板路径

- `templates/outline-v4-template.md` — outline.md 13 节完整模板
- `templates/scene-templates-template.md` — 5 张抽签表（H/B/S/D/A）
- `templates/design-card-template.md` — 设计卡 + 卷一示例
- `templates/volume-guide-template.md` — 卷读者指南 4 节
- `templates/character-network-template.md` — 关系图 3 节
- `templates/arc-registry-template.json` — 弧线注册表初始结构
- `playbooks/config-mutation-playbook.md` — config.json 7 块改造操作手册
- `playbooks/diagnose-checklist.md` — 11 条反爽文病灶清单的判定细则
- `examples/fuben-v4.0/` — 完整参考案例（《副本设计师》v4.0 改造产物快照）

---

## 十、不变的铁律

执行本 Skill 时，**这几条不可妥协**：

1. **不绕过 novel_generate_chapter**：本 Skill 只改大纲与配置，不写正文。
2. **不擅自改风格指纹**：风格指纹由 `styles/profiles/{id}.json` 单独管理，不在本 Skill 范围。
3. **不擅自改 canon**：不可违背事实（核心 6 条）应由用户拍板，本 Skill 只精简结构。
4. **不擅自重写已落盘章节**：已生成章节只追加"作者的话"，不动正文。
5. **改造完必须跑 preflight**：通过才算交付。
