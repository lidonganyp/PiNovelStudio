/**
 * 认证 API：注册 / 登录 / 当前用户，与 apps/api AuthController 对齐。
 */
import { http } from './http';

/** 对外用户视图（余额接口为分字符串，页面按元展示）。 */
export interface PublicUser {
  id: number;
  email: string;
  nickname: string;
  role: string;
  status: string;
  /** 充值余额（真实）。 */
  balance: string;
  /** 赠送余额（虚拟）。 */
  bonusBalance: string;
  /** 总余额 = 充值 + 赠送。 */
  totalBalance: string;
  createdAt: string;
}

/** 认证结果：token + 用户视图。 */
export interface AuthResult {
  accessToken: string;
  user: PublicUser;
}

export const authApi = {
  /** 注册新用户。 */
  register(payload: {
    email: string;
    password: string;
    nickname: string;
  }): Promise<AuthResult> {
    return http.post('/auth/register', payload).then((res) => res.data);
  },
  /** 邮箱密码登录。 */
  login(payload: { email: string; password: string }): Promise<AuthResult> {
    return http.post('/auth/login', payload).then((res) => res.data);
  },
  /** 获取当前登录用户。 */
  me(): Promise<PublicUser> {
    return http.get('/auth/me').then((res) => res.data);
  },
  /** 修改当前用户密码。 */
  changePassword(payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    return http.post('/auth/password', payload).then((res) => res.data);
  },
};
