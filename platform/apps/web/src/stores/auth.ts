/**
 * 认证状态 store（Pinia）：token/user 持久化到 localStorage，
 * 提供登录/注册/拉取当前用户/退出动作。
 */
import { defineStore } from 'pinia';
import { authApi, type PublicUser } from '../api/auth';
import { tokenStorage } from '../api/http';

const USER_KEY = 'platform_user';

/** 从 localStorage 恢复用户视图。 */
function loadStoredUser(): PublicUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicUser;
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: tokenStorage.get(),
    user: loadStoredUser(),
  }),
  getters: {
    /** 是否已登录。 */
    isLoggedIn: (state): boolean => state.token !== null,
    /** 当前角色（user | admin | null）。 */
    role: (state): string | null => state.user?.role ?? null,
  },
  actions: {
    /** 登录并持久化。 */
    async login(email: string, password: string): Promise<void> {
      const result = await authApi.login({ email, password });
      this.applyAuth(result.accessToken, result.user);
    },
    /** 注册（注册即登录）并持久化。 */
    async register(
      email: string,
      password: string,
      nickname: string,
    ): Promise<void> {
      const result = await authApi.register({ email, password, nickname });
      this.applyAuth(result.accessToken, result.user);
    },
    /** 拉取并刷新当前用户信息。 */
    async fetchMe(): Promise<void> {
      if (!this.token) return;
      this.user = await authApi.me();
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
    },
    /** 退出登录，清空本地态。 */
    logout(): void {
      tokenStorage.clear();
      localStorage.removeItem(USER_KEY);
      this.token = null;
      this.user = null;
    },
    /** 写入认证结果（登录/注册共用）。 */
    applyAuth(token: string, user: PublicUser): void {
      tokenStorage.set(token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      this.token = token;
      this.user = user;
    },
  },
});
