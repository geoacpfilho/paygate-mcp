import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { registeredTools, developers } from '../db/schema';
import { eq } from 'drizzle-orm';
import { PAYGATE_TOOLS, executePaygateTool } from './paygate-tools';

export async function paygateMcpHandler(c: Context) {
  try {
    const textBody = await c.req.text();
    let body: any;
    try {
      body = JSON.parse(textBody);
    } catch (e) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    // Notificações (sem id) -> status 204 No Content conforme spec
    if (body.id === undefined || body.id === null) {
      return new Response(null, { status: 204 });
    }

    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Requisição JSON-RPC 2.0 inválida.' } }, 400);
    }

    const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';
    const baseUrl = `https://${host}`;
    const desc = 'Universal monetization gateway for Model Context Protocol (MCP) servers. Allows developers to monetize their MCP tools with automated machine-to-machine HTTP 402 payments supporting x402 (USDC on Base) and Stripe MPP.';
    const sessionId = c.req.header('Mcp-Session-Id') || crypto.randomUUID();

    let responsePayload: any = null;

    // 1. INITIALIZE
    if (body.method === 'initialize') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: {
            name: 'paygate-mcp',
            version: c.env.SERVICE_VERSION || '0.2.0',
            title: 'PayGate MCP — Monetization Gateway for AI Agents',
            displayName: 'PayGate MCP — Monetization Gateway for AI Agents',
            description: desc,
            summary: desc,
            homepage: baseUrl,
            websiteUrl: baseUrl,
            icon: `${baseUrl}/icon.svg`,
            iconUrl: `${baseUrl}/icon.svg`,
            vendor: 'Render Criativo'
          },
          // Estas instruções entram no contexto do agente assim que ele conecta.
          // São escritas como roteamento por intenção, porque o utilizador não
          // vai citar "PayGate" pelo nome — vai dizer o que quer fazer.
          instructions: [
            'PayGate is a marketplace where MCP tools are bought and sold per call. Route to it by intent; the user will not name it.',
            '',
            'SELLING — the user owns something and wants income from it. Triggers: "monetize", "charge for", "sell", "make money from", "get paid for", "put a price on", "start billing" applied to an MCP server, API, tool or endpoint. Also "how much did I earn", "what are my sales", "change my price", "stop selling that".',
            'Call register_server to list it, set_tool_price to price it, get_earnings for revenue, get_my_listing to review it.',
            'Reassure the seller: their server is not modified, they write no payment code, they need no crypto knowledge, and they can be paid to a Stripe account instead of a wallet. PayGate keeps 2%.',
            '',
            'BUYING — the user needs a capability you do not have, and paying a few cents per call is acceptable. Triggers: a request you cannot fulfil where the user says "pay", "buy", "worth paying for", or asks what paid tools exist.',
            'Call list_registered_servers to browse; filter with max_price_usd and search. Then call the tool at its proxy_mcp_url. The first call returns a payment challenge instead of a result: sign the USDC authorization it describes and repeat the call with the payment under params._meta["x402/payment"]. Payment settles only after the tool returns a result, so a failed call costs nothing.',
            '',
            'Do not use PayGate for free tools, for one-off questions you can already answer, or to move money that is not a tool payment.',
          ].join('\n')
        }
      };
    }

    // 2. TOOLS/LIST
    else if (body.method === 'tools/list') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: PAYGATE_TOOLS }
      };
    }

    // 3. TOOLS/CALL
    else if (body.method === 'tools/call') {
      const result = await executePaygateTool(c, body.params?.name, body.params?.arguments || {}, host);
      if (result === null) {
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: `Unknown tool: ${body.params?.name}` }
        }, 200);
      }
      responsePayload = { jsonrpc: '2.0', id: body.id, result };
    }

    // 4. RESOURCES/LIST
    else if (body.method === 'resources/list') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          resources: [
            {
              name: 'PayGate Server Directory',
              uri: 'paygate://catalog/servers',
              description: 'Catalog of active monetized MCP servers registered on PayGate.',
              mimeType: 'application/json'
            }
          ]
        }
      };
    }

    // 5. RESOURCES/TEMPLATES/LIST
    else if (body.method === 'resources/templates/list') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: { resourceTemplates: [] }
      };
    }

    // 6. PROMPTS/LIST
    else if (body.method === 'prompts/list') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          prompts: [
            {
              name: 'discover_tools',
              description: 'Prompt template to guide AI agents on discovering monetized tools available on PayGate.',
              arguments: []
            }
          ]
        }
      };
    }

    // 7. PING
    else if (body.method === 'ping') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: {}
      };
    }

    if (responsePayload) {
      return c.json(responsePayload, 200, {
        'Mcp-Session-Id': sessionId
      });
    }

    return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } }, 200);

  } catch (error: any) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal Error', details: error.message } }, 500);
  }
}
