// BOLT-11 invoice presentation: QR code, copy-to-clipboard, lightning:
// URL link, and (when configured) a one-tap "Pay with NWC" button
// that ships the invoice to the user's connected wallet via NIP-47.
// The same card is used by the Saved screen when a paid archive is
// in progress.

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { colors, fonts, fontSize, radius, space } from '../../shared/tokens.js';
import { isNwcConnected, payInvoice, NwcError } from '../../lib/nwc.js';

export function InvoiceCard({ invoice, amountSats }: { invoice: string; amountSats: number }) {
  const [qr, setQr] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [hasNwc, setHasNwc] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    void QRCode.toDataURL(invoice.toUpperCase(), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    }).then(setQr);
    void isNwcConnected().then(setHasNwc);
  }, [invoice]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* user can manually select instead */
    }
  }

  async function payViaNwc() {
    setPayError(null);
    setPaying(true);
    try {
      await payInvoice(invoice);
      setPaid(true);
    } catch (e) {
      // NWC errors carry the wallet's reason code in `code`; surface
      // the message verbatim so the user sees "INSUFFICIENT_BALANCE",
      // "QUOTA_EXCEEDED", etc. directly from their wallet.
      if (e instanceof NwcError) setPayError(`${e.code}: ${e.message}`);
      else setPayError((e as Error).message ?? 'NWC payment failed');
    } finally {
      setPaying(false);
    }
  }

  return (
    <div style={card}>
      <div style={amount}>{amountSats.toLocaleString()} sats</div>
      {qr && <img src={qr} alt="invoice QR code" style={qrStyle} />}
      {hasNwc && !paid && (
        <button
          type="button"
          style={nwcBtn}
          onClick={() => void payViaNwc()}
          disabled={paying}
        >
          {paying ? 'paying…' : '⚡ pay with connected wallet'}
        </button>
      )}
      {paid && (
        <div style={paidNote}>✓ paid via NWC — waiting for settlement</div>
      )}
      {payError && <div style={errNote}>{payError}</div>}
      <div style={btnRow}>
        <button type="button" style={btn} onClick={() => void copy()}>
          {copied ? 'copied ✓' : 'copy invoice'}
        </button>
        <a href={`lightning:${invoice}`} style={btn}>open in wallet</a>
      </div>
      <p style={hint}>
        {hasNwc
          ? 'Or scan with any Lightning wallet — we poll for settlement automatically.'
          : 'Scan with any Lightning wallet — Phoenix, Wallet of Satoshi, Cash App, Alby. Or connect NWC in Settings for one-tap pay.'}
      </p>
    </div>
  );
}

const card: React.CSSProperties = {
  background: '#fff', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: space.lg,
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.sm,
};
const amount: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.body, fontWeight: 500, color: colors.accent,
};
const qrStyle: React.CSSProperties = {
  width: 220, height: 220, imageRendering: 'pixelated',
};
const btnRow: React.CSSProperties = {
  display: 'flex', gap: space.sm, width: '100%',
};
const btn: React.CSSProperties = {
  flex: 1, textAlign: 'center', textDecoration: 'none',
  padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: 'transparent', color: colors.inkSoft,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall, cursor: 'pointer',
};
const nwcBtn: React.CSSProperties = {
  width: '100%', textAlign: 'center',
  padding: `${space.md}px ${space.lg}px`,
  border: `1px solid ${colors.ink}`, borderRadius: radius.std,
  background: colors.ink, color: colors.paper,
  fontFamily: fonts.sans, fontSize: fontSize.body, fontWeight: 500,
  cursor: 'pointer',
};
const paidNote: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.accent,
  textAlign: 'center',
};
const errNote: React.CSSProperties = {
  fontSize: fontSize.uppercaseLabel, color: '#a33',
  textAlign: 'center', lineHeight: 1.4,
};
const hint: React.CSSProperties = {
  margin: 0, fontSize: fontSize.uppercaseLabel,
  color: colors.muted, textAlign: 'center', lineHeight: 1.4,
};
