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

/** 任务视图。 */
export interface NovelJob {
  jobId: string;
  projectId: number;
  chapterId: number;
  jobType: string;
  status: JobStatus | string;
  progressStage: string | null;
  maxCharge: string;
  settledAmount: string;
  failureMessage: string | null;
  startedAt: string;
  completedAt: string | null;
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

export function getJobCalls(jobId: string): Promise<JobCall[]> {
  return http.get(`/jobs/${jobId}/calls`).then((r) => r.data);
}

/** 任务是否处于终态（轮询停止条件）。 */
export function isTerminalStatus(status: string): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'insufficient_balance'
  );
}
