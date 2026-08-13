import Stripe from 'stripe';

export interface PaymentVerificationResult {
  success: boolean;
  paymentMethod: 'x402' | 'stripe_mpp';
  txHashOrId?: string;
  amountVerifiedCents?: number;
  errorMessage?: string;
}

// NOTA: a verificação x402 vive em src/x402/ (protocol.ts + facilitator.ts),
// implementando a especificação v2. A função abaixo é a implementação antiga,
// mantida fora de uso por não seguir o protocolo.
async function _deprecatedVerifyX402Payment(
  paymentSignature: string,
  priceCents: number,
  paygateWallet: string,
  facilitatorUrl?: string,
  alchemyApiKey?: string
): Promise<PaymentVerificationResult> {

  // ── Caminho A: Facilitator Coinbase (x402 nativo) ──
  if (facilitatorUrl) {
    try {
      const resp = await fetch(facilitatorUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: paymentSignature,
          paymentRequirements: {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: String(priceCents * 10000), // Convert cents to USDC wei (6 decimals)
            resource: paygateWallet,
            description: 'PayGate MCP tool call',
          }
        })
      });

      if (resp.ok) {
        const data = await resp.json() as any;
        return {
          success: true,
          paymentMethod: 'x402',
          txHashOrId: data.txHash || data.transaction_hash || paymentSignature.substring(0, 66),
          amountVerifiedCents: priceCents
        };
      }

      const errorBody = await resp.text();
      return {
        success: false,
        paymentMethod: 'x402',
        errorMessage: `Facilitator rejeitou: ${resp.status} — ${errorBody.substring(0, 200)}`
      };
    } catch (e: any) {
      return {
        success: false,
        paymentMethod: 'x402',
        errorMessage: `Erro ao contactar o Facilitator x402: ${e.message}`
      };
    }
  }

  // ── Caminho B: Verificação direta on-chain via Alchemy (Base Network) ──
  if (alchemyApiKey && paymentSignature.startsWith('0x') && paymentSignature.length === 66) {
    try {
      // Buscar recibo da transação na rede Base
      const rpcUrl = `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [paymentSignature]
        })
      });

      const data = await resp.json() as any;

      if (data.result && data.result.status === '0x1') {
        // Transação confirmada na blockchain!
        // Verificar se o destinatário é a carteira do PayGate (nos logs do ERC-20 Transfer)
        const logs = data.result.logs || [];
        const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base
        const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)

        const usdcTransfer = logs.find((log: any) =>
          log.address.toLowerCase() === USDC_BASE.toLowerCase() &&
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics[2] && log.topics[2].toLowerCase().includes(paygateWallet.slice(2).toLowerCase())
        );

        if (usdcTransfer) {
          // Decodificar o valor transferido (USDC tem 6 decimais)
          const amountWei = parseInt(usdcTransfer.data, 16);
          const amountCents = Math.floor(amountWei / 10000); // 6 decimals -> cents (4 decimals diff)

          if (amountCents >= priceCents) {
            return {
              success: true,
              paymentMethod: 'x402',
              txHashOrId: paymentSignature,
              amountVerifiedCents: amountCents
            };
          }

          return {
            success: false,
            paymentMethod: 'x402',
            errorMessage: `Valor insuficiente: recebido $${(amountCents/100).toFixed(2)}, esperado $${(priceCents/100).toFixed(2)}`
          };
        }

        return {
          success: false,
          paymentMethod: 'x402',
          errorMessage: 'Transação confirmada mas não contém transferência USDC para a carteira do PayGate.'
        };
      }

      return {
        success: false,
        paymentMethod: 'x402',
        errorMessage: 'Transação não encontrada ou não confirmada na rede Base.'
      };
    } catch (e: any) {
      return {
        success: false,
        paymentMethod: 'x402',
        errorMessage: `Erro na verificação on-chain: ${e.message}`
      };
    }
  }

  // ── Sem Facilitator e sem Alchemy: rejeitar ──
  return {
    success: false,
    paymentMethod: 'x402',
    errorMessage: 'Verificação x402 indisponível. Configure X402_FACILITATOR_URL ou ALCHEMY_API_KEY no servidor.'
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. VERIFICADOR STRIPE MPP REAL (PaymentIntent / SPT)
// ═══════════════════════════════════════════════════════════════

export async function verifyStripeMppPayment(
  authToken: string,
  priceCents: number,
  stripeSecretKey?: string
): Promise<PaymentVerificationResult> {
  const token = authToken.replace('Bearer ', '').trim();

  if (!stripeSecretKey) {
    return {
      success: false,
      paymentMethod: 'stripe_mpp',
      errorMessage: 'Stripe não configurado. Configure STRIPE_SECRET_KEY no servidor.'
    };
  }

  if (priceCents < 50) {
    return {
      success: false,
      paymentMethod: 'stripe_mpp',
      errorMessage: `O Stripe exige um valor mínimo de $0.50 USD (50 centavos) por transação. O valor desta ferramenta é $${(priceCents / 100).toFixed(2)}. Utilize o método x402 (USDC/crypto) para micropagamentos ou altere o preço da ferramenta para no mínimo $0.50.`
    };
  }

  try {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-06-30.basil' as any });

    // Se o token é um PaymentMethod ID (pm_xxx) ou token de cartão (tok_xxx)
    if (token.startsWith('pm_') || token.startsWith('tok_')) {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: priceCents,
        currency: 'usd',
        payment_method: token.startsWith('pm_') ? token : undefined,
        payment_method_data: (token.startsWith('tok_') ? {
          type: 'card',
          card: { token: token }
        } : undefined) as any,
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        },
        description: 'PayGate MCP — Tool Call Payment',
        metadata: { source: 'paygate-mcp', type: 'agent_tool_call' }
      });

      if (paymentIntent.status === 'succeeded') {
        return {
          success: true,
          paymentMethod: 'stripe_mpp',
          txHashOrId: paymentIntent.id,
          amountVerifiedCents: priceCents
        };
      }

      return {
        success: false,
        paymentMethod: 'stripe_mpp',
        errorMessage: `Pagamento Stripe não concluído. Status: ${paymentIntent.status}`
      };
    }

    // Se o token é um SPT (Shared Payment Token) — spt_xxx
    if (token.startsWith('spt_')) {
      // SPTs são validados via Stripe como payment methods especiais para agentes
      const paymentIntent = await stripe.paymentIntents.create({
        amount: priceCents,
        currency: 'usd',
        payment_method_data: {
          type: 'card',
          card: { token: token }
        } as any,
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        },
        description: 'PayGate MCP — SPT Agent Payment',
        metadata: { source: 'paygate-mcp', type: 'spt_agent', spt_id: token }
      });

      if (paymentIntent.status === 'succeeded') {
        return {
          success: true,
          paymentMethod: 'stripe_mpp',
          txHashOrId: paymentIntent.id,
          amountVerifiedCents: priceCents
        };
      }

      return {
        success: false,
        paymentMethod: 'stripe_mpp',
        errorMessage: `SPT não processado. Status: ${paymentIntent.status}`
      };
    }

    return {
      success: false,
      paymentMethod: 'stripe_mpp',
      errorMessage: 'Formato de token não reconhecido. Use pm_xxx, tok_xxx ou spt_xxx.'
    };
  } catch (error: any) {
    return {
      success: false,
      paymentMethod: 'stripe_mpp',
      errorMessage: `Erro Stripe: ${error.message}`
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. PAYOUT AUTOMÁTICO via Coinbase CDP (Transferir 98% ao Dev)
// Sem chave privada — a Coinbase assina via MPC Wallet
// ═══════════════════════════════════════════════════════════════

async function cdpRequest(
  method: string,
  path: string,
  body: any,
  apiKeyId: string,
  apiKeySecret: string
): Promise<Response> {
  const url = `https://api.coinbase.com${path}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';

  // CDP API v2 authentication: API Key + HMAC signature
  const message = `${timestamp}${method}${path}${bodyStr}`;
  const encoder = new TextEncoder();
  const keyData = Uint8Array.from(atob(apiKeySecret), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CB-ACCESS-KEY': apiKeyId,
      'CB-ACCESS-SIGN': signatureBase64,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-VERSION': '2024-01-01'
    },
    body: bodyStr || undefined
  });
}

