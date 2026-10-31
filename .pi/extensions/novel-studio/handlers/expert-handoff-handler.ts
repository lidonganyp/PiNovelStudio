/**
 * expert-handoff-handler — 专家群接入生产工具面 + 章节契约正式 handoff
 *
 * 通过已公开的 novel_workspace_manager 暴露三个子操作，不注册第 7 个公开工具
 * （保持 AGENTS.md「6 公开工具」契约与 platform tool-whitelist 不变）：
 *  - action="list_experts"：发现 `.pi/agents/*.md` 专家资产（只读）
 *  - action="dispatch_expert"：校验角色/路径/预算后产出**宿主可执行的专家任务包**
 *    （system prompt + task message + 只读工具白名单），由宿主负责执行；
 *    扩展自身不调用任何模型。
 *  - action="handoff_chapter_contract"：把专家章节契约提案经作者/协调层确认后
 *    写成 `series/ch{N}-outline-explicit.md`（生产唯一消费路径），并落 provenance。
 *
 * 权威边界：
 *  - 专家意见只作提案/参考（EXPERT_AUTHORITY_POLICY），不得直接决定正文。
 *  - dispatch 零写入、零模型调用。
 *  - handoff preview 不签发 commit 凭证；commit 必须回传可信宿主审批层
 *    （`issueChapterContractApproval`）签发的一次性凭证，`confirmedBy` 仅作审计标签。
 *  - commit 的章纲与 provenance 是**可恢复事务**：先写 pending provenance → 写章纲 →
 *    provenance 改 committed；任一步失败回滚章纲、provenance 记 failed、凭证恢复可重试。
 *  - 不伪造 FACT/PROMISE ID：可选 knownFactIds / knownPromiseIds 由调用方提供。
 *  - 缺事件级契约时拒绝生成显式章纲（不编造事件）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildExpertTaskMessage,
  DEFAULT_EXPERT_BUDGET,
  renderExpertSystemPrompt,
  type ExpertTask,
} from "../novelos/experts/expert-dispatcher.js";
import {
  checkExpertReadPath,
  EXPERT_ALLOWED_ACTIONS,
  EXPERT_AUTHORITY_POLICY,
  loadExpertRegistry,
  type ExpertRegistryIssue,
} from "../novelos/experts/expert-registry.js";
import {
  parseExpertChapterContract,
  toExplicitOutlineMarkdown,
  validateExpertChapterContract,
  type ExpertContractValidationResult,
} from "../novelos/experts/chapter-contract-bridge.js";
import { resolveWorkspacePath } from "../utils/fs.js";
import { getProjectRoot } from "../utils/config.js";
import { resolveExplicitOutlineFile, toChapterId } from "../utils/chapter-path.js";
import {
  CHAPTER_CONTRACT_PROVENANCE_SCHEMA_VERSION,
  chapterContractProvenancePath,
  type ChapterContractCommitStatus,
} from "../craft/chapter-contract-provenance.js";

/** 专家角色目录：项目根 `.pi/agents`。 */
export const DEFAULT_AGENTS_DIR = ".pi/agents";

export interface ExpertHandoffInput {
  action: "list_experts" | "dispatch_expert" | "handoff_chapter_contract";
  workspaceId?: string;
  // ── dispatch_expert ──
  expertRole?: string;
  objective?: string;
  inputPaths?: string[];
  constraints?: string[];
  expect?: string;
  /** package（默认，产出宿主任务包）/ execute（生产无授权执行器，fail-closed） */
  executionMode?: "package" | "execute";
  // ── handoff_chapter_contract ──
  /** 专家提案 Markdown（chapter-intent-builder 输出模板） */
  proposalText?: string;
  /** preview（默认，不写盘）/ commit（原子写入显式章纲） */
  handoffMode?: "preview" | "commit";
  chapterNumber?: number;
  /** commit 必填：确认人（作者/协调层标识，仅作审计标签，不构成授权证明） */
  confirmedBy?: string;
  /**
   * commit 必填：可信宿主审批层（`issueChapterContractApproval`）签发的一次性授权凭证，
   * 绑定 workspace/chapter/proposalHash。preview 不签发凭证；任意字符串不构成授权证明。
   */
  approvalReceipt?: string;
  /** commit 必须显式传 true（专家提案不得自动落盘） */
  confirm?: boolean;
  /** commit 且目标文件已存在且内容不同时必填 true */
  overwrite?: boolean;
  knownFactIds?: string[];
  knownPromiseIds?: string[];
  /** 项目根覆盖（测试/批处理入口用；公开 schema 不暴露） */
  _projectRoot?: string;
  /** 专家目录覆盖（测试用；公开 schema 不暴露） */
  _agentsDir?: string;
}

