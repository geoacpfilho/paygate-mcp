import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const developers = sqliteTable('developers', {
  id: text('id').primaryKey(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  name: text('name').notNull(),
  email: text('email'),
  targetServerUrl: text('target_server_url').notNull(),
  stripeAccountId: text('stripe_account_id'),
  walletAddress: text('wallet_address'),
  commissionRate: real('commission_rate').default(0.02),
  isActive: integer('is_active').default(1),
  // Posse do servidor comprovada: 1 depois que o dono publica o token de
  // verificação no domínio do próprio servidor. Fica visível no catálogo.
  isVerified: integer('is_verified').default(0),
  verifyToken: text('verify_token'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const registeredTools = sqliteTable('registered_tools', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  toolName: text('tool_name').notNull(),
  priceCents: integer('price_cents').notNull(),
  description: text('description'),
  isActive: integer('is_active').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  toolName: text('tool_name').notNull(),
  agentId: text('agent_id'),
  paymentMethod: text('payment_method').notNull(),
  grossAmountCents: integer('gross_amount_cents').notNull(),
  commissionCents: integer('commission_cents').notNull(),
  netAmountCents: integer('net_amount_cents').notNull(),
  status: text('status').default('completed'),
  txHash: text('tx_hash'),
  stripePaymentId: text('stripe_payment_id'),
  splitStatus: text('split_status').default('settled'),
  splitCompletedAt: text('split_completed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const processedPaymentProofs = sqliteTable('processed_payment_proofs', {
  proofHash: text('proof_hash').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => transactions.id),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});
