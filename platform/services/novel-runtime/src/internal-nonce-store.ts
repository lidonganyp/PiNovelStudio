/**
 * 内部 HMAC nonce 消费（runtime 侧防重放，INTERNAL-NONCE-REPLAY-1）
 *
 * platform-api 的 nonce 表只保护“发往 platform-api”的请求；本模块保护由
 * platform-api 发往 runtime 的内部端点：验签通过后必须原子消费 nonce，
 * 同一份有效签名在窗口内第二次到达即判定为重放（401 INTERNAL_AUTH_REPLAY）。
 *
 * 实现为进程内存 Map + TTL；Node 单线程同步执行，`consume()` 内的
 * “判重 + 写入”在同一个事件循环任务内完成，不存在并发窗口。
 * 进程重启后 nonce 表清空，但重放窗口只有 5 分钟且时间窗校验仍然生效。
 *
 * 部署约束（与审批 receipt 相同）：runtime 必须以单实例或按 jobId 粘性路由部署；
 * 多实例共享同一内部端点时，nonce 未跨实例共享会让同一签名可在另一实例重放。
 * 需要横向扩容时必须把本模块替换为共享 TTL 存储（Redis / 数据库原子消费）。
 */

import { INTERNAL_HMAC_WINDOW_MS } from "./internal-verify.js";

export class InternalNonceStore {
  private readonly consumedUntil = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = INTERNAL_HMAC_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("InternalNonceStore ttlMs must be a positive number");
    }
  }

  /**
   * 原子消费 nonce：首次消费返回 true；TTL 窗口内重复返回 false。
   * 过期条目在每次消费时顺带清理，不引入定时器。
   */
  consume(nonce: string): boolean {
    const current = this.now();
    this.prune(current);
    const expiresAt = this.consumedUntil.get(nonce);
    if (expiresAt !== undefined && expiresAt > current) {
      return false;
    }
    this.consumedUntil.set(nonce, current + this.ttlMs);
    return true;
  }

  /** 当前保留的 nonce 数量（诊断/测试用）。 */
  size(): number {
    return this.consumedUntil.size;
  }

  private prune(current: number): void {
    for (const [nonce, expiresAt] of this.consumedUntil) {
      if (expiresAt <= current) {
        this.consumedUntil.delete(nonce);
      }
    }
  }
}
