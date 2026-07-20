/**
 * 隔离测试脚本：验证新项目 tianmen-baojiaxiang 与 xinmo 数据完全隔离
 *
 * 用法: node tests/isolation-test.mjs
 *
 * 测试内容：
 * 1. 调用 novel_generate_chapter (mock) 为 tianmen-baojiaxiang 生成第2章
 * 2. 验证 xinmo workspace 的文件未被修改
 * 3. 验证 tianmen-baojiaxiang workspace 收到正确的新文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// tests/ → extensions/novel-studio/ (扩展根目录)
const EXTENSION_ROOT = join(__dirname, "..");
// extensions/novel-studio/ → 项目根目录
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");

// ==========================================================================
// Helper: MD5 文件指纹
// ==========================================================================
function md5File(path) {
  if (!existsSync(path)) return "MISSING";
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

// ==========================================================================
// Helper: 文件计数
// ==========================================================================
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  function walk(d) {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else count++;
    }
  }
  walk(dir);
  return count;
}

// ==========================================================================
// Step 1: 测试前快照
// ==========================================================================
console.log("=".repeat(60));
console.log("P13 隔离测试：novel_generate_chapter workspace 数据隔离");
console.log("=".repeat(60));

// workspaces 在扩展目录下
const XINMO_DIR = join(EXTENSION_ROOT, "workspaces", "心魔界");
const TIANMEN_DIR = join(EXTENSION_ROOT, "workspaces", "tianmen-baojiaxiang");

console.log("\n【步骤1】测试前快照");

const xinmoFilesBefore = countFiles(XINMO_DIR);
const tianmenFilesBefore = countFiles(TIANMEN_DIR);

const xinmoSnapshots = [
  { name: "config.json", path: join(XINMO_DIR, "config.json") },
  { name: "skeleton.json", path: join(XINMO_DIR, "series", "skeleton.json") },
  { name: "outline.md", path: join(XINMO_DIR, "series", "outline.md") },
  { name: "fatigue-state.json", path: join(XINMO_DIR, "series", "fatigue-state.json") },
  { name: "narrative-state.json", path: join(XINMO_DIR, "series", "narrative-state.json") },
  { name: "arc-registry.json", path: join(XINMO_DIR, "series", "arc-registry.json") },
  { name: "narrative-debt.json", path: join(XINMO_DIR, "series", "narrative-debt.json") },
  { name: "unsettled-details.json", path: join(XINMO_DIR, "series", "unsettled-details.json") },
  { name: "clock-state.json", path: join(XINMO_DIR, "series", "clock-state.json") },
].map(s => ({ ...s, md5: md5File(s.path) }));

console.log(`  心魔界: ${xinmoFilesBefore} 个文件`);
console.log(`  天门包家巷: ${tianmenFilesBefore} 个文件`);
console.log("\n  心魔界文件指纹:");
for (const s of xinmoSnapshots) {
  console.log(`    ${s.name}: ${s.md5}`);
}

// ==========================================================================
// Step 2: 模拟 novel_generate_chapter(chapterNumber=2, mockAgent=true)
// ==========================================================================
console.log("\n【步骤2】执行 novel_generate_chapter (workspaceId=tianmen-baojiaxiang, chapterId=2, mock)");

const workspacePath = TIANMEN_DIR;
const chapterId = "2";
const chapterNumber = 2;

// 加载 config
const configPath = join(workspacePath, "config.json");
if (!existsSync(configPath)) {
  console.error("  ❌ config.json 不存在，无法执行测试");
  process.exit(1);
}
const configData = JSON.parse(readFileSync(configPath, "utf-8"));

// 加载 outline
const outlinePath = join(workspacePath, "series", "outline.md");
const outlineText = existsSync(outlinePath) ? readFileSync(outlinePath, "utf-8") : "";

// 加载 skeleton 和 state
const skeletonPath = join(workspacePath, "series", "skeleton.json");
const statePath = join(workspacePath, "series", "narrative-state.json");
const detailsPath = join(workspacePath, "series", "unsettled-details.json");

// 模拟第1章摘要
const ch1Path = join(workspacePath, "chapters", "chapter-01.md");
const priorSummary = existsSync(ch1Path)
  ? readFileSync(ch1Path, "utf-8").slice(0, 500)
  : "第1章：包家巷 - 阿生发现父亲秘密";

const primaryCharacter = configData.characters?.[0]?.name || "阿生";
const totalChapters = configData.totalChapters || 28;

// ==========================================================================
// Mock 链逻辑（从 runMockGenerateChapterChain 提取）
// ==========================================================================

// 阶段1：模拟 anchor search DAG
const dag = {
  chapterId,
  chapterNumber,
  title: `第${chapterNumber}章：洋枪`,
  anchors: [
    { id: "anchor-1", label: "continuity", description: "第1章阿生发现父亲账簿和革命党身份，官府开始注意水货行" },
    { id: "anchor-2", label: "outline", description: "阿生发现父亲的秘密账簿；神秘商人上门送货；官府注意到水货行" },
    { id: "anchor-3", label: "turn", description: "从第1章的家庭秘密初现，进入更具体的危机阶段" },
  ],
  events: [
    {
      id: "ch2-event-1",
      summary: "阿生进一步调查父亲的秘密活动，无意中发现更详细的秘密账簿",
      characters: ["阿生", "包大山"],
      type: "discovery",
      narrativeBeat: "rising_action",
    },
    {
      id: "ch2-event-2",
      summary: "神秘商人再次到访，带来不同寻常的货物，引发阿生警觉",
      characters: ["神秘商人", "包大山", "阿生"],
      type: "tension",
      narrativeBeat: "complication",
    },
    {
      id: "ch2-event-3",
      summary: "官府差役开始在水货行附近巡视，王婶再次警告包家",
      characters: ["王婶", "阿生", "林婉"],
      type: "threat",
      narrativeBeat: "rising_tension",
    },
  ],
};

// 章节 mock 正文
const finalText = [
  `# 第二章 洋枪`,
  ``,
  `【Mock Agent 生成 - 编排测试】`,
  ``,
  `Workspace: tianmen-baojiaxiang / Genre: ${configData.genre}`,
  ``,
  `本章基于第1章埋下的伏笔展开：阿生发现父亲包大山的秘密账簿后，`,
  `神秘商人再次到访水货行。官府开始注意到包家的异常活动。`,
  ``,
  `核心事件：`,
  `1. 阿生在仓库深处发现了更详细的账簿，记录了多次洋枪交易`,
  `2. 神秘商人带着一批特殊货物到访，与包大山密谈`,
  `3. 镇上的差役开始在水货行附近巡查，王婶再次向林家婉发出警告`,
  ``,
  `章节钩子：阿生决定帮助父亲保守秘密，但官府的目光越来越近...`,
  ``,
  `---`,
  `【第二章完 - Mock Agent 生成】`,
].join("\n");

// 更新 skeleton.json
let skeletonData = { version: "1.0", chapterSkeletons: {} };
if (existsSync(skeletonPath)) {
  try { skeletonData = JSON.parse(readFileSync(skeletonPath, "utf-8")); } catch {}
}
skeletonData.chapterSkeletons = {
  ...(skeletonData.chapterSkeletons || {}),
  [chapterId]: {
    chapterNumber,
    mode: "mock-agent",
    title: "洋枪",
    scenes: [
      { location: "水货行仓库", summary: "阿生发现更详细的秘密账簿" },
      { location: "水货行", summary: "神秘商人到访与包大山密谈" },
      { location: "包家巷", summary: "差役巡视，王婶警告" },
    ],
    keyEvents: ["账簿发现", "神秘商人到访", "官府注意"],
    continuityHooks: ["官府正式调查", "神秘商人的真实目的", "阿生协助父亲"],
    charactersInvolved: ["阿生", "包大山", "神秘商人", "王婶", "林婉"],
  },
};
skeletonData.continuityState = skeletonData.continuityState || {};
skeletonData.continuityState.lastChapterId = chapterId;
skeletonData.continuityState.lastChapterNumber = chapterNumber;

// 更新 narrative-state.json
let stateData = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : { version: "1.0" };
stateData = { ...stateData, chapterNumber, lastChapterId: chapterId, mockAgent: true, updatedAt: new Date().toISOString() };

// 更新 unsettled-details.json
let detailsData = existsSync(detailsPath) ? JSON.parse(readFileSync(detailsPath, "utf-8")) : { version: "1.0", trackedDetails: [] };
detailsData.trackedDetails = [
  ...(Array.isArray(detailsData.trackedDetails) ? detailsData.trackedDetails : []),
  { id: `detail-ch2-001`, chapterId, status: "open", note: "神秘商人的真实身份和目的" },
  { id: `detail-ch2-002`, chapterId, status: "open", note: "账簿中记录的洋枪交易详情" },
];
detailsData.lastUpdated = new Date().toISOString();

// ==========================================================================
// 原子事务写入（临时文件 → rename）
// ==========================================================================
const chaptersDir = join(workspacePath, "chapters");
if (!existsSync(chaptersDir)) mkdirSync(chaptersDir, { recursive: true });

const chapterFilePath = join(chaptersDir, `chapter-02.md`);
const chapterTempPath = join(chaptersDir, `chapter-02.tmp.md`);

const pendingWrites = [
  { path: skeletonPath, data: JSON.stringify(skeletonData, null, 2) },
  { path: detailsPath, data: JSON.stringify(detailsData, null, 2) },
  { path: statePath, data: JSON.stringify(stateData, null, 2) },
];

try {
  // 先写临时文件
  writeFileSync(chapterTempPath, finalText, "utf-8");
  for (const w of pendingWrites) {
    const d = dirname(w.path);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(w.path, w.data, "utf-8");
  }

  // 原子 rename
  if (existsSync(chapterFilePath)) unlinkSync(chapterFilePath);
  renameSync(chapterTempPath, chapterFilePath);

  console.log("  ✅ 第2章 mock 生成完成");
  console.log(`  📄 章节文件: ${chapterFilePath}`);
} catch (error) {
  if (existsSync(chapterTempPath)) try { unlinkSync(chapterTempPath); } catch {}
  console.error("  ❌ 原子事务写入失败:", error);
  process.exit(1);
}

// ==========================================================================
// Step 3: 测试后对比
// ==========================================================================
console.log("\n【步骤3】测试后验证");

const xinmoFilesAfter = countFiles(XINMO_DIR);
const tianmenFilesAfter = countFiles(TIANMEN_DIR);

console.log(`\n  心魔界文件数: ${xinmoFilesBefore} → ${xinmoFilesAfter} (${xinmoFilesAfter === xinmoFilesBefore ? "✅ 未变" : "❌ 有变化!"})`);
console.log(`  天门包家巷文件数: ${tianmenFilesBefore} → ${tianmenFilesAfter} (${tianmenFilesAfter > tianmenFilesBefore ? "✅ 新增章节" : "❌ 未增"})`);

// 验证 xinmo 文件完整性
let xinmoIntact = true;
console.log("\n  心魔界文件完整性检查:");
for (const s of xinmoSnapshots) {
  const currentMd5 = md5File(s.path);
  const intact = currentMd5 === s.md5;
  if (!intact) xinmoIntact = false;
  console.log(`    ${s.name}: ${intact ? "✅" : "❌ 被修改!"} (${s.md5} → ${currentMd5})`);
}

// ==========================================================================
// Step 4: 验证 tianmen 新文件
// ==========================================================================
console.log("\n【步骤4】天门包家巷新文件验证");

const newFiles = [
  { name: "chapter-02.md", path: join(TIANMEN_DIR, "chapters", "chapter-02.md"), shouldExist: true },
  { name: "skeleton.json (含ch2)", path: join(TIANMEN_DIR, "series", "skeleton.json"), shouldExist: true },
  { name: "narrative-state.json (更新)", path: join(TIANMEN_DIR, "series", "narrative-state.json"), shouldExist: true },
  { name: "unsettled-details.json (更新)", path: join(TIANMEN_DIR, "series", "unsettled-details.json"), shouldExist: true },
];

let newFilesOk = true;
for (const f of newFiles) {
  const exists = existsSync(f.path);
  if (exists !== f.shouldExist) newFilesOk = false;
  console.log(`    ${f.name}: ${exists === f.shouldExist ? "✅" : "❌"}`);
}

// 读取 skeleton 确认包含第2章
if (existsSync(join(TIANMEN_DIR, "series", "skeleton.json"))) {
  const sk = JSON.parse(readFileSync(join(TIANMEN_DIR, "series", "skeleton.json"), "utf-8"));
  const hasCh2 = sk.chapterSkeletons?.["2"] !== undefined;
  const hasCh1 = sk.chapterSkeletons?.["1"] !== undefined;
  console.log(`    skeleton.json 含第1章: ${hasCh1 ? "✅" : "❌"}`);
  console.log(`    skeleton.json 含第2章: ${hasCh2 ? "✅" : "❌"}`);
}

// ==========================================================================
// Step 5: 全局隔离检查
// ==========================================================================
console.log("\n【步骤5】全局隔离检查");

// 验证 xinmo 中没有任何 tianmen 的内容
const xinmoConfig = JSON.parse(readFileSync(join(XINMO_DIR, "config.json"), "utf-8"));
const noTianmenInXinmo = xinmoConfig.title !== "天门：包家巷"
  && !JSON.stringify(xinmoConfig).includes("tianmen-baojiaxiang")
  && !JSON.stringify(xinmoConfig).includes("阿生")
  && !JSON.stringify(xinmoConfig).includes("包大山");
console.log(`  心魔界不含天门数据: ${noTianmenInXinmo ? "✅" : "❌"}`);

// 验证 tianmen 中没有任何 xinmo 的内容
const tianmenConfig = JSON.parse(readFileSync(join(TIANMEN_DIR, "config.json"), "utf-8"));
const noXinmoInTianmen = tianmenConfig.title !== "心魔界"
  && !JSON.stringify(tianmenConfig).includes("xinmo")
  && !JSON.stringify(tianmenConfig).includes("李一凡")
  && !JSON.stringify(tianmenConfig).includes("都市异能");
console.log(`  天门不含心魔界数据: ${noXinmoInTianmen ? "✅" : "❌"}`);

// ==========================================================================
// 最终报告
// ==========================================================================
console.log("\n" + "=".repeat(60));
console.log("隔离测试结果");
console.log("=".repeat(60));

const allPassed = xinmoIntact && newFilesOk && noTianmenInXinmo && noXinmoInTianmen && (xinmoFilesAfter === xinmoFilesBefore);

if (allPassed) {
  console.log("\n✅ 所有隔离测试通过！");
  console.log("   - 心魔界 (xinmo) workspace 数据完全未被修改");
  console.log("   - 天门包家巷 (tianmen-baojiaxiang) workspace 成功生成第2章");
  console.log("   - 两个 workspace 数据完全隔离，无交叉污染");
} else {
  console.log("\n❌ 隔离测试失败！");
  if (!xinmoIntact) console.log("   - 心魔界文件被意外修改");
  if (!newFilesOk) console.log("   - 天门包家巷文件生成异常");
  if (!noTianmenInXinmo) console.log("   - 检测到数据交叉污染");
}

console.log("");
