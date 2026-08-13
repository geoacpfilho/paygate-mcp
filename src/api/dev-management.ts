import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { developers, registeredTools, transactions } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';

// Helper para validar a API Key do desenvolvedor no cabeçalho Authorization
async function authenticateDev(c: Context) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const apiKey = authHeader.replace('Bearer ', '').trim();

  // Calcular SHA-256 da chave informada
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const apiKeyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const db = drizzle(c.env.DB);
  const devList = await db.select().from(developers).where(eq(developers.apiKeyHash, apiKeyHash)).limit(1);

  if (devList.length === 0 || !devList[0].isActive) {
    return null;
  }

  return devList[0];
}

// 1. GET /api/me — Retorna perfil do dev
export async function getDevProfileHandler(c: Context) {
  const dev = await authenticateDev(c);
  if (!dev) {
    return c.json({ error: 'Não autorizado. API key inválida ou ausente.' }, 401);
  }

  return c.json({
    id: dev.id,
    name: dev.name,
    email: dev.email,
    target_server_url: dev.targetServerUrl,
    wallet_address: dev.walletAddress,
    stripe_account_id: dev.stripeAccountId,
    commission_rate: dev.commissionRate,
    created_at: dev.createdAt,
  });
}

// 2. GET /api/me/tools — Lista todas as ferramentas do dev e seus preços
export async function getDevToolsHandler(c: Context) {
  const dev = await authenticateDev(c);
  if (!dev) {
    return c.json({ error: 'Não autorizado. API key inválida ou ausente.' }, 401);
  }

  const db = drizzle(c.env.DB);
  const tools = await db.select().from(registeredTools).where(eq(registeredTools.developerId, dev.id));

  return c.json({
    developer_id: dev.id,
    total_tools: tools.length,
    tools: tools.map(t => ({
      id: t.id,
      tool_name: t.toolName,
      price_cents: t.priceCents,
      price_usd: (t.priceCents / 100).toFixed(2),
      description: t.description,
      is_active: Boolean(t.isActive),
    }))
  });
}

// 3. PUT /api/me/tools — Altera o preço ou status de uma ferramenta específica
export async function updateToolPriceHandler(c: Context) {
  const dev = await authenticateDev(c);
  if (!dev) {
    return c.json({ error: 'Não autorizado. API key inválida ou ausente.' }, 401);
  }

  try {
    const body = await c.req.json();
    const { tool_name, price_cents, is_active } = body;

    if (!tool_name || price_cents === undefined) {
      return c.json({ error: 'Campos "tool_name" e "price_cents" são obrigatórios.' }, 400);
    }

    if (typeof price_cents !== 'number' || price_cents < 1) {
      return c.json({ error: 'O valor "price_cents" deve ser um número maior que zero (ex: 5 = $0.05).' }, 400);
    }

    const db = drizzle(c.env.DB);
    const existing = await db.select()
      .from(registeredTools)
      .where(and(eq(registeredTools.developerId, dev.id), eq(registeredTools.toolName, tool_name)))
      .limit(1);

    if (existing.length === 0) {
      return c.json({ error: `Ferramenta "${tool_name}" não encontrada para este desenvolvedor.` }, 404);
    }

    await db.update(registeredTools)
      .set({
        priceCents: price_cents,
        isActive: is_active !== undefined ? (is_active ? 1 : 0) : existing[0].isActive
      })
      .where(eq(registeredTools.id, existing[0].id));

    return c.json({
      success: true,
      message: `Preço da ferramenta "${tool_name}" atualizado com sucesso!`,
      tool: {
        tool_name,
        price_cents,
        price_usd: (price_cents / 100).toFixed(2),
        is_active: is_active !== undefined ? is_active : Boolean(existing[0].isActive)
      }
    });
  } catch (error: any) {
    return c.json({ error: 'Erro ao atualizar preço da ferramenta.', details: error.message }, 500);
  }
}

// 4. GET /api/me/earnings — Relatório detalhado de receitas, chamadas e comissões do dev
export async function getDevEarningsHandler(c: Context) {
  const dev = await authenticateDev(c);
  if (!dev) {
    return c.json({ error: 'Não autorizado. API key inválida ou ausente.' }, 401);
  }

  const db = drizzle(c.env.DB);

  // Buscar todas as transações concluídas deste dev
  const txList = await db.select()
    .from(transactions)
    .where(and(eq(transactions.developerId, dev.id), eq(transactions.status, 'completed')));

  let totalGrossCents = 0;
  let totalCommissionCents = 0;
  let totalNetCents = 0;

  const toolStats: Record<string, { calls: number; grossCents: number }> = {};
  const methodStats: Record<string, { calls: number; grossCents: number }> = {
    x402: { calls: 0, grossCents: 0 },
    stripe_mpp: { calls: 0, grossCents: 0 }
  };

  for (const tx of txList) {
    totalGrossCents += tx.grossAmountCents;
    totalCommissionCents += tx.commissionCents;
    totalNetCents += tx.netAmountCents;

    // Métricas por ferramenta
    if (!toolStats[tx.toolName]) {
      toolStats[tx.toolName] = { calls: 0, grossCents: 0 };
    }
    toolStats[tx.toolName].calls += 1;
    toolStats[tx.toolName].grossCents += tx.grossAmountCents;

    // Métricas por método de pagamento
    const method = tx.paymentMethod || 'x402';
    if (!methodStats[method]) {
      methodStats[method] = { calls: 0, grossCents: 0 };
    }
    methodStats[method].calls += 1;
    methodStats[method].grossCents += tx.grossAmountCents;
  }

  return c.json({
    developer: {
      id: dev.id,
      name: dev.name,
      commission_rate: `${((dev.commissionRate || 0.02) * 100).toFixed(1)}%`
    },
    summary: {
      total_calls: txList.length,
      gross_revenue_usd: (totalGrossCents / 100).toFixed(2),
      paygate_commission_usd: (totalCommissionCents / 100).toFixed(2),
      net_revenue_usd: (totalNetCents / 100).toFixed(2)
    },
    by_tool: Object.entries(toolStats).map(([name, data]) => ({
      tool_name: name,
      total_calls: data.calls,
      gross_revenue_usd: (data.grossCents / 100).toFixed(2)
    })),
    by_payment_method: Object.entries(methodStats).map(([method, data]) => ({
      method,
      total_calls: data.calls,
      gross_revenue_usd: (data.grossCents / 100).toFixed(2)
    }))
  });
}
