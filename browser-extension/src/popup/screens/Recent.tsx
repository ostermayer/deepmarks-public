// Recent — default popup landing for signed-in users.
//
// pixel-matches popup-screens-2.jsx ScreenRecent.
//
// Header (brand + settings ghost) → filter input → tab bar (mine/tags/
// archived + count chip right) → list rows (favicon + title + meta +
// tag chips) → footer ("+ Bookmark this page" button).
//
// Initial render shows a "loading bookmarks…" state; relay fetch
// populates after EOSE.

import { useEffect, useMemo, useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { fetchBookmarks, fetchProfile, deleteBookmark, type ParsedProfile } from '../../lib/nostr.js';
import { fetchPrivateBookmarks, deletePrivateBookmark } from '../../lib/private-bookmarks.js';
import { setEditTarget } from './edit-state.js';
import { listMyArchives, archiveViewUrl, deleteArchive, type ArchiveRecord } from '../../lib/archive.js';
import { getArchiveKey, decryptArchiveBlob, reconcileArchiveKeys, purgeArchiveKey } from '../../lib/archive-keys.js';
import type { Event as NostrEvent } from 'nostr-tools';
import { navigate, useScreen } from '../router.js';
import { getLastSaved } from './saved-state.js';
import type { NsecState } from '../../lib/nsec-store.js';

type Tab = 'mine' | 'tags' | 'archived';

interface ParsedBookmark {
  url: string;
  title: string;
  description: string;
  tags: string[];
  archived: boolean;
  savedAt: number;
  eventId: string;
  /** 'public' = kind:39701 from the relay; 'private' = entry inside
   *  the user's encrypted NIP-51 set. UI shows a 🔒 next to private
   *  rows so it's immediately obvious which feed they came from. */
  visibility: 'public' | 'private';
}

function parse(event: NostrEvent): ParsedBookmark | null {
  const get = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const url = get('d');
  if (!url || !/^https?:/i.test(url)) return null;
  return {
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: event.tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean),
    archived: get('archive-tier') === 'forever',
    savedAt: event.created_at,
    eventId: event.id,
    visibility: 'public',
  };
}

