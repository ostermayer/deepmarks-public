# 2026-08-21 — Scanner POST with malformed JSON pages the operator as an unhandled 500

> Severity: low (one spurious critical page per novel scanner path; no
> user impact). Written 2026-08-21 at resolution.

## Symptom

Critical alert `unhandled:POST:/jeecg-boot/jmreport/show` at 06:25:23Z:
a 500 with `SyntaxError: Expected ',' or '}' after property value in
JSON…` thrown from the api's JSON content-type parser
(`dist/index.js:108`). `/jeecg-boot/jmreport/show` is a JeecgBoot
exploit probe — pure internet background noise.

## Root cause

The api replaces Fastify's default JSON parser to keep raw bytes for
BTCPay HMAC verification. Its catch passed the bare `SyntaxError` to
`done(err)` — but unlike Fastify's built-in parser error
(`FST_ERR_CTP_INVALID_JSON`, statusCode 400), a bare SyntaxError has no
`statusCode`, so the global error handler defaulted it to **500** and
its `status >= 500` branch paged the operator.

Two aggravators:

- Fastify runs the content-type parser even for requests that match no
  route (verified empirically: POST to an unregistered path with bad
  JSON hit the parser and 500'd before the 404). So *any* path a
  scanner invents could page, and the per-route alert key
  (`unhandled:POST:<path>`) meant every novel path was a fresh,
  undebounced alert.
- The 500 body leaked the JSON parse position (harmless here, but
  sloppier than the sterile `internal error` the handler sends for real
  500s).

## Fix

`api/src/json-body-parser.ts` (extracted from `index.ts`, `b2a618c`):
the parser tags malformed-JSON errors with `statusCode = 400` before
`done(err)`. The error handler then answers 400 and does not alert
(only ≥500 pages). Raw-bytes capture (`request.rawBody`) is unchanged —
BTCPay webhook verification still works.

Verified live post-deploy: the same scanner-shaped request now returns
HTTP 400. Regression tests pin 400-on-malformed, rawBody preservation,
empty-body handling, and "scanner junk on unknown routes is never 5xx"
(`tests/api/json-body-parser.test.ts`).
