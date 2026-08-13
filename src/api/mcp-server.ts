import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { registeredTools, developers } from '../db/schema';
import { eq } from 'drizzle-orm';

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
          instructions: 'PayGate MCP is a payment proxy gateway for AI agents. Use list_registered_servers to discover available monetized tools.'
        }
      };
    }

    // 2. TOOLS/LIST
    else if (body.method === 'tools/list') {
      responsePayload = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'list_registered_servers',
              description: 'List all monetized MCP servers and tools available through PayGate, including prices, tool descriptions, and proxy endpoints.',
              annotations: {
                readOnlyHint: true,
                consequence: 'none',
                title: 'List Registered Monetized Servers',
                description: 'Queries the PayGate catalogue for all active monetized servers and their available tools.'
              },
              inputSchema: {
                type: 'object',
                properties: {
                  category: { type: 'string', description: 'Optional category filter (e.g. "tax", "crypto", "dev")' }
                }
              },
              outputSchema: {
                type: 'object',
                properties: {
                  total_servers: { type: 'number', description: 'Total number of active registered servers' },
                  servers: {
                    type: 'array',
                    description: 'List of active monetized MCP servers',
                    items: {
                      type: 'object',
                      properties: {
                        developer_name: { type: 'string', description: 'Name of the developer or service' },
                        proxy_mcp_url: { type: 'string', description: 'Proxy URL for agents to access tools' },
                        tools: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              name: { type: 'string', description: 'Name of the tool' },
                              price_usd: { type: 'string', description: 'Price per call in USD' },
                              description: { type: 'string', description: 'Description of tool capabilities' }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          ]
        }
      };
    }

    // 3. TOOLS/CALL
    else if (body.method === 'tools/call') {
      const toolName = body.params?.name;
      if (toolName === 'list_registered_servers') {
        const db = drizzle(c.env.DB);
        const devList = await db.select().from(developers).where(eq(developers.isActive, 1));
        const toolsList = await db.select().from(registeredTools).where(eq(registeredTools.isActive, 1));

        const catalog = devList.map(dev => {
          const devTools = toolsList.filter(t => t.developerId === dev.id);
          return {
            developer_name: dev.name,
            proxy_mcp_url: `https://${host}/mcp/${dev.id}`,
            tools: devTools.map(t => ({
              name: t.toolName,
              price_usd: (t.priceCents / 100).toFixed(2),
              description: t.description
            }))
          };
        });

        responsePayload = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  total_servers: catalog.length,
                  servers: catalog
                }, null, 2)
              }
            ]
          }
        };
      }
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
