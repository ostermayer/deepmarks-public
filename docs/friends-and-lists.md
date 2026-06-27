# Friends and Public Lists

Deepmarks keeps the social graph and collection features on standard
Nostr event kinds. There are no custom event kinds for friends or lists.

## Friends

Deepmarks uses two standard layers:

- **Following:** NIP-02 `kind:3` contact list. This is the user's
  portable Nostr follow graph. Deepmarks reads it as a source for the
  friends picker but does not mutate it from profile-page follow
  controls.
- **Friends subset:** NIP-51 `kind:30000` categorized follow set with
  `d=deepmarks-friends`. The `/app/friends` toolbar has a gear control
  that opens the picker, where a user can choose selected pubkeys from
  their existing NIP-02 follows, or add all. The follow button on a
  public Deepmarks profile toggles this subset directly.

The friends bookmark feed defaults to saved/bookmarked material only:

- friends' public Deepmarks `kind:39701` bookmarks
- friends' NIP-51 `kind:10003` bookmark lists
- friends' public NIP-51 `kind:30003` bookmark sets
- friends' public NIP-51 `kind:30001` bookmark sets (legacy, predecessor
  of 30003)

For NIP-51 lists, `r` tags render as URL bookmarks and `e` tags render
as saved Nostr-post bookmarks. This makes the friends page a curated
bookmark feed across Deepmarks, Primal, Damus, Amethyst, Snort, and
other clients instead of a raw social timeline. The friends feed reads
friends' **public** list refs only — we never decrypt another user's
private NIP-51 `content`.

The server-side import path for signed-in users uses the same model:
`kind:10003` / `kind:30003` / `kind:30001` bookmark events are imported
from the user's relays. Public referenced `kind:1` note targets are
mirrored into `relay.deepmarks.org`. For the signed-in user's **own**
lists, private encrypted `content` is mirrored as ciphertext and
decrypted on-device after sign-in, then the revealed target ids are sent
to the social-bookmark prefetch endpoint so those notes import too.
Details and limitations are in
[`social-bookmark-imports.md`](social-bookmark-imports.md).

The feed never shows raw `nostr:` bech32 references or unresolved note
ids as user-facing content. `nostr:npub...` references render as profile
links, note/event references render as post links, and unresolved NIP-51
`e` tag targets stay hidden until the event is available. The server-side
follows ingester mirrors friends' bookmark events, latest identity events,
and referenced note targets into the Deepmarks relay so most friends-feed
rows can render immediately from local relay data.

The friends gear panel has an optional **social media posts** checkbox.
When enabled, Deepmarks additionally reads the same friends' ordinary
Nostr `kind:1` notes, extracts only `http(s)` links, and renders those
as link-only rows. This raw-post discovery mode is off by default
because high-volume `kind:1` notes are much noisier than bookmark
events. Social-note links are not included in global, popular, recent,
public profile feeds, or browser extension lists. The feature is web +
native mobile only.

Social-note rows get lightweight rich previews:

- direct image URLs render the image with browser-native lazy loading
- direct audio/video URLs render a play control and do not stream until
  the user taps play
- YouTube links use a cached oEmbed metadata lookup for title/thumbnail
  and only load the embedded player after the user taps play
- ordinary web pages use the existing metadata endpoint for title,
  description, and OpenGraph image

The preview path is intentionally server-light. Direct media previews do
not proxy bytes through Deepmarks and do not call the metadata endpoint.
Metadata requests are client-deduped, throttled, delayed until rows are
near the viewport, and cached server-side in Redis. This keeps a large
friends feed from turning into hundreds of immediate crawler requests.
The relay ingest path is less lightweight by design: it proactively
pulls friends' public bookmark material and identity metadata into
`relay.deepmarks.org` so returning users do not have to rediscover the
same historical bookmarks and profiles from older public relays.

If the signed-in user has not saved a friend's link yet, the row shows a
`save` action that opens the normal Deepmarks save flow with the URL
prefilled. Friends links also show the same share action as other
public rows so the viewer can post the link to their own Nostr feed
without saving it first. Zap requests target the original bookmark event
for explicit Deepmarks bookmarks and the original `kind:1` event for
links extracted from social notes; if the friend does not advertise a
Lightning address, Deepmarks falls back to the normal site zap recipient.
Friends-feed zap totals use NIP-57 receipts for the same target event,
queried from common public Nostr relays, so zaps created outside
Deepmarks still show up on saved post bookmarks and optional social-note
links. The friends feed can sort by newest, oldest, title, or total zap
sats. Explicit `kind:39701` bookmarks win over NIP-51 URL refs and
social-note links for the same `(friend, URL)` pair because they carry
richer Deepmarks metadata such as tags, descriptions, and archive state.

`/feed/friends/<npub-or-hex>.xml` exposes the same friends links as an
Atom feed. Feed icons are web-only; the native iOS and Android shells do
not show RSS/Atom subscription controls.

The full NIP-02 contact list remains intact and interoperable with other
Nostr clients.
The friends picker searches the user's cached NIP-02 contacts locally
and also calls the authenticated `/account/people-search` endpoint for
registered Deepmarks users, so a user can add someone who is not already
in their follow list. The picker always keeps the contact list visible;
the "unchecked first" sort is there for later maintenance when a user
has followed new people elsewhere and wants to add only the new contacts
to their Deepmarks friends set.

Event shape:

```jsonc
{
  "kind": 30000,
  "pubkey": "<owner hex>",
  "created_at": 1779100000,
  "tags": [
    ["d", "deepmarks-friends"],
    ["title", "Deepmarks friends"],
    ["p", "<friend pubkey>"],
    ["p", "<friend pubkey>"]
  ],
  "content": ""
}
```

`kind:30000` is addressable by `(pubkey, kind, d-tag)`, so each user has
one current Deepmarks friends set. The set is public, matching standard
NIP-51 follow-set behavior.

## Public bookmark collections

Deepmarks collections are explicit single-author bookmark sets. They are
not derived from tags. A collection can span bookmarks with many tags,
and a bookmark's tags do not imply collection membership.

Collections stay single-author and NIP-compatible. Deepmarks should not
model multi-user mutation of one list event because Nostr replaceable
events are signed by exactly one author.

Use NIP-51 bookmark sets:

- `kind:30003`
- owner is the collection curator's pubkey
- public `d=deepmarks-collection:<collection-slug>`
- private `d=deepmarks-collection-private:<sha256(collection-slug)>`
- `title` tag for display
- `r` tags for web URLs
- `e` tags for Nostr events
- `a` tags for addressable Nostr events
- `t` tags for collection topics

Canonical public Nostr identity is
`30003:<owner-pubkey>:deepmarks-collection:<collection-slug>`.
Deepmarks exposes a web URL such as
`https://deepmarks.org/u/<user>/<collection-slug>`, but the portable
source of truth remains the author's signed NIP-51 event.

If collaborative curation is needed later, keep it protocol-native by
aggregating multiple authors' own signed lists or accepting signed
suggestions that the owner explicitly merges into their list. Do not
pretend multiple users can directly edit the same replaceable event.
