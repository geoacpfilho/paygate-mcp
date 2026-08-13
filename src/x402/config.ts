/**
 * Registro de redes x402 v2.
 *
 * As redes são identificadas por CAIP-2 (`eip155:<chainId>`), conforme exigido
 * pela especificação v2. O nome do domínio EIP-712 do USDC difere entre redes
 * ("USD Coin" na mainnet, "USDC" na sepolia) e uma divergência aqui faz o
 * facilitator rejeitar assinaturas válidas.
 */

export interface NetworkConfig {
  /** Identificador CAIP-2 usado no campo `network` do PaymentRequirements. */
  caip2: string;
  chainId: number;
  usdcAddress: string;
  /** Campo `name` do domínio EIP-712 do contrato USDC. */
  usdcDomainName: string;
  usdcDomainVersion: string;
  isTestnet: boolean;
  /** Facilitator público que atende esta rede, quando existe. */
  defaultFacilitator: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  'eip155:8453': {
    caip2: 'eip155:8453',
    chainId: 8453,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
    isTestnet: false,
    // Único facilitator que liquida na Base mainnet; exige credenciais CDP.
    defaultFacilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  },
  'eip155:84532': {
    caip2: 'eip155:84532',
    chainId: 84532,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
    isTestnet: true,
    defaultFacilitator: 'https://x402.org/facilitator',
  },
};

export const DEFAULT_NETWORK = 'eip155:8453';

/** Aliases legados aceitos em X402_NETWORK para conveniência. */
const ALIASES: Record<string, string> = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  sepolia: 'eip155:84532',
};

export function resolveNetwork(value?: string | null): NetworkConfig {
  if (!value) return NETWORKS[DEFAULT_NETWORK];
  const key = ALIASES[value.toLowerCase()] ?? value;
  return NETWORKS[key] ?? NETWORKS[DEFAULT_NETWORK];
}

/**
 * Converte centavos de dólar para a unidade base do USDC (6 casas decimais).
 * $0.05 -> 5 centavos -> "50000".
 */
export function centsToUsdcUnits(cents: number): string {
  return String(BigInt(Math.round(cents)) * 10000n);
}

/** Converte unidades base do USDC de volta para centavos (trunca). */
export function usdcUnitsToCents(units: string): number {
  try {
    return Number(BigInt(units) / 10000n);
  } catch {
    return 0;
  }
}
