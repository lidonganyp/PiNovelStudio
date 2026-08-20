/**
 * Prisma 客户端服务：封装数据库连接，并对 novel_billing_adjustment
 * 强制只追加（拒绝 update/delete/upsert，含事务内操作）。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

function createGuardedPrisma() {
  return new PrismaClient().$extends({
    name: 'adjustment-append-only',
    query: {
      novelBillingAdjustment: {
        async $allOperations({ operation, args, query }) {
          if (
            operation === 'update' ||
            operation === 'updateMany' ||
            operation === 'delete' ||
            operation === 'deleteMany' ||
            operation === 'upsert'
          ) {
            throw new Error('novel_billing_adjustment is append-only');
          }
          return query(args);
        },
      },
    },
  });
}

type GuardedPrisma = ReturnType<typeof createGuardedPrisma>;

/** 将扩展后的 Prisma Client 成员暴露到 Nest 注入对象上。 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- 声明合并是为了保留 prisma.user / $transaction 的类型
export interface PrismaService extends GuardedPrisma {}

@Injectable()
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- 与上面对应
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly db: GuardedPrisma = createGuardedPrisma();

  constructor() {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop, receiver);
        }
        const value = Reflect.get(target.db, prop) as unknown;
        if (typeof value === 'function') {
          return (value as (...args: unknown[]) => unknown).bind(target.db);
        }
        return value;
      },
    }) as PrismaService;
  }

  /** 模块初始化时建立数据库连接。 */
  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    this.logger.log('Prisma 数据库连接已建立');
  }

  /** 模块销毁时断开数据库连接。 */
  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
