/**
 * 模块说明：platform-api 应用入口（NestJS + Fastify）。
 * 全局前缀 /api（排除 /internal）；CORS 白名单来自 env；全局 ValidationPipe
 * 与异常过滤器在 AppModule 中以 APP_PIPE/APP_FILTER 注册。
 */
import './config/load-env-file';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { AppModule } from './app.module';
import { configureHttpApp } from './configure-http';
import { env } from './config/env';
import { resolveWebDist } from './common/spa';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
    { bufferLogs: true, rawBody: true },
  );
  app.useLogger(app.get(Logger));
  configureHttpApp(app);
  const webDist = resolveWebDist(env.NODE_ENV, env.WEB_DIST_DIR);
  if (webDist) {
    const fastify = app.getHttpAdapter().getInstance();
    const indexHtml = readFileSync(resolve(webDist, 'index.html'));
    await fastify.register(
      fastifyStatic as unknown as Parameters<typeof fastify.register>[0],
      { root: webDist, wildcard: false },
    );
    // NestJS 11 在 init 阶段无条件注册自身的 notFoundHandler，而 Fastify
    // 对同一前缀仅允许设置一次；此处若再调 setNotFoundHandler 会在启动时
    // 抛出 "Not found handler already set"。改用最低优先级通配路由实现
    // 相同的 SPA 回退语义：/api 与 /internal 仍返回 JSON 404，其余回 index.html。
    fastify.get('/*', (request, reply) => {
      const url = request.raw.url ?? '';
      if (url.startsWith('/api') || url.startsWith('/internal')) {
        return reply.status(404).send({ statusCode: 404, message: 'Not Found' });
      }
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
  }
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

void bootstrap();
