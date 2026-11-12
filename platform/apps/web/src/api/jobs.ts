/**
 * 生成任务 API：详情轮询 + 逐调用明细。
 * 契约对齐 platform-api JobsController（getJob/getCalls 响应形状）。
 */
import { http } from './http';

/** 任务状态（后端 novelGenerationJob.status 枚举）。 */
export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'insufficient_balance';

/** 进度阶段（后端 progressStage 已知枚举，按序展示）。 */
export const JOB_STAGES: Array<{ value: string; label: string }> = [
  { value: 'checking_materials', label: '预检素材' },
  { value: 'generating_text', label: '生成正文' },
  { value: 'saving_chapter', label: '保存章节' },
];

export interface JobFailure {
  stage: string;
  gate: string;
  code: string;
  severity: string;
  reason: string;
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: string[];
  fixInstructions?: string[];
}

/** 任务视图。 */
export interface NovelJob {
  jobId: string;
  projectId: number;
  chapterId: number;
  /** 章节号（restorable 列表返回，用于重建聊天卡片标题）。 */
  chapterNumber?: number | null;
  jobType: string;
  status: JobStatus | string;
  progressStage: string | null;
  maxCharge: string;
  settledAmount: string;
  failureMessage: string | null;
  failure?: JobFailure | null;
  startedAt: string;
  completedAt: string | null;
}

/** 任务进度事件（阶段消息/评审意见全文，按时间正序）。 */
export interface JobEvent {
  id: number;
  stage: string;
  content: string;
  createdAt: string;
}

/** 逐调用明细行。 */
export interface JobCall {
  callId: string;
  internalStage: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  actualCharge: string;
  createdAt: string;
}

export function getJob(jobId: string): Promise<NovelJob> {
  return http.get(`/jobs/${jobId}`).then((r) => r.data);
}
/** 刷新恢复：项目下进行中 + 最近终态的章节生成任务（重建聊天卡片用）。 */
export function listRestorableJobs(projectId: number): Promise<NovelJob[]> {
  return http.get('/jobs/restorable', { params: { projectId } }).then((r) => r.data);
}

export function retryGeneration(jobId: string): Promise<NovelJob> {
  return http.post(`/jobs/${jobId}/retry`).then((r) => r.data);
}

export function getJobCalls(jobId: string): Promise<JobCall[]> {
  return http.get(`/jobs/${jobId}/calls`).then((r) => r.data);
}

export function getJobEvents(jobId: string): Promise<JobEvent[]> {
  return http.get(`/jobs/${jobId}/events`).then((r) => r.data);
}

/** 任务是否处于终态（轮询停止条件）。 */
export function isTerminalStatus(status: string): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'insufficient_balance'
  );
}
