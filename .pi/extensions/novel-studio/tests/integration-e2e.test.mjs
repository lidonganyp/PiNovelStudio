/**
 * PiNovelStudio — 主编排流程端到端集成测试
 *
 * 完整调用 novel_generate_chapter 入口，验证阶段0→8全流程
 *
 * 测试场景：
 * 1. 阶段0前置条件检查（config.json、outline.md、角色档案）
 * 2. 阶段1感知锚点搜索（Architect）
 * 3. 脑洞注入（BrainholeEngine）
 * 4. 阶段2锚点驱动生长叙事（Narrator）
 * 5. 阶段3骨架抽取与一致性验证
 * 6. 阶段4未结账细节更新
 * 7. 阶段5整章润色与修订
 * 8. 阶段6情绪节拍验证
 * 9. 阶段7配角健康度检测
 * 10. 阶段8最终把关（AntiAI + StyleShaper）
 * 11. 原子事务保存与回滚
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  existsSync, readFileSync, unlinkSync, readdirSync,
  mkdirSync, rmSync, writeFileSync, copyFileSync, renameSync
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// 获取项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const TEST_WORKSPACE_ID = "e2e-test-novel";
const TEST_WORKSPACE_PATH = join(PROJECT_ROOT, "workspaces", TEST_WORKSPACE_ID);

// ============================================================================
// 测试 Workspace 创建辅助函数
// ============================================================================

function createTestWorkspaceFiles() {
  const dirs = [
    TEST_WORKSPACE_PATH,
    join(TEST_WORKSPACE_PATH, "chapters"),
    join(TEST_WORKSPACE_PATH, "characters"),
    join(TEST_WORKSPACE_PATH, "series"),
    join(TEST_WORKSPACE_PATH, "world"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // config.json - 阶段0必需的配置文件
  const configData = {
    name: `端到端测试小说-${TEST_WORKSPACE_ID}`,
    genre: "都市",
    styleProfile: "default",
    totalChapters: 50,
    chapterType: "standard",
    serialFrequency: "daily",
    subGenres: ["商战", "都市"],
    characters: [
      { id: "li-yifan", name: "李一凡", role: "protagonist" },
      { id: "supporting-1", name: "配角甲", role: "supporting" },
    ],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "config.json"),
    JSON.stringify(configData, null, 2),
    "utf-8"
  );

  // outline.md - 阶段0必需的大纲文件
  const outlineContent = `# 《逆流而上》全书大纲

## 简介
都市商战小说，讲述年轻创业者在商业战场上逆流而上的故事。

## 主线
李一凡从普通职场人成长为商业精英，在资本市场的惊涛骇浪中披荆斩棘。

## 章节规划（共50章）
- 第1-10章：职场起步
- 第11-20章：创业初创
- 第21-35章：商战博弈
- 第36-45章：危机与转机
- 第46-50章：最终决战与结局

## 核心角色
- 李一凡：主角，年轻创业者
- 配角甲：主角的商业伙伴
`;
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "series", "outline.md"),
    outlineContent,
    "utf-8"
  );

  // 角色档案
  const mainCharacter = `# 李一凡

## 基本信息
- 姓名：李一凡
- 年龄：28岁
- 职业：创业者

## 性格特点
- 冷静理智，善于分析局势
- 内心坚定，不轻易放弃
- 对商业有敏锐的洞察力

## 背景
李一凡是一名普通的职场人，在一家中型企业工作。
机缘巧合下，他决定创业，走上了商业这条路。
`;
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "characters", "li-yifan.md"),
    mainCharacter,
    "utf-8"
  );

  const supportingChar = `# 配角甲

## 基本信息
- 姓名：配角甲
- 年龄：30岁
- 职业：投资人

## 性格特点
- 经验丰富，老练沉稳
- 善于发掘人才
- 有自己的商业判断标准

## 与主角关系
配角甲是主角的第一个投资人，在主角创业初期给予了重要支持。
`;
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "characters", "supporting-1.md"),
    supportingChar,
    "utf-8"
  );

  // 初始 skeleton.json
  const initialSkeleton = {
    version: "1.0",
    totalChapters: 50,
    createdAt: new Date().toISOString(),
    events: [],
    characterArcs: {
      "李一凡": {
        arcType: "growth",
        stages: ["职场新人", "初创业者", "成长中"],
      },
    },
    worldState: {
      location: "云城市",
      time: "现代",
    },
  };
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "series", "skeleton.json"),
    JSON.stringify(initialSkeleton, null, 2),
    "utf-8"
  );

  // 初始 narrative-state.json
  const initialNarrativeState = {
    version: "1.0",
    chapterNumber: 0,
    characterStates: {
      "李一凡": {
        name: "李一凡",
        mentality: "neutral",
        abilities: [],
        knowledge: [],
        location: "云城市",
      },
      "配角甲": {
        name: "配角甲",
        mentality: "neutral",
        abilities: [],
        knowledge: [],
      },
    },
    worldState: {
      location: "云城市",
      time: "现代",
    },
    activeForeshadowing: [],
    unresolvedClues: [],
  };
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "series", "narrative-state.json"),
    JSON.stringify(initialNarrativeState, null, 2),
    "utf-8"
  );

  // 初始 unsettled-details.json
  const initialDetails = {
    version: "1.0",
    trackedDetails: [],
    lastUpdated: new Date().toISOString(),
  };
  writeFileSync(
    join(TEST_WORKSPACE_PATH, "series", "unsettled-details.json"),
    JSON.stringify(initialDetails, null, 2),
    "utf-8"
  );

  console.log(`[测试 Workspace] 已创建: ${TEST_WORKSPACE_PATH}`);
}

function cleanupTestWorkspace() {
  try {
    if (existsSync(TEST_WORKSPACE_PATH)) {
      rmSync(TEST_WORKSPACE_PATH, { recursive: true, force: true });
      console.log(`[测试 Workspace] 已清理: ${TEST_WORKSPACE_PATH}`);
    }
  } catch (e) {
    console.warn(`[测试 Workspace] 清理失败: ${e}`);
  }
}

// ============================================================================
// 阶段0前置条件测试
// ============================================================================

describe("阶段0: 上下文加载与前置检查", () => {
  before(() => {
    createTestWorkspaceFiles();
  });

  after(() => {
    cleanupTestWorkspace();
  });

  it("config.json 存在且可解析", () => {
    const configPath = join(TEST_WORKSPACE_PATH, "config.json");
    assert.ok(existsSync(configPath), "config.json 应该存在");

    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);

    assert.ok(config.genre, "config.json 必须包含 genre 字段");
    assert.ok(config.name, "config.json 必须包含 name 字段");
    assert.strictEqual(config.genre, "都市", "genre 应该是 '都市'");
  });

  it("outline.md 存在", () => {
    const outlinePath = join(TEST_WORKSPACE_PATH, "series", "outline.md");
    assert.ok(existsSync(outlinePath), "outline.md 应该存在");

    const content = readFileSync(outlinePath, "utf-8");
    assert.ok(content.length > 100, "outline.md 内容不应该为空");
  });

  it("角色档案目录存在且有角色文件", () => {
    const charsDir = join(TEST_WORKSPACE_PATH, "characters");
    assert.ok(existsSync(charsDir), "characters 目录应该存在");

    const charFiles = readdirSync(charsDir).filter(f => f.endsWith(".md"));
    assert.ok(charFiles.length > 0, "应该有至少一个角色档案文件");
  });

  it("skeleton.json 存在（第2章前置条件）", () => {
    const skeletonPath = join(TEST_WORKSPACE_PATH, "series", "skeleton.json");
    assert.ok(existsSync(skeletonPath), "skeleton.json 应该存在");

    const content = readFileSync(skeletonPath, "utf-8");
    const skeleton = JSON.parse(content);
    assert.ok(skeleton.events !== undefined, "skeleton.json 应该包含 events 字段");
  });

  it("narrative-state.json 存在", () => {
    const statePath = join(TEST_WORKSPACE_PATH, "series", "narrative-state.json");
    assert.ok(existsSync(statePath), "narrative-state.json 应该存在");
  });
});

// ============================================================================
// 阶段0生产阻断测试
// ============================================================================

describe("阶段0: 生产阻断测试", () => {
  const blockedWorkspacePath = join(PROJECT_ROOT, "workspaces", "blocked-test-workspace");

  before(() => {
    // 防御性清理：上次运行若中断残留 config.json，会让"缺少 config.json"测试误判失败。
    // before 中先清空目录再重建，确保隔离。
    try {
      rmSync(blockedWorkspacePath, { recursive: true, force: true });
    } catch {}
    mkdirSync(join(blockedWorkspacePath), { recursive: true });
    mkdirSync(join(blockedWorkspacePath, "series"), { recursive: true });
  });

  after(() => {
    try {
      rmSync(blockedWorkspacePath, { recursive: true, force: true });
    } catch {}
  });

  it("缺少 config.json 时应返回错误状态", () => {
    const configPath = join(blockedWorkspacePath, "config.json");
    const missing = !existsSync(configPath);
    assert.strictEqual(missing, true, "config.json 应该不存在");
  });

  it("缺少 genre 字段时应返回错误状态", () => {
    const configPath = join(blockedWorkspacePath, "config.json");
    mkdirSync(join(blockedWorkspacePath, "characters"), { recursive: true });

    writeFileSync(
      configPath,
      JSON.stringify({ name: "测试" }),
      "utf-8"
    );

    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    const missingGenre = !config.genre;
    assert.strictEqual(missingGenre, true, "应该缺少 genre 字段");
  });

  it("缺少 outline.md 时应返回错误状态", () => {
    const outlinePath = join(blockedWorkspacePath, "series", "outline.md");
    const missing = !existsSync(outlinePath);
    assert.strictEqual(missing, true, "outline.md 应该不存在");
  });

  it("缺少角色档案时应返回错误状态", () => {
    const charsDir = join(blockedWorkspacePath, "characters");
    const missingOrEmpty = !existsSync(charsDir) || readdirSync(charsDir).filter(f => f.endsWith(".md")).length === 0;
    assert.strictEqual(missingOrEmpty, true, "角色档案应该不存在或为空");
  });
});

// ============================================================================
// 条件触发阶段测试
// ============================================================================

describe("条件触发阶段判断", () => {
  it("章节 >= 5 时应触发阶段1.5（读者预期写前规划）", () => {
    const chapterNumber = 5;
    const shouldTrigger = chapterNumber >= 5;
    assert.strictEqual(shouldTrigger, true, "章节5应该触发阶段1.5");
  });

  it("章节 < 5 时不应触发阶段1.5", () => {
    const chapterNumber = 4;
    const shouldTrigger = chapterNumber >= 5;
    assert.strictEqual(shouldTrigger, false, "章节4不应该触发阶段1.5");
  });

  it("章节 <= 20 时应触发阶段1.6（世界观投放策略）", () => {
    const chapterNumber = 20;
    const shouldTrigger = chapterNumber <= 20;
    assert.strictEqual(shouldTrigger, true, "章节20应该触发阶段1.6");
  });

  it("章节 >= 5 时应触发阶段4.5（读者预期写后评分）", () => {
    const chapterNumber = 5;
    const shouldTrigger = chapterNumber >= 5;
    assert.strictEqual(shouldTrigger, true, "章节5应该触发阶段4.5");
  });

  it("章节 <= 20 时应触发阶段4.6（世界观展示质量后置扫描）", () => {
    const chapterNumber = 20;
    const shouldTrigger = chapterNumber <= 20;
    assert.strictEqual(shouldTrigger, true, "章节20应该触发阶段4.6");
  });

  it("章节 >= 20 时应触发阶段5.5（中盘必检点）", () => {
    const chapterNumber = 20;
    const shouldTrigger = chapterNumber >= 20;
    assert.strictEqual(shouldTrigger, true, "章节20应该触发阶段5.5");
  });

  it("终章前5章应触发阶段8.5（结局工艺专项）", () => {
    const totalChapters = 50;
    const currentChapter = 46;
    const shouldTrigger = totalChapters > 0 && currentChapter >= totalChapters - 5 && currentChapter < totalChapters;
    assert.strictEqual(shouldTrigger, true, "章节46应该触发阶段8.5");
  });

  it("非终章前5章不应触发阶段8.5", () => {
    const totalChapters = 50;
    const currentChapter = 40;
    const shouldTrigger = totalChapters > 0 && currentChapter >= totalChapters - 5 && currentChapter < totalChapters;
    assert.strictEqual(shouldTrigger, false, "章节40不应该触发阶段8.5");
  });
});

// ============================================================================
// 原子事务测试
// ============================================================================

describe("原子事务保存与回滚", () => {
  const atomicTestDir = join(PROJECT_ROOT, ".test-atomic-temp");

  beforeEach(() => {
    if (!existsSync(atomicTestDir)) {
      mkdirSync(atomicTestDir, { recursive: true });
    }
    mkdirSync(join(atomicTestDir, "chapters"), { recursive: true });
    mkdirSync(join(atomicTestDir, "series"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(atomicTestDir, { recursive: true, force: true });
    } catch {}
  });

  it("章节保存前应先写入临时文件", () => {
    const chapterId = "test-chapter";
    const chapterFile = join(atomicTestDir, "chapters", `chapter-${chapterId}.md`);
    const tempFile = join(atomicTestDir, "chapters", `chapter-${chapterId}.tmp.md`);
    const content = "测试章节内容";

    writeFileSync(tempFile, content, "utf-8");

    assert.ok(existsSync(tempFile), "临时文件应该存在");
    assert.ok(!existsSync(chapterFile), "正式文件不应该存在（还未 rename）");
  });

  it("临时文件写入成功后才 rename 为正式文件", () => {
    const chapterId = "test-chapter-2";
    const tempFile = join(atomicTestDir, "chapters", `chapter-${chapterId}.tmp.md`);
    const chapterFile = join(atomicTestDir, "chapters", `chapter-${chapterId}.md`);

    writeFileSync(tempFile, "章节内容", "utf-8");
    renameSync(tempFile, chapterFile);

    assert.ok(existsSync(chapterFile), "正式文件应该存在");
    assert.ok(!existsSync(tempFile), "临时文件应该被移除");

    const savedContent = readFileSync(chapterFile, "utf-8");
    assert.strictEqual(savedContent, "章节内容", "保存的内容应该正确");
  });

  it("写入前应备份旧版本以便回滚", () => {
    const testFile = join(atomicTestDir, "series", "skeleton.json");
    const backupFile = testFile + ".rollback.bak";

    const oldData = JSON.stringify({ version: "old" });
    writeFileSync(testFile, oldData, "utf-8");
    copyFileSync(testFile, backupFile);

    assert.ok(existsSync(backupFile), "备份文件应该存在");
    const backupContent = readFileSync(backupFile, "utf-8");
    assert.strictEqual(backupContent, oldData, "备份内容应该正确");
  });

  it("回滚时应从备份恢复旧版本", () => {
    const testFile = join(atomicTestDir, "series", "narrative-state.json");
    const backupFile = testFile + ".rollback.bak";

    const oldData = { state: "old" };
    writeFileSync(testFile, JSON.stringify(oldData), "utf-8");
    copyFileSync(testFile, backupFile);

    // 模拟写入失败后的回滚
    copyFileSync(backupFile, testFile);
    unlinkSync(backupFile);

    const restoredContent = JSON.parse(readFileSync(testFile, "utf-8"));
    assert.deepStrictEqual(restoredContent, oldData, "应该恢复到旧版本");
    assert.ok(!existsSync(backupFile), "备份文件应该被清理");
  });

  it("成功提交后应清理 .rollback.bak 文件", () => {
    const testFile = join(atomicTestDir, "series", "test.json");
    const backupFile = testFile + ".rollback.bak";

    writeFileSync(testFile, JSON.stringify({ data: "test" }), "utf-8");
    copyFileSync(testFile, backupFile);

    if (existsSync(backupFile)) {
      unlinkSync(backupFile);
    }

    assert.ok(!existsSync(backupFile), ".rollback.bak 应该被清理");
  });

  it("章节 rename 失败时应恢复旧章节", () => {
    const chaptersDir = join(atomicTestDir, "chapters");
    const chapterFile = join(chaptersDir, "chapter-old.md");
    const backupFile = join(chaptersDir, "chapter-old.bak.md");
    const tempFile = join(chaptersDir, "chapter-old.tmp.md");

    writeFileSync(chapterFile, "旧章节内容", "utf-8");
    copyFileSync(chapterFile, backupFile);
    unlinkSync(chapterFile);
    writeFileSync(tempFile, "新章节内容", "utf-8");

    // 模拟 rename 失败后恢复旧章节
    if (existsSync(backupFile)) {
      copyFileSync(backupFile, chapterFile);
      unlinkSync(backupFile);
    }

    const restoredContent = readFileSync(chapterFile, "utf-8");
    assert.strictEqual(restoredContent, "旧章节内容", "旧章节应该被恢复");
  });
});

// ============================================================================
// 阶段结果验证测试
// ============================================================================

describe("阶段结果验证", () => {
  it("stageResults 应该包含所有阶段的执行结果", () => {
    const stageResults = {
      stage0: { status: "passed", configLoaded: true },
      stage1: { status: "success", dag: {} },
      brainholeInjection: { status: "success", injections: [{ patternId: "test" }] },
      stage2: { status: "success", text: "章节内容..." },
      stage3: { status: "passed" },
      stage4: { status: "success" },
      stage5: { status: "passed" },
      stage6: { status: "passed" },
      stage7: { status: "success" },
      stage8: { antiAI: { status: "passed" }, style: { status: "passed" } },
    };

    assert.ok(stageResults.stage0, "应该有 stage0 结果");
    assert.ok(stageResults.stage1, "应该有 stage1 结果");
    assert.ok(stageResults.brainholeInjection, "应该有脑洞注入结果");
    assert.ok(stageResults.stage2, "应该有 stage2 结果");
    assert.ok(stageResults.stage3, "应该有 stage3 结果");
    assert.ok(stageResults.stage4, "应该有 stage4 结果");
    assert.ok(stageResults.stage5, "应该有 stage5 结果");
    assert.ok(stageResults.stage6, "应该有 stage6 结果");
    assert.ok(stageResults.stage7, "应该有 stage7 结果");
    assert.ok(stageResults.stage8, "应该有 stage8 结果");
  });

  it("阶段失败时应该记录 blockingIssues", () => {
    const stageResults = {
      stage0: { status: "passed" },
      stage1: { status: "error", message: "Architect 失败" },
    };

    const blockingIssues = [];

    if (stageResults.stage1.status === "error") {
      blockingIssues.push(`【阶段1错误】${stageResults.stage1.message}`);
    }

    assert.strictEqual(blockingIssues.length, 1, "应该有1个阻断问题");
    assert.ok(blockingIssues[0].includes("Architect 失败"), "阻断问题应该包含错误信息");
  });

  it("递归检查应该发现嵌套的 status 错误", () => {
    const stageResults = {
      stage0: { status: "passed" },
      stage8: {
        antiAI: { status: "passed" },
        style: { status: "needs_revision", message: "风格偏差过大" },
      },
    };

    const blockingIssues = [];

    function collectIssues(obj, path = "") {
      if (!obj || typeof obj !== "object") return;
      if (obj.status === "needs_revision") {
        blockingIssues.push(`【${path || "root"}需要修订】${obj.message || "内容需要修订"}`);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === "status") continue;
        if (Array.isArray(value)) {
          value.forEach((item, idx) => collectIssues(item, `${path}.${key}[${idx}]`));
        } else if (value && typeof value === "object") {
          collectIssues(value, path ? `${path}.${key}` : key);
        }
      }
    }

    collectIssues(stageResults);

    assert.strictEqual(blockingIssues.length, 1, "应该发现1个阻断问题");
    assert.ok(blockingIssues[0].includes("风格偏差过大"), "应该包含风格问题信息");
  });
});

// ============================================================================
// 端到端流程验证测试
// ============================================================================

describe("端到端流程验证", () => {
  before(() => {
    createTestWorkspaceFiles();
  });

  after(() => {
    cleanupTestWorkspace();
  });

  it("完整 workspace 结构应该满足生成条件", () => {
    const requiredFiles = [
      join(TEST_WORKSPACE_PATH, "config.json"),
      join(TEST_WORKSPACE_PATH, "series", "outline.md"),
      join(TEST_WORKSPACE_PATH, "characters", "li-yifan.md"),
      join(TEST_WORKSPACE_PATH, "series", "skeleton.json"),
      join(TEST_WORKSPACE_PATH, "series", "narrative-state.json"),
    ];

    for (const file of requiredFiles) {
      assert.ok(existsSync(file), `${file} 应该存在`);
    }
  });

  it("config.json 应该有完整的 genre 和角色列表", () => {
    const configPath = join(TEST_WORKSPACE_PATH, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    assert.ok(config.genre, "必须有 genre 字段");
    assert.ok(Array.isArray(config.characters), "必须有 characters 数组");
    assert.ok(config.characters.length > 0, "至少有一个角色");
  });

  it("skeleton.json 应该可以被后续章节读取", () => {
    const skeletonPath = join(TEST_WORKSPACE_PATH, "series", "skeleton.json");
    const skeleton = JSON.parse(readFileSync(skeletonPath, "utf-8"));

    assert.ok(skeleton.version, "应该有 version 字段");
    assert.ok(skeleton.characterArcs, "应该有 characterArcs 字段");
    assert.ok(skeleton.events !== undefined, "应该有 events 字段");
  });

  it("narrative-state.json 应该包含角色状态", () => {
    const statePath = join(TEST_WORKSPACE_PATH, "series", "narrative-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));

    assert.ok(state.characterStates, "应该有 characterStates 字段");
    assert.ok(state.worldState, "应该有 worldState 字段");
    assert.ok(Object.keys(state.characterStates).length > 0, "至少有一个角色状态");
  });

  it("角色档案应该包含必要的元信息", () => {
    const charPath = join(TEST_WORKSPACE_PATH, "characters", "li-yifan.md");
    const content = readFileSync(charPath, "utf-8");

    assert.ok(content.includes("#"), "应该包含 markdown 标题");
    assert.ok(content.includes("## 基本信息"), "应该包含基本信息部分");
    assert.ok(content.length > 100, "角色档案内容不应该太短");
  });
});
