/**
 * 修改密码请求：必须提供当前密码，新密码长度与注册规则一致。
 */
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  /** 当前登录密码。 */
  @IsString()
  @MinLength(8, { message: '当前密码至少 8 位' })
  @MaxLength(128, { message: '当前密码最长 128 位' })
  currentPassword!: string;

  /** 新密码，长度 8-128。 */
  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  @MaxLength(128, { message: '新密码最长 128 位' })
  newPassword!: string;
}
