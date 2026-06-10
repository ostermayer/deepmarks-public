/** Default ceiling for remote-signer crypto operations. NIP-46 requests
 *  settle only when the bunker replies — a sleeping phone otherwise hangs
 *  the private-bookmark refresh forever and wedges its loading latch. */
export const SIGNER_OP_TIMEOUT_MS = 30_000;

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
