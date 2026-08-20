/**
 * axios 实例与 token 存取：统一注入 Authorization 头；
 * 401 时清除本地登录态并跳转登录页；其他错误弹 Element 消息。
 */
import axios from 'axios';
import { ElMessage } from 'element-plus';

const TOKEN_KEY = 'platform_token';

/** localStorage token 存取工具。 */
export const tokenStorage = {
  /** 读取本地 token，不存在返回 null。 */
  get(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  /** 写入 token。 */
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  /** 清除 token。 */
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

/** 请求拦截器：注入 Bearer token。 */
http.interceptors.request.use((config) => {
  const token = tokenStorage.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** 响应拦截器：401 清登录态跳登录页，其他错误统一提示。 */
http.interceptors.response.use(
  (response) => response,
  (error: {
    response?: { status?: number; data?: { message?: string | string[] } };
  }) => {
    if (error.response?.status === 401) {
      tokenStorage.clear();
      localStorage.removeItem('platform_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }
    const raw = error.response?.data?.message;
    const message = Array.isArray(raw) ? raw[0] : raw;
    ElMessage.error(typeof message === 'string' ? message : '请求失败，请稍后重试');
    return Promise.reject(error);
  },
);
