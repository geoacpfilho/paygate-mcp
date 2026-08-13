export interface Env {
  DB: D1Database;
  ORACULO_B2R?: Fetcher;

  ENVIRONMENT?: string;
  SERVICE_NAME?: string;
  SERVICE_VERSION?: string;

  /** Rede CAIP-2 usada nas cobranças (ex.: eip155:8453). */
  X402_NETWORK?: string;
  /** URL base do facilitator; sem /verify ou /settle no final. */
  X402_FACILITATOR_URL?: string;
  /** Carteira que recebe os pagamentos. */
  PAYGATE_WALLET_ADDRESS?: string;
  /** Token enviado ao servidor MCP do desenvolvedor. */
  UPSTREAM_AUTH_TOKEN?: string;

  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  ALCHEMY_API_KEY?: string;
}
