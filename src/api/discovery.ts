import { Context } from 'hono';

export async function serverCardHandler(c: Context) {
  const host = new URL(c.req.url).host;
  const baseUrl = `https://${host}`;
  const iconUrl = `${baseUrl}/icon.svg`;
  const desc = "Universal monetization gateway for Model Context Protocol (MCP) servers. Enables automated machine-to-machine HTTP 402 billing with x402 USDC on Base and Stripe MPP.";

  return c.json({
    $schema: "https://smithery.ai/schemas/server-card.json",
    // Identidade já publicada nos indexadores — não renomear sem migrar a
    // listagem, sob risco de criar uma entrada duplicada.
    name: "georgefilhoconexao/paygate-mcp",
    displayName: "PayGate MCP — Monetization Gateway for AI Agents",
    description: desc,
    icon: iconUrl,
    categories: ["finance", "payments", "monetization", "mcp"],
    homepage: baseUrl,
    repository: "https://github.com/geoacpfilho/paygate-mcp",
    license: "MIT",
    transport: {
      type: "http",
      url: `${baseUrl}/mcp`
    },
    tools: [
      {
        name: "list_registered_servers",
        description: "Browse every monetized MCP tool with its price per call and proxy endpoint. Free, no key needed.",
        annotations: { readOnly: true, readOnlyHint: true, idempotent: true }
      },
      {
        name: "register_server",
        description: "List an MCP server for sale. Buyers pay the seller's wallet directly in USDC on Base; no payment code needed.",
        annotations: { readOnly: false }
      },
      {
        name: "verify_ownership",
        description: "Prove you own the server you listed by serving a token at /.well-known/paygate-verify, earning a verified badge.",
        annotations: { readOnly: false, idempotent: true }
      },
      {
        name: "set_tool_price",
        description: "Change a listed tool's price per call or take it off the market.",
        annotations: { readOnly: false, idempotent: true }
      },
      {
        name: "get_earnings",
        description: "Revenue report for a seller: paid calls, gross and net, per tool.",
        annotations: { readOnly: true, readOnlyHint: true, idempotent: true }
      },
      {
        name: "get_my_listing",
        description: "Review a seller's current listing, prices and payout destination.",
        annotations: { readOnly: true, readOnlyHint: true, idempotent: true }
      }
    ]
  });
}

export async function ucpManifestHandler(c: Context) {
  const host = new URL(c.req.url).host;
  // O contacto sai de uma variável para o repositório público não carregar um
  // e-mail pessoal. Vazio, o campo é omitido do manifesto.
  const contactEmail = (c.env as any)?.CONTACT_EMAIL || '';
  return c.json({
    ucp_version: "2026-01-30",
    business: {
      name: "PayGate MCP",
      url: `https://${host}`,
      ...(contactEmail ? { contact_email: contactEmail } : {})
    },
    services: [
      {
        type: "mcp_proxy_gateway",
        endpoint: `https://${host}/mcp`,
        description: "Autonomous machine-to-machine payment gateway for MCP tools"
      }
    ],
    payment_methods: [
      { type: "x402", network: "base", asset: "USDC" },
      { type: "stripe_mpp", protocol: "mpp_v1" }
    ]
  });
}
