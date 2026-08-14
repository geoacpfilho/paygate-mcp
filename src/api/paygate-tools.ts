/**
 * Ferramentas de venda do PayGate, expostas pelo próprio protocolo MCP.
 *
 * A gestão do vendedor existia só como API REST, o que exige um humano com um
 * navegador ou um terminal. Aqui as mesmas operações viram ferramentas que um
 * agente executa sozinho: cadastrar um serviço, precificar e consultar receita.
 *
 * As descrições são escritas para serem lidas por um agente decidindo o que
 * fazer — dizem o que acontece, o que é obrigatório e o que é devolvido.
 */

import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { developers, registeredTools, transactions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { isEvmAddress } from './proxy';

export const DEFAULT_PRICE_CENTS = 2;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Resolve o vendedor a partir da chave. O agente pode mandá-la como argumento
 * da ferramenta ou no cabeçalho Authorization — clientes MCP variam em qual dos
 * dois conseguem enviar.
 */
type SellerLookup = { error: string; seller?: undefined } | { error?: undefined; seller: any };

async function resolveSeller(c: Context, args: any): Promise<SellerLookup> {
  const fromArg = typeof args?.api_key === 'string' ? args.api_key.trim() : '';
  const fromHeader = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const apiKey = fromArg || fromHeader;
  if (!apiKey) return { error: 'Missing api_key. Pass the key returned by register_server.' };

  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(developers)
    .where(eq(developers.apiKeyHash, await sha256Hex(apiKey)))
    .limit(1);

  if (rows.length === 0 || !rows[0].isActive) {
    return { error: 'Invalid or inactive api_key.' };
  }
  return { seller: rows[0] };
}

/** Resultado de ferramenta em texto + estruturado, como a especificação pede. */
function toolResult(payload: unknown, isError = false) {
  return {
    isError,
    structuredContent: payload as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function toolFailure(message: string, hint?: string) {
  return toolResult({ error: message, ...(hint ? { hint } : {}) }, true);
}

// ───────────────────────── Definições das ferramentas ─────────────────────────

export const PAYGATE_TOOLS = [
  {
    name: 'list_registered_servers',
    description:
      'Find a paid tool that does something you cannot do yourself. Use when the user needs a capability you lack and is willing to pay per use, or asks what paid tools, APIs or data sources are available. Returns every tool on the market with its price per call in USD and the endpoint to call it. Browsing is free and needs no key.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        max_price_usd: {
          type: 'number',
          description: 'Only return tools priced at or below this amount per call.',
        },
        search: {
          type: 'string',
          description: 'Case-insensitive match against tool names, descriptions and seller names.',
        },
        verified_only: {
          type: 'boolean',
          description: 'Return only sellers who proved they own the server they sell.',
        },
      },
    },
  },
  {
    name: 'register_server',
    description:
      'Start charging for an MCP server the user owns. Use when they want to monetize, sell, charge for, get paid for, put a price on, or make money from a server, API or tool. Buyers pay their wallet DIRECTLY on-chain — PayGate never holds the money, so there is no payout to wait for, no balance to withdraw and no commission taken. Their server is never modified and needs no payment code. Tools are imported automatically, so it must be publicly reachable over HTTPS and answer tools/list. Returns a proxy URL and a secret api_key shown only once; save it, every other seller tool needs it.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name of the service in the marketplace.' },
        target_server_url: {
          type: 'string',
          description: 'Public HTTPS URL of the MCP server to monetize, e.g. https://example.com/mcp',
        },
        wallet_address: {
          type: 'string',
          description: 'EVM address that receives USDC on Base. Required unless stripe_account_id is given.',
        },
        stripe_account_id: {
          type: 'string',
          description: 'Stripe Connect account (acct_...) to receive fiat instead. Only for tools priced at $0.50 or above.',
        },
        email: { type: 'string', description: 'Optional contact address.' },
        default_price_usd: {
          type: 'number',
          description: 'Price per call applied to every imported tool. Defaults to 0.02.',
        },
      },
      required: ['name', 'target_server_url'],
    },
  },
  {
    name: 'set_tool_price',
    description:
      'Reprice or unlist something the user already sells. Use when they want to raise, lower or change a price, make a tool free, pause selling it, or take it off the market. Requires the api_key from register_server.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your seller key.' },
        tool_name: { type: 'string', description: 'Exact name of the tool to update.' },
        price_usd: { type: 'number', description: 'New price per call in USD. Minimum 0.01.' },
        is_active: { type: 'boolean', description: 'Set false to stop selling this tool.' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'get_earnings',
    description:
      'Report how much the user has earned selling their tools. Use when they ask about sales, revenue, income, how much they made, how many calls were paid, or which tool sells best. Returns paid calls, gross revenue, commission and net revenue, broken down per tool. Requires the api_key from register_server.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { api_key: { type: 'string', description: 'Your seller key.' } },
    },
  },
  {
    name: 'get_my_listing',
    description:
      'Review what the user currently has for sale. Use when they ask what they are selling, what their prices are, where their money goes, or want to check their listing before changing it. Returns the proxy URL, payout destination, commission rate and every listed tool with its price. Requires the api_key from register_server.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { api_key: { type: 'string', description: 'Your seller key.' } },
    },
  },
  {
    name: 'verify_ownership',
    description:
      'Prove the user owns the server they listed, earning a trusted badge in the marketplace. Use after they have published their verification token at /.well-known/paygate-verify on the server\'s domain. PayGate fetches that URL and confirms the token matches. Verified sellers can be filtered for by buyers, so this directly increases how often their tools get chosen. Requires the api_key from register_server.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { api_key: { type: 'string', description: 'Your seller key.' } },
    },
  },
];

