/**
 * Run a Redis multi()/pipeline and throw on any command-level error.
 *
 * ioredis resolves exec() with [[err, result], ...] when Redis accepts the
 * pipeline but an individual command fails. Queue state transitions must
 * inspect those entries so partial writes do not masquerade as completion.
 */
export async function execOrThrow(pipeline: { exec: () => Promise<unknown> }): Promise<void> {
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!results) throw new Error('redis pipeline failed (exec returned null)');
  for (const entry of results) {
    const err = entry?.[0];
    if (err) throw err instanceof Error ? err : new Error(String(err));
  }
}