export interface ExpertHandoffResult {
  status: "ok" | "blocked" | "error";
  error?: string;
  // list_experts
  agentsDir?: string;
  registryOk?: boolean;
  experts?: Array<{
    name: string;
    description: string;
    model: string | null;
    tools: string[];
    knowledgePaths: string[];
    sourceFile: string;
  }>;
  registryIssues?: ExpertRegistryIssue[];
  // dispatch_expert
  expertRole?: string;
  expertPackage?: {
    name: string;
    description: string;
    model: string | null;
    tools: string[];
    skills: string[];
    knowledgePaths: string[];
    sourceFile: string;
    systemPrompt: string;
    taskMessage: string;
    authority: typeof EXPERT_AUTHORITY_POLICY;
    /** 带子操作工具的 action 白名单（宿主执行时必须按此校验，字符串不足以证明授权）。 */
    allowedActions: Array<{ tool: string; actions: string[] }>;
  };
  execution?: {
    mode: "host_package";
    executed: false;
    note: string;
  };
  promptBudget?: { limitChars: number; usedChars: number; exceeded: boolean };
  omittedInputs?: Array<{ path: string; reason: string }>;
  // handoff_chapter_contract
  handoffMode?: "preview" | "commit";
  wrote?: boolean;
  chapterNumber?: number;
  outlineMarkdown?: string | null;
  proposalHash?: string;
  targetPath?: string;
  provenancePath?: string;
  validation?: ExpertContractValidationResult;
  /**
   * preview 的 commit 前置说明：preview 不签发凭证；作者确认后由可信宿主审批层
   * 调用 `issueChapterContractApproval` 签发一次性凭证，commit 必须回传该凭证。
   */
  approvalRequired?: {
    proposalHash: string;
    issuer: "trusted_host";
    note: string;
  };
}

function resolveAgentsDir(input: ExpertHandoffInput): string {
  if (input._agentsDir) return input._agentsDir;
  return join(input._projectRoot ?? getProjectRoot(), DEFAULT_AGENTS_DIR);
}

