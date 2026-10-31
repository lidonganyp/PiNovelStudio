/**
 * 专家派发器测试（EXPERT-GROUP-R10/R18）
 *
 * 锁定项目内最小派发器的边界与退出：
 * - 派发单解析 fail-closed（缺失 / 非法 JSON / 缺字段）
 * - 任务包按五要素组织，并声明只能使用专家已声明工具
 * - 未知角色、越权路径、越权工具、预算耗尽、取消都有明确状态
 * - director → 单专家 handoff 拒绝自我派发与未知专家
 *
 * 依赖边界：只依赖 dist-test；executor 为注入的 stub，不调用任何模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExpertRegistry } from "../dist-test/novelos/experts/expert-registry.js";
import {
  DEFAULT_EXPERT_BUDGET,
  ExpertDispatcher,
  buildExpertTaskMessage,
  parseDispatchTicket,
} from "../dist-test/novelos/experts/expert-dispatcher.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(TESTS_DIR, "../../../agents");
const SAFE_INPUT = resolve(AGENTS_DIR, "novel-director/knowledge/director-playbook.md");

function okExecutor(output = "## 结论\n提案如下") {
  return () => ({ status: "ok", output });
}

function makeDispatcher(executor, budget) {
  const registry = loadExpertRegistry(AGENTS_DIR);
  assert.equal(registry.ok, true);
  return new ExpertDispatcher({ registry, executor, agentsDir: AGENTS_DIR, budget });
}

test("派发单解析：缺失 / 非 JSON / 缺字段都返回错误码", () => {
  assert.equal(parseDispatchTicket("没有代码块").error, "dispatch_ticket_missing");
  assert.equal(parseDispatchTicket("```json\n{不是json}\n```").error, "dispatch_ticket_not_json");
  assert.equal(parseDispatchTicket("```json\n\"text\"\n```").error, "dispatch_ticket_not_object");
  assert.equal(parseDispatchTicket("```json\n{\"expert\":\"x\"}\n```").error, "dispatch_ticket_missing_fields");

  const parsed = parseDispatchTicket(
    "```json\n{\"expert\":\"world-builder\",\"objective\":\"补术语表\",\"inputPaths\":[\"a.md\"],\"expect\":\"提案\"}\n```",
  );
  assert.equal(parsed.error, null);
  assert.equal(parsed.ticket.expert, "world-builder");
  assert.deepEqual(parsed.ticket.inputPaths, ["a.md"]);
});

test("任务包：五要素齐全，且声明工具白名单与 pending_parent_action", () => {
  const registry = loadExpertRegistry(AGENTS_DIR);
  const expert = registry.require("world-builder");
  const message = buildExpertTaskMessage(expert, { role: expert.name, objective: "补齐术语表" }, { maxOutputChars: 4000 });
  for (const heading of ["## 【角色】", "## 【指令】", "## 【约束】", "## 【示例】", "## 【输出格式】"]) {
    assert.ok(message.includes(heading), `任务包缺少 ${heading}`);
  }
  assert.ok(message.includes("read、grep、find"));
  assert.ok(message.includes("pending_parent_action"));
  assert.ok(message.includes("4000"));
});

test("正常派发：返回 ok 并留存记录；越权工具调用判 denied", async () => {
  const dispatcher = makeDispatcher(okExecutor());
  const record = await dispatcher.dispatch({ role: "world-builder", objective: "补术语表", inputPaths: [SAFE_INPUT] });
  assert.equal(record.status, "ok");
  assert.ok(record.output);
  assert.equal(record.toolCalls.length, 0);
  assert.deepEqual(record.toolCallDecisions, []);

  // 未调用守卫就上报执行：先按注册表得出具体违规原因。
  const denied = makeDispatcher(() => ({ status: "ok", output: "x", toolCalls: [{ tool: "write", ok: true }] }));
  const record2 = await denied.dispatch({ role: "world-builder", objective: "写文件" });
  assert.equal(record2.status, "denied");
  assert.equal(record2.error.code, "tool_not_declared");

  // 已声明工具但绕过守卫直接上报执行：tool_call_not_preeuthorized。
  const bypassed = makeDispatcher(() => ({ status: "ok", output: "x", toolCalls: [{ tool: "read", ok: true }] }));
  const record3 = await bypassed.dispatch({ role: "world-builder", objective: "读文件" });
  assert.equal(record3.status, "denied");
  assert.equal(record3.error.code, "tool_call_not_preeuthorized");
});

test("执行前授权守卫：被拒绝的 action 不触发 handler，授权后正常执行", async () => {
  let deniedHandlerCalls = 0;
  const denied = makeDispatcher((request) => {
    // 专家试图调用写盘工具：必须在执行前被守卫拦截，handler 不得被调用。
    const attempt = request.authorizeToolCall({ tool: "novel_plan_story_outline" });
    if (!attempt.ok) {
      return { status: "pending_parent_action", output: "需要父代理落盘", pendingActions: ["novel_plan_story_outline"] };
    }
    deniedHandlerCalls += 1;
    return { status: "ok", output: "不应到达" };
  });
  const deniedRecord = await denied.dispatch({ role: "novel-director", objective: "落盘大纲" });
  assert.equal(deniedHandlerCalls, 0, "被拒绝的 action 不得触发 handler");
  assert.equal(deniedRecord.status, "denied");
  assert.equal(deniedRecord.error.code, "tool_not_declared");
  assert.equal(deniedRecord.toolCallDecisions.length, 1);
  assert.equal(deniedRecord.toolCallDecisions[0].ok, false);

  // action 级拦截：写状态的 action 在执行前即被拒绝。
  const actionDenied = makeDispatcher((request) => {
    const attempt = request.authorizeToolCall({ tool: "novel_workspace_manager", action: "init" });
    if (!attempt.ok) return { status: "pending_parent_action", output: "需要父代理初始化工作区" };
    return { status: "ok", output: "不应到达" };
  });
  const actionRecord = await actionDenied.dispatch({ role: "novel-director", objective: "初始化工作区" });
  assert.equal(actionRecord.status, "denied");
  assert.equal(actionRecord.error.code, "tool_action_not_allowed");

  // 授权通过的只读调用可以执行，且上报调用命中预授权。
  let permittedHandlerCalls = 0;
  const permitted = makeDispatcher((request) => {
    const attempt = request.authorizeToolCall({ tool: "read" });
    if (!attempt.ok) return { status: "denied", output: "" };
    permittedHandlerCalls += 1;
    return { status: "ok", output: "已读取", toolCalls: [{ tool: "read", ok: true }] };
  });
  const permittedRecord = await permitted.dispatch({ role: "world-builder", objective: "读资料" });
  assert.equal(permittedHandlerCalls, 1);
  assert.equal(permittedRecord.status, "ok");
  assert.equal(permittedRecord.toolCallDecisions[0].ok, true);
});

test("fail-closed：未知角色 / 越权路径 / 生成入口全部阻断", async () => {
  const dispatcher = makeDispatcher(okExecutor());

  const unknown = await dispatcher.dispatch({ role: "no-such-expert", objective: "x" });
  assert.equal(unknown.status, "error");
  assert.equal(unknown.error.code, "unknown_expert");

  const envPath = await dispatcher.dispatch({ role: "world-builder", objective: "x", inputPaths: [resolve(AGENTS_DIR, "../.env")] });
  assert.equal(envPath.status, "denied");
  assert.equal(envPath.error.code, "path_env_denied");

  assert.equal(loadExpertRegistry(AGENTS_DIR).require("novel-director").tools.includes("novel_generate_chapter"), false);
});

test("预算与取消：调用次数上限、取消后不再执行", async () => {
  let calls = 0;
  const dispatcher = makeDispatcher(() => {
    calls += 1;
    return { status: "ok", output: "ok" };
  }, { maxExpertCalls: 1 });

  const first = await dispatcher.dispatch({ role: "world-builder", objective: "1" });
  assert.equal(first.status, "ok");
  const second = await dispatcher.dispatch({ role: "world-builder", objective: "2" });
  assert.equal(second.status, "budget_exhausted");
  assert.equal(second.error.code, "max_expert_calls");
  assert.equal(calls, 1);

  const cancelled = makeDispatcher(() => {
    throw new Error("不应被调用");
  });
  cancelled.cancel("parent_cancelled");
  const record = await cancelled.dispatch({ role: "world-builder", objective: "x" });
  assert.equal(record.status, "cancelled");
});

test("输出超预算必须显式声明截断，不静默丢弃", async () => {
  const long = "字".repeat(DEFAULT_EXPERT_BUDGET.maxOutputChars + 100);
  const dispatcher = makeDispatcher(() => ({ status: "ok", output: long }));
  const record = await dispatcher.dispatch({ role: "world-builder", objective: "x" });
  assert.equal(record.status, "ok");
  assert.ok(record.omitted.some((item) => item.reason === "output_budget_truncated"));
  assert.ok(record.output.includes("[truncated:"));
});

test("director handoff：正常派单、自我派发与未知专家拒绝", async () => {
  const registry = loadExpertRegistry(AGENTS_DIR);
  const withTicket = (expert) =>
    new ExpertDispatcher({
      registry,
      agentsDir: AGENTS_DIR,
      executor: () => ({
        status: "ok",
        output: `\`\`\`json\n{"expert":"${expert}","objective":"补术语表","inputPaths":[]}\n\`\`\``,
      }),
    });

  const first = await withTicket("world-builder").runDirectorHandoff({ objective: "组织写前准备" });
  assert.deepEqual(first.errors, []);
  assert.equal(first.ticket.expert, "world-builder");
  assert.equal(first.expert.status, "ok");

  const self = await withTicket("novel-director").runDirectorHandoff({ objective: "组织写前准备" });
  assert.deepEqual(self.errors, ["dispatch_ticket_self_dispatch"]);
  assert.equal(self.expert, null);

  const unknown = await withTicket("no-such-expert").runDirectorHandoff({ objective: "组织写前准备" });
  assert.deepEqual(unknown.errors, ["dispatch_ticket_unknown_expert"]);
  assert.equal(unknown.expert, null);
});
