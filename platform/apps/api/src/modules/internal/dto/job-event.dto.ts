/**
 * 内部任务进度事件 DTO（进度消息/评审意见全文落库）。
 * runtime 侧保证 stage/content 至少一项非空；此处只做类型与长度校验。
 */
import { IsString, MaxLength } from 'class-validator';

export class JobEventDto {
  @IsString()
  @MaxLength(128)
  stage!: string;

  @IsString()
  @MaxLength(20000)
  content!: string;
}