function resolveWorkspace(projectRoot: string, workspaceId: string): { workspacePath: string } | { error: string } {
  try {
    return { workspacePath: resolveWorkspacePath(join(projectRoot, "workspaces"), workspaceId) };
  } catch (e: unknown) {
    return { error: `Invalid workspaceId: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============================================================================
// list_experts
// ============================================================================

export function handleListExperts(input: ExpertHandoffInput): ExpertHandoffResult {
  const agentsDir = resolveAgentsDir(input);
  const registry = loadExpertRegistry(agentsDir);
  return {
    status: registry.ok ? "ok" : "error",
    agentsDir,
    registryOk: registry.ok,
    registryIssues: registry.issues,
    experts: registry.experts.map((expert) => ({
      name: expert.name,
      description: expert.description,
      model: expert.model,
      tools: [...expert.tools],
      knowledgePaths: expert.knowledge.map((item) => item.resolvedPath),
      sourceFile: expert.sourceFile,
    })),
    error: registry.ok ? undefined : "expert_registry_invalid",
  };
}

// ============================================================================
// dispatch_expert
// ============================================================================

export function handleDispatchExpert(input: ExpertHandoffInput): ExpertHandoffResult {
  const role = typeof input.expertRole === "string" ? input.expertRole.trim() : "";
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (!role) return { status: "error", error: "dispatch_expert 需要 expertRole" };
  if (!objective) return { status: "error", error: "dispatch_expert 需要 objective" };

  // 生产没有授权的专家执行器：显式拒绝，不得静默降级为“已完成”
  if (input.executionMode === "execute") {
    return {
      status: "error",
      error:
        "expert_execution_requires_authorized_executor：生产扩展不调用模型执行专家；" +
        "请用 executionMode=\"package\" 取得任务包，由宿主执行。",
    };
  }

  const agentsDir = resolveAgentsDir(input);
  const registry = loadExpertRegistry(agentsDir);
  if (!registry.ok) {
    return {
      status: "error",
      error: `expert_registry_invalid：${registry.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code)
        .join(", ")}`,
      agentsDir,
      registryIssues: registry.issues,
    };
  }

  let expert;
  try {
    expert = registry.require(role);
  } catch (e: unknown) {
    return { status: "error", error: e instanceof Error ? e.message : String(e), agentsDir };
  }

  const projectRoot = input._projectRoot ?? getProjectRoot();
  let workspaceRoot: string | undefined;
  if (input.workspaceId) {
    const resolved = resolveWorkspace(projectRoot, input.workspaceId);
    if ("error" in resolved) return { status: "error", error: resolved.error };
    workspaceRoot = resolved.workspacePath;
  }

  // 输入路径 fail-closed：.env / chapters / 长期状态 / 路由配置 / 越界一律拒绝
  const requestedInputs = Array.isArray(input.inputPaths) ? input.inputPaths : [];
  const keptInputs: string[] = [];
  for (const inputPath of requestedInputs) {
    const check = checkExpertReadPath(inputPath, { agentsDir, workspaceRoot });
    if (!check.ok) {
      return {
        status: "error",
        error: `${check.code ?? "path_denied"}：${check.message ?? inputPath}`,
        agentsDir,
      };
    }
    if (check.resolvedPath) keptInputs.push(check.resolvedPath);
  }

  const task: ExpertTask = {
    role,
    objective,
    inputPaths: keptInputs,
    constraints: Array.isArray(input.constraints) ? input.constraints : undefined,
    expect: typeof input.expect === "string" && input.expect.trim() ? input.expect.trim() : undefined,
    workspaceId: input.workspaceId,
    chapterNumber: input.chapterNumber,
  };

  const systemPrompt = renderExpertSystemPrompt(expert);
  const limitChars = DEFAULT_EXPERT_BUDGET.maxPromptChars;
  const omittedInputs: Array<{ path: string; reason: string }> = [];
  let effectiveInputs = keptInputs;
  let taskMessage = buildExpertTaskMessage(expert, { ...task, inputPaths: effectiveInputs }, {
    maxOutputChars: DEFAULT_EXPERT_BUDGET.maxOutputChars,
  });
  // 提示词预算：从尾部丢弃输入并显式声明，不静默省略
  while (
    effectiveInputs.length > 0 &&
    systemPrompt.length + taskMessage.length > limitChars
  ) {
    omittedInputs.push({ path: effectiveInputs[effectiveInputs.length - 1], reason: "prompt_budget" });
    effectiveInputs = effectiveInputs.slice(0, -1);
    taskMessage = buildExpertTaskMessage(
      expert,
      { ...task, inputPaths: effectiveInputs },
      { omittedInputs: omittedInputs.map((item) => item.path), maxOutputChars: DEFAULT_EXPERT_BUDGET.maxOutputChars },
    );
  }
  const usedChars = systemPrompt.length + taskMessage.length;
  if (usedChars > limitChars) {
    return {
      status: "error",
      error: `expert_prompt_budget_exceeded：专家正文与任务包合计 ${usedChars} 字符，超过上限 ${limitChars}`,
      agentsDir,
      promptBudget: { limitChars, usedChars, exceeded: true },
    };
  }

  return {
    status: "ok",
    expertRole: role,
    agentsDir,
    expertPackage: {
      name: expert.name,
      description: expert.description,
      model: expert.model,
      tools: [...expert.tools],
      skills: [...expert.skills],
      knowledgePaths: expert.knowledge.map((item) => item.resolvedPath),
      sourceFile: expert.sourceFile,
      systemPrompt,
      taskMessage,
      authority: EXPERT_AUTHORITY_POLICY,
      allowedActions: expert.tools
        .filter((tool) => EXPERT_ALLOWED_ACTIONS[tool])
        .map((tool) => ({ tool, actions: [...EXPERT_ALLOWED_ACTIONS[tool]] })),
    },
    execution: {
      mode: "host_package",
      executed: false,
      note:
        "扩展不调用模型：宿主以 expertPackage.systemPrompt 为系统提示、taskMessage 为用户输入执行，" +
        "只允许 expertPackage.tools 中的只读工具；专家输出是提案，不是权威事实。",
    },
    promptBudget: { limitChars, usedChars, exceeded: false },
    omittedInputs,
  };
}

// ============================================================================
// handoff_chapter_contract
// ============================================================================

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function atomicWriteText(filePath: string, text: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, text, "utf8");
  renameSync(tempPath, filePath);
}

/**
 * 一次性授权凭证（APPROVAL-RECEIPT-1 / EXPERT-HOST-APPROVAL-1）：
 * 只能由**可信宿主审批层**调用 `issueChapterContractApproval` 签发，任何 tool action 都无法签发。
 * 凭证是随机不可猜的 id，绑定 workspaceId / chapterNumber / proposalHash，单次消费、15 分钟过期；
 * `confirmedBy` 只是审计标签，调用方自行填写的字符串不构成授权。
 * 凭证只存进程内存（不落盘），过期或进程重启后必须重新走宿主审批 —— 宁可重走流程，
 * 也不接受“调用者 preview 后自行 commit”这种只能证明“发生过 preview”的伪授权。
 *
 * 部署约束：签发与消费必须在同一 runtime 进程内完成（单实例或按 workspace 粘性路由）。
 * 多实例部署时 receipt 不跨实例共享，commit 会 fail-closed 为 approval_receipt_required；
 * 需要横向扩容时应迁移到共享 TTL 存储，而不是放宽校验。
 */
interface PendingApprovalReceipt {
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  approvedBy: string;
  expiresAtMs: number;
}

const APPROVAL_RECEIPT_TTL_MS = 15 * 60 * 1000;
const pendingApprovalReceipts = new Map<string, PendingApprovalReceipt>();

function pruneExpiredReceipts(now: number): void {
  for (const [id, receipt] of pendingApprovalReceipts) {
    if (receipt.expiresAtMs <= now) pendingApprovalReceipts.delete(id);
  }
}

/**
 * 可信宿主审批层专用：作者/协调人确认某份提案后签发一次性 commit 凭证。
 *
 * 本函数**不是**任何 tool action，扩展工具面无法触达；因此“能调用
 * `novel_workspace_manager`”不等于“能签发授权”。宿主审批 UI/协调层在拿到用户
 * 明确批准后调用本函数，再把 `receiptId` 交给 commit。
 */
export function issueChapterContractApproval(params: {
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  approvedBy: string;
}): { receiptId: string; proposalHash: string; approvedBy: string; expiresAt: string } {
  const approvedBy = (params.approvedBy ?? "").trim();
  if (!approvedBy) {
    throw new Error("issueChapterContractApproval 需要非空 approvedBy（作者/协调人标识）");
  }
  const now = Date.now();
  pruneExpiredReceipts(now);
  const receiptId = randomUUID();
  const expiresAtMs = now + APPROVAL_RECEIPT_TTL_MS;
  pendingApprovalReceipts.set(receiptId, {
    workspaceId: params.workspaceId,
    chapterNumber: params.chapterNumber,
    proposalHash: params.proposalHash,
    approvedBy,
    expiresAtMs,
  });
  return {
    receiptId,
    proposalHash: params.proposalHash,
    approvedBy,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function consumeApprovalReceipt(params: {
  receiptId: string;
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
}): { ok: true; approvedBy: string; receipt: PendingApprovalReceipt } | { ok: false; error: string } {
  pruneExpiredReceipts(Date.now());
  const receipt = pendingApprovalReceipts.get(params.receiptId);
  if (!receipt) {
    return {
      ok: false,
      error: "approval_receipt_invalid：凭证不存在、已被使用或已过期；请重新走宿主审批",
    };
  }
  if (receipt.expiresAtMs <= Date.now()) {
    pendingApprovalReceipts.delete(params.receiptId);
    return { ok: false, error: "approval_receipt_expired：凭证已过期；请重新走宿主审批" };
  }
  if (
    receipt.workspaceId !== params.workspaceId ||
    receipt.chapterNumber !== params.chapterNumber ||
    receipt.proposalHash !== params.proposalHash
  ) {
    return {
      ok: false,
      error: "approval_receipt_mismatch：凭证与本次 workspace/chapter/proposal 不匹配",
    };
  }
  // 单次使用：消费即失效。记录一并返回，落盘失败时可原样恢复以便重试。
  pendingApprovalReceipts.delete(params.receiptId);
  return { ok: true, approvedBy: receipt.approvedBy, receipt };
}

/**
 * 落盘失败时把凭证放回（事务回滚）：章纲与 provenance 都没提交成功时，
 * 一次性授权不应被“用掉”。错误路径上只恢复原始记录，不延长有效期。
 */
function restoreApprovalReceipt(receiptId: string, receipt: PendingApprovalReceipt): void {
  if (receipt.expiresAtMs <= Date.now()) return;
  if (!pendingApprovalReceipts.has(receiptId)) pendingApprovalReceipts.set(receiptId, receipt);
}

export function handleHandoffChapterContract(input: ExpertHandoffInput): ExpertHandoffResult {
  if (!input.workspaceId) return { status: "error", error: "handoff_chapter_contract 需要 workspaceId" };
  const chapterNumber = input.chapterNumber;
  if (
    typeof chapterNumber !== "number" ||
    !Number.isInteger(chapterNumber) ||
    chapterNumber <= 0
  ) {
    return { status: "error", error: "handoff_chapter_contract 需要正整数 chapterNumber" };
  }
  const proposalText = typeof input.proposalText === "string" ? input.proposalText : "";
  if (!proposalText.trim()) {
    return { status: "error", error: "handoff_chapter_contract 需要 proposalText（专家契约提案 Markdown）" };
  }

  const mode: "preview" | "commit" = input.handoffMode === "commit" ? "commit" : "preview";

  const projectRoot = input._projectRoot ?? getProjectRoot();
  const resolved = resolveWorkspace(projectRoot, input.workspaceId);
  if ("error" in resolved) return { status: "error", error: resolved.error };
  const { workspacePath } = resolved;
  if (!existsSync(join(workspacePath, "config.json"))) {
    return { status: "error", error: `workspace_not_found：${input.workspaceId}` };
  }

  const proposal = parseExpertChapterContract(proposalText);
  const validation = validateExpertChapterContract(proposal, {
    knownFactIds: input.knownFactIds,
    knownPromiseIds: input.knownPromiseIds,
    requireEvents: true,
  });
  if (proposal.chapterNumber !== null && proposal.chapterNumber !== chapterNumber) {
    return {
      status: "blocked",
      error: `chapter_number_mismatch：提案章号 ${proposal.chapterNumber} 与入参 ${chapterNumber} 不一致`,
      handoffMode: mode,
      chapterNumber,
      validation,
    };
  }
  if (!validation.ok) {
    return {
      status: "blocked",
      error: "expert_contract_invalid",
      handoffMode: mode,
      chapterNumber,
      validation,
    };
  }

  const outlineMarkdown = toExplicitOutlineMarkdown(proposal);
  if (!outlineMarkdown) {
    return {
      status: "blocked",
      error: "explicit_outline_not_generatable：提案缺事件级契约，拒绝编造事件",
      handoffMode: mode,
      chapterNumber,
      validation,
    };
  }
  const proposalHash = sha256(outlineMarkdown);
  const targetPath = resolveExplicitOutlineFile(workspacePath, toChapterId(chapterNumber));
  const relativeTarget = `series/ch${toChapterId(chapterNumber)}-outline-explicit.md`;
  const provenancePath = chapterContractProvenancePath(targetPath);

  if (mode === "preview") {
    // preview 只做校验与预览，**不签发 commit 凭证**：能调用工具 ≠ 获得作者批准。
    return {
      status: "ok",
      handoffMode: "preview",
      wrote: false,
      chapterNumber,
      outlineMarkdown,
      proposalHash,
      targetPath: relativeTarget,
      validation,
      approvalRequired: {
        proposalHash,
        issuer: "trusted_host",
        note:
          "preview 不签发 commit 凭证。作者/协调人确认后，必须由可信宿主审批层调用 " +
          "issueChapterContractApproval({ workspaceId, chapterNumber, proposalHash, approvedBy }) " +
          "签发一次性凭证，commit 时回传该凭证的 receiptId。",
      },
    };
  }

  // ── commit：显式授权 + 原子写入 + provenance ──
  if (input.confirm !== true) {
    return { status: "error", error: "handoff commit 需要 confirm=true（专家提案不得自动落盘）" };
  }
  const confirmedBy = typeof input.confirmedBy === "string" ? input.confirmedBy.trim() : "";
  if (!confirmedBy) {
    return { status: "error", error: "handoff commit 需要 confirmedBy（作者/协调层确认人，仅作审计标签）" };
  }
  const approvalReceiptId = typeof input.approvalReceipt === "string" ? input.approvalReceipt.trim() : "";
  if (!approvalReceiptId) {
    return {
      status: "blocked",
      error:
        "approval_receipt_required：commit 必须回传可信宿主审批层（issueChapterContractApproval）" +
        "签发的一次性授权凭证（approvalReceipt），preview 不签发凭证",
      handoffMode: "commit",
      chapterNumber,
      targetPath: relativeTarget,
      validation,
    };
  }
  if (existsSync(targetPath)) {
    let existing: string;
    try {
      existing = readFileSync(targetPath, "utf8");
    } catch (error: unknown) {
      // 目录/权限异常必须结构化阻断，不能让同步 I/O 异常穿透工具处理器。
      return {
        status: "blocked",
        error:
          `explicit_outline_unreadable：目标路径不可读取（可能是目录或权限问题）：` +
          `${error instanceof Error ? error.message : String(error)}`,
        handoffMode: "commit",
        chapterNumber,
        targetPath: relativeTarget,
        validation,
      };
    }
    if (sha256(existing) !== proposalHash && input.overwrite !== true) {
      return {
        status: "blocked",
        error: "explicit_outline_exists：目标显式章纲已存在且内容不同；确认覆盖时传 overwrite=true",
        handoffMode: "commit",
        chapterNumber,
        targetPath: relativeTarget,
        validation,
      };
    }
  }

  // 凭证消费放在覆盖校验之后：无关阻断不消耗授权；一旦放行即失效，不能重放。
  const receiptCheck = consumeApprovalReceipt({
    receiptId: approvalReceiptId,
    workspaceId: input.workspaceId,
    chapterNumber,
    proposalHash,
  });
  if (!receiptCheck.ok) {
    return {
      status: "blocked",
      error: receiptCheck.error,
      handoffMode: "commit",
      chapterNumber,
      targetPath: relativeTarget,
      validation,
    };
  }

  // ── 事务：章纲与 provenance 必须一起成功，否则回滚并把凭证放回 ──
  // 顺序：先写 pending provenance → 写章纲 → 把 provenance 改成 committed。
  // 任一步失败：恢复原章纲（或删除新建文件）、provenance 记为 failed、凭证恢复可重试。
  // 单进程同步执行，不存在“章纲已落盘但没有 provenance”的静默中间态。
  let previousOutline: string | null = null;
  try {
    previousOutline = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  } catch {
    // 目标不可读时按“无旧内容”处理；真正的写入失败会由下方事务 catch 结构化返回。
    previousOutline = null;
  }
  const provenanceBase = {
    schemaVersion: CHAPTER_CONTRACT_PROVENANCE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    chapterNumber,
    targetPath: relativeTarget,
    proposalHash,
    expertRole: typeof input.expertRole === "string" && input.expertRole.trim() ? input.expertRole.trim() : null,
    // confirmedBy 仅审计；授权证明来自宿主审批层签发的凭证。
    confirmedBy,
    approvalReceiptId,
    approval: {
      issuedBy: "trusted_host",
      approvedBy: receiptCheck.approvedBy,
      proposalHash,
    },
    confirmedAt: new Date().toISOString(),
    handoff: "expert_proposal_to_explicit_outline",
    consumer: "craft/chapter-seed-builder.ts:loadAuthorChapterContract",
    generationTraceRef: `${relativeTarget}#authorChapterContract.sourceIds`,
    validation: { ok: validation.ok, warnings: validation.warnings, scoreAdvisory: validation.scoreAdvisory },
  };
  const writeProvenance = (
    commitStatus: ChapterContractCommitStatus,
    failure?: { message: string; outlineRolledBack: boolean; at: string },
  ): void => {
    mkdirSync(dirname(provenancePath), { recursive: true });
    const record = failure
      ? { ...provenanceBase, commitStatus, failure }
      : { ...provenanceBase, commitStatus };
    atomicWriteText(provenancePath, JSON.stringify(record, null, 2));
  };
  const rollbackOutline = (previous: string | null): boolean => {
    try {
      if (previous === null) {
        if (existsSync(targetPath)) unlinkSync(targetPath);
      } else {
        atomicWriteText(targetPath, previous);
      }
      return true;
    } catch {
      return false;
    }
  };

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeProvenance("pending");
    atomicWriteText(targetPath, outlineMarkdown);
    writeProvenance("committed");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const rolledBack = rollbackOutline(previousOutline);
    try {
      writeProvenance("failed", {
        message,
        outlineRolledBack: rolledBack,
        at: new Date().toISOString(),
      });
    } catch {
      // provenance 写失败时保留 pending 状态，供人工核对；原始错误优先返回。
    }
    restoreApprovalReceipt(approvalReceiptId, receiptCheck.receipt);
    return {
      status: "error",
      error:
        `handoff_commit_failed：${message}；章纲` +
        (rolledBack ? "已回滚" : "回滚失败，需人工检查") +
        "，一次性凭证未消费，可修正后重试",
      handoffMode: "commit",
      chapterNumber,
      targetPath: relativeTarget,
      provenancePath: `${relativeTarget}.provenance.json`,
      validation,
    };
  }

  return {
    status: "ok",
    handoffMode: "commit",
    wrote: true,
    chapterNumber,
    outlineMarkdown,
    proposalHash,
    targetPath: relativeTarget,
    provenancePath: `${relativeTarget}.provenance.json`,
    validation,
  };
}

export function handleExpertHandoff(input: ExpertHandoffInput): ExpertHandoffResult {
  switch (input.action) {
    case "list_experts":
      return handleListExperts(input);
    case "dispatch_expert":
      return handleDispatchExpert(input);
    case "handoff_chapter_contract":
      return handleHandoffChapterContract(input);
    default:
      return { status: "error", error: `未知专家子操作: ${String(input.action)}` };
  }
}