export function Recent({ state }: { state: NsecState }) {
  const [tab, setTab] = useState<Tab>('mine');
  const [filter, setFilter] = useState('');
  const [bookmarks, setBookmarks] = useState<ParsedBookmark[] | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[] | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ParsedProfile | null>(null);
  const screen = useScreen();

  // Fetch the user's kind:0 profile metadata so the header can show
  // their avatar + name. Stale-while-revalidate: paint cached
  // immediately if present, then force-refresh in the background so
  // a recent picture change (e.g. just uploaded via /app/settings)
  // shows up on the next popup tick instead of after the cache TTL
  // expires. Falls back to the deepmarks pennant if no kind:0 is
  // ever found.
  useEffect(() => {
    if (!state.pubkey) return;
    let cancelled = false;
    const pubkey = state.pubkey;
    void fetchProfile(pubkey)
      .then((p) => { if (!cancelled && p) setProfile(p); })
      .catch(() => { /* fallback paints pennant */ });
    void fetchProfile(pubkey, undefined, undefined, { force: true })
      .then((p) => { if (!cancelled && p) setProfile(p); })
      .catch(() => { /* keep cached */ });
    return () => { cancelled = true; };
  }, [state.pubkey]);

  // Fetch archives when the 'archived' tab is first selected. The
  // existing 'archived' filter on bookmarks (b.archived) is a UI hint —
  // means the bookmark has the archive-tier:forever tag set on its
  // kind:39701 event. The actual archive snapshot record lives at the
  // /account/archives endpoint and is what users mean when they click
  // the tab. Lazy-load so the popup-open path doesn't block on it.
  useEffect(() => {
    if (tab !== 'archived' || archives !== null || !state.nsecHex) return;
    let cancelled = false;
    const nsecHex = state.nsecHex;
    const pubkey = state.pubkey;
    listMyArchives(nsecHex)
      .then(async (recs) => {
        if (cancelled) return;
        setArchives(recs);
        // Reconcile any pending keys (paymentHash stashes from saves
        // whose popup closed before completion) into permanent
        // saveArchiveKey calls. Self-healing: every popup open that
        // shows the archived tab fixes any newly-completed private
        // archives. No-op when the stash is empty.
        if (pubkey) {
          await reconcileArchiveKeys(recs, nsecHex, pubkey).catch(() => { /* surface in UI later */ });
        }
      })
      .catch((e) => { if (!cancelled) setArchivesError((e as Error).message); });
    return () => { cancelled = true; };
  }, [tab, archives, state.nsecHex, state.pubkey]);

  // Refetch whenever the screen becomes 'recent' — covers the
  // "user just saved a bookmark and navigated back" path. Also
  // fires on first mount. Without this, the feed only loads once
  // per popup-open and never sees newly-published events.
  //
  // Fetches BOTH public (kind:39701) and private (kind:30003 NIP-51
  // sets, decrypted client-side) so a user whose default visibility
  // is 'private' still sees their saves here. Private fetch needs
  // the nsec to decrypt — when locked, only public shows up.
  // Recent screen has two reads:
  //   1. chrome.storage.local prime — paints the last-known feed
  //      essentially instantly (~5ms after popup mount). Without this
  //      every popup open showed an empty 'loading bookmarks…' state
  //      while the relay round-trip ran.
  //   2. Live fetch from relays — same merge logic as before; updates
  //      the store + re-saves the cache when fresh data arrives.
  useEffect(() => {
    if (!state.pubkey || screen !== 'recent') return;
    let cancelled = false;
    const pubkey = state.pubkey;
    const nsecHex = state.nsecHex;
    const cacheKey = `deepmarks-recent-cache:${pubkey}`;

    // Step 1: cache prime. chrome.storage.local is async but very
    // fast; the popup hasn't fully painted yet by the time this
    // resolves on a typical machine.
    void chrome.storage.local.get(cacheKey).then((raw) => {
      if (cancelled) return;
      const cached = raw[cacheKey] as ParsedBookmark[] | undefined;
      if (Array.isArray(cached) && cached.length > 0) {
        setBookmarks(mergeOptimistic(cached, pubkey));
      }
    }).catch(() => { /* tolerable; live fetch fills in */ });

    // Step 2: live fetch. Same path as before — merge public + private.
    void Promise.all([
      fetchBookmarks([pubkey], 100).then((events) =>
        events.map(parse).filter((b): b is ParsedBookmark => b !== null),
      ).catch(() => [] as ParsedBookmark[]),
      nsecHex
        ? fetchPrivateBookmarks(nsecHex, pubkey)
            .then((entries) => entries.map((e): ParsedBookmark => ({
              url: e.url,
              title: e.title,
              description: e.description,
              tags: e.tags,
              archived: e.archived,
              savedAt: e.savedAt,
              eventId: `private:${e.url}`,
              visibility: 'private',
            })))
            .catch(() => [] as ParsedBookmark[])
        : Promise.resolve([] as ParsedBookmark[]),
    ]).then(([pub, priv]) => {
      if (cancelled) return;
      const byUrl = new Map<string, ParsedBookmark>();
      for (const b of pub) byUrl.set(b.url, b);
      for (const b of priv) byUrl.set(b.url, b);
      const merged = [...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt);
      setBookmarks(mergeOptimistic(merged, pubkey));
      // Persist for the next popup open. Ignore the empty-result
      // case so a transient relay miss doesn't blank the cache.
      if (merged.length > 0) {
        void chrome.storage.local.set({ [cacheKey]: merged }).catch(() => { /* quota */ });
      }
    });
    return () => { cancelled = true; };
  }, [state.pubkey, state.nsecHex, screen]);

  // Build a tag-cloud entry list from current bookmarks for the
  // tags tab. Sorted by count desc, then alphabetically.
  const tagCloud = useMemo(() => {
    if (!bookmarks) return [];
    const counts = new Map<string, number>();
    for (const b of bookmarks) {
      for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [bookmarks]);

  const filtered = useMemo(() => {
    if (!bookmarks) return [];
    let list = bookmarks;
    if (tab === 'tags') list = list.filter((b) => b.tags.length > 0);
    const q = filter.trim().toLowerCase();
    if (q) {
      const tag = q.startsWith('#') ? q.slice(1) : null;
      list = list.filter((b) =>
        tag
          ? b.tags.some((t) => t.includes(tag))
          : b.title.toLowerCase().includes(q)
            || b.tags.some((t) => t.includes(q))
            || b.url.toLowerCase().includes(q),
      );
    }
    return list;
  }, [bookmarks, tab, filter]);

  // Same filter, applied to the archived list. We match against the
  // same fields (title via the matching bookmark, tags, url) so a
  // tag query on the mine tab and the archived tab gives consistent
  // results. Falls back to URL-only matching when there's no
  // bookmark to look up the title from.
  const filteredArchives = useMemo(() => {
    if (!archives) return [];
    const byUrl = new Map((bookmarks ?? []).map((b) => [b.url, b]));
    const q = filter.trim().toLowerCase();
    if (!q) return archives;
    const tag = q.startsWith('#') ? q.slice(1) : null;
    return archives.filter((a) => {
      const b = byUrl.get(a.url);
      if (tag) return (b?.tags ?? []).some((t) => t.includes(tag));
      const title = b?.title.toLowerCase() ?? '';
      const tags = b?.tags ?? [];
      return title.includes(q) || tags.some((t) => t.includes(q)) || a.url.toLowerCase().includes(q);
    });
  }, [archives, bookmarks, filter]);

  // Avatar links to the user's settings page on deepmarks.org with
  // ?source=extension so the page knows to attempt a silent NIP-07
  // sign-in via this extension instead of dropping them on the marketing
  // page. Profile editing (name + picture) lives there too.
  const settingsUrl = 'https://deepmarks.org/app/settings?source=extension';
  // Fallback when the user hasn't published a kind:0 picture yet:
  // the deepmarks pennant. Hosted on deepmarks.org so it stays in sync
  // with brand updates without bundling a copy in the extension.
  const defaultAvatar = 'https://deepmarks.org/pennant.svg';

  return (
    <div style={page}>
      <header style={header}>
        <div style={brandRow}>
          <Pennant size={14} />
          <span style={brand}>Deepmarks</span>
        </div>
        <div style={headerRight}>
          {state.pubkey && (
            <a
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
              style={avatar}
              title={profile?.displayName || profile?.name || 'edit your profile on deepmarks.org'}
            >
              {profile?.picture ? (
                <img src={profile.picture} alt="" style={avatarImg} />
              ) : (
                <img src={defaultAvatar} alt="" style={avatarImg} />
              )}
            </a>
          )}
          <button style={ghostBtn} onClick={() => navigate('settings')}>settings</button>
        </div>
      </header>

      <input
        type="text"
        placeholder="filter by title or #tag"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={filterInput}
      />

      <div style={tabBar}>
        {(['mine', 'tags', 'archived'] as Tab[]).map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              // onMouseDown preventDefault keeps the click from focusing
              // the button — without this, the previously-clicked tab
              // retains keyboard focus and Chromium's :focus-visible
              // styling would still paint an underline on it on top of
              // our :focus { outline: none } global. Click handler still
              // fires; only the focus side-effect is suppressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t)}
              // borderBottomColor + color are set as discrete keys (not
              // mixed in via a `borderBottom` shorthand) so React's
              // style diff cleanly transitions inactive→active without
              // leaving ink-colored borders on inactive tabs. Earlier
              // version mixed shorthand+individual and produced ghost
              // underlines on the previously-active tab.
              style={{
                ...tabBtn,
                color: active ? colors.ink : colors.muted,
                borderBottomColor: active ? colors.ink : 'transparent',
              }}
            >
              {t}
            </button>
          );
        })}
        <span style={countChip}>
          {tab === 'archived'
            ? `${filteredArchives.length} of ${archives?.length ?? 0}`
            : `${filtered.length} of ${bookmarks?.length ?? 0}`}
        </span>
      </div>

      <div style={list}>
        {tab === 'archived' ? (
          archivesError ? (
            <Empty text={`couldn't load archives — ${archivesError}`} />
          ) : archives === null ? (
            <Empty text="loading archives…" />
          ) : archives.length === 0 ? (
            <Empty text="no archives yet — toggle 'Archive forever' on save" />
          ) : filteredArchives.length === 0 ? (
            <Empty text="no matches" />
          ) : (
            filteredArchives.map((a) => (
              <ArchiveRow
                key={a.blobHash}
                archive={a}
                account={state}
                bookmark={bookmarks?.find((b) => b.url === a.url) ?? null}
                onDeleted={() => setArchives((prev) => prev?.filter((x) => x.blobHash !== a.blobHash) ?? null)}
              />
            ))
          )
        ) : bookmarks === null ? (
          <Empty text="loading bookmarks…" />
        ) : tab === 'tags' && !filter ? (
          tagCloud.length === 0
            ? <Empty text="no tagged bookmarks yet" />
            : (
              <div style={tagCloudWrap}>
                {tagCloud.map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    style={tagChip}
                    onClick={() => setFilter('#' + tag)}
                  >
                    #{tag} <span style={tagCount}>{count}</span>
                  </button>
                ))}
              </div>
            )
        ) : filtered.length === 0 ? (
          <Empty text={bookmarks.length === 0 ? 'no bookmarks yet — save your first below' : 'no matches'} />
        ) : (
          filtered.map((b) => (
            <Row
              key={b.eventId}
              bookmark={b}
              account={state}
              onDeleted={() => setBookmarks((prev) => prev?.filter((x) => x.eventId !== b.eventId) ?? null)}
            />
          ))
        )}
      </div>

      <footer style={footer}>
        <button style={primaryBtn} onClick={() => navigate('add')}>
          + Bookmark this page
        </button>
      </footer>
    </div>
  );
}

