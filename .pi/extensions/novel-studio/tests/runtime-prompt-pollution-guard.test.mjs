/**
 * PiNovelStudio — 运行时提示词污染守护测试
 *
 * 目的：防止西方创意写作术语/翻译腔短语通过运行时数据层回流到 Narrator 系统提示词。
 *
 * 守护范围（直接进 prompt 的运行时数据 + 脑洞模式 + AntiAI 修复建议）：
 *   - data/runtime/techniques-index.json      （KnowledgeRetriever.formatAsPrompt → Narrator）
 *   - data/runtime/style-lessons.json         （事件级知识检索 → Narrator）
 *   - data/runtime/validated-craft-rules.json （Stage 2 事件级写作契约）
 *   - data/runtime/contrastive-rules-index.json（对比蒸馏规则索引）
 *   - data/runtime/injectable_rules.json      （可注入规则，存在则扫）
 *   - data/fewshots/fewshots_flat.json        （loadFewshotExamples → buildSystemPrompt）
 *   - data/contrastive/contrastive_full.json  （对比蒸馏 good_text 标杆）
 *   - brainholes/patterns.json                （BrainholeEngine → dag.enhancements → Narrator）
 *   - brainholes/index.json                   （脑洞模式注册表 name 字段）
 *   - craft/anti-ai-detector.ts 源码          （fix 修复建议字段）
 *
 * 禁止短语（命中即 fail，列出 文件:短语:片段）：
 *   Show/Tell、POV、蒙太奇、弧光、冰山法则、多米诺连锁、Hero's Journey、英雄之旅
 *
 * 设计原则：
 *   - 原始文本扫描（raw text scan），覆盖所有字段，避免遗漏新增字段
 *   - 英文短语大小写敏感（POV 不匹配 pov；Show/Tell 不匹配 show/tell）
 *   - 中文短语直接子串匹配
 *   - 文件不存在则 skip（不 fail），仅对存在文件硬门禁
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..", "..", "..", "..");
const extRoot = resolve(__dirname, "..", "..");

// ============================================================
// 禁止短语列表
// ============================================================

// 英文短语（大小写敏感）
const FORBIDDEN_EN = [
  "Show/Tell",
  "POV",
  "Hero's Journey",
];

// 中文短语（直接子串匹配）
const FORBIDDEN_ZH = [
  "蒙太奇",
  "弧光",
  "冰山法则",
  "多米诺连锁",
  "英雄之旅",
];

// ============================================================
// 待扫描文件清单
// ============================================================

const DATA_FILES = [
  "data/runtime/techniques-index.json",
  "data/runtime/style-lessons.json",
  "data/runtime/validated-craft-rules.json",
  "data/runtime/contrastive-rules-index.json",
  "data/runtime/injectable_rules.json",
  "data/fewshots/fewshots_flat.json",
  "data/contrastive/contrastive_full.json",
  "brainholes/patterns.json",
  "brainholes/index.json",
];

// 源码文件（非 JSON，按源码文本扫描）
const SOURCE_FILES = [
  ".pi/extensions/novel-studio/craft/anti-ai-detector.ts",
];

// ============================================================
// 扫描工具
// ============================================================

/**
 * 在文本中查找所有命中，返回 {phrase, snippet} 数组。
 * snippet 为命中位置前后 20 字上下文，便于定位。
 */
function findHits(text) {
  const hits = [];
  for (const phrase of FORBIDDEN_EN) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + phrase.length + 20);
      hits.push({ phrase, snippet: text.slice(start, end).replace(/\s+/g, " ").trim() });
      idx = text.indexOf(phrase, idx + 1);
    }
  }
  for (const phrase of FORBIDDEN_ZH) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + phrase.length + 20);
      hits.push({ phrase, snippet: text.slice(start, end).replace(/\s+/g, " ").trim() });
      idx = text.indexOf(phrase, idx + 1);
    }
  }
  return hits;
}

// ============================================================
// 测试
// ============================================================

describe("运行时提示词污染守护", () => {
  describe("data 层运行时文件不含翻译腔术语", () => {
    for (const relPath of DATA_FILES) {
      it(`${relPath} 不含禁止短语`, () => {
        const absPath = join(projectRoot, relPath);
        if (!existsSync(absPath)) {
          // 文件不存在则 skip（injectable_rules.json 可能不存在）
          return;
        }
        const raw = readFileSync(absPath, "utf-8");
        const hits = findHits(raw);
        if (hits.length > 0) {
          const detail = hits
            .map((h) => `  [${h.phrase}] ...${h.snippet}...`)
            .join("\n");
          assert.fail(
            `${relPath} 含 ${hits.length} 处禁止短语（应已中文化）:\n${detail}`,
          );
        }
      });
    }
  });

  describe("源码层 fix/修复建议不含翻译腔术语", () => {
    for (const relPath of SOURCE_FILES) {
      it(`${relPath} 源码不含禁止短语（含 蒙太奇）`, () => {
        const absPath = join(projectRoot, relPath);
        if (!existsSync(absPath)) {
          return;
        }
        const raw = readFileSync(absPath, "utf-8");
        const hits = findHits(raw);
        if (hits.length > 0) {
          const detail = hits
            .map((h) => `  [${h.phrase}] ...${h.snippet}...`)
            .join("\n");
          assert.fail(
            `${relPath} 源码含 ${hits.length} 处禁止短语:\n${detail}`,
          );
        }
      });
    }
  });

  describe("禁止短语清单本身完整（防回潮元测试）", () => {
    it("FORBIDDEN_EN + FORBIDDEN_ZH 至少覆盖 8 个短语", () => {
      const total = FORBIDDEN_EN.length + FORBIDDEN_ZH.length;
      assert.ok(
        total >= 8,
        `禁止短语清单应至少 8 个，实际 ${total} 个；清单被误删会导致守护失效`,
      );
    });
  });
});

console.log("运行时提示词污染守护测试加载完成");
