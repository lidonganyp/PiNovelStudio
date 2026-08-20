/**
 * 角色档案 API。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import {
  CharactersService,
  CreateCharacterDto,
  UpdateCharacterDto,
} from './characters.service';

@Controller('projects/:id/characters')
@UseGuards(JwtAuthGuard)
export class CharactersController {
  constructor(private readonly characters: CharactersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown> {
    return this.characters.list(user.sub, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: CreateCharacterDto,
  ): Promise<unknown> {
    return this.characters.create(user.sub, projectId, dto);
  }

  @Patch(':characterId')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('characterId', ParseIntPipe) characterId: number,
    @Body() dto: UpdateCharacterDto,
  ): Promise<unknown> {
    return this.characters.update(user.sub, projectId, characterId, dto);
  }

  @Delete(':characterId')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('characterId', ParseIntPipe) characterId: number,
  ): Promise<unknown> {
    return this.characters.remove(user.sub, projectId, characterId);
  }
}