/** 16×16 favicon next to a row title. Hits api.deepmarks.org/favicon
 *  which redirects to a cached image on Linode (4-step fallback chain
 *  for misses). On image-load error we swap to the host-letter fallback
 *  so a row never looks broken. Empty host (chrome:// or file://) → letter only. */
function Favicon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (!host || failed) {
    return <div style={rowFavicon}>{host.charAt(0).toUpperCase() || '·'}</div>;
  }
  return (
    <img
      src={`https://api.deepmarks.org/favicon?host=${encodeURIComponent(host)}`}
      alt=""
      style={rowFaviconImg}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

function Row({ bookmark, account, onDeleted }: {
  bookmark: ParsedBookmark;
  account: NsecState;
  onDeleted: () => void;
}) {
  const host = (() => { try { return new URL(bookmark.url).hostname; } catch { return ''; } })();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<'edit' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startEdit(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    setEditTarget({
      url: bookmark.url,
      title: bookmark.title,
      description: bookmark.description,
      tags: bookmark.tags,
      archived: bookmark.archived,
      visibility: bookmark.visibility,
      eventId: bookmark.visibility === 'public' ? bookmark.eventId : undefined,
    });
    navigate('add');
  }

  async function startDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${bookmark.title}"?\n\nFor public bookmarks this publishes a NIP-09 deletion request — relays may keep mirrors. Private bookmarks vanish immediately from your set.`)) {
      return;
    }
    if (!account.nsecHex || !account.pubkey) {
      setError('locked — unlock to delete');
      return;
    }
    setMenuOpen(false);
    setBusy('delete');
    setError(null);
    try {
      if (bookmark.visibility === 'private') {
        await deletePrivateBookmark(bookmark.url, account.nsecHex, account.pubkey);
      } else {
        await deleteBookmark(bookmark.eventId, bookmark.url, account.pubkey, account.nsecHex);
      }
      onDeleted();
    } catch (err) {
      setError((err as Error).message ?? 'delete failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={rowWrap}>
      <a
        href={bookmark.url}
        target="_blank"
        rel="noreferrer"
        // Extra right padding leaves room for the absolutely-positioned
        // ⋯ menu button (~32px wide including its margin) so long titles
        // ellipsize before sliding under the menu instead of overlapping.
        style={{ ...rowLink, paddingRight: 40, opacity: busy === 'delete' ? 0.5 : 1 }}
      >
        <Favicon host={host} />
        <div style={rowMain}>
          <div style={rowTitle}>
            {bookmark.visibility === 'private' && (
              <span style={privateBadge} title="private bookmark">🔒 </span>
            )}
            {bookmark.title}
          </div>
          <div style={rowMeta}>
            {host} · {relTime(bookmark.savedAt)}
            {bookmark.archived && ' · archived'}
            {busy === 'delete' && ' · deleting…'}
          </div>
          {bookmark.tags.length > 0 && (
            <div style={chipRow}>
              {bookmark.tags.slice(0, 4).map((t) => (
                <span key={t} style={chip}>#{t}</span>
              ))}
            </div>
          )}
          {error && <div style={{ ...rowMeta, color: '#a33', marginTop: 4 }}>↳ {error}</div>}
        </div>
      </a>
      <button
        type="button"
        style={menuToggleBtn}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((v) => !v); }}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="bookmark actions"
        title="edit / delete"
      >⋯</button>
      {menuOpen && (
        <>
          {/* Click-away catcher — closes menu when the user clicks
              anywhere else in the popup. zIndex below the menu so
              the menu's own clicks register. */}
          <div style={menuBackdrop} onClick={() => setMenuOpen(false)} />
          <div style={menuPopover}>
            <button type="button" style={menuItem} onClick={startEdit} onMouseDown={(e) => e.preventDefault()}>edit</button>
            <button type="button" style={{ ...menuItem, color: '#a33' }} onClick={(e) => void startDelete(e)} onMouseDown={(e) => e.preventDefault()}>delete</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Archived-tab row. Renders identically to the mine-tab Row (favicon
 *  → title → host · relTime → tag chips) so the user sees one
 *  consistent visual language across tabs. Title + tags come from the
 *  matching bookmark when one is loaded; falls back to the URL when
 *  the user hasn't bookmarked the page (rare — archives flow from
 *  bookmarks today, but kept defensive).
 *
 *  Click behavior:
 *    - public: opens the snapshot URL on Blossom in a new tab
 *    - private: decrypts client-side via the NIP-51 archive-key set
 *      and opens the plaintext HTML in a sandboxed blob: tab */
function ArchiveRow({ archive, account, bookmark, onDeleted }: {
  archive: ArchiveRecord;
  account: NsecState;
  bookmark: ParsedBookmark | null;
  onDeleted: () => void;
}) {
  const host = (() => { try { return new URL(archive.url).hostname; } catch { return ''; } })();
  const isPrivate = archive.tier === 'private';
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = bookmark?.title || archive.url;
  const tags = bookmark?.tags ?? [];

  async function openPrivate(e: React.MouseEvent) {
    e.preventDefault();
    setDecryptError(null);
    try {
      if (!account.nsecHex || !account.pubkey) throw new Error('locked — unlock to view');
      const archiveKey = await getArchiveKey(archive.blobHash, account.nsecHex, account.pubkey);
      if (!archiveKey) {
        throw new Error('no decryption key found on this device or in your relay set');
      }
      const res = await fetch(archiveViewUrl(archive.blobHash));
      if (!res.ok) throw new Error(`blossom fetch ${res.status}`);
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      const plaintext = await decryptArchiveBlob(ciphertext, archiveKey);
      const blob = new Blob([plaintext as BlobPart], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setDecryptError((err as Error).message ?? 'failed to decrypt');
    }
  }

  async function startDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this archive?')) return;
    if (!account.nsecHex || !account.pubkey) {
      setError('locked — unlock to delete');
      return;
    }
    setMenuOpen(false);
    setBusy('delete');
    setError(null);
    try {
      const result = await deleteArchive(archive.blobHash, account.nsecHex);
      // For private archives, also wipe the key from the user's
      // NIP-51 set + local cache so cross-device + future mirror
      // fetches stay unreadable. Best-effort: server delete already
      // succeeded, so we proceed even if this step has issues.
      if (isPrivate) {
        await purgeArchiveKey(archive.blobHash, account.nsecHex, account.pubkey).catch(() => { /* tolerable */ });
      }
      onDeleted();
      // If the primary delete didn't actually fire, surface that —
      // user expects the blob gone from our side.
      if (!result.primaryDeleted) {
        setError(`removed from your list, but our primary delete failed: ${result.primaryError ?? 'unknown'}`);
      }
    } catch (err) {
      setError((err as Error).message ?? 'delete failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={rowWrap}>
      <a
        href={isPrivate ? '#' : archiveViewUrl(archive.blobHash)}
        onClick={isPrivate ? (e) => void openPrivate(e) : undefined}
        target={isPrivate ? undefined : '_blank'}
        rel={isPrivate ? undefined : 'noreferrer'}
        style={{ ...rowLink, paddingRight: 40, opacity: busy === 'delete' ? 0.5 : 1 }}
        title={isPrivate ? 'Private archive — click to decrypt + open' : 'Open the archived snapshot'}
      >
        {archive.thumbHash ? (
          <img
            src={`https://blossom.deepmarks.org/${encodeURIComponent(archive.thumbHash)}`}
            alt=""
            style={archiveThumb}
            loading="lazy"
          />
        ) : (
          <Favicon host={host} />
        )}
        <div style={rowMain}>
          <div style={rowTitle}>
            {isPrivate && <span style={privateBadge} title="private archive">🔒 </span>}
            {title}
          </div>
          <div style={rowMeta}>
            {host} · archived {relTime(archive.archivedAt)}
            {busy === 'delete' && ' · deleting…'}
          </div>
          {tags.length > 0 && (
            <div style={chipRow}>
              {tags.slice(0, 4).map((t) => (
                <span key={t} style={chip}>#{t}</span>
              ))}
            </div>
          )}
          {decryptError && (
            <div style={{ ...rowMeta, color: '#a33', marginTop: 4 }}>↳ {decryptError}</div>
          )}
          {error && (
            <div style={{ ...rowMeta, color: '#a33', marginTop: 4 }}>↳ {error}</div>
          )}
        </div>
      </a>
      <button
        type="button"
        style={menuToggleBtn}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((v) => !v); }}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="archive actions"
        title="delete"
      >⋯</button>
      {menuOpen && (
        <>
          <div style={menuBackdrop} onClick={() => setMenuOpen(false)} />
          <div style={menuPopover}>
            <button
              type="button"
              style={{ ...menuItem, color: '#a33' }}
              onClick={(e) => void startDelete(e)}
              onMouseDown={(e) => e.preventDefault()}
            >delete</button>
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={empty}>
      <span style={emptyText}>{text}</span>
    </div>
  );
}

/** Splice the just-saved bookmark (from the in-memory handoff) into
 *  the relay-fetched list. Relay propagation has 1-2s of latency, so
 *  a fresh save often hasn't shown up by the time the user navigates
 *  back to Recent. The handoff record carries enough to render the
 *  row optimistically; the real event replaces it on the next refetch. */
function mergeOptimistic(fromRelay: ParsedBookmark[], pubkey: string): ParsedBookmark[] {
  const last = getLastSaved();
  if (!last) return fromRelay;
  // Drop any older entry with the same URL — the optimistic record wins.
  const filtered = fromRelay.filter((b) => b.url !== last.url);
  const optimistic: ParsedBookmark = {
    url: last.url,
    title: last.title || last.url,
    description: '',
    tags: [],
    archived: last.archive,
    savedAt: Math.floor(Date.now() / 1000),
    eventId: last.visibility === 'private' ? `private:${last.url}` : last.eventId,
    visibility: last.visibility,
  };
  void pubkey;
  return [optimistic, ...filtered];
}

function relTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / (86400 * 30))}mo`;
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
const headerRight: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm,
};
const avatar: React.CSSProperties = {
  width: 22, height: 22, borderRadius: '50%',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  overflow: 'hidden', flexShrink: 0,
  background: colors.tagBg, border: `1px solid ${colors.hairlineSoft}`,
  textDecoration: 'none', cursor: 'pointer',
};
const avatarImg: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'cover', display: 'block',
};
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: colors.muted,
  fontSize: fontSize.metaSmall, cursor: 'pointer', padding: `${space.xs}px ${space.sm}px`,
};
const filterInput: React.CSSProperties = {
  margin: `${space.lg}px ${space.xl}px ${space.sm}px`,
  padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', color: colors.ink, fontSize: fontSize.bodyMicro,
  outline: 'none',
};
const tabBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.lg,
  padding: `0 ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairlineSoft}`,
};
const tabBtn: React.CSSProperties = {
  background: 'transparent',
  // Decompose `borderBottom: 2px solid transparent` into discrete keys
  // so React's style diff only mutates `borderBottomColor` between
  // active and inactive — without this, the shorthand can leave a
  // residual ink color on the DOM after a tab swap and we see a
  // ghost underline on the previously-active tab.
  borderTop: 'none',
  borderLeft: 'none',
  borderRight: 'none',
  borderBottomStyle: 'solid',
  borderBottomWidth: 2,
  borderBottomColor: 'transparent',
  marginBottom: -1,
  cursor: 'pointer',
  padding: `${space.sm}px 0`,
  fontSize: fontSize.metaSmall,
  color: colors.muted,
  // Belt-and-suspenders for the focus ring; the popup's global
  // button:focus rule does the heavy lifting via !important.
  outline: 'none',
  WebkitTapHighlightColor: 'transparent',
};
const countChip: React.CSSProperties = {
  marginLeft: 'auto',
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.muted,
};
const list: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: `${space.sm}px 0` };
const rowWrap: React.CSSProperties = {
  position: 'relative',
};
const rowLink: React.CSSProperties = {
  display: 'flex', gap: space.lg, alignItems: 'flex-start',
  padding: `${space.md}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairlineSoft}`,
  textDecoration: 'none', color: 'inherit',
};
const menuToggleBtn: React.CSSProperties = {
  position: 'absolute',
  top: space.sm,
  right: space.sm,
  width: 24, height: 24,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent',
  border: `1px solid transparent`,
  borderRadius: radius.std,
  color: colors.muted,
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1,
  cursor: 'pointer',
  outline: 'none',
};
const menuBackdrop: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  zIndex: 10,
};
const menuPopover: React.CSSProperties = {
  position: 'absolute',
  top: space.xl + 4,
  right: space.sm,
  zIndex: 11,
  minWidth: 100,
  background: '#fff',
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  overflow: 'hidden',
};
const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: `${space.sm}px ${space.md}px`,
  background: 'transparent',
  border: 'none',
  fontSize: fontSize.metaSmall,
  color: colors.ink,
  cursor: 'pointer',
  outline: 'none',
};
const rowFavicon: React.CSSProperties = {
  width: 16, height: 16, borderRadius: 3, flexShrink: 0,
  background: colors.tagBg, display: 'flex', alignItems: 'center',
  justifyContent: 'center', fontSize: 10, fontWeight: 600, color: colors.muted,
  marginTop: 2,
};
const archiveThumb: React.CSSProperties = {
  width: 56,
  height: 40,
  borderRadius: 4,
  flexShrink: 0,
  marginTop: 2,
  background: colors.tagBg,
  objectFit: 'cover',
  display: 'block',
};
const rowFaviconImg: React.CSSProperties = {
  width: 16, height: 16, borderRadius: 3, flexShrink: 0,
  marginTop: 2,
  background: colors.tagBg,
  objectFit: 'contain',
  // Don't ship "alt" text rendering when the image is empty — keeps
  // the row layout stable while a slow Linode redirect resolves.
  display: 'block',
};
const rowMain: React.CSSProperties = { flex: 1, minWidth: 0 };
const rowTitle: React.CSSProperties = {
  fontSize: fontSize.bodyMicro, fontWeight: 500, lineHeight: lineHeight.title,
  color: colors.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const rowMeta: React.CSSProperties = {
  marginTop: 2,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.muted,
};
const privateBadge: React.CSSProperties = {
  fontSize: '0.85em', verticalAlign: 'middle',
};
const chipRow: React.CSSProperties = { display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' };
const chip: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, padding: '2px 6px',
  background: colors.tagBg, color: colors.inkSoft, borderRadius: radius.badge,
  height: 18, lineHeight: '14px',
};
const tagCloudWrap: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6,
  padding: `${space.lg}px ${space.xl}px`,
};
const tagChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', borderRadius: radius.badge,
  background: colors.tagBg, border: 'none',
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.inkSoft,
  cursor: 'pointer',
};
const tagCount: React.CSSProperties = {
  color: colors.muted, fontSize: fontSize.uppercaseLabel,
};
const empty: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: `${space.xxxl}px ${space.xl}px`,
};
const emptyText: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.metaSmall, color: colors.muted,
};
const footer: React.CSSProperties = {
  padding: `${space.lg}px ${space.xl}px`,
  borderTop: `1px solid ${colors.hairline}`, background: colors.paper,
};
const primaryBtn: React.CSSProperties = {
  width: '100%', padding: space.lg,
  background: colors.ink, color: colors.paper,
  border: 'none', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.body, fontWeight: 500,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space.sm,
};
