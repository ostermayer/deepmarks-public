import { describe, expect, it } from 'vitest';
import { residentialSourceIp } from '../../archive-worker/src/residential-egress.js';

// The per-URL selector (residentialSourceIpFor / RESIDENTIAL_ALWAYS_DOMAINS)
// was removed 2026-08-24 — it never gained a production caller; the live
// wiring is youtube.ts's explicit last-ditch fallback on residentialSourceIp.

const OFF = {} as NodeJS.ProcessEnv;
const ON = { RESIDENTIAL_EGRESS_SOURCE_IP: '10.66.0.2' } as NodeJS.ProcessEnv;

describe('residential egress (last-ditch fallback)', () => {
  it('residentialSourceIp is the configured wg0 IP, or undefined when off', () => {
    expect(residentialSourceIp(OFF)).toBeUndefined();
    expect(residentialSourceIp({ RESIDENTIAL_EGRESS_SOURCE_IP: '  ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(residentialSourceIp(ON)).toBe('10.66.0.2');
  });
});
