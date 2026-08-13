import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { registerDeveloperHandler } from './api/register';
import { mcpProxyHandler } from './api/proxy';
import { serverCardHandler, ucpManifestHandler } from './api/discovery';
import { paygateMcpHandler } from './api/mcp-server';
import type { Env } from './env';
import { resolveNetwork } from './x402/config';
import { probeFacilitator } from './x402/facilitator';
import {
  getDevProfileHandler,
  getDevToolsHandler,
  updateToolPriceHandler,
  getDevEarningsHandler
} from './api/dev-management';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'PAYMENT-SIGNATURE', 'UCP-Agent', 'Accept'],
  exposeHeaders: ['WWW-Authenticate', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
}));

app.use('*', async (c, next) => {
  console.log(`[REQ] ${c.req.method} ${c.req.url}`);
  console.log(`[HEADERS]`, JSON.stringify(c.req.header()));
  await next();
});

// Health Check
app.get('/health', (c) => {
  return c.json({
    status: 'operational',
    service: 'paygate-mcp',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

// Diagnóstico do trilho de pagamento: confirma facilitator, credenciais e rede.
app.get('/health/x402', async (c) => {
  const network = resolveNetwork(c.env.X402_NETWORK);
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || network.defaultFacilitator;
  const hasCdpCredentials = Boolean(c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET);

  const probe = await probeFacilitator(facilitatorUrl, {
    apiKeyId: c.env.CDP_API_KEY_ID,
    apiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  const settleable = probe.networks.includes(network.caip2);

  return c.json({
    x402Version: 2,
    network: network.caip2,
    is_testnet: network.isTestnet,
    usdc_asset: network.usdcAddress,
    pay_to: c.env.PAYGATE_WALLET_ADDRESS || '0x82e36db0d0001d9c1f12a1b6761fbbad48f0999e',
    facilitator: { url: facilitatorUrl, ...probe },
    cdp_credentials_present: hasCdpCredentials,
    ready_to_charge: probe.reachable && settleable,
    diagnosis: probe.reachable
      ? settleable
        ? 'Pronto para cobrar.'
        : `Facilitator acessível mas não liquida em ${network.caip2}.`
      : `Facilitator inacessível (HTTP ${probe.status}). ${probe.detail || ''}`.trim(),
  });
});

// Homepage & Metadata Assets for Smithery/Glama
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PayGate MCP — Monetization Gateway for AI Agents</title>
  <meta name="description" content="Universal monetization gateway for Model Context Protocol (MCP) servers. Automated HTTP 402 payments (x402 USDC & Stripe MPP).">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0c10; color: #e2e8f0; margin: 0; padding: 40px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1a1d24; border: 1px solid #2d3748; border-radius: 16px; padding: 40px; max-width: 600px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h1 { color: #6366f1; margin-top: 0; }
    code { background: #2d3748; padding: 2px 8px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
    .badge { display: inline-block; background: #059669; color: white; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 0.875rem; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Operational ⚡</div>
    <h1>PayGate MCP</h1>
    <p>Monetization Gateway for AI Agents (Model Context Protocol).</p>
    <p><strong>Endpoint MCP:</strong> <code>https://paygate-mcp.rendercriativo.workers.dev/mcp</code></p>
    <p><strong>Supported Protocols:</strong> x402 (USDC on Base), Stripe MPP</p>
  </div>
</body>
</html>`);
});

app.get('/icon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4f46e5" />
      <stop offset="100%" stop-color="#06b6d4" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="128" fill="url(#grad)" />
  <path d="M280 80L140 280h100l-20 152 150-200H270l10-152z" fill="#ffffff" />
</svg>`);
});

// Descoberta Automática Smithery / Glama / UCP (Múltiplas aliases para garantia de indexação)
app.get('/.well-known/mcp/server-card.json', serverCardHandler);
app.get('/.well-known/mcp.json', serverCardHandler);
app.get('/.well-known/mcp/manifest.json', serverCardHandler);
app.get('/.well-known/ucp.json', ucpManifestHandler);
app.get('/mcp.json', serverCardHandler);

// Endpoint MCP GET Handlers for Connection Probe (Glama / Smithery / Clients / SSE)
app.get('/mcp', async (c) => {
  const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';
  const accept = c.req.header('Accept') || '';

  if (accept.includes('text/event-stream')) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'endpoint',
        data: `https://${host}/mcp`
      });
    });
  }

  return c.json({
    status: 'operational',
    service: 'paygate-mcp',
    version: '0.1.0',
    endpoint: `https://${host}/mcp`,
    transport: 'streamable_http',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'paygate-mcp', version: '0.1.0' }
  });
});

app.get('/mcp/:devId', async (c) => {
  const devId = c.req.param('devId');
  const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';
  const accept = c.req.header('Accept') || '';

  if (accept.includes('text/event-stream')) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'endpoint',
        data: `https://${host}/mcp/${devId}`
      });
    });
  }

  return c.json({
    status: 'operational',
    service: 'paygate-mcp-proxy',
    developer_id: devId,
    endpoint: `https://${host}/mcp/${devId}`,
    transport: 'streamable_http',
    capabilities: { tools: { listChanged: false } }
  });
});

// SSE Transport Direct Endpoints
app.get('/sse', async (c) => {
  const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'endpoint',
      data: `https://${host}/mcp`
    });
  });
});

app.get('/mcp/:devId/sse', async (c) => {
  const devId = c.req.param('devId');
  const host = c.req.header('host') || 'paygate-mcp.rendercriativo.workers.dev';
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'endpoint',
      data: `https://${host}/mcp/${devId}`
    });
  });
});

// Endpoint MCP do Próprio PayGate (Agentes usam list_registered_servers)
app.post('/mcp', paygateMcpHandler);

// Endpoints de Gestão para Desenvolvedores (REST API com Auth via Bearer API Key)
app.post('/api/register', registerDeveloperHandler);
app.get('/api/me', getDevProfileHandler);
app.get('/api/me/tools', getDevToolsHandler);
app.put('/api/me/tools', updateToolPriceHandler);
app.get('/api/me/earnings', getDevEarningsHandler);

// Endpoint MCP Proxy por Desenvolvedor (/mcp/:devId)
app.post('/mcp/:devId', mcpProxyHandler);

export default app;
