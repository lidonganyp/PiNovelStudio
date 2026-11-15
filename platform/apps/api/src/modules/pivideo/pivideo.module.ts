/**
 * PiVideoStudio 视频工场模块（B6 融合）。
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PivideoController } from './pivideo.controller';
import { PivideoService } from './pivideo.service';

@Module({
  imports: [PrismaModule],
  controllers: [PivideoController],
  providers: [PivideoService],
})
export class PivideoModule {}
