-- Migração 0002: Rastreamento de transações on-chain, status de repasse e proteção anti-replay

-- Adicionar colunas de controle financeiro na tabela de transações
ALTER TABLE transactions ADD COLUMN tx_hash TEXT;
ALTER TABLE transactions ADD COLUMN stripe_payment_id TEXT;
ALTER TABLE transactions ADD COLUMN split_status TEXT DEFAULT 'settled';
ALTER TABLE transactions ADD COLUMN split_completed_at TEXT;

-- Tabela de comprovantes de pagamento processados (Proteção Anti-Replay)
CREATE TABLE IF NOT EXISTS processed_payment_proofs (
  proof_hash TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_proof_hash ON processed_payment_proofs(proof_hash);
