/**
 * Cliente do facilitator x402 v2 (/verify e /settle).
 *
 * Facilitators públicos (testnet) não exigem autenticação. O facilitator da
 * Coinbase CDP, único que liquida na Base mainnet, exige um Bearer JWT assinado
 * com a chave de API — EdDSA para as chaves atuais, ES256 para as antigas.
 */

import type { PaymentPayload, PaymentRequirements } from './protocol';

export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface SettleResult {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  errorReason?: string;
}

export interface FacilitatorCredentials {
  apiKeyId?: string | null;
  apiKeySecret?: string | null;
}

// ───────────────────────── JWT para a API CDP ─────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return base64ToBytes(body);
}

/**
 * Gera o Bearer JWT exigido pela API CDP. O token é escopado para um único
 * método+URI e expira em 2 minutos, então é gerado a cada chamada.
 */
async function createCdpJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  requestUrl: string,
): Promise<string> {
  const url = new URL(requestUrl);
  const uri = `${method} ${url.host}${url.pathname}`;
  const now = Math.floor(Date.now() / 1000);

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const payload = {
    iss: 'cdp',
    sub: apiKeyId,
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uris: [uri],
  };

  const isPem = apiKeySecret.includes('-----BEGIN');

  if (isPem) {
    // Chave legada: EC P-256, assinatura ES256.
    const header = { alg: 'ES256', typ: 'JWT', kid: apiKeyId, nonce };
    const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
      JSON.stringify(payload),
    )}`;

    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(apiKeySecret) as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  // Chave atual: Ed25519, assinatura EdDSA. O segredo é base64 de 64 bytes
  // (32 de seed + 32 de chave pública).
  const header = { alg: 'EdDSA', typ: 'JWT', kid: apiKeyId, nonce };
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(payload),
  )}`;

  const raw = base64ToBytes(apiKeySecret);
  if (raw.length !== 64) {
    throw new Error(
      `Chave CDP Ed25519 inválida: esperado 64 bytes após decodificar base64, recebido ${raw.length}.`,
    );
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'OKP',
      crv: 'Ed25519',
      d: base64UrlEncode(raw.slice(0, 32)),
      x: base64UrlEncode(raw.slice(32)),
    },
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ───────────────────────── Chamadas ao facilitator ─────────────────────────

async function callFacilitator(
  facilitatorUrl: string,
  path: '/verify' | '/settle',
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  credentials: FacilitatorCredentials,
): Promise<{ ok: boolean; status: number; data: any; rawText?: string }> {
  const url = `${facilitatorUrl.replace(/\/+$/, '')}${path}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials.apiKeyId && credentials.apiKeySecret) {
    const jwt = await createCdpJwt(credentials.apiKeyId, credentials.apiKeySecret, 'POST', url);
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    }),
  });

  const rawText = await resp.text();
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    // Facilitator devolveu HTML/texto — normalmente URL errada ou 404.
    return { ok: false, status: resp.status, data: null, rawText };
  }
  return { ok: resp.ok, status: resp.status, data };
}

function describeNonJson(status: number, rawText?: string): string {
  const snippet = (rawText || '').slice(0, 120).replace(/\s+/g, ' ').trim();
  return `facilitator respondeu ${status} sem JSON (verifique X402_FACILITATOR_URL): ${snippet}`;
}

/**
 * Consulta `/supported` do facilitator. Serve como diagnóstico: confirma a URL,
 * a autenticação CDP e se a rede configurada é de fato liquidável ali.
 */
export async function probeFacilitator(
  facilitatorUrl: string,
  credentials: FacilitatorCredentials = {},
): Promise<{ reachable: boolean; authenticated: boolean; status: number; networks: string[]; detail?: string }> {
  const url = `${facilitatorUrl.replace(/\/+$/, '')}/supported`;
  try {
    const headers: Record<string, string> = {};
    let authenticated = false;
    if (credentials.apiKeyId && credentials.apiKeySecret) {
      headers['Authorization'] = `Bearer ${await createCdpJwt(
        credentials.apiKeyId,
        credentials.apiKeySecret,
        'GET',
        url,
      )}`;
      authenticated = true;
    }

    const resp = await fetch(url, { headers });
    const text = await resp.text();
    let networks: string[] = [];
    try {
      const data = JSON.parse(text);
      networks = [...new Set((data.kinds || []).map((k: any) => String(k.network)))] as string[];
    } catch {
      return {
        reachable: false,
        authenticated,
        status: resp.status,
        networks: [],
        detail: text.slice(0, 160).replace(/\s+/g, ' ').trim(),
      };
    }
    return {
      reachable: resp.ok,
      authenticated,
      status: resp.status,
      networks,
      detail: resp.ok ? undefined : text.slice(0, 160),
    };
  } catch (e: any) {
    return { reachable: false, authenticated: false, status: 0, networks: [], detail: e.message };
  }
}

export async function verifyPayment(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  credentials: FacilitatorCredentials = {},
): Promise<VerifyResult> {
  try {
    const { ok, status, data, rawText } = await callFacilitator(
      facilitatorUrl,
      '/verify',
      paymentPayload,
      paymentRequirements,
      credentials,
    );

    if (!data) {
      return { isValid: false, invalidReason: describeNonJson(status, rawText) };
    }
    if (!ok && data.isValid === undefined) {
      return {
        isValid: false,
        invalidReason: data.error || data.message || `facilitator retornou HTTP ${status}`,
      };
    }
    return {
      isValid: data.isValid === true,
      payer: data.payer,
      invalidReason: data.invalidReason,
    };
  } catch (e: any) {
    return { isValid: false, invalidReason: `erro ao contactar o facilitator: ${e.message}` };
  }
}

export async function settlePayment(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  credentials: FacilitatorCredentials = {},
): Promise<SettleResult> {
  try {
    const { ok, status, data, rawText } = await callFacilitator(
      facilitatorUrl,
      '/settle',
      paymentPayload,
      paymentRequirements,
      credentials,
    );

    if (!data) {
      return { success: false, errorReason: describeNonJson(status, rawText) };
    }
    if (!ok && data.success === undefined) {
      return {
        success: false,
        errorReason: data.error || data.message || `facilitator retornou HTTP ${status}`,
      };
    }
    return {
      success: data.success === true,
      payer: data.payer,
      transaction: data.transaction,
      network: data.network,
      errorReason: data.errorReason,
    };
  } catch (e: any) {
    return { success: false, errorReason: `erro ao liquidar no facilitator: ${e.message}` };
  }
}
