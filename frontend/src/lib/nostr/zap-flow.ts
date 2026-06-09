import type { ParsedBookmark } from './bookmarks.js';
import {
  ManualPaymentRequired,
  ZapPaymentFailed,
  fetchAllZapInvoices,
  lightningUriForInvoice,
  type ZapInvoice,
  type ZapPlan,
} from './zap.js';

export async function createZapInvoices(opts: {
  plan: ZapPlan;
  bookmark: ParsedBookmark;
  zapperPubkey: string | null | undefined;
  comment: string;
}): Promise<ZapInvoice[]> {
  if (!opts.zapperPubkey) throw new Error('Sign in to zap.');
  if (!opts.plan.recipients.length) throw new Error('Enter a positive zap amount.');
  return fetchAllZapInvoices(opts.plan, opts.bookmark, opts.zapperPubkey, opts.comment);
}

export function manualFallbackInvoices(e: unknown, invoices: ZapInvoice[]): ZapInvoice[] | null {
  if (e instanceof ManualPaymentRequired) return e.invoices;
  if (e instanceof ZapPaymentFailed) return e.invoices;
  if (!invoices.length) return null;
  const message = ((e as Error).message ?? '').toLowerCase();
  if (
    message.includes('no wallet connected') ||
    message.includes('wallet is not connected') ||
    message.includes('no nwc wallet connected') ||
    message.includes('nwc wallet is not connected') ||
    message.includes('unsupported nip-07 method: webln.sendpayment')
  ) {
    return invoices;
  }
  return null;
}

export function manualNoticeForError(e: unknown): string {
  const message = ((e as Error).message ?? '').toLowerCase();
  if (e instanceof ZapPaymentFailed && e.paidPreimages.length > 0) {
    return `${e.paidPreimages.length} invoice${e.paidPreimages.length === 1 ? '' : 's'} already confirmed. Check your wallet before paying the remaining invoice${e.invoices.length === 1 ? '' : 's'} manually.`;
  }
  if (message.includes('did not respond within')) {
    return 'Your wallet may still have paid the first invoice shown here. Check your wallet history before paying manually.';
  }
  return '';
}

export function invoiceKey(invoice: string): string {
  return invoice.trim().toLowerCase();
}

export async function invoiceQrCodes(invoices: ZapInvoice[]): Promise<string[]> {
  const QRCode = await import('qrcode');
  return Promise.all(
    invoices.map((inv) =>
      QRCode.toDataURL(lightningUriForInvoice(inv.invoice), {
        margin: 2,
        width: 256,
        errorCorrectionLevel: 'M',
      })
    )
  );
}