export async function processDevPayout(
  paymentMethod: 'x402' | 'stripe_mpp',
  netAmountCents: number,
  devWalletAddress?: string | null,
  devStripeAccountId?: string | null,
  stripeSecretKey?: string | null,
  cdpApiKeyId?: string | null,
  cdpApiKeySecret?: string | null
): Promise<{ success: boolean; payoutId?: string; error?: string }> {

  // ── Payout via Stripe (para devs com conta Stripe) ──
  if (paymentMethod === 'stripe_mpp' && devStripeAccountId && stripeSecretKey) {
    try {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-06-30.basil' as any });
      const transfer = await stripe.transfers.create({
        amount: netAmountCents,
        currency: 'usd',
        destination: devStripeAccountId,
        description: 'PayGate MCP — Developer Payout'
      });
      return { success: true, payoutId: transfer.id };
    } catch (e: any) {
      return { success: false, error: `Stripe Transfer falhou: ${e.message}` };
    }
  }

  // ── Payout via Coinbase CDP (USDC on Base → carteira do dev) ──
  if (devWalletAddress && cdpApiKeyId && cdpApiKeySecret) {
    try {
      const amountUsdc = (netAmountCents / 100).toFixed(6); // cents → USD com 6 decimais

      // Coinbase Send API: envia crypto da conta Coinbase para endereço externo
      // Primeiro, listar contas para encontrar a conta USDC
      const accountsResp = await cdpRequest(
        'GET',
        '/v2/accounts',
        null,
        cdpApiKeyId,
        cdpApiKeySecret
      );
      const accountsData = await accountsResp.json() as any;

      if (!accountsResp.ok) {
        return {
          success: false,
          error: `CDP Accounts erro: ${accountsData?.errors?.[0]?.message || accountsResp.status}`
        };
      }

      // Encontrar a conta USDC
      const usdcAccount = accountsData.data?.find(
        (acc: any) => acc.currency === 'USDC' || acc.balance?.currency === 'USDC'
      );

      if (!usdcAccount) {
        return {
          success: false,
          error: 'Conta USDC não encontrada na Coinbase. Deposite USDC primeiro.',
          payoutId: `payout_queued_${Date.now()}`
        };
      }

      // Enviar USDC para o endereço do dev
      const sendResp = await cdpRequest(
        'POST',
        `/v2/accounts/${usdcAccount.id}/transactions`,
        {
          type: 'send',
          to: devWalletAddress,
          amount: amountUsdc,
          currency: 'USDC',
          description: 'PayGate MCP — Developer Payout (98%)',
          network: 'base'
        },
        cdpApiKeyId,
        cdpApiKeySecret
      );

      const sendData = await sendResp.json() as any;

      if (sendResp.ok || sendResp.status === 201) {
        return {
          success: true,
          payoutId: sendData.data?.id || `cdp_payout_${Date.now()}`
        };
      }

      return {
        success: false,
        error: `CDP Send erro: ${sendData?.errors?.[0]?.message || sendResp.status}`,
        payoutId: `payout_failed_${Date.now()}`
      };
    } catch (e: any) {
      return { success: false, error: `Erro no payout CDP: ${e.message}` };
    }
  }

  // ── Sem método de payout disponível: registrar como pendente ──
  return {
    success: false,
    error: 'Payout pendente: dev não tem wallet nem Stripe Account configurado.',
    payoutId: `payout_queued_${Date.now()}`
  };
}
