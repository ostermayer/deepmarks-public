import { describe, it, expect } from 'vitest';

// Regression guard (2026-08-23 cleanup review #1): the email-account
// removal deleted privateMarksRemoved/hadAccount from the DELETE /account
// response while this schema still REQUIRED them — every account deletion
// then errored client-side AFTER the server had irreversibly tombstoned.
// The server currently returns compatibility constants for shipped
// clients; this pins that the schema tolerates their eventual removal.
import { AccountDeleteResponseSchema } from '$lib/api/client';

const base = {
  ok: true as const,
  releasedUsername: null,
  revokedApiKeys: 0,
};

describe('AccountDeleteResponseSchema', () => {
  it('accepts a response WITHOUT the email-era fields', () => {
    const parsed = AccountDeleteResponseSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('still accepts the compatibility constants the server sends today', () => {
    const parsed = AccountDeleteResponseSchema.safeParse({
      ...base,
      privateMarksRemoved: 0,
      hadAccount: false,
    });
    expect(parsed.success).toBe(true);
  });
});
