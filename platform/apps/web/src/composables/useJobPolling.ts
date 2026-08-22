/**
 * 生成任务轮询 composable（P5-3）：
 * 运行态按间隔轮询 job 详情 + calls 明细；终态自动停止；
 * 组件卸载自动清理定时器。
 */
import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import {
  getJob,
  getJobCalls,
  isTerminalStatus,
  type JobCall,
  type NovelJob,
} from '../api/jobs';

export interface UseJobPollingReturn {
  /** 当前任务（null = 无任务）。 */
  job: Ref<NovelJob | null>;
  /** 逐调用明细（随轮询刷新）。 */
  calls: Ref<JobCall[]>;
  /** 轮询进行中（含首查）。 */
  loading: Ref<boolean>;
  /** 最近一次轮询错误（404 等不中断轮询语义由调用方决定）。 */
  error: Ref<string | null>;
  /** 开始跟踪一个 job。 */
  track: (jobId: string) => void;
  /** 立即刷新一次。 */
  refresh: () => Promise<void>;
  /** 停止轮询并清空状态。 */
  reset: () => void;
}

const POLL_INTERVAL_MS = 2000;

export function useJobPolling(): UseJobPollingReturn {
  const job = shallowRef<NovelJob | null>(null);
  const calls = shallowRef<JobCall[]>([]);
  const loading = ref(false);
  const error = shallowRef<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function poll(): Promise<void> {
    const jobId = job.value?.jobId;
    if (!jobId) return;
    try {
      const [nextJob, nextCalls] = await Promise.all([
        getJob(jobId),
        getJobCalls(jobId).catch(() => [] as JobCall[]),
      ]);
      job.value = nextJob;
      calls.value = nextCalls;
      error.value = null;
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '轮询失败';
    }
    if (
      job.value &&
      !isTerminalStatus(String(job.value.status)) &&
      timer === null
    ) {
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, POLL_INTERVAL_MS);
    }
  }

  function track(jobId: string): void {
    clearTimer();
    job.value = null;
    calls.value = [];
    error.value = null;
    loading.value = true;
    // 先占位（记录 jobId 供 poll 使用），随后立即首查
    job.value = {
      jobId,
      projectId: 0,
      chapterId: 0,
      jobType: 'chapter_generation',
      status: 'pending',
      progressStage: null,
      maxCharge: '0',
      settledAmount: '0',
      failureMessage: null,
      failure: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    void poll().finally(() => {
      loading.value = false;
    });
  }

  async function refresh(): Promise<void> {
    if (job.value && !isTerminalStatus(String(job.value.status))) {
      await poll();
    }
  }

  function reset(): void {
    clearTimer();
    job.value = null;
    calls.value = [];
    error.value = null;
    loading.value = false;
  }

  onBeforeUnmount(clearTimer);

  return { job, calls, loading, error, track, refresh, reset };
}
