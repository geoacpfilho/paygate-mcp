-- Migração 0001: Schema inicial do PayGate MCP

-- Desenvolvedores cadastrados
CREATE TABLE IF NOT EXISTS developers (
  id TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  target_server_url TEXT NOT NULL,
  stripe_account_id TEXT,
  wallet_address TEXT,
  commission_rate REAL DEFAULT 0.02,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Ferramentas registradas por desenvolvedor
CREATE TABLE IF NOT EXISTS registered_tools (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (developer_id) REFERENCES developers(id),
  UNIQUE(developer_id, tool_name)
);

-- Transações financeiras M2M
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT,
  payment_method TEXT NOT NULL,
  gross_amount_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  net_amount_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'completed',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (developer_id) REFERENCES developers(id)
);

-- Índices de consulta rápida
CREATE INDEX IF NOT EXISTS idx_dev_api_key ON developers(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_tools_dev ON registered_tools(developer_id);
CREATE INDEX IF NOT EXISTS idx_tx_dev ON transactions(developer_id);
