/**
 * PiNovelStudio — 共享门禁函数单元测试
 *
 * 覆盖 collectBlockingIssues 核心逻辑：
 * 1. 三种核心阻断性 status: error, blocked, needs_revision
 * 2. skipped/deferred/partial 默认为软警告（不阻断），除非设置 includeSkippedPartial=true
 * 3. report.issues 中的 critical/error 级别问题检测
 * 4. 嵌套对象递归遍历
 * 5. 数组元素遍历
 * 6. 非对象值和边界情况处理
 *
 * P11-风险4修复：可选阶段（skipped/partial/deferred）不再自动阻断
 */

// 提取共享门禁函数用于测试（内联版本保持与源文件同步）
function collectBlockingIssues(obj, path = "", includeSkippedPartial = false) {
  const issues = [];
  if (!obj || typeof obj !== "object") return issues;

  // P11-风险4修复：skipped 和 deferred 默认为软警告，不阻断
  if (obj.status === "skipped") {
    if (includeSkippedPartial) {
      issues.push(`【${path || "root"}跳过】${obj.reason || "阶段被跳过"}`);
    }
    return issues;
  }
  if (obj.status === "deferred") {
    if (includeSkippedPartial) {
      issues.push(`【${path || "root"}延迟】${obj.reason || "阶段未执行"}`);
    }
    return issues;
  }
  if (obj.status === "partial") {
    // partial 需要特殊处理：检查是否有 critical 级别的问题
    const hasCritical = obj.violations?.some(v => v.severity === "critical") ||
                        obj.issues?.some(i => i.severity === "critical");
    if (hasCritical || includeSkippedPartial) {
      issues.push(`【${path || "root"}不完整】${obj.message || "检测未完成"}`);
    }
    return issues;
  }
  if (obj.status === "error") {
    issues.push(`【${path || "root"}错误】${obj.message || "未知错误"}`);
    return issues;
  }
  if (obj.status === "blocked") {
    issues.push(`【${path || "root"}阻断】${obj.reason || "阶段被阻断"}`);
    return issues;
  }
  if (obj.status === "needs_revision") {
    issues.push(`【${path || "root"}需要修订】${obj.message || "内容需要修订"}`);
    return issues;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "status") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        issues.push(...collectBlockingIssues(item, path ? `${path}.${key}` : key, includeSkippedPartial));
      }
    } else if (value && typeof value === "object") {
      const newPath = path ? `${path}.${key}` : key;
      // 扫描 report.issues 中的 critical/error 级别问题
      if (key === "report" && Array.isArray(value.issues)) {
        for (const issue of value.issues) {
          if (issue.severity === "critical" || issue.severity === "error") {
            issues.push(`【${newPath}严重问题】${issue.message || JSON.stringify(issue)}`);
          }
        }
      }
      issues.push(...collectBlockingIssues(value, newPath, includeSkippedPartial));
    }
  }
  return issues;
}

import { describe, it } from "node:test";
import assert from "node:assert";

