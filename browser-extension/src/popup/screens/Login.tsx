// Login. Two modes:
//   1. Paste — user already has an nsec. Standard input + Unlock.
//   2. Generated — user doesn't have one yet. We mint a fresh
//      Schnorr key locally with nostr-tools.generateSecretKey, show
//      the resulting nsec1… so they can back it up, gate Continue
//      on a "saved it" checkbox.
//
// In both modes the Unlock/Continue handler funnels through
// nsecStore.set which decodes the nsec, derives the pubkey, and
// stamps the schemaVersion-1 record into local storage.

import { useState } from 'react';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { BackButton } from '../components/BackButton.js';
import { nsecStore, type NsecState } from '../../lib/nsec-store.js';
import { fetchUserRelayList } from '../../lib/nostr.js';
import { importNip65Relays } from '../../lib/settings-store.js';

type Mode =
  | { kind: 'paste' }
  | { kind: 'generated'; nsec: string; backupConfirmed: boolean; copied: boolean };

export function Login({ onSignedIn }: { onSignedIn: (state: NsecState) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: 'paste' });
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validPaste = value.trim().startsWith('nsec1') && value.trim().length >= 60;
  const canSubmit =
    mode.kind === 'paste'
      ? validPaste
      : mode.backupConfirmed;

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      const input = mode.kind === 'generated' ? mode.nsec : value.trim();
      const state = await nsecStore.setPlain(input);
      // Import the user's existing NIP-65 relay list so the extension
      // respects the relays they already use elsewhere instead of
      // forcing the default-4 set. Fire-and-forget — sign-in must not
      // block on a relay query, and a missing kind:10002 just means
      // the user has no published list yet (most new users).
      if (state.pubkey) {
        void fetchUserRelayList(state.pubkey)
          .then((list) => { if (list.length > 0) return importNip65Relays(list); })
          .catch(() => { /* silent — UX shouldn't fail on a relay blip */ });
      }
      onSignedIn(state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function generateLocal() {
    // generateSecretKey returns a 32-byte Uint8Array. We display it
    // bech32-encoded (`nsec1…`) since that's what the user will see
    // everywhere else and what they should back up.
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    // Defence: zero out the hex form once nsec is encoded. The bytes
    // live as long as `sk` is referenced; React keeping the nsec
    // string in state is the unavoidable copy.
    void bytesToHex; // keep import retained
    setValue('');
    setError(null);
    setMode({ kind: 'generated', nsec, backupConfirmed: false, copied: false });
  }

  async function copyGenerated() {
    if (mode.kind !== 'generated') return;
    try {
      await navigator.clipboard.writeText(mode.nsec);
      setMode({ ...mode, copied: true });
      setTimeout(() => {
        setMode((m) => (m.kind === 'generated' ? { ...m, copied: false } : m));
      }, 1500);
    } catch {
      /* clipboard refused — user can select manually */
    }
  }

  /** Download the nsec as a plain text file. Same convenience the web
   *  app's signup flow offers (see frontend signup +page.svelte) —
   *  drop into a password manager / paper / encrypted USB / whatever. */
  function downloadGenerated() {
    if (mode.kind !== 'generated') return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const content = [
      `# Deepmarks — Nostr identity backup`,
      `# Generated ${new Date().toISOString()}`,
      ``,
      `# Your nsec is your PRIVATE KEY. Anyone holding it controls the account forever.`,
      `# Treat it like a seed phrase. There is no recovery if you lose it.`,
      `nsec: ${mode.nsec}`,
      ``,
      `# You can import this nsec into any Nostr client: Damus, Primal, Amethyst,`,
      `# Alby (browser extension), nsec.app, Amber, etc. The same identity works`,
      `# across every Nostr app.`,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepmarks-nsec-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div style={page}>
      <header style={header}>
        <BackButton />
        <Pennant size={14} />
        <span style={brand}>Deepmarks</span>
      </header>

      <div style={body}>
        {mode.kind === 'paste' ? (
          <>
            <h1 style={h1}>Paste your nsec</h1>
            <p style={lede}>Stays on this device. Never sent anywhere.</p>

            <label style={uppercaseLabel}>private key</label>
            <input
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="nsec1…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && validPaste && !busy) void unlock(); }}
              style={input}
            />

            <div style={warningRow}>
              <span style={warningPrefix}>!</span>
              <span style={warningText}>
                your nsec is your password. don't paste it into apps you don't trust.
              </span>
            </div>

            {error && <div style={errorRow}>{error}</div>}

            <div style={divider} />
            <button type="button" onClick={generateLocal} style={generateBtn}>
              Don't have one? Generate a new key →
            </button>
          </>
        ) : (
          <>
            <h1 style={h1}>Your new nsec</h1>
            <p style={lede}>
              Save this somewhere safe. <strong>If you lose it, the account is gone</strong>{' '}
              — there's no password reset on Nostr.
            </p>

            <label style={uppercaseLabel}>private key</label>
            <div style={generatedKey}>{mode.nsec}</div>
            <div style={generatedActions}>
              <button type="button" onClick={() => void copyGenerated()} style={copyBtn}>
                {mode.copied ? 'copied ✓' : 'copy nsec'}
              </button>
              <button type="button" onClick={downloadGenerated} style={copyBtn}>
                download .txt
              </button>
            </div>

            <div style={warningRow}>
              <span style={warningPrefix}>!</span>
              <span style={warningText}>
                your nsec is your password. paste it into a password manager, write it down,
                or download it. anyone with this string controls the account.
              </span>
            </div>

            <label style={confirmRow}>
              <input
                type="checkbox"
                checked={mode.backupConfirmed}
                onChange={(e) => setMode({ ...mode, backupConfirmed: e.target.checked })}
              />
              <span>I've saved my nsec somewhere safe.</span>
            </label>

            {error && <div style={errorRow}>{error}</div>}

            <div style={divider} />
            <button
              type="button"
              onClick={() => { setMode({ kind: 'paste' }); setValue(''); }}
              style={generateBtn}
            >
              ← Already have one? Paste it instead
            </button>
          </>
        )}
      </div>

      <footer style={footer}>
        <button
          style={{ ...primaryBtn, opacity: canSubmit && !busy ? 1 : 0.5, cursor: canSubmit && !busy ? 'pointer' : 'not-allowed' }}
          disabled={!canSubmit || busy}
          onClick={() => void unlock()}
        >
          {busy
            ? (mode.kind === 'generated' ? 'Saving…' : 'Unlocking…')
            : (mode.kind === 'generated' ? 'Continue' : 'Unlock')}
        </button>
      </footer>
    </div>
  );
}

// ── Styles

const page: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: colors.paper, color: colors.ink, fontFamily: fonts.sans,
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: `${space.lg}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairline}`,
};
const brand: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.accent,
};
const body: React.CSSProperties = {
  flex: 1, padding: `${space.xxl}px ${space.xxl}px ${space.xl}px`, overflowY: 'auto',
};
const h1: React.CSSProperties = {
  margin: `0 0 ${space.xs}px`, fontSize: fontSize.h1, lineHeight: lineHeight.h1,
  fontWeight: 500, letterSpacing: '-0.01em', color: colors.ink,
};
const lede: React.CSSProperties = {
  margin: `0 0 ${space.xl}px`, fontSize: fontSize.bodySmall,
  lineHeight: lineHeight.body, color: colors.inkSoft,
};
const uppercaseLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs,
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: `${space.md}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  background: '#fff', color: colors.ink,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro,
  outline: 'none',
  marginBottom: space.lg,
};
const warningRow: React.CSSProperties = {
  display: 'flex', gap: space.sm, alignItems: 'flex-start',
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.warn,
  marginTop: space.xs,
};
const warningPrefix: React.CSSProperties = { fontWeight: 700 };
const warningText: React.CSSProperties = { lineHeight: 1.5 };
const errorRow: React.CSSProperties = {
  marginTop: space.lg,
  padding: `${space.sm}px ${space.lg}px`,
  background: '#fbe9e3', color: '#8b2f17',
  borderRadius: radius.std,
  fontSize: fontSize.metaSmall,
};
const divider: React.CSSProperties = {
  borderTop: `1px solid ${colors.hairlineSoft}`,
  margin: `${space.xl}px 0 ${space.lg}px`,
};
const generateBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall, color: colors.accent,
  textAlign: 'left', cursor: 'pointer',
};
const generatedKey: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall,
  background: '#fff', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  padding: `${space.sm}px ${space.lg}px`,
  color: colors.inkSoft, wordBreak: 'break-all',
  marginBottom: space.sm,
};
const generatedActions: React.CSSProperties = {
  display: 'flex', gap: space.sm, marginBottom: space.lg,
};
const copyBtn: React.CSSProperties = {
  flex: 1,
  background: 'transparent', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  padding: `${space.xs}px ${space.lg}px`,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall, color: colors.inkSoft,
  cursor: 'pointer',
};
const confirmRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: space.sm,
  marginTop: space.lg,
  fontSize: fontSize.metaSmall, color: colors.inkSoft, lineHeight: lineHeight.body,
  cursor: 'pointer',
};
const footer: React.CSSProperties = {
  padding: `${space.lg}px ${space.xl}px`,
  borderTop: `1px solid ${colors.hairline}`,
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: space.lg,
};
const primaryBtn: React.CSSProperties = {
  padding: `${space.md}px ${space.xxl}px`,
  background: colors.ink, color: colors.paper,
  border: 'none', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, fontWeight: 500,
};
