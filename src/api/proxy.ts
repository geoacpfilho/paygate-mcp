import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { developers, registeredTools, transactions, processedPaymentProofs } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { verifyStripeMppPayment, processDevPayout } from '../services/payment-verifier';
import { resolveNetwork } from '../x402/config';
import { verifyPayment, settlePayment } from '../x402/facilitator';
import {
  buildPaymentRequirements,
  buildPaymentRequired,
  buildBazaarExtension,
  buildMcpPaymentRequiredResult,
  extractMcpPayment,
  extractHttpPayment,
  stripMcpPayment,
  attachMcpPaymentResponse,
  encodeHeaderValue,
  matchesRequirements,
  describeInvalidReason,
  paymentFingerprint,
  type PaymentPayload,
  type PaymentRequirements,
} from '../x402/protocol';

const DEFAULT_PAYGATE_WALLET = '0x82e36db0d0001d9c1f12a1b6761fbbad48f0999e';

/** Endereço EVM válido: 0x seguido de 40 dígitos hexadecimais. */
export function isEvmAddress(value?: string | null): boolean {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}
const STRIPE_TOKEN_PREFIXES = ['pm_', 'tok_', 'spt_'];

async function proxyFetch(c: Context, targetUrl: string, body: any): Promise<Response> {
  const isB2R = targetUrl.includes('oraculo-b2r');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'PayGate-MCP-Proxy/0.2.0',
  };

  // Token do servidor de destino. Mantido configurável; o valor antigo segue
  // como padrão para não quebrar o backend já em produção.
  const upstreamToken = c.env.UPSTREAM_AUTH_TOKEN || 'spt_test';
  headers['Authorization'] = `Bearer ${upstreamToken}`;

  const request = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (isB2R && c.env.ORACULO_B2R) {
    return c.env.ORACULO_B2R.fetch(request);
  }
  return fetch(request);
}

/** Busca o esquema de entrada da ferramenta no servidor do desenvolvedor. */
async function fetchUpstreamToolSchema(
  c: Context,
  targetUrl: string,
  toolName: string,
): Promise<{ description?: string; inputSchema: Record<string, unknown> } | null> {
  const resp = await proxyFetch(c, targetUrl, {
    jsonrpc: '2.0',
    id: 'schema-lookup',
    method: 'tools/list',
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  const tool = (data?.result?.tools || []).find((t: any) => t.name === toolName);
  if (!tool?.inputSchema) return null;
  return { description: tool.description, inputSchema: tool.inputSchema };
}

function jsonRpcError(c: Context, id: unknown, code: number, message: string, status = 200) {
  return c.json({ jsonrpc: '2.0', id, error: { code, message } }, status as any);
}

/** Erro de pagamento devolvido como tool result, para o agente conseguir ler. */
function toolError(c: Context, id: unknown, message: string) {
  return c.json({
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{ type: 'text', text: message }],
    },
  });
}

function isStripeToken(authHeader?: string | null): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return STRIPE_TOKEN_PREFIXES.some((p) => token.startsWith(p));
}

