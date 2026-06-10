// One place to read env. Every other module takes an already-built
// config object so tests can inject whatever shape they need without
// poking process.env.

export interface BunkerConfig {
  /** Host for the /health endpoint — keep on 0.0.0.0 so compose
   *  healthchecks work; UFW on Box C blocks external reach anyway. */
  host: string;
  port: number;
  /** Relay we subscribe to for NIP-46 requests + publish responses to.
   *  In prod this is Box A's strfry over the VPC, non-TLS. */
  relayUrl: string;
  /** Filesystem paths to the nsec files for each identity. Files must be
   *  chmod 400 and contain a bech32 nsec1… or 64-char hex. */
  brandNsecPath: string;
  personalNsecPath: string;
  /** Audit log — append-only JSONL. Directory must exist + be writable. */
  auditPath: string;
  /** Allowlisted payment-proxy client pubkey. Only requests signed by
   *  this key are considered. Set to a random new keypair per deploy. */
  clientPubkey: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfigFromEnv(): BunkerConfig {
  const required = ['BUNKER_RELAY_URL', 'BUNKER_BRAND_NSEC_PATH', 'BUNKER_PERSONAL_NSEC_PATH', 'BUNKER_CLIENT_PUBKEY'];
  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(`${k} is required`);
    }
  }
  return {
    host: process.env.BUNKER_HOST ?? '0.0.0.0',
    port: Number.parseInt(process.env.BUNKER_PORT ?? '4100', 10),
    relayUrl: process.env.BUNKER_RELAY_URL!,
    brandNsecPath: process.env.BUNKER_BRAND_NSEC_PATH!,
    personalNsecPath: process.env.BUNKER_PERSONAL_NSEC_PATH!,
    auditPath: process.env.BUNKER_AUDIT_PATH ?? '/var/log/deepmarks-bunker/audit.jsonl',
    clientPubkey: process.env.BUNKER_CLIENT_PUBKEY!,
    logLevel: (process.env.LOG_LEVEL as BunkerConfig['logLevel']) ?? 'info',
  };
}
