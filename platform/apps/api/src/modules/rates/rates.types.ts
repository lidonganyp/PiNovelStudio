/**
 * 费率快照与 Provider 凭证下发结构。
 */

export interface RateSnapshot {
  modelKey: string;
  displayName: string;
  providerKey: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  /** 结算倍率（百分比整数，100=1.0 倍）；旧快照缺省按 100。 */
  multiplierPercent?: number;
  effectiveFrom: string;
}

export interface ProviderCredential {
  providerKey: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  enabled: boolean;
}
