/**
 * NovelOS Session Schema（OPT-8.4）
 *
 * workspace/chapter/request/model 版本、状态与 checkpoint。
 * M1 仅 in-memory（不做 OPT-8.5 session-store 持久化）。
 * NovelOS 自主管理 sessionId，不依赖 PI Host session。
 */

/** Session 状态 */
export type NovelSessionStatus = "active" | "completed" | "aborted" | "failed";

/** Session checkpoint（M1 仅记录，不做 resume） */
export interface NovelSessionCheckpoint {
  turn: number;
  messageCount: number;
  timestamp: number;
}

/** NovelSession schema */
export interface NovelSession {
  /** 自主管理的 session ID（不依赖 PI Host） */
  sessionId: string;
  workspaceId: string;
  chapterId: string;
  /** 请求摘要：agent 被要求产出什么 */
  requestSummary: string;
  /** 模型路由名（如 narrator_primary） */
  route: string;
  /** 模型版本键（从 raw 实际模型派生，隔离策略信誉） */
  modelVersion?: string;
  status: NovelSessionStatus;
  createdAt: number;
  updatedAt: number;
  checkpoint?: NovelSessionCheckpoint;
}

/** 创建参数 */
export interface CreateNovelSessionParams {
  sessionId: string;
  workspaceId: string;
  chapterId: string;
  requestSummary: string;
  route: string;
  modelVersion?: string;
}

/** 创建一个 active session */
export function createNovelSession(params: CreateNovelSessionParams): NovelSession {
  const now = Date.now();
  return {
    ...params,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** 更新 session 状态 */
export function updateSessionStatus(
  session: NovelSession,
  status: NovelSessionStatus,
): NovelSession {
  return { ...session, status, updatedAt: Date.now() };
}

/** 记录 checkpoint */
export function checkpointSession(
  session: NovelSession,
  turn: number,
  messageCount: number,
): NovelSession {
  return {
    ...session,
    checkpoint: { turn, messageCount, timestamp: Date.now() },
    updatedAt: Date.now(),
  };
}
