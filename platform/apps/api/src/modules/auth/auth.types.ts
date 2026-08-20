/**
 * 认证领域类型：JWT 载荷、对外用户视图、认证结果。
 * 余额统一为字符串（分），避免 BigInt JSON 序列化问题。
 */

/** JWT 载荷（登录态最小事实集）。 */
export interface AuthUserPayload {
  /** 用户 ID（users.id）。 */
  sub: number;
  /** 邮箱。 */
  email: string;
  /** 角色：user | admin。 */
  role: string;
}

/** 对外暴露的用户视图（不含密码哈希等敏感字段）。 */
export interface PublicUser {
  id: number;
  email: string;
  nickname: string;
  role: string;
  status: string;
  /** 余额，单位：分（字符串形式）。 */
  balance: string;
  createdAt: string;
}

/** 登录/注册成功返回。 */
export interface AuthResult {
  accessToken: string;
  user: PublicUser;
}

/** 数据库 users 行（Prisma 生成类型的轻量声明，供 service 内部使用）。 */
export interface UserRow {
  id: number;
  email: string;
  passwordHash: string;
  nickname: string;
  role: string;
  status: string;
  balance: bigint;
  createdAt: Date;
  updatedAt: Date;
}
