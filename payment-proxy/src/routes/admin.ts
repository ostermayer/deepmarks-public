// /admin/* — admin-only routes.
//
// Protected by ADMIN_PUBKEYS env var (comma-separated list, parsed in
// bootstrap.ts). Admin requests use NIP-98 auth from one of these
// pubkeys. The admin UI is a separate service at admin.deepmarks.org
// that holds the admin's signer and proxies requests here.

import { z } from 'zod';
import { listInvoices } from '../btcpay.js';
import { publishLifetimeLabel } from '../nostr.js';
import type { ActionKind } from '../reports.js';
import type { Deps } from '../route-deps.js';

const ActionSchema = z.object({
  // Cap so a misclick on the admin UI (or a stolen admin nsec) can't
  // submit thousands of actions in one POST and grind through Redis
  // sequentially in a single handler. 50 is generous for the largest
  // realistic batch (a flood of related reports).
  actions: z.array(z.object({
    kind: z.enum([
      'dismiss', 'delist_index', 'delist_relay', 'delete_blob',
      'hash_blocklist', 'url_blocklist', 'suspend_pubkey',
    ]),
    reason: z.string().max(500).optional(),
    target_override: z.string().optional(),
    suspension_expires_at: z.number().int().positive().optional(),
  })).min(1).max(50),
});

