/**
 * 内部预占收尾请求 DTO。
 */
import { IsIn } from 'class-validator';

export class FinalizeHoldDto {
  @IsIn(['success', 'failure'])
  outcome!: 'success' | 'failure';
}
