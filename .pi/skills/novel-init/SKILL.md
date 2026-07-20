---
name: novel-init
description: |
  初始化新小说的 workspace。创建目录结构、config.json、
  大纲模板、角色档案模板。

  触发条件: "创建新小说"、"新建项目"、"init novel"、"初始化小说"
---

# Novel Init — 新小说初始化

## 功能说明

此 Skill 用于创建新的小说创作空间，包括：

1. 创建 workspace 目录结构
2. 初始化配置文件
3. 生成大纲模板
4. 生成角色档案模板

## 交互流程

### 步骤 1: 收集基本信息

向用户询问以下信息：

1. **小说名称** - 例如：《心魔界》
2. **小说类型** - 例如：都市异能、玄幻修仙、悬疑推理
3. **子类型**（可选）- 例如：系统流、热血、感情线
4. **目标风格** - 从 `styles/index.json` 选择，或选择"自定义"
5. **总字数目标** - 例如：200万字

### 步骤 2: 创建 Workspace

使用 WorkspaceManager 创建 workspace：

```
workspaceId: slug化的小说名 (如 "xinmo")
novelName: 用户输入的小说名
genre: 用户选择的类型
subGenres: 用户选择的子类型
styleProfile: 用户选择的风格
targetWordCount.total: 用户输入的总字数目标
```

### 步骤 3: 初始化模板文件

创建以下模板文件：

- `series/outline.md` - 大纲模板
- `series/character-arcs.md` - 角色弧线模板
- `series/foreshadowing-tracker.json` - 伏笔追踪器
- `series/faction-attitudes.json` - 势力态度追踪
- `worldbuilding/world-rules.md` - 世界规则模板
- `worldbuilding/power-system.md` - 战斗力体系模板
- `worldbuilding/timeline.md` - 时间线模板
- `characters/_template.md` - 角色档案模板

### 步骤 4: 引导创建主要角色

提示用户创建主要角色档案：

- 主角（必填）
- 女主角（推荐）
- 主要反派（推荐）
- 配角（可选）

## 输出示例

```
✅ 新小说 workspace 创建成功！

📚 小说名称：《心魔界》
🏷️ 类型：都市异能
🎨 风格：番茄流爽文
📊 字数目标：200万字
📁 路径：workspaces/xinmo/

下一步：
1. 编辑 series/outline.md 完成大纲
2. 创建主要角色档案
3. 定义世界规则和战斗力体系
4. 使用 novel_generate_chapter 开始创作第一章
```

## 约束条件

- workspaceId 必须是唯一的 slug（小写字母、数字、连字符）
- 不允许覆盖已存在的 workspace
- 至少需要提供小说名称和类型