export function register(deps: Deps): void {
  const {
    app,
    reports,
    blocklist,
    lifetimeStore,
    accounts,
    btcPay,
    signers,
    relayPool,
    requireAdmin,
    LIFETIME_LABEL_RELAYS,
  } = deps;

  // List pending reports.
  app.get('/admin/reports/pending', async (request, reply) => {
    const auth = await requireAdmin({ headers: request.headers, url: '/admin/reports/pending', method: 'GET' });
    if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });
    const limit = parseInt((request.query as { limit?: string }).limit ?? '50', 10);
    const pending = await reports.listPending(Math.min(limit, 200));
    return { reports: pending };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/reports/:id/action',
    async (request, reply) => {
      const auth = await requireAdmin({
        headers: request.headers,
        url: `/admin/reports/${request.params.id}/action`,
        method: 'POST',
        rawBody: (request as { rawBody?: Buffer }).rawBody,
      });
      if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });

      const parsed = ActionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid actions' });

      const report = await reports.get(request.params.id);
      if (!report) return reply.status(404).send({ error: 'report not found' });

      const applied: ActionKind[] = [];
      for (const action of parsed.data.actions) {
        const target = action.target_override ?? report.target_id;
        const reason = action.reason ?? `report ${report.id}: ${report.category}`;

        switch (action.kind) {
          case 'dismiss':
            break;
          case 'delist_index':
          case 'delist_relay':
            await blocklist.delistEvent(target, reason, auth.pubkey);
            break;
          case 'delete_blob':
          case 'hash_blocklist':
            await blocklist.blockHash(target, reason, auth.pubkey);
            // TODO: also DELETE the blob from blossom-server via its admin API
            break;
          case 'url_blocklist':
            await blocklist.blockUrl(target, reason, auth.pubkey);
            break;
          case 'suspend_pubkey':
            await blocklist.suspendPubkey(
              target, reason, auth.pubkey, action.suspension_expires_at,
            );
            break;
        }
        await reports.recordAction(report.id, {
          kind: action.kind, admin: auth.pubkey, reason,
        });
        applied.push(action.kind);
      }

      // TODO: send statement-of-reasons email to affected user.
      app.log.info({ reportId: report.id, applied, admin: auth.pubkey }, 'actions applied');
      return { ok: true, applied };
    },
  );

  // The /admin/appeals/:token/grant route was previously a stub that
  // auth-checked then returned 501. Removing it entirely until the
  // full reversal-of-actions workflow is built — a 501 stub looks like
  // a wired endpoint to anyone reading the route table, which is a
  // footgun for the admin dashboard work that consumes this API.
  // When implemented: look up report by appeal_token, reverse every
  // applied action, record the reversal in the audit log.

  // ─── Admin / lifetime-membership durability ────────────────────────
  //
  // Redis alone is one box, one disk — not enough. BTCPay keeps every
  // settled invoice forever with metadata.deepmarksPubkey attached, so
  // we treat it as the authoritative ledger. These endpoints let an
  // admin rebuild Redis from BTCPay (reconcile), issue a promo grant
  // (stamp), or dump current state for audit (members).

  app.post('/admin/lifetime/reconcile', async (request, reply) => {
    const auth = await requireAdmin({
      headers: request.headers,
      url: '/admin/lifetime/reconcile',
      method: 'POST',
      rawBody: (request as { rawBody?: Buffer }).rawBody,
    });
    if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });
    if (!btcPay) return reply.status(503).send({ error: 'btcpay not configured' });

    // Page through Settled invoices 100 at a time. BTCPay's API doesn't
    // return a total so we loop until we get a short page. Hard cap on
    // pages + wall-time so a runaway BTCPay history (or a misbehaving
    // pagination cursor that always returns full pages) doesn't pin
    // this handler indefinitely. 200 pages × 100 = 20 000 invoices is
    // ample for real history; admin can re-run if more are needed.
    const PAGE = 100;
    const MAX_PAGES = 200;
    const DEADLINE_MS = Date.now() + 60 * 1000;
    let skip = 0;
    let scanned = 0;
    let stamped = 0;
    let skipped = 0;
    let truncated = false;
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      if (Date.now() > DEADLINE_MS) { truncated = true; break; }
      const page = await listInvoices(btcPay, {
        status: ['Settled'],
        skip,
        take: PAGE,
      });
      if (page.length === 0) break;
      for (const inv of page) {
        scanned++;
        const product = typeof inv.metadata?.deepmarksProduct === 'string'
          ? inv.metadata.deepmarksProduct
          : undefined;
        if (product !== 'lifetime') { skipped++; continue; }
        const pubkey = typeof inv.metadata?.deepmarksPubkey === 'string'
          ? inv.metadata.deepmarksPubkey
          : undefined;
        if (!pubkey) { skipped++; continue; }
        const alreadyPaid = await lifetimeStore.isPaid(pubkey);
        if (!alreadyPaid) {
          // Use invoice creation time as the paidAt anchor when we have
          // to reconstruct — more accurate than "now" for a retroactive
          // stamp and won't surprise people whose badge shows up dated
          // from the original payment.
          await lifetimeStore.markPaid(pubkey, inv.expirationTime);
          try { await accounts.markLifetimePaid(pubkey, inv.expirationTime); } catch { /* no account — fine */ }
          // Re-publish the attestation so Redis-wipe recovery also
          // repopulates the relay ledger with any events that may have
          // fallen off (e.g. if a relay's retention window expired).
          publishLifetimeLabel(
            signers.brand,
            { memberPubkey: pubkey, paidAt: inv.expirationTime, invoiceId: inv.id },
            LIFETIME_LABEL_RELAYS,
            relayPool,
          ).catch(() => { /* best-effort */ });
          stamped++;
        }
      }
      if (page.length < PAGE) break;
      skip += PAGE;
    }
    // If we hit the page or wall-time cap without exhausting BTCPay,
    // mark the response so the admin knows to re-invoke.
    if (skip >= MAX_PAGES * PAGE) truncated = true;
    app.log.info({ scanned, stamped, skipped, truncated, admin: auth.pubkey }, 'lifetime reconcile complete');
    return { scanned, stamped, skipped, truncated };
  });

  app.post<{ Body: { pubkey?: string; paidAt?: number } }>(
    '/admin/lifetime/stamp',
    async (request, reply) => {
      const auth = await requireAdmin({
        headers: request.headers,
        url: '/admin/lifetime/stamp',
        method: 'POST',
        rawBody: (request as { rawBody?: Buffer }).rawBody,
      });
      if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });
      const { pubkey, paidAt } = request.body ?? {};
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'pubkey (hex, 64 chars) required in body' });
      }
      const now = Math.floor(Date.now() / 1000);
      // Bound paidAt: never in the future, never older than ~5 years.
      // Lifetime stamps in 2099 break "since X" UI copy and stamps
      // dated before deepmarks existed don't represent a real payment.
      const FIVE_YEARS = 5 * 365 * 24 * 60 * 60;
      let at = now;
      if (typeof paidAt === 'number' && Number.isInteger(paidAt) && paidAt > 0) {
        if (paidAt > now + 60 || paidAt < now - FIVE_YEARS) {
          return reply.status(400).send({ error: 'paidAt out of allowed window (past 5y, not future)' });
        }
        at = paidAt;
      }
      await lifetimeStore.markPaid(pubkey, at);
      try { await accounts.markLifetimePaid(pubkey, at); } catch { /* ok */ }
      // Publish the NIP-32 attestation for manual grants too so the
      // public ledger reflects the full set of lifetime members.
      publishLifetimeLabel(
        signers.brand,
        { memberPubkey: pubkey, paidAt: at },
        LIFETIME_LABEL_RELAYS,
        relayPool,
      ).catch(() => { /* best-effort */ });
      app.log.info({ pubkey, paidAt: at, admin: auth.pubkey }, 'manual lifetime stamp');
      return { ok: true, pubkey, paidAt: at };
    },
  );

  app.get('/admin/lifetime/members', async (request, reply) => {
    const auth = await requireAdmin({
      headers: request.headers,
      url: '/admin/lifetime/members',
      method: 'GET',
    });
    if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });
    const members = await lifetimeStore.listMembers();
    return { count: members.length, members };
  });
}
