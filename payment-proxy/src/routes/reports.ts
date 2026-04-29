// /report — user-facing report submission. No auth required (anyone can
// report, including anonymous). Rate limited per-IP because each call
// sends an outbound email and writes to Redis — a flood would DoS Resend
// and burn Redis memory.

import { z } from 'zod';
import { hashEmailForReport } from '../reports.js';
import type { Deps } from '../route-deps.js';

const ReportSubmitSchema = z.object({
  target_type: z.enum(['bookmark_event', 'blob_hash', 'pubkey']),
  target_id: z.string().min(1).max(200),
  category: z.enum(['csam', 'illegal', 'malware', 'harassment', 'copyright', 'spam', 'other']),
  context: z.string().max(1000).optional(),
  reporter_email: z.string().email().max(320).optional(),
  reporter_pubkey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export function register(deps: Deps): void {
  const { app, reports, email, rateLimit } = deps;

  app.post('/report', async (request, reply) => {
    const gate = await rateLimit('report-ip', request.ip, 5, 60 * 60); // 5/hour
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }
    const parsed = ReportSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request' });
    }
    const p = parsed.data;
    const report = await reports.submit({
      target_type: p.target_type,
      target_id: p.target_id,
      category: p.category,
      context: p.context,
      reporter_email_hash: p.reporter_email ? hashEmailForReport(p.reporter_email) : undefined,
      reporter_pubkey: p.reporter_pubkey,
    });

    // Send notification to the appropriate alias based on severity.
    const recipient = p.category === 'csam'
      ? process.env.EMAIL_CSAM ?? 'csam@deepmarks.org'
      : process.env.EMAIL_ABUSE ?? 'abuse@deepmarks.org';

    try {
      await email.send({
        to: recipient,
        subject: `[${p.category.toUpperCase()}] New report ${report.id.slice(0, 8)}`,
        text: [
          `Report ID: ${report.id}`,
          `Category: ${p.category}`,
          `Target: ${p.target_type} ${p.target_id}`,
          `Context: ${p.context ?? '(none provided)'}`,
          `Reporter: ${p.reporter_email ? '(email hash stored)' : 'anonymous'}`,
          ``,
          `Review at https://admin.deepmarks.org/reports/${report.id}`,
        ].join('\n'),
      });
    } catch (err) {
      app.log.error({ err, reportId: report.id }, 'failed to send report notification');
      // Don't fail the submit — the report is persisted.
    }

    app.log.info({ reportId: report.id, category: p.category }, 'report submitted');
    return { ok: true, report_id: report.id };
  });
}
