/**
 * 费率快照与 Provider 凭证下发结构。
 */

export interface RateSnapshot {
  modelKey: string;
  displayName: string;
  providerKey: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  effectiveFrom: string;
}

export interface ProviderCredential {
  providerKey: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  enabled: boolean;
}
