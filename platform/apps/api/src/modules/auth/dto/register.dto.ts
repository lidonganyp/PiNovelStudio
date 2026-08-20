/**
 * 注册请求 DTO：邮箱 + 密码（8-128 位）+ 昵称（1-32 字符）。
 */
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  /** 登录邮箱，全局唯一。 */
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  /** 明文密码（传输层依赖 HTTPS），长度 8-128。 */
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(128, { message: '密码最长 128 位' })
  password!: string;

  /** 展示昵称，1-32 字符。 */
  @IsString()
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(32, { message: '昵称最长 32 字符' })
  nickname!: string;
}
