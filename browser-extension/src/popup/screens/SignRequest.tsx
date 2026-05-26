// NIP-07 sign-in / sign-event and WebLN payment approval.
//
// "REQUESTED BY" label → site card (favicon + hostname + URL +
// VERIFIED SSL pill) → "ACTION" sand panel describing the sign action
// → "EVENT PREVIEW" mono JSON of the template → "REMEMBER DECISION"
// radio group → footer (Reject / Approve & sign).
//
// The list of pending requests comes from the background service worker
// via chrome.runtime.sendMessage({kind:'nip07-list-pending'}). Approve /
// Reject sends {kind:'nip07-resolve', id, decision, remember}.

import { useEffect, useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { BackButton } from '../components/BackButton.js';
import { navigate } from '../router.js';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { savedLoginLabel, type SavedLoginScope } from '../../lib/settings-store.js';

type Remember = 'just-once' | 'until-close' | 'one-hour' | 'forever';

interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  origin: string;
  title: string;
  createdAt: number;
}

export function SignRequest() {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [active, setActive] = useState(0);
  const [remember, setRemember] = useState<Remember>('just-once');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const reply = await chrome.runtime.sendMessage({ kind: 'nip07-list-pending' });
      setRequests((reply?.pending ?? []) as PendingRequest[]);
      setError(null);
    } catch (e) {
      setRequests([]);
      setError((e as Error).message ?? 'extension runtime unavailable — reload this tab');
    }
  }

  // Poll for new pending requests while the screen is open. Without
  // this, a request that arrives during review never appears — the
  // user only sees it after refreshing the popup. 1.5s feels live
  // without burning service-worker cycles.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(interval);
  }, []);

  async function decide(decision: 'approve' | 'reject') {
    if (!requests[active]) return;
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({
        kind: 'nip07-resolve',
        id: requests[active]!.id,
        decision,
        remember: requests[active]!.method === 'webln.sendPayment' ? 'just-once' : remember,
      });
      const next = requests.filter((_, i) => i !== active);
      setRequests(next);
      if (next.length === 0) {
        navigate('recent');
      } else {
        setActive(Math.min(active, next.length - 1));
      }
    } catch (e) {
      setError((e as Error).message ?? 'could not respond to this request');
    } finally {
      setBusy(false);
    }
  }

  if (requests.length === 0) {
    return <NoRequests error={error} />;
  }

  const req = requests[active]!;
  const host = (() => { try { return new URL(req.origin).hostname; } catch { return req.origin; } })();
  const isHttps = req.origin.startsWith('https://');
  const isSignEvent = req.method === 'signEvent';
  const isPayment = req.method === 'webln.sendPayment';
  const eventPreview = isSignEvent
    ? JSON.stringify(req.params[0], null, 2)
    : null;
  const paymentPreview = isPayment ? describeInvoice(req.params[0]) : null;
  const actionDescription = describeAction(req);
  const scope = rememberScope(req);
  const showRemember = !!scope;
  const approveCopy = busy
    ? isPayment ? 'Paying…' : isSignEvent ? 'Signing…' : 'Approving…'
    : isPayment ? 'Approve & pay' : isSignEvent ? 'Approve & sign' : 'Approve';

  return (
    <div style={page}>
      <header style={header}>
        <div style={brandRow}>
          <BackButton />
          <Pennant size={14} />
          <span style={brand}>Deepmarks</span>
        </div>
        {requests.length > 1 && (
          <span style={countBadge}>
            {active + 1} of {requests.length}
          </span>
        )}
      </header>

      <div style={body}>
        <div>
          <div style={uppercaseLabel}>requested by</div>
          <div style={siteCard}>
            <div style={favicon}>{host.charAt(0).toUpperCase()}</div>
            <div style={siteCardMain}>
              <div style={siteCardHost}>{host}</div>
              <div style={siteCardUrl}>{req.origin}</div>
            </div>
            {isHttps
              ? <span style={sslPill}>VERIFIED SSL</span>
              : <span style={insecurePill}>INSECURE HTTP</span>}
          </div>
        </div>

        <div>
          <div style={uppercaseLabel}>action</div>
          <div style={sandPanel}>{actionDescription}</div>
        </div>

        {eventPreview && (
          <div>
            <div style={uppercaseLabel}>event preview</div>
            <pre style={eventPreviewStyle}>{eventPreview}</pre>
          </div>
        )}

        {paymentPreview && (
          <div>
            <div style={uppercaseLabel}>payment preview</div>
            <div style={paymentPanel}>
              <PaymentRow label="amount" value={paymentPreview.amount} />
              <PaymentRow label="description" value={paymentPreview.description} />
              <PaymentRow label="expires" value={paymentPreview.expires} />
              <PaymentRow label="network" value={paymentPreview.network} />
              <div style={invoiceText}>{paymentPreview.invoice}</div>
            </div>
          </div>
        )}

        {showRemember && (
          <div>
            <div style={uppercaseLabel}>remember {savedLoginLabel(scope)}</div>
            <div style={radioGroup}>
              {([
                ['just-once',   'Just this time'],
                ['until-close', 'Until I close the browser'],
                ['one-hour',    'For 1 hour'],
                ['forever',     'Forever — add to saved logins ★'],
              ] as [Remember, string][]).map(([val, label]) => (
                <label key={val} style={radioRow}>
                  <input
                    type="radio"
                    name="remember"
                    value={val}
                    checked={remember === val}
                    onChange={() => setRemember(val)}
                  />
                  <span style={radioLabel}>{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer style={footer}>
        <button
          type="button"
          style={{ ...btnSplit, ...rejectBtn, opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => void decide('reject')}
        >
          Reject
        </button>
        <button
          type="button"
          style={{ ...btnSplit, ...approveBtn, opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => void decide('approve')}
        >
          {approveCopy}
        </button>
      </footer>
    </div>
  );
}

function rememberScope(req: PendingRequest): SavedLoginScope | null {
  if (req.method === 'getPublicKey' || req.method === 'getRelays' || req.method === 'webln.enable' || req.method === 'webln.getInfo') {
    return { method: req.method };
  }
  if (req.method === 'signEvent') {
    const tpl = req.params[0] as { kind?: unknown } | null;
    const kind = tpl && typeof tpl.kind === 'number' && Number.isInteger(tpl.kind) ? tpl.kind : null;
    if (kind === null) return null;
    if (new Set([0, 3, 5, 13, 1059, 10002]).has(kind)) return null;
    return { method: 'signEvent', kind };
  }
  return null;
}

function describeAction(req: PendingRequest): string {
  if (req.method === 'getPublicKey') {
    return 'Identify you to this site (share your nostr pubkey)';
  }
  if (req.method === 'getRelays') {
    return 'Read your relay list';
  }
  if (req.method === 'signEvent') {
    const tpl = req.params[0] as { kind?: number };
    return `Sign a kind:${tpl?.kind ?? '?'} event with your nostr key`;
  }
  if (req.method === 'nip04.encrypt' || req.method === 'nip44.encrypt') {
    return 'Encrypt a message to a recipient using your private key';
  }
  if (req.method === 'nip04.decrypt' || req.method === 'nip44.decrypt') {
    return 'Decrypt a message addressed to you';
  }
  if (req.method === 'webln.enable') {
    return 'Allow this site to use the Deepmarks WebLN wallet bridge';
  }
  if (req.method === 'webln.getInfo') {
    return 'Read basic wallet capabilities from the Deepmarks WebLN bridge';
  }
  if (req.method === 'webln.sendPayment') {
    return 'Pay a Lightning invoice through your connected NWC wallet';
  }
  return req.method;
}

interface InvoicePreview {
  amount: string;
  description: string;
  expires: string;
  network: string;
  invoice: string;
}

function describeInvoice(raw: unknown): InvoicePreview {
  const invoice = typeof raw === 'string' ? raw.trim() : '';
  if (!invoice) {
    return {
      amount: 'invalid invoice',
      description: 'unable to decode',
      expires: 'unknown',
      network: 'unknown',
      invoice: '',
    };
  }
  try {
    const decoded = decodeBolt11(invoice) as {
      sections?: Array<{ name?: string; value?: unknown }>;
      expiry?: number;
    };
    const sections = decoded.sections ?? [];
    const amount = sections.find((s) => s.name === 'amount')?.value;
    const description = sections.find((s) => s.name === 'description')?.value;
    const descriptionHash = sections.find((s) => s.name === 'description_hash')?.value;
    const network = sections.find((s) => s.name === 'coin_network')?.value as { bech32?: string } | undefined;
    const timestamp = sections.find((s) => s.name === 'timestamp')?.value;
    const expiryTag = sections.find((s) => s.name === 'expiry')?.value;
    return {
      amount: typeof amount === 'string' ? formatMsats(amount) : 'amount not specified',
      description: typeof description === 'string'
        ? description
        : typeof descriptionHash === 'string'
          ? `description hash ${descriptionHash.slice(0, 16)}…`
          : 'none',
      expires: formatInvoiceExpiry(timestamp, expiryTag, decoded.expiry),
      network: network?.bech32 === 'bc' ? 'Bitcoin mainnet' : network?.bech32 ?? 'unknown',
      invoice: abbreviateInvoice(invoice),
    };
  } catch {
    return {
      amount: 'unable to decode',
      description: 'check the wallet prompt before approving',
      expires: 'unknown',
      network: 'unknown',
      invoice: abbreviateInvoice(invoice),
    };
  }
}

function formatMsats(raw: string): string {
  try {
    const msats = BigInt(raw);
    const sats = msats / 1000n;
    const remainder = msats % 1000n;
    if (remainder === 0n) return `${sats.toLocaleString()} sats`;
    return `${sats.toLocaleString()}.${remainder.toString().padStart(3, '0')} sats`;
  } catch {
    return `${raw} msats`;
  }
}

function formatInvoiceExpiry(timestamp: unknown, expiryTag: unknown, decodedExpiry: unknown): string {
  const expiryUnix =
    typeof decodedExpiry === 'number'
      ? decodedExpiry
      : typeof timestamp === 'number'
        ? timestamp + (typeof expiryTag === 'number' ? expiryTag : 3600)
        : null;
  if (!expiryUnix) return 'unknown';
  const ms = expiryUnix * 1000;
  const diffSeconds = Math.floor((ms - Date.now()) / 1000);
  const time = new Date(ms).toLocaleString();
  if (diffSeconds < 0) return `expired at ${time}`;
  if (diffSeconds < 90) return `in ${Math.max(diffSeconds, 0)}s`;
  if (diffSeconds < 3600) return `in ${Math.ceil(diffSeconds / 60)}m`;
  return time;
}

function abbreviateInvoice(invoice: string): string {
  if (invoice.length <= 72) return invoice;
  return `${invoice.slice(0, 34)}…${invoice.slice(-24)}`;
}

function PaymentRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={paymentRow}>
      <span style={paymentLabel}>{label}</span>
      <span style={paymentValue}>{value}</span>
    </div>
  );
}

function NoRequests({ error }: { error?: string | null }) {
  return (
    <div style={emptyPage}>
      <span style={emptyText}>no pending requests</span>
      {error && <span style={emptyError}>{error}</span>}
      <button style={emptyBack} onClick={() => navigate('recent')}>back to recent</button>
    </div>
  );
}

// ── Styles

const page: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: colors.paper, color: colors.ink, fontFamily: fonts.sans,
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: `${space.lg}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairline}`,
};
const brandRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const brand: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.accent,
};
const countBadge: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.muted, letterSpacing: '0.04em',
};
const body: React.CSSProperties = {
  flex: 1, padding: `${space.lg}px ${space.xl}px`,
  overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: space.lg,
};
const uppercaseLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs,
};
const siteCard: React.CSSProperties = {
  background: '#fff', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: space.lg,
  display: 'flex', alignItems: 'center', gap: space.lg,
};
const favicon: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 2, background: colors.tagBg,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, fontWeight: 600, color: colors.muted, flexShrink: 0,
};
const siteCardMain: React.CSSProperties = { flex: 1, minWidth: 0 };
const siteCardHost: React.CSSProperties = {
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.ink,
};
const siteCardUrl: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.muted,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const sslPill: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, fontWeight: 500, color: colors.good,
  padding: '2px 6px', background: '#e8f0e3', borderRadius: radius.badge,
  flexShrink: 0,
};
const insecurePill: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, fontWeight: 500, color: colors.warn,
  padding: '2px 6px', background: '#fbe9e3', borderRadius: radius.badge,
  flexShrink: 0,
};
const sandPanel: React.CSSProperties = {
  background: colors.paperAlt, border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: space.lg,
  fontSize: fontSize.bodyMicro, lineHeight: lineHeight.body, color: colors.inkSoft,
};
const eventPreviewStyle: React.CSSProperties = {
  margin: 0, padding: space.lg,
  background: '#fff', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.inkSoft,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflowY: 'auto',
};
const paymentPanel: React.CSSProperties = {
  background: '#fff', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: space.lg,
  display: 'flex', flexDirection: 'column', gap: space.sm,
};
const paymentRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr)', gap: space.sm,
  alignItems: 'baseline',
};
const paymentLabel: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em',
  color: colors.muted, textTransform: 'uppercase',
};
const paymentValue: React.CSSProperties = {
  minWidth: 0, fontSize: fontSize.bodySmall, lineHeight: lineHeight.body,
  color: colors.inkSoft, overflowWrap: 'anywhere',
};
const invoiceText: React.CSSProperties = {
  marginTop: space.xs,
  paddingTop: space.sm,
  borderTop: `1px solid ${colors.hairlineSoft}`,
  fontFamily: fonts.mono,
  fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall,
  color: colors.muted,
  overflowWrap: 'anywhere',
};
const radioGroup: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: space.sm,
};
const radioRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm, cursor: 'pointer',
};
const radioLabel: React.CSSProperties = {
  fontSize: fontSize.bodySmall, color: colors.inkSoft,
};
const footer: React.CSSProperties = {
  borderTop: `1px solid ${colors.hairline}`,
  padding: `${space.lg}px ${space.xl}px`,
  display: 'flex', gap: space.sm,
};
const btnSplit: React.CSSProperties = {
  flex: 1, padding: space.lg, borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, fontWeight: 500,
  cursor: 'pointer',
};
const rejectBtn: React.CSSProperties = {
  background: 'transparent', color: colors.inkSoft,
  border: `1px solid ${colors.hairline}`,
};
const approveBtn: React.CSSProperties = {
  background: colors.ink, color: colors.paper, border: 'none',
};
const emptyPage: React.CSSProperties = {
  height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexDirection: 'column', gap: space.lg,
  background: colors.paper, fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
};
const emptyText: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em',
};
const emptyError: React.CSSProperties = {
  maxWidth: 260, textAlign: 'center', lineHeight: lineHeight.body,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall, color: colors.warn,
};
const emptyBack: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: `${space.sm}px ${space.lg}px`,
  cursor: 'pointer', fontFamily: fonts.sans, fontSize: fontSize.metaSmall, color: colors.inkSoft,
};
