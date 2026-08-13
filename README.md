# PayGate MCP

**Monetization gateway for Model Context Protocol servers.** Put any MCP server behind a pay-per-call toll that AI agents can settle autonomously — no signup, no API keys, no human in the loop.

Live endpoint: `https://paygate-mcp.rendercriativo.workers.dev/mcp`

[![x402](https://img.shields.io/badge/x402-v2-4f46e5)](https://github.com/x402-foundation/x402)
[![network](https://img.shields.io/badge/Base-USDC-06b6d4)](https://basescan.org)
[![license](https://img.shields.io/badge/license-MIT-059669)](LICENSE)

## What it does

An agent calls a tool. If the tool is monetized, PayGate answers with an [x402 v2](https://github.com/x402-foundation/x402) payment challenge instead of the result. The agent signs a USDC transfer authorization, retries, and gets its answer. Settlement happens on Base; the developer never touches payment code.

```
agent ──tools/call──▶ PayGate ──▶ 402 challenge (price, asset, payTo)
agent ──signed payload──▶ PayGate ──verify──▶ facilitator
                          PayGate ──▶ developer's MCP server ──▶ result
                          PayGate ──settle──▶ facilitator ──▶ USDC on Base
agent ◀── result + settlement receipt
```

Payment is **verified before** the tool runs and **settled after** it returns. If the tool fails or returns an error, nothing is charged.

## For agents

Discovery is free. Ask PayGate what is for sale:

```bash
curl -X POST https://paygate-mcp.rendercriativo.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_registered_servers","arguments":{}}}'
```

Calling a monetized tool without payment returns a spec-compliant challenge — a tool result with `isError: true` whose `structuredContent` holds the `PaymentRequired` object:

```jsonc
{
  "x402Version": 2,
  "error": "Payment required: calculate_fator_r custa $0.02 USDC.",
  "resource": { "url": "mcp://tool/calculate_fator_r", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "20000",                                     // 6-decimal USDC units
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x82e3...999e",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USD Coin", "version": "2" }        // EIP-712 domain
  }]
}
```

Sign an EIP-3009 `TransferWithAuthorization` using **exactly** the domain in `extra`, then retry the call with the payment attached under `params._meta["x402/payment"]`. The settlement receipt comes back in `_meta["x402/payment-response"]`.

> The USDC EIP-712 domain name is `"USD Coin"` on Base mainnet and `"USDC"` on Base Sepolia. Using the wrong one makes every signature fail verification.

A working reference client is in [`scripts/pay-test.mjs`](scripts/pay-test.mjs):

```bash
PRIVATE_KEY=0x... node scripts/pay-test.mjs
```

The paying wallet needs USDC on Base — but **no ETH**: gas is covered by the facilitator.

Both x402 transports are supported. HTTP clients can use the base64 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers instead of the MCP `_meta` binding.

## For developers who want to get paid

Register your existing MCP server and PayGate proxies it, charging per call:

```bash
curl -X POST https://paygate-mcp.rendercriativo.workers.dev/api/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Your Service",
       "target_server_url":"https://your-mcp-server.example.com/mcp",
       "wallet_address":"0xYourWallet"}'
```

You get back an API key and a proxy URL at `/mcp/<devId>`. Set per-tool prices via `PUT /api/me/tools`, check earnings at `GET /api/me/earnings`. Your server stays unchanged — PayGate forwards `initialize`, `tools/list`, `resources/list` and `prompts/list` for free, and charges only on `tools/call`.

## Health and diagnostics

`GET /health/x402` reports whether the payment rail is actually able to charge:

```json
{
  "network": "eip155:8453",
  "facilitator": { "url": "...", "reachable": true, "authenticated": true },
  "ready_to_charge": true,
  "diagnosis": "Pronto para cobrar."
}
```

## Configuration

Runtime values live in `wrangler.jsonc` (`vars`) and Cloudflare secrets.

| Variable | Purpose |
| --- | --- |
| `X402_NETWORK` | CAIP-2 network. `eip155:8453` (Base mainnet, default) or `eip155:84532` (Sepolia). |
| `X402_FACILITATOR_URL` | Facilitator base URL, no `/verify` suffix. Defaults per network. |
| `PAYGATE_WALLET_ADDRESS` | Wallet that receives payments. |
| `CONTACT_EMAIL` | Optional; omitted from the UCP manifest when empty. |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Coinbase CDP credentials. Required for mainnet — it is the only facilitator that settles on Base. |
| `UPSTREAM_AUTH_TOKEN` | Token forwarded to the developer's MCP server. |
| `STRIPE_SECRET_KEY` | Optional, for the Stripe path on tools priced ≥ $0.50. |

Base Sepolia needs no credentials: the public facilitator at `https://x402.org/facilitator` settles testnet USDC for free — the cheapest way to try the whole flow.

## Layout

```
src/
├── index.ts                 routes, health, discovery documents
├── x402/
│   ├── config.ts            network registry (CAIP-2, USDC assets, EIP-712 domains)
│   ├── protocol.ts          v2 structures, MCP + HTTP transport bindings
│   └── facilitator.ts       /verify and /settle, CDP JWT auth (EdDSA and ES256)
├── api/
│   ├── proxy.ts             the paid path: challenge → verify → execute → settle
│   ├── mcp-server.ts        PayGate's own MCP server (catalogue)
│   ├── register.ts          developer onboarding
│   ├── dev-management.ts    profile, pricing, earnings
│   └── discovery.ts         server card and UCP manifest
└── db/schema.ts             developers, tools, transactions, payment proofs
```

## Development

```bash
npm install
npx wrangler dev      # local
npx wrangler deploy   # production
```

Built on Cloudflare Workers, Hono, and D1.

## License

MIT
