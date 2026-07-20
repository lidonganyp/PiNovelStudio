/**
 * 通过 PI 扩展 API 调用 novel_generate_chapter 生成指定章节
 * 并将生成的章节内容和质量追踪保存到 D:\CODE\PiNovelStudio\delete 目录
 *
 * 用法:
 *   node scripts/generate-chapter-save.mjs <workspaceId> <chapterNumber>
 *   node scripts/generate-chapter-save.mjs xinmo 11
 *   node scripts/generate-chapter-save.mjs tianmen-baojiaxiang 1
 */

import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "delete");

// 从命令行参数读取 workspaceId 和 chapterNumber
const workspaceId = process.argv[2];
const chapterNumber = parseInt(process.argv[3] || "0", 10);

if (!workspaceId || !chapterNumber) {
  console.error("用法: node scripts/generate-chapter-save.mjs <workspaceId> <chapterNumber>");
  console.error("示例: node scripts/generate-chapter-save.mjs xinmo 11");
  process.exit(1);
}

const WORKSPACE_DIR = join(PROJECT_ROOT, "workspaces", workspaceId);

if (!existsSync(WORKSPACE_DIR)) {
  console.error(`工作区不存在: ${WORKSPACE_DIR}`);
  process.exit(1);
}

// 读取 workspace 配置获取小说名称
const configPath = join(WORKSPACE_DIR, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const novelName = config.novelName || workspaceId;

// 确保输出目录存在
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

const extPath = join(EXTENSION_ROOT, "dist", "index.js");
const extURL = pathToFileURL(extPath).href;
const extModule = await import(extURL);
const extensionSetup = extModule.default;

const registeredTools = {};
const ui = {
  notify(msg, level) {
    console.log(`  [PI UI ${level}] ${msg}`);
  },
};

const pi = {
  registerTool(toolDef) {
    registeredTools[toolDef.name] = toolDef;
    console.log(`  [注册工具] ${toolDef.name}`);
    return toolDef;
  },
  registerCommand(cmdDef) {
    console.log(`  [注册命令] ${cmdDef.name}`);
    return cmdDef;
  },
  on(event, handler) {
    console.log(`  [注册事件] ${event}`);
  },
  ui,
};

console.log("=".repeat(70));
console.log(`  PiNovelStudio — ${novelName} 第${chapterNumber}章 生成 & 保存`);
console.log("=".repeat(70));
console.log();

// 显示工作区信息
console.log(`[工作区] ${workspaceId} (${novelName})`);
console.log(`  作品: ${config.novelName}`);
console.log(`  类型: ${config.genre}`);
console.log(`  已完成的章节: ${config.chapterProgress?.completed || 0}`);
console.log(`  当前章节号: ${config.chapterProgress?.current || 0}`);
console.log();

console.log("[阶段0] 加载扩展...");
extensionSetup(pi);

const generateTool = registeredTools["novel_generate_chapter"];
if (!generateTool) {
  console.error("❌ novel_generate_chapter 工具未注册！");
  process.exit(1);
}

console.log(`✅ novel_generate_chapter 已注册`);
console.log();

const params = {
  workspaceId,
  chapterId: String(chapterNumber),
  chapterNumber,
};

console.log("[参数]");
console.log(`  workspaceId: ${params.workspaceId}`);
console.log(`  chapterId: ${params.chapterId}`);
console.log(`  chapterNumber: ${params.chapterNumber}`);
console.log();

console.log("[调用] novel_generate_chapter...");
console.log("─".repeat(70));

const progressUpdates = [];

try {
  const result = await generateTool.execute(
    "tool-call-ch" + chapterNumber + "-" + Date.now(),
    params,
    undefined,
    (update) => {
      const msg = typeof update === "string" ? update : JSON.stringify(update).slice(0, 300);
      progressUpdates.push(msg);
      console.log(`  [进度] ${msg}`);
    },
    {
      cwd: PROJECT_ROOT,
      ui,
    }
  );

  console.log();
  console.log("─".repeat(70));
  console.log("[结果分析]");
  console.log("─".repeat(70));

  const details = result.details || result;

  if (result.isError || details?.status === "error" || details?.error) {
    const errMsg = result.content?.[0]?.text || details?.message || details?.error || JSON.stringify(details);
    console.log(`\n❌ 生成失败`);
    console.log(`错误: ${errMsg}`);
    if (details?.stage) console.log(`阶段: ${details.stage}`);

    // 保存错误信息
    const errorReport = {
      status: "error",
      error: errMsg,
      stage: details?.stage,
      timestamp: new Date().toISOString(),
      workspaceId,
      chapterId: String(chapterNumber),
      details,
    };
    writeFileSync(
      join(OUTPUT_DIR, `ch${chapterNumber}-generation-error.json`),
      JSON.stringify(errorReport, null, 2),
      "utf-8"
    );
    console.log(`\n⚠️ 错误报告已保存到: ${join(OUTPUT_DIR, `ch${chapterNumber}-generation-error.json`)}`);

    // 保存进度追踪以辅助诊断
    writeFileSync(
      join(OUTPUT_DIR, `ch${chapterNumber}-progress-trace.json`),
      JSON.stringify(progressUpdates, null, 2),
      "utf-8"
    );

    // 即使失败也保存完整结果 JSON
    try {
      const resultToSave = JSON.parse(JSON.stringify(details || result));
      writeFileSync(
        join(OUTPUT_DIR, `ch${chapterNumber}-full-result.json`),
        JSON.stringify(resultToSave, null, 2),
        "utf-8"
      );
    } catch (e) {
      console.log(`⚠️ 保存完整结果失败: ${e.message}`);
    }

    // 即使失败也复制质量追踪
    const traceDir = join(WORKSPACE_DIR, "traces");
    if (existsSync(traceDir)) {
      const traceFiles = readdirSync(traceDir).filter(f => f.includes(String(chapterNumber)) || f.includes(`ch${chapterNumber}`));
      for (const tf of traceFiles) {
        const traceContent = readFileSync(join(traceDir, tf), "utf-8");
        writeFileSync(join(OUTPUT_DIR, tf), traceContent, "utf-8");
      }
    }
    process.exit(1);
  }

  console.log(`\n✅ 生成完成!`);
  console.log(`状态: ${details.status}`);
  console.log(`章节: ${details.chapterId} (第${details.chapterNumber}章)`);

  // 保存阶段结果概览
  if (details.stageResults) {
    console.log(`\n【阶段结果】`);
    for (const [stage, s] of Object.entries(details.stageResults)) {
      if (s && typeof s === "object" && s.status) {
        const icon = s.status === "success" ? "✅" : s.status === "skipped" ? "⏭️" : s.status === "error" ? "❌" : "ℹ️";
        console.log(`  ${icon} ${stage}: ${s.status}`);
      }
    }
  }

  // 保存生成的章节内容到 delete 目录
  let chapterContent = "";

  if (details.content) {
    chapterContent = typeof details.content === "string" ? details.content : JSON.stringify(details.content);
  } else if (details.text) {
    chapterContent = details.text;
  } else if (details.chapterText) {
    chapterContent = details.chapterText;
  } else if (result.content && result.content[0] && result.content[0].text) {
    chapterContent = result.content[0].text;
  }

  if (chapterContent) {
    const outputPath = join(OUTPUT_DIR, `${novelName}-第${chapterNumber}章.md`);
    writeFileSync(outputPath, chapterContent, "utf-8");
    console.log(`\n📝 章节内容已保存到: ${outputPath}`);
    console.log(`   文件大小: ${chapterContent.length} 字符`);
  } else {
    console.log(`\n⚠️ 未能提取章节正文内容`);
  }

  // 保存完整结果 JSON
  const fullResultPath = join(OUTPUT_DIR, `ch${chapterNumber}-full-result.json`);
  try {
    const resultToSave = JSON.parse(JSON.stringify(details));
    writeFileSync(fullResultPath, JSON.stringify(resultToSave, null, 2), "utf-8");
    console.log(`📊 完整结果已保存到: ${fullResultPath}`);
  } catch (e) {
    console.log(`⚠️ 保存完整结果失败: ${e.message}`);
  }

  // 保存 DAG 概览
  if (details.dag) {
    const dagPath = join(OUTPUT_DIR, `ch${chapterNumber}-dag-overview.json`);
    const dagOverview = {
      eventCount: details.dag.events?.length || 0,
      events: (details.dag.events || []).map(e => ({
        name: e.name,
        type: e.type,
        characters: e.characters || [],
        conflictLevel: e.conflictLevel,
        narrativeBeat: e.narrativeBeat,
      })),
    };
    writeFileSync(dagPath, JSON.stringify(dagOverview, null, 2), "utf-8");
    console.log(`📊 DAG 概览已保存到: ${dagPath}`);
  }

  // 保存质量追踪（如果有）
  const traceDir = join(WORKSPACE_DIR, "traces");
  if (existsSync(traceDir)) {
    const traceFiles = readdirSync(traceDir).filter(f => f.includes(String(chapterNumber)) || f.includes(`ch${chapterNumber}`));
    for (const tf of traceFiles) {
      const traceContent = readFileSync(join(traceDir, tf), "utf-8");
      writeFileSync(join(OUTPUT_DIR, tf), traceContent, "utf-8");
      console.log(`📊 质量追踪已保存到: ${join(OUTPUT_DIR, tf)}`);
    }
  }

  // 保存警告和错误
  if (details.warnings && details.warnings.length > 0) {
    console.log(`\n⚠️ 警告 (${details.warnings.length}):`);
    for (const w of details.warnings.slice(0, 10)) {
      console.log(`  - ${w}`);
    }
  }
  if (details.errors && details.errors.length > 0) {
    console.log(`\n❌ 错误 (${details.errors.length}):`);
    for (const e of details.errors) {
      console.log(`  - ${e}`);
    }
  }

  console.log();
  console.log("=".repeat(70));
  console.log("  生成完毕！");
  console.log("=".repeat(70));

} catch (error) {
  console.error(`\n❌ 调用异常: ${error.message}`);
  console.error(error.stack);

  // 保存异常信息
  const errorReport = {
    status: "exception",
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
    workspaceId,
    chapterId: String(chapterNumber),
  };
  writeFileSync(
    join(OUTPUT_DIR, `ch${chapterNumber}-generation-exception.json`),
    JSON.stringify(errorReport, null, 2),
    "utf-8"
  );

  // 保存进度追踪
  try {
    writeFileSync(
      join(OUTPUT_DIR, `ch${chapterNumber}-progress-trace.json`),
      JSON.stringify(progressUpdates, null, 2),
      "utf-8"
    );
  } catch (_) { /* ignore */ }

  // 复制质量追踪
  try {
    const traceDir = join(WORKSPACE_DIR, "traces");
    if (existsSync(traceDir)) {
      const traceFiles = readdirSync(traceDir).filter(f => f.includes(String(chapterNumber)) || f.includes(`ch${chapterNumber}`));
      for (const tf of traceFiles) {
        const traceContent = readFileSync(join(traceDir, tf), "utf-8");
        writeFileSync(join(OUTPUT_DIR, tf), traceContent, "utf-8");
      }
    }
  } catch (_) { /* ignore */ }

  process.exit(1);
}
