// Short-lived token stored in Redis: proves the client completed a
// fresh WebAuthn assertion for a given pubkey. Used to gate the
// ciphertext GET without forcing the client to replay the full
// WebAuthn exchange on every read.
//
// Lives here (not in routes/passkey.ts) so routes/ciphertext.ts can
// redeem the token without importing from a sibling route module.

import type { Redis } from 'ioredis';

export const ASSERT_TOKEN_TTL_SECONDS = 120;

export async function issueAssertToken(redis: Redis, pubkey: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '');
  await redis.set(`dm:passkey:token:${token}`, pubkey, 'EX', ASSERT_TOKEN_TTL_SECONDS);
  return token;
}

export async function redeemAssertToken(
  redis: Redis,
  token: string,
  pubkey: string,
): Promise<boolean> {
  const claimed = await redis.get(`dm:passkey:token:${token}`);
  if (!claimed || claimed !== pubkey) return false;
  await redis.del(`dm:passkey:token:${token}`);
  return true;
}
