/**
 * P1 修复（Phase 1 整改）：测试用最小可消费风格指纹。
 *
 * orchestrator 入口要求 context.styleReferences 中存在 kind=fingerprint 的档案，
 * 否则在模型调用前 hard block（作者风格整章优化是必经阶段）。
 * 测试文件 import 此常量，避免每个测试文件重复定义。
 */

/** 最小可消费风格指纹（kind=fingerprint）。测试 context.styleReferences 默认使用。 */
export const TEST_STYLE_FINGERPRINT = {
  id: "style:test-fingerprint",
  kind: "fingerprint",
  content: JSON.stringify({
    id: "test",
    usagePolicy: {
      rawPrompt: "excluded",
      fullChapterOptimization: "required",
    },
    editorialGuidance: [
      "保持叙事节奏紧凑，避免平铺直叙。",
      "对白自然口语化，符合人物身份。",
      "章末留有钩子，牵引下一章阅读意愿。",
    ],
    characterVoiceGuidance: {},
  }),
};

/** 包含最小风格指纹的 styleReferences 数组，可直接展开到测试 context。 */
export const TEST_STYLE_REFERENCES = [TEST_STYLE_FINGERPRINT];
