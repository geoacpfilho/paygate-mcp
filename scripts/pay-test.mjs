#!/usr/bin/env node
/**
 * Teste ponta a ponta de um pagamento x402 real contra o PayGate.
 *
 * Fluxo: pede o desafio -> assina a autorização EIP-3009 -> reenvia a chamada
 * com o pagamento em _meta["x402/payment"] -> imprime o hash da liquidação.
 *
 * A chave privada é lida da variável de ambiente PRIVATE_KEY e nunca é gravada
 * em disco nem enviada a lugar algum além da assinatura local.
 *
 * Uso:
 *   PRIVATE_KEY=0x... node scripts/pay-test.mjs
 *
 * A carteira precisa de USDC na Base (o valor da ferramenta, ~$0.05).
 * Não precisa de ETH: o gás é pago pelo facilitator.
 */

import { privateKeyToAccount } from 'viem/accounts';

const PAYGATE = process.env.PAYGATE_URL || 'https://paygate-mcp.rendercriativo.workers.dev';
const DEV_ID = process.env.DEV_ID || 'dev_egYYbqBPmy';
const TOOL = process.env.TOOL || 'calculate_fator_r';
const ARGS = process.env.TOOL_ARGS ? JSON.parse(process.env.TOOL_ARGS) : {};

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error('Defina PRIVATE_KEY no ambiente. Ex.: PRIVATE_KEY=0x... node scripts/pay-test.mjs');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const endpoint = `${PAYGATE}/mcp/${DEV_ID}`;

async function rpc(payload) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

console.log(`Carteira pagadora : ${account.address}`);
console.log(`Endpoint          : ${endpoint}`);
console.log(`Ferramenta        : ${TOOL}\n`);

// 1. Pedir o desafio.
const challenge = await rpc({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: TOOL, arguments: ARGS },
});

const required = challenge?.result?.structuredContent;
if (!required?.accepts?.length) {
  console.error('Não veio desafio de pagamento. Resposta:');
  console.error(JSON.stringify(challenge, null, 2));
  process.exit(1);
}

const req = required.accepts[0];
const chainId = Number(req.network.split(':')[1]);
console.log('Desafio recebido:');
console.log(`  rede    : ${req.network} (chainId ${chainId})`);
console.log(`  valor   : ${req.amount} unidades = $${(Number(req.amount) / 1e6).toFixed(6)} USDC`);
console.log(`  asset   : ${req.asset}`);
console.log(`  payTo   : ${req.payTo}\n`);

// 2. Assinar a autorização EIP-3009 (transferWithAuthorization).
const now = Math.floor(Date.now() / 1000);
const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
const nonce = `0x${Array.from(nonceBytes)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')}`;

const authorization = {
  from: account.address,
  to: req.payTo,
  value: req.amount,
  validAfter: String(now - 60),
  validBefore: String(now + (req.maxTimeoutSeconds || 120)),
  nonce,
};

const signature = await account.signTypedData({
  domain: {
    name: req.extra?.name ?? 'USDC',
    version: req.extra?.version ?? '2',
    chainId,
    verifyingContract: req.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  },
});

console.log('Autorização assinada. Reenviando a chamada com o pagamento...\n');

// 3. Reenviar com o pagamento anexado.
const paid = await rpc({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: TOOL,
    arguments: ARGS,
    _meta: {
      'x402/payment': {
        x402Version: 2,
        resource: required.resource,
        accepted: req,
        payload: { signature, authorization },
      },
    },
  },
});

const receipt = paid?.result?._meta?.['x402/payment-response'];

if (receipt?.transaction) {
  const explorer =
    chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  console.log('PAGAMENTO LIQUIDADO');
  console.log(`  tx        : ${receipt.transaction}`);
  console.log(`  explorer  : ${explorer}/tx/${receipt.transaction}`);
  console.log(`  pagador   : ${receipt.payer}`);
  console.log(`  valor     : $${receipt.amount_usd}`);
  console.log(`  taxa      : $${receipt.paygate_fee_usd}`);
  console.log(`  dev       : $${receipt.developer_net_usd}\n`);
  console.log('Resposta da ferramenta:');
  console.log(JSON.stringify(paid.result.content ?? paid.result, null, 2));
} else {
  console.log('Não liquidou. Resposta completa:');
  console.log(JSON.stringify(paid, null, 2));
  process.exit(1);
}
