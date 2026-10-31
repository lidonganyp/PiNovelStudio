/**
 * 宿主审批通道：加载 PiNovelStudio 扩展里的章纲授权签发函数
 *
 * 背景（EXPERT-HOST-APPROVAL-1）：`issueChapterContractApproval` 是**宿主专享**接口，
 * 不在任何 tool action 里暴露。它签发的凭证只存在于进程内存，因此必须由与工具调用
 * **同一进程**的宿主签发：novel-runtime 在启动时加载扩展 dist，这里从同一 dist 路径
 * 导入该函数，与扩展注册工具时使用的是同一个模块实例（同一张凭证表）。
 *
 * 安全边界：
 * - 工具调用方（agent）只有 6 个公开工具，触达不到本模块；
 * - 唯一入口是 runtime 的 `/internal/chapter-contract/approvals` 路由，要求内部 HMAC
 *   签名（只有 platform-api 持有 INTERNAL_API_SECRET）；
 * - platform-api 侧再要求作者 JWT 登录并校验项目归属，`approvedBy` 由服务端从
 *   JWT 用户取，不接受客户端自填。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ExtensionLoadError } from "./extension-loader.js";

/** 凭证签发结果（与 expert-handoff-handler 的返回值一致）。 */
export interface ChapterContractApprovalTicket {
  receiptId: string;
  proposalHash: string;
  approvedBy: string;
  expiresAt: string;
}

export type ChapterContractApprovalIssuer = (params: {
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  approvedBy: string;
}) => ChapterContractApprovalTicket;

/**
 * 从扩展 dist 导入签发函数。失败一律 fail closed：运行时不启动，
 * 不做“审批路由静默不可用”的降级。
 */
export async function loadChapterContractApprovalIssuer(
  distPath: string,
): Promise<ChapterContractApprovalIssuer> {
  const modulePath = join(dirname(distPath), "handlers", "expert-handoff-handler.js");
  if (!existsSync(modulePath)) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: chapter contract approval issuer not found at ${modulePath}. ` +
        "Rebuild PiNovelStudio dist before starting the runtime.",
      "LOAD_FAILED",
    );
  }
  let issuerModule: { issueChapterContractApproval?: unknown };
  try {
    issuerModule = (await import(pathToFileURL(modulePath).href)) as {
      issueChapterContractApproval?: unknown;
    };
  } catch (error: unknown) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: failed to import chapter contract approval issuer: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "LOAD_FAILED",
    );
  }
  if (typeof issuerModule.issueChapterContractApproval !== "function") {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: ${modulePath} does not export issueChapterContractApproval.`,
      "LOAD_FAILED",
    );
  }
  return issuerModule.issueChapterContractApproval as ChapterContractApprovalIssuer;
}
