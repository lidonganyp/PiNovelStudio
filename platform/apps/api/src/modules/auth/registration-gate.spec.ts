/**
 * 注册开关解析：缺失视为开放，false / {enabled:false} 关闭。
 */
import { describe, expect, it } from 'vitest';
import { isRegistrationClosed } from './registration-gate';

describe('isRegistrationClosed', () => {
  it('treats a missing setting as open', () => {
    expect(isRegistrationClosed(undefined)).toBe(false);
    expect(isRegistrationClosed(null)).toBe(false);
    expect(isRegistrationClosed({ enabled: true })).toBe(false);
  });

  it('closes registration for false and {enabled:false}', () => {
    expect(isRegistrationClosed(false)).toBe(true);
    expect(isRegistrationClosed({ enabled: false })).toBe(true);
  });
});
