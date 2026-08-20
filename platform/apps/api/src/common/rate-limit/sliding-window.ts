/**
 * 内存滑动窗口限流：单机无 Redis 时用于登录 IP 限速。
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记录一次命中；超过窗口配额返回 false。 */
  tryConsume(key: string): boolean {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
