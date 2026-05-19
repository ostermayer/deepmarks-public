// Add bookmark — pixel-matches popup-screens-2.jsx ScreenAdd.
//
// URL preview chip + AUTOFILLED badge → title input → description
// textarea → tag chip input → footer (archive toggle + Cancel/Save).
//
// On mount: read active tab, prefill title/description, mark
// "AUTOFILLED" until the user edits the title field.
//
// On Save: build kind:39701 template, sign locally, POST to /publish,
// optionally start an archive flow, transition to Saved screen.

import { useEffect, useRef, useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { BackButton } from '../components/BackButton.js';
import { TagInput } from '../components/TagInput.js';
import { readActiveTab, type ActiveTabInfo } from '../../lib/active-tab.js';
import { fetchUrlMetadata } from '../../lib/metadata.js';
import {
  defaultSocialPostText,
  publishBookmark,
  publishSocialPost,
  deleteBookmark,
  type PublishResult,
} from '../../lib/nostr.js';
import { publishPrivateBookmark, deletePrivateBookmark } from '../../lib/private-bookmarks.js';
import {
  getSettings,
  patchSettings,
  pushSettingsToServer,
  type BookmarkVisibility,
  type Settings as SettingsT,
} from '../../lib/settings-store.js';
import { getLifetimeStatus, startLifetimeArchive } from '../../lib/archive.js';
import { generateArchiveKey, stashPendingKey } from '../../lib/archive-keys.js';
import { navigate } from '../router.js';
import { setLastSaved } from './saved-state.js';
import { takeEditTarget } from './edit-state.js';
import {
  clearAddBookmarkDraft,
  loadAddBookmarkDraft,
  saveAddBookmarkDraft,
  type AddBookmarkDraft,
} from './popup-drafts.js';
import type { NsecState } from '../../lib/nsec-store.js';

export function Add({ state: account }: { state: NsecState }) {
  const [tab, setTab] = useState<ActiveTabInfo | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [archive, setArchive] = useState(false);
  const [crossPost, setCrossPost] = useState(false);
  const [socialPost, setSocialPost] = useState('');
  // Archive UI is lifetime-only. The toggle stays hidden until the
  // lifetime probe resolves true.
  const [showArchiveToggle, setShowArchiveToggle] = useState<boolean>(false);
  const [visibility, setVisibility] = useState<BookmarkVisibility>('private');
  const [autofilled, setAutofilled] = useState(false);
  // Edit mode = the user came in from a row's "edit" button. We
  // skip the active-tab read (the URL is fixed to the bookmark's),
  // skip default-tags / default-archive (use the bookmark's values),
  // and label the save button "save changes" to make it clear this
  // overwrites instead of creating.
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleEditedRef = useRef(false);
  const socialPostEditedRef = useRef(false);
  const draftReadyRef = useRef(false);
  // Captured at edit-mount so onSave can detect a visibility flip and
  // tear down the prior record. Refs (not state) — read-only metadata
  // that doesn't drive UI.
  const originalVisibilityRef = useRef<BookmarkVisibility | null>(null);
  const originalEventIdRef = useRef<string | undefined>(undefined);
  const originalSavedAtRef = useRef<number | undefined>(undefined);

  // Initial load: edit handoff first, then a volatile draft from a
  // closed popup, else active tab + default settings.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const edit = takeEditTarget();
      if (edit) {
        applyDraft({
          tab: { url: edit.url, title: edit.title, description: edit.description, scraped: false },
          title: edit.title,
          description: edit.description,
          tags: edit.tags,
          archive: edit.archived,
          crossPost: false,
          socialPost: '',
          showArchiveToggle: false,
          visibility: edit.visibility,
          autofilled: false,
          editing: true,
          titleEdited: true,
          socialPostEdited: false,
          originalVisibility: edit.visibility,
          originalEventId: edit.eventId,
          originalSavedAt: edit.publishedAt ?? edit.savedAt,
        });
        return;
      }

      const draft = await loadAddBookmarkDraft();
      if (cancelled) return;
      if (draft) {
        applyDraft(draft);
        return;
      }

      const [t, s, lifetime] = await Promise.all([
        readActiveTab(),
        getSettings(),
        account.pubkey
          ? getLifetimeStatus(account.pubkey).catch(() => ({ isLifetimeMember: false }))
          : Promise.resolve({ isLifetimeMember: false }),
      ]);
      if (cancelled) return;
      if (t) {
        setTab(t);
        if (t.title) setTitle(t.title);
        if (t.description) setDescription(t.description);
        setAutofilled(t.scraped);
        // Fetch suggested tags from the server's metadata extractor.
        // Fire-and-forget; failure leaves the suggestion list empty.
        void fetchUrlMetadata(t.url).then((meta) => {
          if (cancelled) return;
          if (meta?.suggestedTags?.length) setSuggestedTags(meta.suggestedTags);
        });
      }
      setTags(s.defaultTags);
      const archiveByDefault = lifetime.isLifetimeMember && shouldArchiveByDefault(s);
      setArchive(archiveByDefault);
      if (archiveByDefault && !s.archiveDefault) {
        void persistLifetimeArchiveDefault(account.nsecHex);
      }
      setCrossPost(false);
      setSocialPost('');
      socialPostEditedRef.current = false;
      setVisibility(s.defaultVisibility);
      setShowArchiveToggle(lifetime.isLifetimeMember);
      draftReadyRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [account.pubkey]);

  useEffect(() => {
    if (!draftReadyRef.current || !tab) return;
    const id = setTimeout(() => {
      void saveAddBookmarkDraft({
        tab,
        title,
        description,
        tags,
        archive,
        crossPost,
        socialPost,
        showArchiveToggle,
        visibility,
        autofilled,
        editing,
        titleEdited: titleEditedRef.current,
        socialPostEdited: socialPostEditedRef.current,
        originalVisibility: originalVisibilityRef.current,
        originalEventId: originalEventIdRef.current,
        originalSavedAt: originalSavedAtRef.current,
      });
    }, 150);
    return () => clearTimeout(id);
  }, [
    archive,
    autofilled,
    crossPost,
    description,
    editing,
    showArchiveToggle,
    socialPost,
    tab,
    tags,
    title,
    visibility,
  ]);

  function applyDraft(draft: AddBookmarkDraft) {
    setTab(draft.tab);
    setTitle(draft.title);
    setDescription(draft.description);
    setTags(draft.tags);
    setArchive(draft.archive);
    setCrossPost(draft.crossPost);
    setSocialPost(draft.socialPost);
    setShowArchiveToggle(draft.showArchiveToggle);
    setVisibility(draft.visibility);
    setAutofilled(draft.autofilled);
    setEditing(draft.editing);
    titleEditedRef.current = draft.titleEdited;
    socialPostEditedRef.current = draft.socialPostEdited;
    originalVisibilityRef.current = draft.originalVisibility;
    originalEventIdRef.current = draft.originalEventId;
    originalSavedAtRef.current = draft.originalSavedAt;
    draftReadyRef.current = true;
  }

  function onTitleChange(v: string) {
    if (!titleEditedRef.current) {
      titleEditedRef.current = true;
      setAutofilled(false);
    }
    setTitle(v);
  }

  useEffect(() => {
    if (!crossPost || visibility !== 'public' || socialPostEditedRef.current || !tab) return;
    setSocialPost(defaultSocialPostText({
      url: tab.url,
      title,
      description,
    }));
  }, [crossPost, visibility, tab, title, description]);

  function onCrossPostChange(next: boolean) {
    setCrossPost(next);
    if (next && !socialPostEditedRef.current && tab) {
      setSocialPost(defaultSocialPostText({ url: tab.url, title, description }));
    }
  }

  async function onSave() {
    if (!tab || !title.trim() || !account.nsecHex || !account.pubkey) return;
    setBusy(true);
    setError(null);
    try {
      const savedAt = editing
        ? (originalSavedAtRef.current ?? Math.floor(Date.now() / 1000))
        : Math.floor(Date.now() / 1000);
      const input = {
        url: tab.url,
        title: title.trim(),
        description: description.trim() || undefined,
        tags,
        publishedAt: savedAt,
        archivedForever: archive,
      };
      // Visibility flip on edit: when the user changes private↔public on
      // an existing bookmark, the OLD record needs to come down or the
      // bookmark exists in both surfaces. Public→private leaves a
      // kind:39701 visible to anyone reading the relay; private→public
      // leaves an entry inside the user's encrypted NIP-51 set that's
      // logically stale. Tear down the prior shape before publishing
      // the new one. Best-effort: if the cleanup publish fails, the
      // new record still ships and the user gets at least one accurate
      // copy + a logged error to surface.
      const originalVisibility = originalVisibilityRef.current;
      if (editing && originalVisibility && originalVisibility !== visibility) {
        try {
          if (originalVisibility === 'public' && originalEventIdRef.current) {
            await deleteBookmark(
              originalEventIdRef.current,
              tab.url,
              account.pubkey,
              account.nsecHex,
            );
          } else if (originalVisibility === 'private') {
            await deletePrivateBookmark(tab.url, account.nsecHex, account.pubkey);
          }
        } catch (cleanupErr) {
          // Don't block the save — the user still wants their new
          // record live. Surface in error so they know to verify.
          console.warn('[deepmarks] failed to remove old visibility record', cleanupErr);
        }
      }

      const result: PublishResult =
        visibility === 'private'
          ? await publishPrivateBookmark(input, account.nsecHex, account.pubkey)
          : await publishBookmark(input, account.nsecHex);

      // Optimistic-render handoff for Recent so the new bookmark
      // appears at the top of the list before relay propagation
      // catches up. mergeOptimistic on Recent reads this on mount.
      setLastSaved({
        url: tab.url,
        title: title.trim(),
        host: hostOf(tab.url),
        eventId: result.event.id,
        savedAt,
        relayResults: { ok: result.ok, failed: result.failed },
        archive,
        visibility,
      });

      if (visibility === 'public' && crossPost && socialPost.trim()) {
        try {
          const socialResult = await publishSocialPost(
            {
              url: tab.url,
              title: title.trim(),
              description: description.trim() || undefined,
              content: socialPost,
              bookmarkEventId: result.event.id,
              bookmarkAuthor: account.pubkey,
            },
            account.nsecHex,
          );
          if (socialResult.ok.length === 0) {
            throw new Error('no relay accepted the Nostr post');
          }
        } catch (crossPostErr) {
          console.warn('[deepmarks] failed to publish social cross-post', crossPostErr);
          setError(`Bookmark saved, but the Nostr post failed: ${(crossPostErr as Error).message}`);
          return;
        }
      }

      // Archive kickoff happens here now (used to be on the Saved
      // screen, but the polling progress bar that screen showed
      // never visibly moved and just delayed the user from getting
      // back to their list). The checkbox is lifetime-only; we still
      // re-check server-side before enqueueing.
      if (archive) {
        const account_ = account as { nsecHex: string; pubkey: string };
        let archiveKey: string | undefined;
        if (visibility === 'private') {
          archiveKey = generateArchiveKey();
        }
        // Fire-and-forget: we await the *kickoff* (so we can stash
        // the key keyed by paymentHash before navigating) but not
        // the worker's render. Reconciliation on the next archived-
        // tab open promotes the stash to a permanent saveArchiveKey.
        try {
          const lifetime = await getLifetimeStatus(account_.pubkey);
          if (lifetime.isLifetimeMember) {
            const latestSettings = await getSettings();
            const r = await startLifetimeArchive(
              {
                url: tab.url,
                tier: visibility,
                archiveKey,
                mirrorUrls: latestSettings.backupBlossomServers,
              },
              account_.nsecHex,
            );
            if (visibility === 'private' && archiveKey) {
              await stashPendingKey(r.paymentHash, archiveKey).catch(() => { /* tolerable */ });
            }
          }
        } catch {
          // Archive kickoff failed — bookmark is already saved, the
          // user can retry from the row's edit menu later.
        }
      }
      await clearAddBookmarkDraft();
      navigate('recent');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={page}>
      <header style={header}>
        <div style={brandRow}>
          <BackButton />
          <Pennant size={14} />
          <span style={brand}>Deepmarks</span>
        </div>
        <button style={ghostBtn} onClick={() => void cancel()}>cancel</button>
      </header>

      <div style={body}>
        <div style={urlChip}>
          <div style={favicon}>{(tab && hostOf(tab.url).charAt(0).toUpperCase()) || '·'}</div>
          <span style={urlText}>{tab?.url ?? 'reading active tab…'}</span>
          {autofilled && <span style={autofilledBadge}>AUTOFILLED</span>}
        </div>

        <label style={uppercaseLabel}>title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="page title"
          style={input}
        />

        <label style={uppercaseLabel}>description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="why is this worth saving?"
          rows={3}
          style={textarea}
        />

        <label style={uppercaseLabel}>tags</label>
        <TagInput value={tags} onChange={setTags} />
        {suggestedTags.length > 0 && (
          <div style={suggestionRow} aria-label="suggested tags">
            <span style={suggestionLabel}>suggested:</span>
            {suggestedTags
              .filter((t) => !tags.includes(t))
              .map((t) => (
                <button
                  key={t}
                  type="button"
                  style={suggestionChip}
                  onClick={() => setTags([...tags, t])}
                >
                  + {t}
                </button>
              ))}
          </div>
        )}

        {error && <div style={errorRow}>{error}</div>}
      </div>

      <footer style={footer}>
        <div style={visibilityRow}>
          <button
            type="button"
            onClick={() => setVisibility('private')}
            style={{
              ...visBtn,
              background: visibility === 'private' ? colors.ink : 'transparent',
              color: visibility === 'private' ? colors.paper : colors.inkSoft,
              borderColor: visibility === 'private' ? colors.ink : colors.hairline,
            }}
            aria-pressed={visibility === 'private'}
          >
            🔒 private
          </button>
          <button
            type="button"
            onClick={() => setVisibility('public')}
            style={{
              ...visBtn,
              background: visibility === 'public' ? colors.ink : 'transparent',
              color: visibility === 'public' ? colors.paper : colors.inkSoft,
              borderColor: visibility === 'public' ? colors.ink : colors.hairline,
            }}
            aria-pressed={visibility === 'public'}
          >
            🌐 public
          </button>
          <span style={visHint}>
            {visibility === 'private'
              ? 'encrypted to your key — only you see it'
              : 'visible to anyone on Nostr'}
          </span>
        </div>
        {visibility === 'public' && (
          <div style={crossPostBox}>
            <label style={crossPostLabel}>
              <input
                type="checkbox"
                checked={crossPost}
                onChange={(e) => onCrossPostChange(e.currentTarget.checked)}
              />
              <span>Post a Nostr note too</span>
            </label>
            {crossPost && (
              <textarea
                value={socialPost}
                onChange={(e) => {
                  socialPostEditedRef.current = true;
                  setSocialPost(e.currentTarget.value);
                }}
                placeholder="Nostr post text"
                rows={4}
                style={socialTextarea}
              />
            )}
          </div>
        )}
        <div style={archiveRow}>
          <button
            type="button"
            onClick={() => {
              const isRead = tags.includes('toread');
              setTags(isRead ? tags.filter((t) => t !== 'toread') : [...tags, 'toread']);
            }}
            style={{
              ...toggle,
              background: tags.includes('toread') ? '#d97706' : colors.hairline,
            }}
            aria-pressed={tags.includes('toread')}
            aria-label="Save for later reading"
          >
            <span style={{
              ...toggleKnob,
              transform: tags.includes('toread') ? 'translateX(12px)' : 'translateX(0)',
            }} />
          </button>
          <div>
            <div style={archiveTitle}>Read later</div>
            <div style={archiveSub}>Adds the toread tag; shows in the Read later tab</div>
          </div>
        </div>
        {showArchiveToggle && (
          <div style={archiveRow}>
            <button
              type="button"
              onClick={() => setArchive(!archive)}
              style={{ ...toggle, background: archive ? colors.accent : colors.hairline }}
              aria-pressed={archive}
              aria-label="Archive forever"
            >
              <span style={{
                ...toggleKnob,
                transform: archive ? 'translateX(12px)' : 'translateX(0)',
              }} />
            </button>
            <div>
              <div style={archiveTitle}>Archive forever</div>
              <div style={archiveSub}>Snapshot stored on the deepmarks archive node</div>
            </div>
          </div>
        )}
        <div style={btnRow}>
          <button type="button" style={cancelBtn} onClick={() => void cancel()}>Cancel</button>
          <button
            type="button"
            style={{ ...saveBtn, opacity: title.trim() && !busy ? 1 : 0.5, cursor: title.trim() && !busy ? 'pointer' : 'not-allowed' }}
            onClick={() => void onSave()}
            disabled={!title.trim() || busy}
          >
            {busy ? 'Publishing…' : (editing ? 'Save changes' : 'Save bookmark')}
            {!busy && <kbd style={kbd}>⏎</kbd>}
          </button>
        </div>
      </footer>
    </div>
  );

  async function cancel() {
    await clearAddBookmarkDraft();
    navigate('recent');
  }
}

function shouldArchiveByDefault(settings: SettingsT): boolean {
  // Existing explicit setting wins. Without a manual override,
  // lifetime members should start with archiving on and can turn it off
  // in Settings.
  return settings.archiveDefault || !settings.archiveDefaultManualOverride;
}

async function persistLifetimeArchiveDefault(nsecHex: string | null): Promise<void> {
  const next = await patchSettings({ archiveDefault: true, archiveDefaultManualOverride: false });
  if (!nsecHex) return;
  await pushSettingsToServer(nsecHex, next).catch(() => undefined);
}

function hostOf(u: string): string {
  try { return new URL(u).hostname; } catch { return ''; }
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
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: colors.muted,
  fontSize: fontSize.metaSmall, cursor: 'pointer',
};
const body: React.CSSProperties = {
  flex: 1, padding: `${space.lg}px ${space.xl}px`,
  overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: space.lg,
};
const urlChip: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm,
  padding: `${space.sm}px ${space.lg}px`,
  background: colors.paperAlt, border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
};
const favicon: React.CSSProperties = {
  width: 14, height: 14, borderRadius: 2, background: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 9, fontWeight: 600, color: colors.muted, flexShrink: 0,
};
const urlText: React.CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.inkSoft,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const autofilledBadge: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.good, padding: '2px 6px', background: '#e8f0e3', borderRadius: radius.badge,
};
const uppercaseLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: 4,
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', color: colors.ink, fontSize: fontSize.bodyMicro,
  fontFamily: fonts.sans, outline: 'none',
};
const textarea: React.CSSProperties = {
  ...input,
  fontFamily: fonts.sans, lineHeight: lineHeight.body, resize: 'vertical',
};
const errorRow: React.CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`, background: '#fbe9e3', color: '#8b2f17',
  borderRadius: radius.std, fontSize: fontSize.metaSmall,
};
const suggestionRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
  marginTop: -2,
};
const suggestionLabel: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.04em',
  color: colors.muted, textTransform: 'uppercase',
};
const suggestionChip: React.CSSProperties = {
  padding: '3px 8px', border: `1px solid ${colors.hairline}`,
  borderRadius: 999, background: colors.paperAlt, color: colors.accent,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall, cursor: 'pointer',
};
const footer: React.CSSProperties = {
  borderTop: `1px solid ${colors.hairline}`,
  padding: `${space.lg}px ${space.xl}px`,
  display: 'flex', flexDirection: 'column', gap: space.lg,
  background: colors.paper,
};
const visibilityRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap',
};
const visBtn: React.CSSProperties = {
  padding: `${space.xs}px ${space.sm}px`,
  border: '1px solid', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.metaSmall,
  cursor: 'pointer',
};
const visHint: React.CSSProperties = {
  flex: 1, fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.muted,
  letterSpacing: '0.04em',
};
const crossPostBox: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: space.sm,
  padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  background: colors.paperAlt,
};
const crossPostLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm,
  fontSize: fontSize.metaSmall, color: colors.ink,
};
const socialTextarea: React.CSSProperties = {
  ...input,
  minHeight: 74,
  fontFamily: fonts.sans,
  lineHeight: lineHeight.body,
  resize: 'vertical',
};
const archiveRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: space.lg,
};
const toggle: React.CSSProperties = {
  width: 28, height: 16, padding: 2, borderRadius: 9,
  border: 'none', cursor: 'pointer', flexShrink: 0,
  transition: 'background 0.15s', position: 'relative',
};
const toggleKnob: React.CSSProperties = {
  display: 'block', width: 12, height: 12, borderRadius: '50%',
  background: '#fff', transition: 'transform 0.15s',
};
const archiveTitle: React.CSSProperties = {
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.ink,
};
const archiveSub: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.muted, lineHeight: 1.4,
};
const btnRow: React.CSSProperties = { display: 'flex', gap: space.sm };
const cancelBtn: React.CSSProperties = {
  flex: 1, padding: space.lg,
  background: 'transparent', color: colors.inkSoft,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, cursor: 'pointer',
};
const saveBtn: React.CSSProperties = {
  flex: 2, padding: space.lg,
  background: colors.ink, color: colors.paper,
  border: 'none', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, fontWeight: 500,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space.sm,
};
const kbd: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, background: '#3a3a3a', color: colors.paper,
  padding: '1px 5px', borderRadius: radius.badge,
};