export async function mcpProxyHandler(c: Context) {
  const devId = c.req.param('devId');
  if (!devId) {
    return c.json({ error: 'devId não informado na URL.' }, 400);
  }

  const db = drizzle(c.env.DB);
  const devList = await db.select().from(developers).where(eq(developers.id, devId)).limit(1);

  if (devList.length === 0 || !devList[0].isActive) {
    return c.json({ error: 'Desenvolvedor não encontrado ou inativo.' }, 404);
  }

  const dev = devList[0];

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return jsonRpcError(c, body?.id ?? null, -32600, 'Requisição JSON-RPC 2.0 inválida.', 400);
  }

  // Notificações não têm resposta.
  if (body.id === undefined || body.id === null) {
    if (body.method?.startsWith('notifications/')) {
      return new Response(null, { status: 204 });
    }
  }

  // ── 1. Descoberta: gratuita, repassada ao servidor do desenvolvedor ──
  if (['initialize', 'tools/list', 'resources/list', 'prompts/list', 'ping'].includes(body.method)) {
    try {
      const resp = await proxyFetch(c, dev.targetServerUrl, body);
      const text = await resp.text();
      try {
        return c.json(JSON.parse(text), resp.status as any);
      } catch {
        return jsonRpcError(
          c,
          body.id,
          -32603,
          `Resposta inválida do servidor de destino: ${text.substring(0, 200)}`,
          502,
        );
      }
    } catch (e: any) {
      return jsonRpcError(c, body.id, -32603, `Erro de comunicação com o destino: ${e.message}`, 502);
    }
  }

  // ── 2. Execução de ferramenta: exige pagamento ──
  if (body.method !== 'tools/call') {
    return jsonRpcError(c, body.id, -32601, `Método ${body.method} não suportado pelo proxy.`);
  }

  const toolName = body.params?.name;
  if (!toolName) {
    return jsonRpcError(c, body.id, -32602, 'Nome da ferramenta não especificado.');
  }

  const toolConfig = await db
    .select()
    .from(registeredTools)
    .where(and(eq(registeredTools.developerId, devId), eq(registeredTools.toolName, toolName)))
    .limit(1);

  const priceCents = toolConfig.length > 0 ? toolConfig[0].priceCents : 5;
  const network = resolveNetwork(c.env.X402_NETWORK);
  const paygateWallet = c.env.PAYGATE_WALLET_ADDRESS || DEFAULT_PAYGATE_WALLET;
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || network.defaultFacilitator;
  const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';

  // O pagamento vai direto para a carteira do vendedor. O PayGate não custodia
  // dinheiro alheio: não há saldo a repassar, nada a reter e nada que possa
  // falhar entre receber e pagar. Sem carteira declarada (caso Stripe), o valor
  // cai na carteira do PayGate e o repasse segue pelo caminho antigo.
  const payTo = isEvmAddress(dev.walletAddress) ? dev.walletAddress! : paygateWallet;
  const directToSeller = payTo.toLowerCase() !== paygateWallet.toLowerCase();

  const expected: PaymentRequirements = buildPaymentRequirements(network, priceCents, payTo);
  const resourceInfo = {
    url: `mcp://tool/${toolName}`,
    description: toolConfig.length > 0 ? toolConfig[0].description || toolName : toolName,
    mimeType: 'application/json',
    serviceName: dev.name,
    iconUrl: `https://${host}/icon.svg`,
  };

  const authHeader = c.req.header('Authorization');
  const stripeAttempt = isStripeToken(authHeader);

  const payment: PaymentPayload | null =
    extractMcpPayment(body) || extractHttpPayment(c.req.header('PAYMENT-SIGNATURE'));

  // ── 2a. Sem pagamento: devolver o desafio x402 ──
  if (!payment && !stripeAttempt) {
    // O esquema da ferramenta vem do servidor de destino e alimenta a extensão
    // bazaar, que é o que torna o serviço encontrável pelo facilitator.
    let extensions: Record<string, unknown> = {};
    try {
      const schema = await fetchUpstreamToolSchema(c, dev.targetServerUrl, toolName);
      if (schema) {
        extensions = {
          bazaar: buildBazaarExtension(
            toolName,
            schema.description || resourceInfo.description,
            schema.inputSchema,
          ),
        };
      }
    } catch {
      // Catálogo é opcional: sem o esquema, o desafio segue válido.
    }

    const paymentRequired = buildPaymentRequired(
      [expected],
      resourceInfo,
      `Payment required: ${toolName} custa $${(priceCents / 100).toFixed(2)} USDC.`,
      extensions,
    );

    // Header base64 para clientes que falam o transporte HTTP do x402.
    c.header('PAYMENT-REQUIRED', encodeHeaderValue(paymentRequired));

    // O transporte MCP exige status 200 com tool result isError — um 402 seria
    // tratado como falha de transporte pela maioria dos clientes MCP.
    return c.json(buildMcpPaymentRequiredResult(body.id, paymentRequired));
  }

  // ── 2b. Caminho Stripe (mantido para ferramentas acima de $0.50) ──
  if (!payment && stripeAttempt) {
    const verification = await verifyStripeMppPayment(authHeader!, priceCents, c.env.STRIPE_SECRET_KEY);
    if (!verification.success) {
      return toolError(c, body.id, verification.errorMessage || 'Pagamento Stripe recusado.');
    }
    return executeAndRecord(c, {
      db,
      dev,
      devId,
      toolName,
      body,
      priceCents,
      paymentMethod: 'stripe_mpp',
      txReference: verification.txHashOrId || null,
      proofHash: await sha256Hex(`stripe:${verification.txHashOrId}`),
      directToSeller: false,
      settle: null,
    });
  }

  // ── 2c. Caminho x402 ──
  const match = matchesRequirements(payment!.accepted, expected);
  if (!match.ok) {
    return toolError(
      c,
      body.id,
      `Pagamento não corresponde ao exigido (${match.reason}). Refaça a chamada usando o desafio devolvido por esta ferramenta.`,
    );
  }

  const proofHash = await paymentFingerprint(payment!);
  const existing = await db
    .select()
    .from(processedPaymentProofs)
    .where(eq(processedPaymentProofs.proofHash, proofHash))
    .limit(1);
  if (existing.length > 0) {
    return toolError(c, body.id, 'Replay detectado: este pagamento já foi utilizado.');
  }

  // Verificar a assinatura antes de gastar trabalho no servidor do dev.
  const verification = await verifyPayment(facilitatorUrl, payment!, expected, {
    apiKeyId: c.env.CDP_API_KEY_ID,
    apiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  if (!verification.isValid) {
    return toolError(c, body.id, `Payment rejected: ${describeInvalidReason(verification.invalidReason)}`);
  }

  return executeAndRecord(c, {
    db,
    dev,
    devId,
    toolName,
    body,
    priceCents,
    paymentMethod: 'x402',
    txReference: null,
    proofHash,
    directToSeller,
    settle: { facilitatorUrl, payment: payment!, requirements: expected },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface ExecuteArgs {
  db: any;
  dev: any;
  devId: string;
  toolName: string;
  body: any;
  priceCents: number;
  paymentMethod: 'x402' | 'stripe_mpp';
  txReference: string | null;
  proofHash: string;
  /** true quando o pagamento vai direto do agente para a carteira do vendedor. */
  directToSeller: boolean;
  settle: { facilitatorUrl: string; payment: PaymentPayload; requirements: PaymentRequirements } | null;
}

/**
 * Executa a ferramenta no servidor do desenvolvedor e só então liquida o
 * pagamento: se a execução falhar, nada é cobrado.
 */
async function executeAndRecord(c: Context, args: ExecuteArgs) {
  const { db, dev, devId, toolName, body, priceCents, paymentMethod, proofHash, settle } = args;

  const grossCents = priceCents;
  // Sem piso de 1 centavo: em micropagamentos ele transformava os 2% anunciados
  // em 20–50% reais. Abaixo de meio centavo a comissão é zero, e tudo bem.
  const commissionCents = args.directToSeller
    ? 0
    : Math.round(grossCents * (dev.commissionRate || 0.02));
  const netCents = grossCents - commissionCents;
  const txId = `tx_${nanoid(12)}`;

  // Reserva o comprovante antes de executar: o PK bloqueia replay concorrente.
  try {
    await db.insert(transactions).values({
      id: txId,
      developerId: devId,
      toolName,
      agentId: c.req.header('User-Agent') || 'agent_unknown',
      paymentMethod,
      grossAmountCents: grossCents,
      commissionCents,
      netAmountCents: netCents,
      status: 'pending',
      txHash: null,
      stripePaymentId: paymentMethod === 'stripe_mpp' ? args.txReference : null,
      splitStatus: 'pending',
      splitCompletedAt: null,
    });
    await db.insert(processedPaymentProofs).values({ proofHash, transactionId: txId });
  } catch (e: any) {
    return toolError(c, body.id, 'Replay detectado: este pagamento já está em processamento.');
  }

  // Executar a ferramenta sem repassar os dados de pagamento adiante.
  let responseData: any;
  let upstreamStatus = 200;
  try {
    const resp = await proxyFetch(c, dev.targetServerUrl, stripMcpPayment(body));
    upstreamStatus = resp.status;
    responseData = await resp.json();
  } catch (e: any) {
    await db.update(transactions).set({ status: 'failed' }).where(eq(transactions.id, txId));
    return toolError(c, body.id, `Upstream execution failed: ${e.message}. You were not charged.`);
  }

  // O servidor de destino pode devolver HTTP 200 com um resultado de erro — é
  // assim que um servidor MCP sinaliza falha (isError) ou esgotamento de quota.
  // Cobrar nesse caso seria vender uma mensagem de erro ao agente.
  const upstreamFailed =
    Boolean(responseData?.error) || responseData?.result?.isError === true;

  if (upstreamFailed) {
    const detail =
      responseData?.error?.message ||
      responseData?.result?.content?.[0]?.text ||
      'the upstream server returned an error result';
    await db.update(transactions).set({ status: 'upstream_error' }).where(eq(transactions.id, txId));
    return toolError(
      c,
      body.id,
      `Tool did not deliver a result, so no payment was taken. Upstream said: ${String(detail).slice(0, 300)}`,
    );
  }

  // Liquidar on-chain só depois de a ferramenta ter respondido.
  let settlementInfo: Record<string, unknown> = {
    success: true,
    payer: null,
    transaction: args.txReference,
    network: null,
  };

  if (settle) {
    const result = await settlePayment(settle.facilitatorUrl, settle.payment, settle.requirements, {
      apiKeyId: c.env.CDP_API_KEY_ID,
      apiKeySecret: c.env.CDP_API_KEY_SECRET,
    });

    if (!result.success) {
      await db.update(transactions).set({ status: 'settlement_failed' }).where(eq(transactions.id, txId));
      return toolError(
        c,
        body.id,
        `Payment verified but settlement failed: ${describeInvalidReason(result.errorReason)}. You were not charged.`,
      );
    }

    settlementInfo = {
      success: true,
      payer: result.payer ?? null,
      transaction: result.transaction ?? null,
      network: result.network ?? settle.requirements.network,
    };

    await db
      .update(transactions)
      .set({ status: 'completed', txHash: result.transaction || null })
      .where(eq(transactions.id, txId));
  } else {
    await db.update(transactions).set({ status: 'completed' }).where(eq(transactions.id, txId));
  }

  // Repasse ao desenvolvedor. No modo direto o agente já pagou a carteira do
  // vendedor on-chain, então não existe transferência a fazer — o dinheiro
  // nunca passou pelo PayGate. Só o caminho Stripe ainda envolve repasse.
  if (args.directToSeller) {
    await db
      .update(transactions)
      .set({ splitStatus: 'direct', splitCompletedAt: new Date().toISOString() })
      .where(eq(transactions.id, txId));
  } else if (paymentMethod === 'x402') {
    // Carteira do vendedor é a do próprio PayGate: já chegou ao destino.
    await db
      .update(transactions)
      .set({ splitStatus: 'completed', splitCompletedAt: new Date().toISOString() })
      .where(eq(transactions.id, txId));
  } else {
    const payout = await processDevPayout(
      paymentMethod,
      netCents,
      dev.walletAddress,
      dev.stripeAccountId,
      c.env.STRIPE_SECRET_KEY,
      c.env.CDP_API_KEY_ID,
      c.env.CDP_API_KEY_SECRET,
    );
    await db
      .update(transactions)
      .set({
        splitStatus: payout.success ? 'completed' : 'pending',
        splitCompletedAt: payout.success ? new Date().toISOString() : null,
      })
      .where(eq(transactions.id, txId));
  }

  const receipt = {
    ...settlementInfo,
    amount_usd: (priceCents / 100).toFixed(2),
    paid_directly_to_seller: args.directToSeller,
    paygate_fee_usd: (commissionCents / 100).toFixed(3),
    seller_net_usd: (netCents / 100).toFixed(3),
  };

  c.header('PAYMENT-RESPONSE', encodeHeaderValue(receipt));
  return c.json(attachMcpPaymentResponse(responseData, receipt), upstreamStatus as any);
}
