# 完整参考案例索引

本目录给出已成功改造的 workspace 作为参考。

## fuben-v4.0 — 《副本设计师》v4.0 改造产物

**workspace 路径**：`workspaces/fuben/`

**改造前后对比**：

| 维度 | v3.2 改造前 | v4.0 改造后 |
|---|---|---|
| 定位 | 克制悬疑解谜 | 规则副本爽文（披悬疑外壳） |
| 主角 | 非命运中心 | 设计局唯一非标样本（N-7）|
| 金手指代价 | 全程头痛+视觉噪声 | 前 30 章无代价；后期"心智值"=升级资源 |
| 大反派登场 | 第 110 章实名 | 第 15 章首次冲突 / 第 40 章化名 / 第 80 章实名 |
| 阶段长度 | 15/25/30/40/40 | 20/25/30/35/40 |
| 信息门禁 | 10 维 5 阶段 | 4 维 5 阶段 |
| 章末钩子 | 留一个问题 | 8 模板抽签（H1-H8）|
| 主伏笔总数 | 17 条 | 12 条（跨卷 6 条）|
| 副本设计卡 | 14 项 | 8 项精简 |
| 风格指纹 | wu-hu-suspense（通用） | fuben-rule-suspense（专属，dialogueRatio=0.18）|

**关键产物文件路径**（已落盘）：

- `workspaces/fuben/series/outline.md`（v4.0 重写，13 节）
- `workspaces/fuben/series/scene-templates.md`（H/B/S/D/A 五张抽签表）
- `workspaces/fuben/series/dungeon-design-template.md`（卷一示例"诚实的房间"）
- `workspaces/fuben/series/volume-1-guide.md`（4 节读者指南）
- `workspaces/fuben/series/character-network.md`（关系图）
- `workspaces/fuben/series/arc-registry.json`（7 弧线 + 6 跨卷伏笔）
- `workspaces/fuben/config.json`（7 块改造完毕）
- `workspaces/fuben/characters/*.md`（5 角色档案 + voiceFingerprint summary）
- `workspaces/fuben/chapters/chapter-01.md`（已落盘第 1 章 + 章末作者的话）

**预检结果**：✅ status: passed / seedReadiness 100/100 / 0 blockingItems。

**第 1 章质量门**（已通过）：

- Critic 综合分 0.98（Gate1 1.00 / Gate2 0.85 / Gate3 0.90 / Gate4 0.90）
- Stage 5 & Stage 8 风格匹配 100%
- Anti-AI 密度 0.011（< 2% 阈值）
- Voice 100
- 钩子密度 3.40/2000 字（> 1.0 阈值）

---

## 如何借鉴

执行 Skill 时按本目录文件路径**抄结构 + 替换内容**：

1. outline 的 13 节结构原样保留，每节内容按新作品 canon 重写
2. scene-templates 的 H/B/S/D/A 编号体系原样保留，示例可替换
3. design-card 的 8 项格式严格保留，必须给出本作卷一示例
4. config.json 的 7 块改造按 `playbooks/config-mutation-playbook.md` 严格执行
5. arc-registry.json 的 7 弧线 + 6 跨卷伏笔结构保留，内容按新作品填
