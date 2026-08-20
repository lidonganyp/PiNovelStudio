/**
 * 注册开关：settings.registration_enabled 为 false 或 {enabled:false} 时关闭。
 * 缺失该设置视为开放注册。
 */
export function isRegistrationClosed(value: unknown): boolean {
  if (value === false) return true;
  if (value && typeof value === 'object' && 'enabled' in value) {
    return (value as { enabled?: unknown }).enabled === false;
  }
  return false;
}
