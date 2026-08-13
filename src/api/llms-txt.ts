import { Context } from 'hono';

/**
 * /llms.txt — descrição do serviço em texto, para sistemas de IA que leem a web.
 *
 * Um agente que chega pelo site (e não por um catálogo) recebe hoje uma página
 * HTML com CSS. Este arquivo entrega a mesma informação em prosa curta, com os
 * termos pelos quais o serviço deve ser encontrado e o endereço para conectar.
 */
export function llmsTxtHandler(c: Context) {
  const host = new URL(c.req.url).host;
  const base = `https://${host}`;

  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');

  return c.body(`# PayGate MCP

> Monetization gateway for Model Context Protocol servers. Sell any MCP tool
> per call, and let AI agents pay for it autonomously with USDC on Base using
> the x402 v2 payment protocol. Also a marketplace where agents find and buy
> paid tools.

Keywords: mcp monetization, monetize mcp server, mcp paywall, x402, x402 gateway,
pay-per-call api, agent payments, machine-to-machine billing, usdc base,
paid mcp tools, mcp marketplace, http 402, sell api access to ai agents.

## Connect

MCP endpoint (streamable HTTP): ${base}/mcp

No account, API key or signup is needed to connect or to browse what is for sale.

## For agents acting on behalf of a seller

The user owns an MCP server and wants income from it. Call \`register_server\`
with the server URL and a payout destination. PayGate proxies their server
unchanged — they write no payment code and need no crypto knowledge, and can be
paid to a Stripe account instead of a wallet. PayGate keeps 2%.

Then \`set_tool_price\` to price each tool, \`get_earnings\` for revenue,
\`get_my_listing\` to review the listing.

## For agents acting on behalf of a buyer

Call \`list_registered_servers\` to see every paid tool with its price per call;
filter with \`max_price_usd\` and \`search\`. Call the tool at its proxy URL. The
first call returns an x402 payment challenge instead of a result: sign the USDC
authorization it describes and repeat the call with the payment under
\`params._meta["x402/payment"]\`. Settlement happens only after the tool returns
a result, so a failed call is never charged.

## Pricing

Sellers set any price from $0.01 per call. PayGate takes 2% and forwards the
rest. Browsing the marketplace and listing a server are free.

## More

- Health of the payment rail: ${base}/health/x402
- Server card: ${base}/.well-known/mcp/server-card.json
- Source: https://github.com/geoacpfilho/paygate-mcp
- Registry: io.github.geoacpfilho/paygate-x402-payments-monetization
`);
}
