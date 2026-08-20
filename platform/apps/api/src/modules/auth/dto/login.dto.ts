/**
 * 登录请求 DTO：邮箱 + 密码。
 */
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** 登录邮箱。 */
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  /** 明文密码。 */
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(128, { message: '密码最长 128 位' })
  password!: string;
}