// ───────────────────────── Execução ─────────────────────────

export async function executePaygateTool(c: Context, toolName: string, args: any, host: string) {
  const db = drizzle(c.env.DB);

  // ── Vitrine ──
  if (toolName === 'list_registered_servers') {
    const sellers = await db.select().from(developers).where(eq(developers.isActive, 1));
    const tools = await db.select().from(registeredTools).where(eq(registeredTools.isActive, 1));

    const maxCents =
      typeof args?.max_price_usd === 'number' ? Math.round(args.max_price_usd * 100) : null;
    const needle = typeof args?.search === 'string' ? args.search.toLowerCase() : null;
    const verifiedOnly = args?.verified_only === true;

    const catalog = sellers
      .filter((seller) => (verifiedOnly ? seller.isVerified === 1 : true))
      .map((seller) => {
        const own = tools
          .filter((t) => t.developerId === seller.id)
          .filter((t) => (maxCents === null ? true : t.priceCents <= maxCents))
          .filter((t) =>
            needle === null
              ? true
              : `${t.toolName} ${t.description || ''} ${seller.name}`.toLowerCase().includes(needle),
          );
        return {
          seller_name: seller.name,
          verified: seller.isVerified === 1,
          proxy_mcp_url: `https://${host}/mcp/${seller.id}`,
          tools: own.map((t) => ({
            name: t.toolName,
            price_usd: (t.priceCents / 100).toFixed(2),
            description: t.description,
          })),
        };
      })
      .filter((s) => s.tools.length > 0)
      // Verificados primeiro: é o sinal de confiança que o comprador usa.
      .sort((a, b) => Number(b.verified) - Number(a.verified));

    return toolResult({
      total_sellers: catalog.length,
      total_tools: catalog.reduce((n, s) => n + s.tools.length, 0),
      verified_sellers: catalog.filter((s) => s.verified).length,
      payment: { protocol: 'x402 v2', asset: 'USDC', network: 'Base (eip155:8453)' },
      trust:
        'A verified seller proved they own the server they sell. Pass verified_only:true to see only those.',
      how_to_buy:
        'Call any tool at its proxy_mcp_url. The first call returns a payment challenge; sign it and repeat the call with the payment attached under params._meta["x402/payment"].',
      sellers: catalog,
    });
  }

  // ── Cadastro de vendedor ──
  if (toolName === 'register_server') {
    const { name, target_server_url, wallet_address, stripe_account_id, email } = args || {};

    if (!name || !target_server_url) {
      return toolFailure('Both "name" and "target_server_url" are required.');
    }
    if (!wallet_address && !stripe_account_id) {
      return toolFailure(
        'A payout destination is required.',
        'Provide wallet_address (EVM address for USDC on Base) or stripe_account_id (acct_...).',
      );
    }
    // A carteira recebe o pagamento diretamente, então um endereço malformado
    // mandaria dinheiro para lugar nenhum. Recusar antes de listar.
    if (wallet_address && !isEvmAddress(wallet_address)) {
      return toolFailure(
        `"${wallet_address}" is not a valid EVM address.`,
        'Expected 0x followed by 40 hex characters. Buyers pay this address directly, so it must be exact.',
      );
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(target_server_url);
    } catch {
      return toolFailure(`"${target_server_url}" is not a valid URL.`);
    }
    if (targetUrl.protocol !== 'https:') {
      return toolFailure('target_server_url must use HTTPS.');
    }

    // Um servidor só entra no catálogo se realmente responder como MCP.
    let discovered: any[] = [];
    try {
      const request = new Request(target_server_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

      // A Cloudflare bloqueia um Worker que chama outro Worker da mesma conta
      // pela URL pública (erro 1042). Quando existe service binding, é por ele
      // que a chamada precisa passar.
      const probe =
        target_server_url.includes('oraculo-b2r') && c.env.ORACULO_B2R
          ? await c.env.ORACULO_B2R.fetch(request)
          : await fetch(request);

      const raw = await probe.text();
      if (raw.includes('error code: 1042')) {
        return toolFailure(
          'The target server is hosted on the same Cloudflare account as PayGate, which blocks direct calls between them.',
          'Host it on a different account or expose it through a service binding.',
        );
      }
      discovered = (JSON.parse(raw) as any)?.result?.tools || [];
    } catch (e: any) {
      return toolFailure(
        `Could not reach ${target_server_url}: ${e.message}`,
        'The server must be publicly reachable and answer a JSON-RPC tools/list request.',
      );
    }
    if (discovered.length === 0) {
      return toolFailure(
        'The target server returned no tools.',
        'PayGate lists servers by their tools, so tools/list must return at least one.',
      );
    }

    const existing = await db
      .select()
      .from(developers)
      .where(eq(developers.targetServerUrl, target_server_url))
      .limit(1);
    if (existing.length > 0) {
      return toolFailure(
        `${target_server_url} is already listed on PayGate.`,
        'Use get_my_listing with your api_key to inspect it, or register a different server URL.',
      );
    }

    const priceCents =
      typeof args?.default_price_usd === 'number'
        ? Math.max(1, Math.round(args.default_price_usd * 100))
        : DEFAULT_PRICE_CENTS;

    const devId = `dev_${nanoid(10)}`;
    const apiKey = `pg_live_${nanoid(24)}`;
    const verifyToken = `paygate-verify-${nanoid(20)}`;

    await db.insert(developers).values({
      id: devId,
      apiKeyHash: await sha256Hex(apiKey),
      name,
      email: email || null,
      targetServerUrl: target_server_url,
      walletAddress: wallet_address || null,
      stripeAccountId: stripe_account_id || null,
      commissionRate: 0.02,
      verifyToken,
    });

    for (const t of discovered) {
      await db.insert(registeredTools).values({
        id: `tool_${nanoid(10)}`,
        developerId: devId,
        toolName: t.name,
        priceCents,
        description: t.description || null,
      });
    }

    return toolResult({
      listed: true,
      seller_id: devId,
      proxy_mcp_url: `https://${host}/mcp/${devId}`,
      api_key: apiKey,
      api_key_notice: 'Shown once. Store it — every other seller tool requires it.',
      imported_tools: discovered.map((t) => t.name),
      price_per_call_usd: (priceCents / 100).toFixed(2),
      paid_directly_to: wallet_address || stripe_account_id,
      custody: wallet_address
        ? 'None. Buyers settle USDC straight to your wallet; PayGate never receives or holds your funds.'
        : 'Stripe payouts are forwarded by PayGate.',
      commission: wallet_address ? '0% — nothing is deducted from a direct payment' : '2%',
      verification: {
        status: 'unverified',
        why: 'Verified listings prove they own the server they sell. Buyers can filter for them, so verifying earns trust and more calls.',
        how: `Serve the exact text "${verifyToken}" at https://<your-server-domain>/.well-known/paygate-verify (a plain-text response), then call verify_ownership with your api_key. Anyone can list a public server, but only its owner can publish this token on its domain.`,
        token: verifyToken,
      },
      next_step:
        'Agents can now discover and pay for these tools. Verify ownership with verify_ownership to earn the trusted badge; adjust pricing with set_tool_price; track revenue with get_earnings.',
    });
  }

  // ── Daqui em diante exige identificação do vendedor ──
  const auth = await resolveSeller(c, args);
  if (auth.error) return toolFailure(auth.error);
  const seller = auth.seller;

  if (toolName === 'verify_ownership') {
    if (seller.isVerified === 1) {
      return toolResult({ verified: true, note: 'Already verified.' });
    }
    if (!seller.verifyToken) {
      return toolFailure('This listing has no verification token.', 'Re-register to receive one.');
    }

    // O token só pode existir nesse caminho se o dono do domínio o publicou.
    const origin = new URL(seller.targetServerUrl).origin;
    const verifyUrl = `${origin}/.well-known/paygate-verify`;
    let served = '';
    try {
      const resp = await fetch(verifyUrl, { method: 'GET' });
      if (!resp.ok) {
        return toolFailure(
          `${verifyUrl} returned HTTP ${resp.status}.`,
          `Serve the token "${seller.verifyToken}" as plain text at that path, then try again.`,
        );
      }
      served = (await resp.text()).trim();
    } catch (e: any) {
      return toolFailure(
        `Could not fetch ${verifyUrl}: ${e.message}`,
        'The file must be publicly reachable over HTTPS.',
      );
    }

    if (!served.includes(seller.verifyToken)) {
      return toolFailure(
        `${verifyUrl} did not contain the expected token.`,
        `It must serve "${seller.verifyToken}". Found: "${served.slice(0, 60)}"`,
      );
    }

    await db.update(developers).set({ isVerified: 1 }).where(eq(developers.id, seller.id));
    return toolResult({
      verified: true,
      seller_id: seller.id,
      note: 'Ownership confirmed. Your listing now shows a verified badge and appears in verified_only searches.',
    });
  }

  if (toolName === 'set_tool_price') {
    const { tool_name, price_usd, is_active } = args || {};
    if (!tool_name) return toolFailure('"tool_name" is required.');
    if (price_usd === undefined && is_active === undefined) {
      return toolFailure('Provide price_usd, is_active, or both.');
    }
    if (price_usd !== undefined && (typeof price_usd !== 'number' || price_usd < 0.01)) {
      return toolFailure('price_usd must be a number of at least 0.01.');
    }

    const rows = await db
      .select()
      .from(registeredTools)
      .where(and(eq(registeredTools.developerId, seller.id), eq(registeredTools.toolName, tool_name)))
      .limit(1);
    if (rows.length === 0) {
      return toolFailure(`You have no tool named "${tool_name}".`, 'Call get_my_listing to see your tools.');
    }

    const priceCents = price_usd !== undefined ? Math.round(price_usd * 100) : rows[0].priceCents;
    await db
      .update(registeredTools)
      .set({
        priceCents,
        isActive: is_active === undefined ? rows[0].isActive : is_active ? 1 : 0,
      })
      .where(eq(registeredTools.id, rows[0].id));

    return toolResult({
      updated: true,
      tool_name,
      price_usd: (priceCents / 100).toFixed(2),
      is_active: is_active === undefined ? Boolean(rows[0].isActive) : Boolean(is_active),
    });
  }

  if (toolName === 'get_my_listing') {
    const tools = await db
      .select()
      .from(registeredTools)
      .where(eq(registeredTools.developerId, seller.id));

    return toolResult({
      seller_id: seller.id,
      name: seller.name,
      verified: seller.isVerified === 1,
      ...(seller.isVerified === 1 || !seller.verifyToken
        ? {}
        : {
            verify_hint: `Serve "${seller.verifyToken}" at ${new URL(seller.targetServerUrl).origin}/.well-known/paygate-verify and call verify_ownership to earn the trusted badge.`,
          }),
      proxy_mcp_url: `https://${host}/mcp/${seller.id}`,
      target_server_url: seller.targetServerUrl,
      payout_to: seller.walletAddress || seller.stripeAccountId,
      commission: `${((seller.commissionRate || 0.02) * 100).toFixed(1)}%`,
      tools: tools.map((t) => ({
        name: t.toolName,
        price_usd: (t.priceCents / 100).toFixed(2),
        is_active: Boolean(t.isActive),
        description: t.description,
      })),
    });
  }

  if (toolName === 'get_earnings') {
    const paid = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.developerId, seller.id), eq(transactions.status, 'completed')));

    let gross = 0;
    let commission = 0;
    let net = 0;
    const perTool: Record<string, { calls: number; grossCents: number }> = {};

    for (const tx of paid) {
      gross += tx.grossAmountCents;
      commission += tx.commissionCents;
      net += tx.netAmountCents;
      perTool[tx.toolName] ??= { calls: 0, grossCents: 0 };
      perTool[tx.toolName].calls += 1;
      perTool[tx.toolName].grossCents += tx.grossAmountCents;
    }

    return toolResult({
      seller_id: seller.id,
      paid_calls: paid.length,
      gross_revenue_usd: (gross / 100).toFixed(2),
      paygate_commission_usd: (commission / 100).toFixed(2),
      net_revenue_usd: (net / 100).toFixed(2),
      by_tool: Object.entries(perTool).map(([name, d]) => ({
        tool_name: name,
        paid_calls: d.calls,
        gross_revenue_usd: (d.grossCents / 100).toFixed(2),
      })),
    });
  }

  return null;
}
