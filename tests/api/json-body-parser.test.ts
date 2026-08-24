import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRawJsonBodyParser } from '../../api/src/json-body-parser.js';

describe('raw JSON body parser', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function buildApp(): Promise<FastifyInstance> {
    app = Fastify({ logger: false });
    registerRawJsonBodyParser(app);
    // Mirror of the prod error handler in index.ts (minus the alerter):
    // status comes from err.statusCode, defaulting to 500.
    app.setErrorHandler((err, _request, reply) => {
      if (reply.sent) return;
      const e = err as { statusCode?: number; message?: string };
      const status = e.statusCode ?? 500;
      reply.status(status).send({ error: status >= 500 ? 'internal error' : (e.message ?? 'error') });
    });
    app.post('/echo', async (request) => ({
      body: request.body ?? null,
      rawBody: (request as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? null,
    }));
    await app.ready();
    return app;
  }

  it('parses valid JSON and preserves the raw bytes for HMAC verification', async () => {
    const server = await buildApp();
    const payload = '{"a": 1,  "b":"two"}';
    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { a: 1, b: 'two' }, rawBody: payload });
  });

  it('answers malformed JSON with 400, not an unhandled 500', async () => {
    // Regression: scanner POSTs with junk JSON (e.g. /jeecg-boot/jmreport
    // probes, 2026-08-21) used to surface as SyntaxError → 500 → operator
    // page. Malformed JSON is a client error.
    const server = await buildApp();
    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a": oops}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('never answers scanner junk on unknown routes with a 5xx', async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: 'POST',
      url: '/jeecg-boot/jmreport/show',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken": }',
    });
    // 404 (body never parsed) or 400 (parse error) are both fine — the
    // invariant is that unauthenticated junk cannot produce a 5xx page.
    expect(res.statusCode).toBeLessThan(500);
  });

  it('treats an empty JSON body as undefined instead of erroring', async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null, rawBody: '' });
  });
});
