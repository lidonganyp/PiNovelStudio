/**
 * Phase 4 P1-3 生产探针：自然语言反馈编译 + 自动记录策略信誉
 *
 * 验证 P1-3 修复（Phase 4 学习闭环 — 自然语言反馈编译）：
 *
 * 1. NaturalLanguageFeedbackCompiler 关键词映射：
 *    - guidance_reduction 正向（"太啰嗦/指导太多" → positive → choice）
 *    - guidance_reduction 负向（"太短/细节太少" → negative → edit）
 *    - voice_emphasis 正向（"角色不像/语气不对" → positive → choice）
 *    - rhythm_adjustment 正向（"节奏太平/太机械" → positive → choice）
 * 2. 通用情感归因到 selectedStrategyIds[0]
 * 3. 无法映射的反馈 → strategyId=null, neutral, 不记录 outcome
 * 4. 空反馈 → neutral
 * 5. extractSelectedStrategyIds 从 stageResults 读取选中策略
 * 6. handleStrategyFeedback 自然语言路径：
 *    - 提供 naturalLanguageFeedback + modelVersion，省略 action/strategyId
 *    - 编译器推断 strategyId + action，自动记录 outcome
 *    - 返回 compiledFeedback 供审计
 * 7. 无法映射的自然语言反馈 → recorded:false
 * 8. 显式 action 路径仍向后兼容
 *
 * 用户反馈（P1-3）：
 * "反馈接口要求调用方手填一个 strategyId；自然语言反馈编译仍是 TODO"
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compileNaturalLanguageFeedback,
  extractSelectedStrategyIds,
} from "../dist/v2/learning/natural-language-feedback-compiler.js";
import { handleStrategyFeedback } from "../dist/handlers/public-handlers.js";

// ============================================================================
// 辅助函数
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p1-3-nlfb-"));
  const workspaceId = "ws-p1-3-nlfb";
  return { dir, workspaceId };
}

function readStrategyPolicy(dir, workspaceId) {
  const path = join(dir, "workspaces", workspaceId, "strategy-policy.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ============================================================================
// 1. 编译器关键词映射
// ============================================================================

describe("P1-3 编译器：关键词特定映射", () => {
  it("guidance_reduction 正向：'太啰嗦了，指导太多' → positive → choice", () => {
    const result = compileNaturalLanguageFeedback("太啰嗦了，指导太多，风格指导过重");
    assert.equal(result.strategyId, "guidance_reduction");
    assert.equal(result.sentiment, "positive");
    assert.equal(result.inferredAction, "choice");
    assert.equal(result.inferredRating, 5);
    assert.ok(result.matchedKeywords.length >= 1);
    assert.ok(result.reason.includes("关键词匹配"));
  });

  it("guidance_reduction 负向：'太短了，细节太少' → negative → edit", () => {
    const result = compileNaturalLanguageFeedback("太短了，细节太少，内容不够丰富");
    assert.equal(result.strategyId, "guidance_reduction");
    assert.equal(result.sentiment, "negative");
    assert.equal(result.inferredAction, "edit");
    assert.equal(result.inferredRating, 1);
  });

  it("voice_emphasis 正向：'角色不像，语气不对' → positive → choice", () => {
    const result = compileNaturalLanguageFeedback("角色不像，语气不对，对白分不清");
    assert.equal(result.strategyId, "voice_emphasis");
    assert.equal(result.sentiment, "positive");
    assert.equal(result.inferredAction, "choice");
  });

  it("rhythm_adjustment 正向：'节奏太平，太机械' → positive → choice", () => {
    const result = compileNaturalLanguageFeedback("节奏太平，段落太均匀，太机械");
    assert.equal(result.strategyId, "rhythm_adjustment");
    assert.equal(result.sentiment, "positive");
    assert.equal(result.inferredAction, "choice");
  });
});

// ============================================================================
// 2. 通用情感归因
// ============================================================================

describe("P1-3 编译器：通用情感归因到 selectedStrategyIds", () => {
  it("正向通用情感 '不错，很满意' 归因到 selectedStrategyIds[0]", () => {
    const result = compileNaturalLanguageFeedback("不错，很满意", ["voice_emphasis"]);
    assert.equal(result.strategyId, "voice_emphasis");
    assert.equal(result.sentiment, "positive");
    assert.equal(result.inferredAction, "choice");
    assert.ok(result.reason.includes("通用正向情感"));
  });

  it("负向通用情感 '不好，差' 归因到 selectedStrategyIds[0]", () => {
    const result = compileNaturalLanguageFeedback("不好，太差了", ["rhythm_adjustment"]);
    assert.equal(result.strategyId, "rhythm_adjustment");
    assert.equal(result.sentiment, "negative");
    assert.equal(result.inferredAction, "edit");
  });

  it("通用情感无 selectedStrategyIds 时 strategyId=null", () => {
    const result = compileNaturalLanguageFeedback("不错", []);
    assert.equal(result.strategyId, null);
    assert.equal(result.sentiment, "positive");
  });
});

// ============================================================================
// 3. 无法映射的反馈
// ============================================================================

describe("P1-3 编译器：无法映射的反馈", () => {
  it("'我觉得还可以吧' → strategyId=null, neutral", () => {
    const result = compileNaturalLanguageFeedback("我觉得还可以吧");
    assert.equal(result.strategyId, null);
    assert.equal(result.sentiment, "neutral");
    assert.equal(result.inferredAction, "rating");
    assert.equal(result.inferredRating, 3);
    assert.ok(result.reason.includes("无法匹配"));
  });
});

// ============================================================================
// 4. 空反馈
// ============================================================================

describe("P1-3 编译器：空反馈", () => {
  it("空字符串 → neutral, strategyId=null", () => {
    const result = compileNaturalLanguageFeedback("");
    assert.equal(result.strategyId, null);
    assert.equal(result.sentiment, "neutral");
    assert.ok(result.reason.includes("空反馈"));
  });

  it("纯空白字符串 → neutral, strategyId=null", () => {
    const result = compileNaturalLanguageFeedback("   ");
    assert.equal(result.strategyId, null);
    assert.equal(result.sentiment, "neutral");
  });
});

// ============================================================================
// 5. extractSelectedStrategyIds
// ============================================================================

describe("P1-3 extractSelectedStrategyIds", () => {
  it("从 authorStyleStrategySelection.selectedStrategyIds 读取", () => {
    const stageResults = {
      authorStyleStrategySelection: {
        selectedStrategyIds: ["guidance_reduction", "voice_emphasis"],
      },
    };
    const ids = extractSelectedStrategyIds(stageResults);
    assert.deepEqual(ids, ["guidance_reduction", "voice_emphasis"]);
  });

  it("authorStyleStrategySelection 为空时回退到 strategySelection.sampled", () => {
    const stageResults = {
      strategySelection: {
        sampled: [{ strategyId: "rhythm_adjustment" }, { strategyId: "voice_emphasis" }],
      },
    };
    const ids = extractSelectedStrategyIds(stageResults);
    assert.deepEqual(ids, ["rhythm_adjustment", "voice_emphasis"]);
  });

  it("无策略选择数据时返回空数组", () => {
    const ids = extractSelectedStrategyIds({});
    assert.deepEqual(ids, []);
  });
});

// ============================================================================
// 6. handleStrategyFeedback 自然语言路径（端到端）
// ============================================================================

const COMPLETE_LINEAGE = {
  orchestratorRunId: "run-nl-1",
  candidateId: "cand-nl-1",
  strategyBundleId: "bundle:guidance_reduction",
  exposureId: "exp-nl-1",
  promptBundleId: "prompt:author_style:default",
};

describe("P1-3 handler：自然语言反馈自动记录 outcome", () => {
  it("提供 naturalLanguageFeedback + 完整血缘 自动记录 choice outcome 并写 ledger", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        modelVersion: "gemini-3.1-pro",
        naturalLanguageFeedback: "太啰嗦了，指导太多",
        sourceChapter: "ch17",
        ...COMPLETE_LINEAGE,
        strategyBundleId: "bundle:guidance_reduction",
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.naturalLanguageFeedbackAccepted, true);
      assert.ok(result.compiledFeedback, "应返回 compiledFeedback 供审计");
      assert.equal(result.compiledFeedback.strategyId, "guidance_reduction");
      assert.equal(result.compiledFeedback.sentiment, "positive");
      assert.equal(result.action, "choice");
      assert.equal(result.strategyId, "guidance_reduction");
      assert.ok(result.result?.recorded, "应记录 outcome");
      assert.equal(result.lineageAudit?.complete, true);
      assert.ok((result.lineageAudit?.ledgerAppended ?? 0) >= 1);

      // 验证策略信誉库已写入
      const store = readStrategyPolicy(dir, workspaceId);
      assert.ok(store, "strategy-policy.json 应已落盘");
      const partition = store.partitions?.["gemini-3.1-pro"];
      assert.ok(partition, "应有 gemini-3.1-pro 分区");
      const rep = partition?.["guidance_reduction"];
      assert.ok(rep, "应有 guidance_reduction 信誉记录");
      assert.ok(rep.sampleCount >= 1, "sampleCount 应 >= 1");
      assert.ok(rep.evidence?.length >= 1, "应有 evidence");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺完整血缘的自然语言反馈不得污染策略信誉", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        modelVersion: "gemini-3.1-pro",
        naturalLanguageFeedback: "角色不像，语气不对",
        sourceChapter: "ch18",
        _projectRoot: dir,
      });

      assert.equal(result.compiledFeedback.strategyId, "voice_emphasis");
      assert.equal(result.action, "choice");
      assert.equal(result.result?.recorded, false);
      assert.equal(result.lineageAudit?.complete, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("完整血缘 + 负向 guidance_reduction 自动记录 edit outcome（loss）", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        modelVersion: "gemini-3.1-pro",
        naturalLanguageFeedback: "太短了，细节太少",
        sourceChapter: "ch19",
        ...COMPLETE_LINEAGE,
        strategyBundleId: "bundle:guidance_reduction",
        _projectRoot: dir,
      });

      assert.equal(result.compiledFeedback.strategyId, "guidance_reduction");
      assert.equal(result.compiledFeedback.sentiment, "negative");
      assert.equal(result.action, "edit");
      assert.ok(result.result?.recorded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 7. 无法映射的自然语言反馈 → recorded:false
// ============================================================================

describe("P1-3 handler：无法映射的自然语言反馈不记录 outcome", () => {
  it("'我觉得还可以吧' → recorded:false, strategyId=null", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        modelVersion: "gemini-3.1-pro",
        naturalLanguageFeedback: "我觉得还可以吧",
        sourceChapter: "ch20",
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.naturalLanguageFeedbackAccepted, true);
      assert.equal(result.compiledFeedback.strategyId, null);
      assert.equal(result.compiledFeedback.sentiment, "neutral");
      assert.equal(result.result?.recorded, false);
      assert.ok(result.result?.reason, "应返回不记录原因");

      // 策略信誉库不应有 evidence（无法映射时不记录）
      const store = readStrategyPolicy(dir, workspaceId);
      if (store?.partitions?.["gemini-3.1-pro"]) {
        const reps = store.partitions["gemini-3.1-pro"];
        for (const [, rep] of Object.entries(reps)) {
          assert.equal(rep.evidence?.length ?? 0, 0, "不应有 evidence");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 8. 显式 action 路径向后兼容
// ============================================================================

describe("P1-3 handler：显式 action 路径向后兼容", () => {
  it("显式 action=choice + strategyId + 完整血缘 仍正常工作", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        action: "choice",
        strategyId: "voice_emphasis",
        modelVersion: "gemini-3.1-pro",
        sourceChapter: "ch21",
        chosen: "editorial",
        opportunityType: "author_style",
        orchestratorRunId: "run-explicit-21",
        candidateId: "cand-explicit-21",
        strategyBundleId: "bundle:voice_emphasis",
        exposureId: "exp-explicit-21",
        promptBundleId: "prompt:author_style:default",
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.action, "choice");
      assert.equal(result.strategyId, "voice_emphasis");
      assert.ok(result.result?.recorded);
      assert.equal(result.lineageAudit?.complete, true);
      // 未提供 naturalLanguageFeedback → compiledFeedback 不存在
      assert.equal(result.compiledFeedback, undefined);
      assert.equal(result.naturalLanguageFeedbackAccepted, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("显式 action 缺 strategyId → 抛错（防御性校验）", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      await assert.rejects(
        () =>
          handleStrategyFeedback({
            workspaceId,
            action: "choice",
            modelVersion: "gemini-3.1-pro",
            chosen: "editorial",
            sourceChapter: "ch22",
            _projectRoot: dir,
          }),
        /需要 strategyId/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
