/**
 * Estruturas e ligações de transporte do x402 v2.
 *
 * Suporta os dois transportes que interessam ao PayGate:
 *  - MCP:  desafio via tool result com `isError: true`; pagamento em
 *          `params._meta["x402/payment"]`; recibo em `_meta["x402/payment-response"]`.
 *  - HTTP: desafio no header `PAYMENT-REQUIRED`; pagamento em `PAYMENT-SIGNATURE`;
 *          recibo em `PAYMENT-RESPONSE`. Todos em JSON codificado em base64.
 */

import { centsToUsdcUnits, type NetworkConfig } from './config';

export const X402_VERSION = 2;
export const MCP_PAYMENT_KEY = 'x402/payment';
export const MCP_PAYMENT_RESPONSE_KEY = 'x402/payment-response';

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

// ───────────────────────── Construção do desafio ─────────────────────────

export function buildPaymentRequirements(
  network: NetworkConfig,
  priceCents: number,
  payTo: string,
  maxTimeoutSeconds = 120,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: network.caip2,
    amount: centsToUsdcUnits(priceCents),
    asset: network.usdcAddress,
    payTo,
    maxTimeoutSeconds,
    extra: {
      name: network.usdcDomainName,
      version: network.usdcDomainVersion,
    },
  };
}

export function buildPaymentRequired(
  requirements: PaymentRequirements[],
  resource: ResourceInfo,
  error = 'Payment required to access this resource',
  extensions: Record<string, unknown> = {},
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error,
    resource,
    accepts: requirements,
    extensions,
  };
}

/**
 * Extensão `bazaar`: descreve a ferramenta no próprio desafio para que o
 * facilitator possa catalogá-la no serviço de descoberta. É assim que um
 * serviço x402 vira encontrável — não há formulário de submissão.
 */
export function buildBazaarExtension(
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    info: {
      input: {
        type: 'mcp',
        toolName,
        description,
        transport: 'streamable-http',
        inputSchema,
      },
      output: { type: 'json' },
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'mcp' },
            toolName: { type: 'string' },
            description: { type: 'string' },
            transport: { type: 'string', enum: ['streamable-http', 'sse'] },
            inputSchema: { type: 'object' },
            example: { type: 'object' },
          },
          required: ['type', 'toolName', 'inputSchema'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { type: { type: 'string' }, example: { type: 'object' } },
          required: ['type'],
        },
      },
      required: ['input'],
    },
  };
}

// ───────────────────────── Transporte MCP ─────────────────────────

/**
 * Resultado de tool que sinaliza pagamento necessário. A especificação exige o
 * mesmo objeto em `structuredContent` e serializado em `content[0].text`.
 */
export function buildMcpPaymentRequiredResult(id: unknown, paymentRequired: PaymentRequired) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      structuredContent: paymentRequired,
      content: [{ type: 'text', text: JSON.stringify(paymentRequired) }],
    },
  };
}

