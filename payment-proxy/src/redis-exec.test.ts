import { describe, expect, it } from 'vitest';
import { execOrThrow } from './redis-exec.js';

describe('execOrThrow', () => {
  it('throws when Redis reports a command-level pipeline error', async () => {
    const err = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    await expect(execOrThrow({
      exec: async () => [
        [null, 1],
        [err, null],
      ],
    })).rejects.toThrow('WRONGTYPE');
  });

  it('throws when Redis returns a null exec result', async () => {
    await expect(execOrThrow({
      exec: async () => null,
    })).rejects.toThrow('exec returned null');
  });
});
