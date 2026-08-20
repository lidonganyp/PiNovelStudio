/**
 * 滑动窗口限流单测：窗口内超配额拒绝，窗口外重新放行。
 */
import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './sliding-window';

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit then rejects until the window slides', () => {
    let now = 1_000;
    const limiter = new SlidingWindowLimiter(2, 1_000, () => now);

    expect(limiter.tryConsume('127.0.0.1')).toBe(true);
    expect(limiter.tryConsume('127.0.0.1')).toBe(true);
    expect(limiter.tryConsume('127.0.0.1')).toBe(false);

    now = 2_001;
    expect(limiter.tryConsume('127.0.0.1')).toBe(true);
  });

  it('isolates keys so one IP does not consume another', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });
});
