# Issue: Prompt 上游元信息泄漏根因清理

> **legacy 说明**（2026-07-16）：本 issue 引用的 `agents/narrator.ts` 与 `prompts/narrator.md` 均已随 legacy Stage0-8 架构退役物理删除。统一主链路不再使用独立 Narrator Agent 与独立 narrator prompt 文件；prompt 上游元信息泄漏的防护已迁移到统一主链路的 promptProfile 审计与 ContextCompiler。本 issue 保留为历史行为记录。

**优先级**: P1（最高）
**状态**: Resolved（legacy，已退役）
**创建日期**: 2026-06-21
**关联**: PR #gate-fixes 验收遗留项

## 问题描述

Narrator prompt 仍大量注入结构化标签和元信息块，虽然下游 Stage 8 清理已增强，但上游根因未清干净，存在泄漏到生成正文的风险。

### 当前残留位置（legacy，文件已删除）

> 下表所列 `agents/narrator.ts`（2421 行等引用）与 `prompts/narrator.md` 均已随 legacy Stage0-8 架构退役物理删除。残留位置记录保留为历史行为参考；统一主链路通过 promptProfile 审计与 ContextCompiler 防止 prompt 元信息泄漏，不再依赖独立 narrator prompt 文件。

| 文件 | 行号 | 残留内容 |
|------|------|----------|
| `agents/narrator.ts`（已删除） | 2421 | "核心规则" 块 |
| `agents/narrator.ts`（已删除） | 2787 | "世界观规则检查点" |
| `agents/narrator.ts`（已删除） | 2918 | "脑洞注入指导" |
| `agents/narrator.ts`（已删除） | 2980 | "大纲意图对齐" |
| `agents/narrator.ts`（已删除） | 3549 | "输出契约/正文开始" |
| `prompts/narrator.md`（已删除） | 113 | "叙事状态卡" |

### 已完成的缓解措施

- `【】` 方括号标签已转为自然语言
- emoji 标记（⚠️, ✅, ❌）已移除
- 添加了显式"不要复制元信息"指令
- Stage 8 下游清理规则已增强

## 验收标准

1. Narrator prompt 中所有 `【】` 方括号标签移除或转为自然语言
2. Prompt 中的结构化块（核心规则、世界观检查点等）用 `<!-- -->` 注释包裹或移至 system message
3. 新增测试验证：生成文本不包含 prompt 中的结构化标签关键词
4. 真实章节 replay 中无 prompt 标签泄漏

## 建议方案

1. 将结构化指导块移至 system message（与正文分离）
2. 或用 XML 注释 `<!-- ... -->` 包裹（LLM 通常不复制注释内容）
3. 在 Stage 8 清理规则中增加 prompt 标签关键词黑名单
4. 添加回归测试：检查生成文本是否包含 prompt 中的特征词
