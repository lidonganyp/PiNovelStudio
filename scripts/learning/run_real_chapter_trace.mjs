/**
 * P9 真实章节生成 trace 集成脚本
 *
 * 用途：通过真实的 createNarratorAgent + agent.execute 代码路径
 * 产生 quality-trace.json，证明：
 * 1. validated-craft-rules.json 被主链路真实加载
 * 2. craftRuleSelector.select() 在 generateEvent 内部被真实调用
 * 3. qualityTraceRecorder.recordEvent() 在 LLM 生成后被真实调用
 * 4. trace 文件含真实 selectedRuleIds（非脚本硬编码）
 *
 * 与 produce_trace_evidence.mjs 的区别：
 * - 调用真实 NarratorAgent.execute（含 LLM 调用、DAG 处理、事件编排）
 * - segment 文本由 LLM 真实生成（非 mock）
 * - workspace 有 config.json + characters，是真实章节生成 workspace
 * - trace 由 narrator 内部 qualityTraceRecorder.flush() 写入
 *
 * 运行：node scripts/learning/run_real_chapter_trace.mjs
 *
 * 产物：workspaces/p9-real-trace/traces/1-quality-trace.json
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..");

async function main() {
  // 1. 前置检查：validated-craft-rules.json 必须存在
  const validatedRulesPath = join(projectRoot, "data", "runtime", "validated-craft-rules.json");
  if (!existsSync(validatedRulesPath)) {
    console.error(`[P9 real trace] validated-craft-rules.json not found: ${validatedRulesPath}`);
    console.error(`[P9 real trace] 请先运行 node scripts/learning/produce_promotion_evidence.mjs`);
    process.exit(1);
  }

  // 2. 前置检查：workspace config 必须存在
  const workspaceId = "p9-real-trace";
  const workspacePath = join(projectRoot, "workspaces");
  const configPath = join(workspacePath, workspaceId, "config.json");
  if (!existsSync(configPath)) {
    console.error(`[P9 real trace] workspace config not found: ${configPath}`);
    process.exit(1);
  }

  // 3. 清理旧 trace（确保是本轮真实产生）
  const chapterId = "1";
  const tracePath = join(workspacePath, workspaceId, "traces", `${chapterId}-quality-trace.json`);
  if (existsSync(tracePath)) {
    rmSync(tracePath, { force: true });
    console.log(`[P9 real trace] cleaned old trace: ${tracePath}`);
  }

  // 4. 动态导入 dist 中的 NarratorAgent（已编译的真实代码）
  const { createNarratorAgent } = await import(
    "../../.pi/extensions/novel-studio/dist-test/agents/narrator.js"
  );

  // 5. 构造最小 DAG（1 个事件，含主角林衡）
  //    DAG 结构对应 StoryDAGSchema，narrator.execute 内部不验证 schema
  //    只读取字段，所以构造最小有效对象即可
  const dag = {
    chapterId,
    title: "第一章 北站异变",
    chapterFunction: "setup",
    events: [
      {
        id: "E1",
        name: "林衡排查停电",
        type: "scene",
        preconditions: [],
        effects: ["北区供电恢复", "发现异常线索"],
        characters: ["林衡"],
        location: "轨道城北站",
        emotionalArc: { from: "好奇", to: "紧张" },
        conflictLevel: 3,
        narrativeBeat: "establishment",
        hooks: ["北区停电的真正原因"],
        contentPoints: ["林衡进入北区排查", "发现供电核心异常", "恢复部分供电"],
        wordCountTarget: { min: 600, max: 1000 },
      },
    ],
    causalGraph: [],
    emotionalCurve: {
      beats: [
        { event: "E1", emotion: "好奇", intensity: 4 },
        { event: "E1", emotion: "紧张", intensity: 6 },
      ],
      metrics: {
        satisfactionDensity: 0.001,
        tensionWaveCount: 1,
        maxOppressionLength: 0,
        cliffhangerStrength: 5,
        emotionDiversity: 2,
        curveSmoothness: 0.5,
        climaxTiming: 0.75,
      },
    },
    foreshadowing: {
      planted: [
        {
          id: "F1",
          hook: "北区停电的真正原因",
          plantedAt: "E1",
          plantedBy: "林衡",
          payoffCondition: "第3章揭示",
          payoffPlan: "反派阴谋",
        },
      ],
      pending: ["F1"],
      resolved: [],
    },
    worldConstraints: [],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: "1.0.0",
      status: "in_progress",
    },
  };

  // 6. 创建 NarratorAgent（真实主链路创建函数）
  console.log(`[P9 real trace] creating NarratorAgent...`);
  const agent = createNarratorAgent({
    workspacePath,
    workspaceId,
    styleProfile: "default",
    worldContext: "轨道城是一个建于近地轨道的巨型空间站城市。",
    protagonistName: "林衡",
  });

  // 7. 执行章节生成（真实 LLM 调用 + 事件编排 + trace 写入）
  console.log(`[P9 real trace] calling agent.execute() — this will call LLM...`);
  console.log(`[P9 real trace] workspaceId=${workspaceId}, chapterId=${chapterId}`);

  const result = await agent.execute({
    workspaceId,
    chapterId,
    dag,
    text: undefined,
    context: {
      workspaceId,
      chapterId,
      chapterNumber: 1,
      novelName: workspaceId,
      genre: "玄幻",
      styleProfile: "default",
      activeForeshadowing: [],
      previousChapterText: "",
    },
  });

  console.log(`[P9 real trace] execute result: status=${result.status}`);
  if (result.status === "error") {
    console.error(`[P9 real trace] execute failed: ${(result).message || "unknown"}`);
    console.error(`[P9 real trace] findings: ${result.report?.findings?.slice(-5).join("\n") || "none"}`);
    // 即使 LLM 失败，也检查 trace 是否被写入（narrator 可能在异常路径 flush）
  }

  // 8. 打印关键 findings（验证规则被加载和选择）
  if (result.report?.findings) {
    const ruleFindings = result.report.findings.filter(f =>
      f.includes("validated") || f.includes("规则") || f.includes("selectedRule") || f.includes("craft rule")
    );
    console.log(`[P9 real trace] rule-related findings:`);
    for (const f of ruleFindings.slice(0, 10)) {
      console.log(`  - ${f}`);
    }
  }

  // 9. 验证 trace 文件
  if (existsSync(tracePath)) {
    const trace = JSON.parse(readFileSync(tracePath, "utf-8"));
    console.log(`[P9 real trace] ✓ trace file written: ${tracePath}`);
    console.log(`[P9 real trace] trace.events.length=${trace.events.length}`);
    console.log(`[P9 real trace] trace.patches.length=${trace.patches?.length || 0}`);
    for (const evt of trace.events) {
      console.log(`[P9 real trace] event ${evt.eventId}: selectedRuleIds=${(evt.selectedRuleIds || []).join(",") || "(empty)"}`);
    }
    const hasActiveRule = trace.events.some(e => (e.selectedRuleIds || []).length > 0);
    if (hasActiveRule) {
      console.log(`[P9 real trace] ✓ PASS: trace contains active validated rules (real generation path)`);
      process.exit(0);
    } else {
      console.error(`[P9 real trace] ✗ FAIL: trace has no active validated rules`);
      process.exit(2);
    }
  } else {
    console.error(`[P9 real trace] ✗ FAIL: trace file not written at ${tracePath}`);
    console.error(`[P9 real trace] narrator may not have reached flush() — check LLM availability`);
    process.exit(3);
  }
}

main().catch(err => {
  console.error(`[P9 real trace] uncaught error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
