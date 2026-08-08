/**
 * gpt-5.6-sol 盲测评分脚本
 *
 * 对 uncertainty-ablation-r2/seed-1/blind-pack.json 中的 14 个文本逐个评分，
 * 与用户人工评审（满分 100）对比差异。
 *
 * 评分维度（与人工评审一致）：
 * - 自然度（0-100）：中文表达是否自然、无 AI 腔/翻译腔
 * - 叙事完成度（0-100）：情节是否完整、是否有明显遗漏或仓促收尾
 * - 事实准确性（0-100）：是否有事实硬伤、人物状态错误、与 prefix 矛盾
 * - 总分（0-100）：综合文学质量
 *
 * 调用路由：v2_literary_judge / novel_quality_judge（gpt-5.6-sol via NOVELOS_JUDGE_*）
 * 仅用于隔离评测，不进生产路径。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CASES_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "novelbench",
  "uncertainty-ablation-cases-r2.json",
);
const BLIND_PACK_PATH = path.join(
  REPO_ROOT,
  "reports",
  "uncertainty-ablation-r2",
  "seed-1",
  "blind-pack.json",
);
const OUTPUT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "uncertainty-ablation-r2",
  "seed-1",
);
const SCORES_OUTPUT = path.join(OUTPUT_DIR, "gpt56-scores.json");
const REPORT_OUTPUT = path.join(OUTPUT_DIR, "gpt56-vs-human-comparison.md");

// 注意：环境变量在 main() 中 loadEnv() 之后读取，这里只声明默认模型
const JUDGE_MODEL = "gpt-5.6-sol";

// 人工评分（满分 100）—— 来自用户评审
const HUMAN_SCORES = {
  "X-high-xuanhuan-1": 75, // A
  "Y-high-xuanhuan-1": 85, // B
  "X-high-suspense-1": 86, // B
  "Y-high-suspense-1": 90, // A
  "X-real-xuanhuan-1": 89, // A
  "Y-real-xuanhuan-1": 90, // B
  "X-real-suspense-1": 84, // A
  "Y-real-suspense-1": 89, // B
  "X-real-urban-1": 86, // B
  "Y-real-urban-1": 88, // A
  "X-real-xianxia-1": 87, // A
  "Y-real-xianxia-1": 89, // B
  "X-real-scifi-1": 85, // B
  "Y-real-scifi-1": 80, // A
};

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 300000; // 5 分钟

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取 .env 文件（简单解析） */
function loadEnv() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/** 调用 gpt-5.6-sol 评分 */
async function callJudge(systemPrompt, userPrompt) {
  const apiKey = process.env.NOVELOS_JUDGE_API_KEY;
  const baseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const model = process.env.NOVELOS_JUDGE_MODEL || JUDGE_MODEL;
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    stream: false,
  };

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const status = resp.status;
        const text = await resp.text().catch(() => "");
        lastError = `HTTP ${status}: ${text.slice(0, 200)}`;
        // 502/503/429/520-524 重试
        if (
          status === 502 ||
          status === 503 ||
          status === 429 ||
          (status >= 520 && status <= 524)
        ) {
          console.warn(
            `  ⚠️ 第 ${attempt}/${MAX_RETRIES} 次重试（${status}）：${lastError}`,
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // 其他错误不重试
        throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        lastError = "返回内容为空";
        console.warn(`  ⚠️ 第 ${attempt}/${MAX_RETRIES} 次重试：${lastError}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      clearTimeout(timer);
      return content;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        lastError = `请求超时（${REQUEST_TIMEOUT_MS}ms）`;
      } else {
        lastError = e.message;
      }
      console.warn(
        `  ⚠️ 第 ${attempt}/${MAX_RETRIES} 次重试：${lastError}`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`重试 ${MAX_RETRIES} 次后仍失败：${lastError}`);
}

/** 解析评分 JSON */
function parseScore(rawText) {
  const trimmed = rawText.trim();
  // 尝试直接 parse
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // 容错：提取 JSON 片段
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        obj = JSON.parse(match[0]);
      } catch {
        // fallthrough
      }
    }
  }
  if (!obj) {
    return null;
  }
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    naturalness: num(obj.naturalness) ?? num(obj.自然度) ?? null,
    completeness: num(obj.completeness) ?? num(obj.叙事完成度) ?? null,
    accuracy: num(obj.accuracy) ?? num(obj.事实准确性) ?? null,
    total: num(obj.total) ?? num(obj.总分) ?? null,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

/** 构造评分 prompt */
function buildScoringPrompts(caseData, text) {
  const system = [
    `你是资深网文文学评委。请对下面这段中文网文章节正文进行评分。`,
    `你会看到本章的前文（prefix）、作者章纲必须包含的要素（mustVerify）、不可破坏的事实，以及待评分的正文。`,
    ``,
    `评分维度（0-100 分，整数）：`,
    `1. naturalness（自然度）：中文表达是否自然、是否有 AI 腔/翻译腔、对白是否口语化`,
    `2. completeness（叙事完成度）：情节是否完整、是否有明显遗漏或仓促收尾、是否与 mustVerify 要素呼应`,
    `3. accuracy（事实准确性）：是否有事实硬伤、人物状态错误、与 prefix/inviolableFacts 矛盾`,
    `4. total（总分）：综合文学质量，0-100`,
    ``,
    `输出格式（严格 JSON，不要其他内容）：`,
    `{`,
    `  "naturalness": 数字,`,
    `  "completeness": 数字,`,
    `  "accuracy": 数字,`,
    `  "total": 数字,`,
    `  "reason": "总体评价（50-150字）"`,
    `}`,
    ``,
    `要求：`,
    `- 只输出 JSON，不要其他内容`,
    `- 评分必须基于文本本身的文学质量，不要考虑生成过程`,
    `- 事实准确性要对照 prefix 和 inviolableFacts 检查`,
  ].join("\n");

  const mustVerifyStr =
    caseData.authorMustInclude && caseData.authorMustInclude.length > 0
      ? caseData.authorMustInclude.map((m, i) => `${i + 1}. ${m}`).join("\n")
      : "（无高风险 mustVerify）";

  const inviolableFactsStr =
    caseData.inviolableFacts && caseData.inviolableFacts.length > 0
      ? caseData.inviolableFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")
      : "（无显式不可破坏事实，参考 prefix）";

  const user = [
    `【前文（prefix）】`,
    caseData.prefix,
    ``,
    `【作者章纲必须包含（mustVerify）】`,
    mustVerifyStr,
    ``,
    `【不可破坏的事实（inviolableFacts）】`,
    inviolableFactsStr,
    ``,
    `【待评正文】`,
    text,
    ``,
    `请评分（0-100），输出严格 JSON。`,
  ].join("\n");

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  // loadEnv 后读取环境变量
  if (!process.env.NOVELOS_JUDGE_API_KEY || !process.env.NOVELOS_JUDGE_BASE_URL) {
    console.error("loadEnv 后仍缺少 NOVELOS_JUDGE_* 环境变量");
    process.exit(1);
  }

  const displayModel = process.env.NOVELOS_JUDGE_MODEL || JUDGE_MODEL;
  console.log("=== gpt-5.6-sol 盲测评分 ===");
  console.log(`模型: ${displayModel}`);
  console.log(`端点: ${process.env.NOVELOS_JUDGE_BASE_URL}`);
  console.log(`时间: ${new Date().toISOString()}`);
  console.log("");

  // 读取数据
  const casesData = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8"));
  const blindPack = JSON.parse(fs.readFileSync(BLIND_PACK_PATH, "utf-8"));

  const caseMap = new Map(casesData.cases.map((c) => [c.caseId, c]));

  // 加载已有结果（支持断点续跑）
  let existingResults = {};
  if (fs.existsSync(SCORES_OUTPUT)) {
    try {
      existingResults = JSON.parse(fs.readFileSync(SCORES_OUTPUT, "utf-8"));
      console.log(
        `📂 已有 ${Object.keys(existingResults).length} 个评分结果，将跳过已完成的\n`,
      );
    } catch {
      existingResults = {};
    }
  }

  const results = { ...existingResults };

  // 逐个评分
  for (const entry of blindPack.entries) {
    const { anonymousId, caseId, text } = entry;

    if (results[anonymousId]) {
      console.log(`✓ 跳过已完成：${anonymousId}`);
      continue;
    }

    const caseData = caseMap.get(caseId);
    if (!caseData) {
      console.error(`❌ 找不到 case: ${caseId}`);
      continue;
    }

    console.log(`\n📝 评分：${anonymousId}（case=${caseId}, arm=${blindPack.mapping[anonymousId].arm}）`);

    const prompts = buildScoringPrompts(caseData, text);

    try {
      const rawOutput = await callJudge(prompts.system, prompts.user);
      const score = parseScore(rawOutput);

      if (!score || score.total === null) {
        console.error(`  ❌ 评分解析失败`);
        console.error(`  原始输出: ${rawOutput.slice(0, 300)}`);
        results[anonymousId] = {
          caseId,
          arm: blindPack.mapping[anonymousId].arm,
          rawOutput: rawOutput.slice(0, 1000),
          error: "parse_failed",
          timestamp: new Date().toISOString(),
        };
      } else {
        console.log(
          `  ✓ total=${score.total} naturalness=${score.naturalness} completeness=${score.completeness} accuracy=${score.accuracy}`,
        );
        results[anonymousId] = {
          caseId,
          arm: blindPack.mapping[anonymousId].arm,
          naturalness: score.naturalness,
          completeness: score.completeness,
          accuracy: score.accuracy,
          total: score.total,
          reason: score.reason,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (e) {
      console.error(`  ❌ 评分失败：${e.message}`);
      results[anonymousId] = {
        caseId,
        arm: blindPack.mapping[anonymousId].arm,
        error: e.message,
        timestamp: new Date().toISOString(),
      };
    }

    // 保存中间结果
    fs.writeFileSync(SCORES_OUTPUT, JSON.stringify(results, null, 2), "utf-8");

    // 间隔 2 秒避免 rate limit
    await sleep(2000);
  }

  console.log("\n=== 评分完成，生成对比报告 ===\n");
  generateReport(results, blindPack);
  console.log(`报告已保存: ${REPORT_OUTPUT}`);
}

/** 生成对比报告 */
function generateReport(results, blindPack) {
  const lines = [];
  lines.push("# gpt-5.6-sol 评分 vs 人工评审 对比报告");
  lines.push("");
  lines.push(`**生成时间**: ${new Date().toISOString()}`);
  lines.push(`**模型**: ${process.env.NOVELOS_JUDGE_MODEL || JUDGE_MODEL}（NOVELOS_JUDGE 路由）`);
  lines.push(`**盲测数据**: reports/uncertainty-ablation-r2/seed-1/blind-pack.json`);
  lines.push("");
  lines.push("## 评分维度说明");
  lines.push("");
  lines.push("- **naturalness**（自然度）：中文表达是否自然、无 AI 腔/翻译腔");
  lines.push("- **completeness**（叙事完成度）：情节是否完整、是否与 mustVerify 呼应");
  lines.push("- **accuracy**（事实准确性）：是否有事实硬伤、与 prefix/inviolableFacts 矛盾");
  lines.push("- **total**（总分）：综合文学质量，0-100");
  lines.push("- **人工评分**：用户满分 100 制评分");
  lines.push("");

  // 对比表
  lines.push("## 评分汇总");
  lines.push("");
  lines.push("| anonymousId | caseId | arm | 人工 | gpt56 total | gpt56 naturalness | gpt56 completeness | gpt56 accuracy | 差值(gpt56-人工) |");
  lines.push("|-------------|--------|-----|------|-------------|-------------------|-------------------|----------------|------------------|");

  const caseOrder = [
    "X-high-xuanhuan-1",
    "Y-high-xuanhuan-1",
    "X-high-suspense-1",
    "Y-high-suspense-1",
    "X-real-xuanhuan-1",
    "Y-real-xuanhuan-1",
    "X-real-suspense-1",
    "Y-real-suspense-1",
    "X-real-urban-1",
    "Y-real-urban-1",
    "X-real-xianxia-1",
    "Y-real-xianxia-1",
    "X-real-scifi-1",
    "Y-real-scifi-1",
  ];

  const diffs = [];
  for (const id of caseOrder) {
    const r = results[id];
    const human = HUMAN_SCORES[id];
    if (!r) {
      lines.push(`| ${id} | - | - | ${human ?? "-"} | - | - | - | - | - |`);
      continue;
    }
    const arm = r.arm ?? blindPack.mapping[id]?.arm ?? "?";
    if (r.error) {
      lines.push(`| ${id} | ${r.caseId} | ${arm} | ${human} | ERROR | - | - | - | - |`);
      continue;
    }
    const diff = r.total - human;
    diffs.push({ id, caseId: r.caseId, arm, human, gpt56: r.total, diff });
    lines.push(
      `| ${id} | ${r.caseId} | ${arm} | ${human} | ${r.total} | ${r.naturalness} | ${r.completeness} | ${r.accuracy} | ${diff >= 0 ? "+" : ""}${diff} |`,
    );
  }
  lines.push("");

  // 按 case 对比
  lines.push("## 按 case 对比（X vs Y）");
  lines.push("");
  lines.push("| caseId | 人工 X | 人工 Y | 人工更优 | gpt56 X | gpt56 Y | gpt56 更优 | 一致? |");
  lines.push("|--------|--------|--------|----------|---------|---------|------------|-------|");

  const caseIds = [
    "high-xuanhuan-1",
    "high-suspense-1",
    "real-xuanhuan-1",
    "real-suspense-1",
    "real-urban-1",
    "real-xianxia-1",
    "real-scifi-1",
  ];

  let humanWinsB = 0;
  let gpt56WinsB = 0;
  let consistentCount = 0;
  let totalCases = 0;

  for (const caseId of caseIds) {
    const xId = `X-${caseId}`;
    const yId = `Y-${caseId}`;
    const xRes = results[xId];
    const yRes = results[yId];
    const xHuman = HUMAN_SCORES[xId];
    const yHuman = HUMAN_SCORES[yId];

    // 解析 arm
    const xArm = blindPack.mapping[xId]?.arm ?? "?";
    const yArm = blindPack.mapping[yId]?.arm ?? "?";

    const xGpt = xRes?.total;
    const yGpt = yRes?.total;

    const humanBetter = xHuman > yHuman ? "X" : yHuman > xHuman ? "Y" : "平";
    const gptBetter =
      xGpt != null && yGpt != null
        ? xGpt > yGpt
          ? "X"
          : yGpt > xGpt
            ? "Y"
            : "平"
        : "?";

    const consistent = humanBetter === gptBetter ? "✓" : "✗";

    // B 组胜率统计
    if (humanBetter === "X" && xArm === "B") humanWinsB++;
    if (humanBetter === "Y" && yArm === "B") humanWinsB++;
    if (gptBetter === "X" && xArm === "B") gpt56WinsB++;
    if (gptBetter === "Y" && yArm === "B") gpt56WinsB++;

    if (humanBetter === gptBetter) consistentCount++;
    totalCases++;

    lines.push(
      `| ${caseId} | ${xHuman} | ${yHuman} | ${humanBetter} | ${xGpt ?? "ERROR"} | ${yGpt ?? "ERROR"} | ${gptBetter} | ${consistent} |`,
    );
  }
  lines.push("");

  // 统计分析
  lines.push("## 统计分析");
  lines.push("");

  if (diffs.length > 0) {
    const allDiffs = diffs.map((d) => d.diff);
    const absDiffs = allDiffs.map(Math.abs);
    const meanDiff = allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length;
    const meanAbsDiff = absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length;
    const maxAbsDiff = Math.max(...absDiffs);
    const minAbsDiff = Math.min(...absDiffs);

    // 相关系数
    const humanScores = diffs.map((d) => d.human);
    const gptScores = diffs.map((d) => d.gpt56);
    const meanH = humanScores.reduce((a, b) => a + b, 0) / humanScores.length;
    const meanG = gptScores.reduce((a, b) => a + b, 0) / gptScores.length;
    let num = 0,
      denH = 0,
      denG = 0;
    for (let i = 0; i < diffs.length; i++) {
      num += (humanScores[i] - meanH) * (gptScores[i] - meanG);
      denH += (humanScores[i] - meanH) ** 2;
      denG += (gptScores[i] - meanG) ** 2;
    }
    const correlation = num / Math.sqrt(denH * denG);

    lines.push(`### 分差统计（gpt56 total - 人工）`);
    lines.push("");
    lines.push(`- **样本数**: ${diffs.length}`);
    lines.push(`- **平均差值**: ${meanDiff >= 0 ? "+" : ""}${meanDiff.toFixed(2)}`);
    lines.push(`- **平均绝对差值**: ${meanAbsDiff.toFixed(2)}`);
    lines.push(`- **最大绝对差值**: ${maxAbsDiff}`);
    lines.push(`- **最小绝对差值**: ${minAbsDiff}`);
    lines.push(`- **皮尔逊相关系数**: ${correlation.toFixed(4)}`);
    lines.push("");

    // 方向一致性
    lines.push(`### X/Y 更优方向一致性`);
    lines.push("");
    lines.push(`- 一致 case 数: ${consistentCount}/${totalCases}`);
    lines.push(`- 一致率: ${((consistentCount / totalCases) * 100).toFixed(1)}%`);
    lines.push("");

    // B 组胜率对比
    lines.push(`### B 组胜率对比`);
    lines.push("");
    lines.push(`- 人工评审 B 组胜率: ${humanWinsB}/${totalCases}（${((humanWinsB / totalCases) * 100).toFixed(1)}%）`);
    lines.push(`- gpt-5.6-sol B 组胜率: ${gpt56WinsB}/${totalCases}（${((gpt56WinsB / totalCases) * 100).toFixed(1)}%）`);
    lines.push("");
  }

  // 各文本详细评价
  lines.push("## 各文本详细评价");
  lines.push("");
  for (const id of caseOrder) {
    const r = results[id];
    if (!r || r.error) continue;
    lines.push(`### ${id}（arm=${r.arm}）`);
    lines.push("");
    lines.push(`- 人工评分: ${HUMAN_SCORES[id]}`);
    lines.push(
      `- gpt-5.6-sol: total=${r.total}, naturalness=${r.naturalness}, completeness=${r.completeness}, accuracy=${r.accuracy}`,
    );
    lines.push(`- 差值: ${r.total - HUMAN_SCORES[id] >= 0 ? "+" : ""}${r.total - HUMAN_SCORES[id]}`);
    if (r.reason) {
      lines.push(`- 评价: ${r.reason}`);
    }
    lines.push("");
  }

  lines.push("## 结论");
  lines.push("");
  lines.push("> 本报告由 gpt-5.6-sol 自动评分生成，仅用于评测对比，不进入生产路径。");
  lines.push("> 文学评价最终裁决权归用户。");

  fs.writeFileSync(REPORT_OUTPUT, lines.join("\n"), "utf-8");
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
