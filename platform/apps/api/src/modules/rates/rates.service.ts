/**
 * 费率服务：按 effectiveFrom 取调用时刻生效费率，构造不可变快照；
 * 下发已启用 Provider 的解密凭证。
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decryptSecret } from '../../common/crypto/aes-gcm';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderCredential, RateSnapshot } from './rates.types';

/** 后台常填展示名时，仍用于 Gemini 写作链路计费。 */
const MODEL_RATE_ALIASES: Record<string, string[]> = {
  v2_rawstage2_gemini31: ['gemini-3.7-flash', 'gemini'],
  v2_amplified_gemini31: ['gemini-3.7-flash', 'gemini'],
};

@Injectable()
export class RatesService {
  private readonly logger = new Logger(RatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 取 modelKey 在 at 时刻已生效且 enabled 的最新费率。 */
  async findEffectiveRate(
    modelKey: string,
    at: Date = new Date(),
  ): Promise<Prisma.ModelRateGetPayload<{ include: { provider: true } }>> {
    const keys = [modelKey, ...(MODEL_RATE_ALIASES[modelKey] ?? [])];
    for (const key of keys) {
      const rate = await this.prisma.modelRate.findFirst({
        where: {
          modelKey: key,
          enabled: true,
          effectiveFrom: { lte: at },
          provider: { is: { enabled: true } },
        },
        orderBy: { effectiveFrom: 'desc' },
        include: { provider: true },
      });
      if (rate) {
        if (key !== modelKey) {
          this.logger.log(`using rate alias ${key} for ${modelKey}`);
        }
        return rate;
      }
    }
    throw new NotFoundException(`未找到模型 ${modelKey} 的生效费率`);
  }

  /** 构造结算用费率快照（单价以分的字符串落库）。 */
  async buildRateSnapshot(
    modelKey: string,
    at: Date = new Date(),
  ): Promise<RateSnapshot> {
    const rate = await this.findEffectiveRate(modelKey, at);
    return {
      modelKey: rate.modelKey,
      displayName: rate.displayName,
      providerKey: rate.provider.providerKey,
      inputPricePerMillion: rate.inputPricePerMillion.toString(),
      outputPricePerMillion: rate.outputPricePerMillion.toString(),
      multiplierPercent: rate.multiplierPercent,
      effectiveFrom: rate.effectiveFrom.toISOString(),
    };
  }

  /** 下发 enabled=true 的 Provider 凭证；单条解密失败则跳过并记日志。 */
  async listEnabledCredentials(): Promise<ProviderCredential[]> {
    const providers = await this.prisma.modelProvider.findMany({
      where: { enabled: true },
      orderBy: { id: 'asc' },
    });
    const result: ProviderCredential[] = [];
    for (const provider of providers) {
      try {
        result.push({
          providerKey: provider.providerKey,
          name: provider.name,
          apiBaseUrl: provider.apiBaseUrl,
          apiKey: decryptSecret(provider.apiKeyEncrypted, env.AES_MASTER_KEY),
          enabled: provider.enabled,
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `跳过无法解密的 provider ${provider.providerKey}: ${message}`,
        );
      }
    }
    return result;
  }
}
