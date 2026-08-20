/**
 * 章节模块：依赖 jobs 以提交生成任务。
 */
import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ChaptersController } from './chapters.controller';
import { ChaptersService } from './chapters.service';

@Module({
  imports: [JobsModule],
  controllers: [ChaptersController],
  providers: [ChaptersService],
  exports: [ChaptersService],
})
export class ChaptersModule {}