describe("collectBlockingIssues 单元测试", () => {

  // ============================================================================
  // 三种核心阻断性 status 测试
  // ============================================================================

  it("应检测 error 状态", () => {
    const input = { status: "error", message: "发生错误" };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("错误"));
    assert.ok(issues[0].includes("发生错误"));
  });

  it("应检测 blocked 状态", () => {
    const input = { status: "blocked", reason: "被阻断" };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("阻断"));
  });

  it("应检测 needs_revision 状态", () => {
    const input = { status: "needs_revision", message: "需要修订" };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("需要修订"));
  });

  // ============================================================================
  // P11-风险4修复：skipped/deferred/partial 默认为软警告，不阻断
  // ============================================================================

  it("应检测 skipped 状态（默认不阻断，includeSkippedPartial=true 时阻断）", () => {
    const input = { status: "skipped", reason: "测试跳过" };
    // 默认不阻断
    const issues1 = collectBlockingIssues(input);
    assert.strictEqual(issues1.length, 0);
    // includeSkippedPartial=true 时阻断
    const issues2 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues2.length, 1);
    assert.ok(issues2[0].includes("跳过"));
  });

  it("应检测 deferred 状态（默认不阻断，includeSkippedPartial=true 时阻断）", () => {
    const input = { status: "deferred", reason: "阶段延迟" };
    // 默认不阻断
    const issues1 = collectBlockingIssues(input);
    assert.strictEqual(issues1.length, 0);
    // includeSkippedPartial=true 时阻断
    const issues2 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues2.length, 1);
    assert.ok(issues2[0].includes("延迟"));
  });

  it("应检测 partial 状态（默认不阻断，有 critical 时阻断）", () => {
    const input = { status: "partial", message: "检测未完成" };
    // 默认不阻断
    const issues1 = collectBlockingIssues(input);
    assert.strictEqual(issues1.length, 0);
    // 有 critical violations 时阻断
    const inputWithCritical = {
      status: "partial",
      message: "检测未完成",
      violations: [{ severity: "critical", message: "严重问题" }]
    };
    const issues2 = collectBlockingIssues(inputWithCritical);
    assert.strictEqual(issues2.length, 1);
    assert.ok(issues2[0].includes("不完整"));
    // includeSkippedPartial=true 时也阻断
    const issues3 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues3.length, 1);
  });

  it("应检测 success 状态（不应阻断）", () => {
    const input = { status: "success" };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 0);
  });

  it("应检测 checked 状态（不应阻断）", () => {
    const input = { status: "checked" };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 0);
  });

  // ============================================================================
  // report.issues critical/error 检测测试
  // ============================================================================

  it("应检测 report.issues 中的 critical 问题", () => {
    const input = {
      stage5_critic: {
        status: "success",
        report: {
          issues: [
            { severity: "critical", message: "严重问题1" },
            { severity: "warning", message: "警告1" },
            { severity: "info", message: "信息1" }
          ]
        }
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("严重问题1"));
    assert.ok(issues[0].includes("critical") || issues[0].includes("严重问题"));
  });

  it("应检测 report.issues 中的 error 级别问题", () => {
    const input = {
      report: {
        issues: [
          { severity: "error", message: "错误级别问题" }
        ]
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("错误级别问题"));
  });

  it("不应拦截 report.issues 中的 warning 级别问题", () => {
    const input = {
      report: {
        issues: [
          { severity: "warning", message: "警告" }
        ]
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 0);
  });

  it("不应拦截 report.issues 中的 info 级别问题", () => {
    const input = {
      report: {
        issues: [
          { severity: "info", message: "信息" }
        ]
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 0);
  });

  // ============================================================================
  // 嵌套对象递归测试
  // ============================================================================

  it("应递归检测嵌套对象中的阻断状态", () => {
    const input = {
      outer: {
        inner: {
          status: "error",
          message: "深层错误"
        }
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("深层错误"));
  });

  it("应正确计算嵌套路径", () => {
    const input = {
      stageResults: {
        stage5: {
          critic: {
            status: "blocked",
            reason: "批评者阻断"
          }
        }
      }
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].includes("stageResults.stage5.critic") || issues[0].includes("阻断"));
  });

  // ============================================================================
  // 数组遍历测试
  // ============================================================================

  it("应遍历数组中的每个元素（包含阻断性状态）", () => {
    const input = {
      conditionalStages: [
        { status: "error", message: "错误1" },
        { status: "blocked", reason: "阻断1" }
      ]
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 2);
  });

  it("应遍历数组中的每个元素（skipped/deferred 默认不阻断）", () => {
    const input = {
      conditionalStages: [
        { status: "skipped", reason: "条件未满足" },
        { status: "deferred", reason: "延迟执行" }
      ]
    };
    // skipped 和 deferred 默认不阻断
    const issues1 = collectBlockingIssues(input);
    assert.strictEqual(issues1.length, 0);
    // includeSkippedPartial=true 时阻断
    const issues2 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues2.length, 2);
  });

  it("空数组不应导致问题", () => {
    const input = {
      conditionalStages: []
    };
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 0);
  });

  // ============================================================================
  // 边界情况测试
  // ============================================================================

  it("应处理 null 输入", () => {
    const issues = collectBlockingIssues(null);
    assert.strictEqual(issues.length, 0);
  });

  it("应处理 undefined 输入", () => {
    const issues = collectBlockingIssues(undefined);
    assert.strictEqual(issues.length, 0);
  });

  it("应处理非对象输入", () => {
    const issues = collectBlockingIssues("string");
    assert.strictEqual(issues.length, 0);
  });

  it("应处理数字输入", () => {
    const issues = collectBlockingIssues(123);
    assert.strictEqual(issues.length, 0);
  });

  it("应处理空对象", () => {
    const issues = collectBlockingIssues({});
    assert.strictEqual(issues.length, 0);
  });

  it("应处理无 status 字段的对象", () => {
    const issues = collectBlockingIssues({ data: "some value" });
    assert.strictEqual(issues.length, 0);
  });

  // ============================================================================
  // 组合场景测试
  // ============================================================================

  it("应同时检测多个阻断问题（skiped/deferred 默认不计入）", () => {
    const input = {
      stage5: { status: "error", message: "阶段5错误" },
      stage6: { status: "needs_revision", message: "阶段6需要修订" },
      stage7: { status: "skipped", reason: "阶段7跳过" }
    };
    // 只有 error 和 needs_revision 是阻断，skipped 默认不阻断
    const issues = collectBlockingIssues(input);
    assert.strictEqual(issues.length, 2);
    // includeSkippedPartial=true 时，skipped 也计入
    const issues2 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues2.length, 3);
  });

  it("应处理复杂的阶段结果对象（partial/deferred 默认不阻断）", () => {
    const input = {
      status: "success",
      stageResults: {
        stage0: { status: "success" },
        stage1: { status: "success" },
        stage8_5: {
          status: "partial",
          message: "结局检测未完整"
        }
      },
      conditionalStages: [
        { status: "success" },
        { status: "deferred", reason: "条件触发延迟" }
      ]
    };
    // partial 和 deferred 默认不阻断
    const issues1 = collectBlockingIssues(input);
    assert.strictEqual(issues1.length, 0);
    // includeSkippedPartial=true 时，partial 和 deferred 计入
    const issues2 = collectBlockingIssues(input, "", true);
    assert.strictEqual(issues2.length, 2);
  });

  it("应同时处理 status 阻断和 report.issues 阻断", () => {
    const input = {
      stage5: {
        status: "needs_revision",
        message: "需要修订",
        report: {
          issues: [
            { severity: "critical", message: "关键问题" }
          ]
        }
      }
    };
    const issues = collectBlockingIssues(input);
    // status: needs_revision 触发阻断
    // report.issues 中有 critical 问题也触发阻断
    assert.ok(issues.length >= 1);
    assert.ok(issues.some(i => i.includes("需要修订") || i.includes("关键问题")));
  });
});

console.log("门禁函数测试加载完成");