/** Lê o pagamento enviado pelo agente em `params._meta["x402/payment"]`. */
export function extractMcpPayment(body: any): PaymentPayload | null {
  const candidate = body?.params?._meta?.[MCP_PAYMENT_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  if (!candidate.payload || !candidate.accepted) return null;
  return candidate as PaymentPayload;
}

/** Remove o pagamento antes de repassar a chamada ao servidor do desenvolvedor. */
export function stripMcpPayment(body: any): any {
  if (!body?.params?._meta?.[MCP_PAYMENT_KEY]) return body;
  const clone = JSON.parse(JSON.stringify(body));
  delete clone.params._meta[MCP_PAYMENT_KEY];
  if (Object.keys(clone.params._meta).length === 0) delete clone.params._meta;
  return clone;
}

/** Anexa o recibo de liquidação ao resultado da tool. */
export function attachMcpPaymentResponse(response: any, settlement: Record<string, unknown>): any {
  if (!response || typeof response !== 'object' || !response.result) return response;
  const result = response.result;
  result._meta = { ...(result._meta || {}), [MCP_PAYMENT_RESPONSE_KEY]: settlement };
  return response;
}

// ───────────────────────── Transporte HTTP ─────────────────────────

export function encodeHeaderValue(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeaderValue<T>(value: string): T | null {
  try {
    const bin = atob(value.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    // Tolera clientes que enviam JSON puro em vez de base64.
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
}

export function extractHttpPayment(headerValue?: string | null): PaymentPayload | null {
  if (!headerValue) return null;
  const decoded = decodeHeaderValue<PaymentPayload>(headerValue);
  if (!decoded || !decoded.payload || !decoded.accepted) return null;
  return decoded;
}

// ───────────────────────── Validação ─────────────────────────

/**
 * Confere se o requisito escolhido pelo agente corresponde ao que o servidor
 * exige. O `accepted` vem do cliente e não pode ser tratado como confiável: sem
 * esta checagem, um agente poderia declarar ter aceitado um valor menor.
 */
export function matchesRequirements(
  accepted: PaymentRequirements,
  expected: PaymentRequirements,
): { ok: boolean; reason?: string } {
  if (accepted.scheme !== expected.scheme) {
    return { ok: false, reason: `scheme divergente: ${accepted.scheme} != ${expected.scheme}` };
  }
  if (accepted.network !== expected.network) {
    return { ok: false, reason: `rede divergente: ${accepted.network} != ${expected.network}` };
  }
  if (accepted.asset?.toLowerCase() !== expected.asset.toLowerCase()) {
    return { ok: false, reason: `asset divergente: ${accepted.asset} != ${expected.asset}` };
  }
  if (accepted.payTo?.toLowerCase() !== expected.payTo.toLowerCase()) {
    return { ok: false, reason: `destinatário divergente: ${accepted.payTo} != ${expected.payTo}` };
  }
  try {
    if (BigInt(accepted.amount) < BigInt(expected.amount)) {
      return { ok: false, reason: `valor insuficiente: ${accepted.amount} < ${expected.amount}` };
    }
  } catch {
    return { ok: false, reason: `valor inválido: ${accepted.amount}` };
  }
  return { ok: true };
}

/**
 * Traduz os códigos do facilitator em instruções acionáveis. As mensagens vão
 * para agentes de IA de qualquer país, por isso ficam em inglês.
 */
export function describeInvalidReason(reason?: string): string {
  const code = (reason || '').toLowerCase();
  const known: Record<string, string> = {
    insufficient_funds:
      'the paying wallet does not hold enough USDC on this network. Fund it and retry.',
    invalid_payload:
      'the facilitator could not execute the authorization — most often the wallet holds no USDC on this network, or the nonce was already used. Fund the wallet and retry with a fresh nonce.',
    invalid_exact_evm_payload_signature:
      'the EIP-712 signature does not match. Sign TransferWithAuthorization using the exact domain from the challenge (name and version come from `accepts[].extra`).',
    invalid_exact_evm_signature:
      'the EIP-712 signature does not match. Sign TransferWithAuthorization using the exact domain from the challenge (name and version come from `accepts[].extra`).',
    invalid_exact_evm_payload_authorization_valid_before:
      'the authorization expired. Set validBefore far enough ahead to allow settlement.',
    invalid_exact_evm_payload_authorization_valid_after:
      'the authorization is not valid yet. Set validAfter to a timestamp already in the past.',
    invalid_network: 'the network does not match the challenge. Use the `network` value from `accepts[]`.',
    invalid_scheme: 'the scheme does not match the challenge. Use the `scheme` value from `accepts[]`.',
    unsupported_scheme: 'the facilitator does not support this scheme on this network.',
  };
  const detail = known[code];
  return detail ? `${reason} — ${detail}` : reason || 'no reason reported by the facilitator';
}

/**
 * Identificador estável do pagamento, usado para bloquear replay. Para o schema
 * `exact` o nonce da autorização EIP-3009 é único por pagamento.
 */
export async function paymentFingerprint(payment: PaymentPayload): Promise<string> {
  const auth = (payment.payload as any)?.authorization;
  const basis =
    auth?.nonce && auth?.from
      ? `${payment.accepted.network}:${auth.from}:${auth.nonce}`
      : JSON.stringify(payment.payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
