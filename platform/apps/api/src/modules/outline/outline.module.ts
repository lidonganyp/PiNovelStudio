/**
 * 大纲模块。
 */
import { Module } from '@nestjs/common';
import { OutlineController } from './outline.controller';
import { OutlineService } from './outline.service';

@Module({
  controllers: [OutlineController],
  providers: [OutlineService],
})
export class OutlineModule {}
