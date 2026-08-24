import type { FastifyInstance } from 'fastify';

/**
 * JSON body parser that keeps the raw bytes on `request.rawBody` for
 * signature verification (BTCPay HMAC) while still exposing the parsed
 * object as `request.body`.
 *
 * Malformed JSON is tagged statusCode 400 before it reaches the error
 * handler. Without that, the bare SyntaxError defaulted to a 500 there,
 * so every internet scanner POSTing junk (e.g. the jeecg-boot probes)
 * paged the operator through the unhandled-5xx alert (2026-08-21).
 */
export function registerRawJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        const invalid = err as Error & { statusCode?: number };
        invalid.statusCode = 400;
        done(invalid, undefined);
      }
    },
  );
}
