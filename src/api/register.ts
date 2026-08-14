import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { developers, registeredTools } from '../db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { isEvmAddress } from './proxy';

export async function registerDeveloperHandler(c: Context) {
  try {
    const body = await c.req.json();
    const { name, email, target_server_url, wallet_address, stripe_account_id } = body;

    if (!name || !target_server_url) {
      return c.json({ error: 'Campos "name" e "target_server_url" são obrigatórios.' }, 400);
    }

    if (!wallet_address && !stripe_account_id) {
      return c.json({
        error: 'Informe pelo menos um método de recebimento.',
        options: {
          wallet_address: 'Endereço USDC na rede Base (ex: 0x...) — recebe via Coinbase CDP',
          stripe_account_id: 'ID da conta Stripe Connect (ex: acct_xxx) — recebe via Stripe Transfer'
        }
      }, 400);
    }

    // A carteira recebe o pagamento diretamente do comprador, então um endereço
    // malformado enviaria dinheiro para o vazio.
    if (wallet_address && !isEvmAddress(wallet_address)) {
      return c.json({
        error: `"${wallet_address}" não é um endereço EVM válido.`,
        expected: '0x seguido de 40 caracteres hexadecimais'
      }, 400);
    }

    const db = drizzle(c.env.DB);
    const devId = `dev_${nanoid(10)}`;
    const apiKey = `pg_live_${nanoid(24)}`;

    // Criar hash da API Key para armazenamento seguro
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const apiKeyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    await db.insert(developers).values({
      id: devId,
      apiKeyHash,
      name,
      email: email || null,
      targetServerUrl: target_server_url,
      walletAddress: wallet_address || null,
      stripeAccountId: stripe_account_id || null,
      commissionRate: 0.02,
    });

    // Buscar as ferramentas do servidor do dev via tools/list
    let importedToolsCount = 0;
    try {
      const resp = await fetch(target_server_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        }),
      });

      if (resp.ok) {
        const json = await resp.json() as any;
        if (json.result && Array.isArray(json.result.tools)) {
          for (const t of json.result.tools) {
            await db.insert(registeredTools).values({
              id: `tool_${nanoid(10)}`,
              developerId: devId,
              toolName: t.name,
              priceCents: 5, // Preço padrão: $0.05
              description: t.description || null,
            });
            importedToolsCount++;
          }
        }
      }
    } catch (e) {
      console.warn('Não foi possível importar a lista de ferramentas automaticamente:', e);
    }

    return c.json({
      success: true,
      message: 'Desenvolvedor registrado com sucesso!',
      developer: {
        id: devId,
        name,
        target_server_url,
        proxy_url: `https://${new URL(c.req.url).host}/mcp/${devId}`,
        api_key: apiKey,
        imported_tools_count: importedToolsCount,
        default_price_per_call: '$0.05'
      }
    }, 201);
  } catch (error: any) {
    return c.json({ error: 'Erro ao registrar desenvolvedor.', details: error.message }, 500);
  }
}
