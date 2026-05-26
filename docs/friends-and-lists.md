# Friends and Public Lists

Deepmarks keeps the social graph and collection features on standard
Nostr event kinds. There are no custom event kinds for friends or lists.

## Friends

Deepmarks uses two standard layers:

- **Following:** NIP-02 `kind:3` contact list. This is the user's
  portable Nostr follow graph. The follow button on another user's
  profile writes this list.
- **Friends subset:** NIP-51 `kind:30000` categorized follow set with
  `d=deepmarks-friends`. The `/app/friends` picker lets a user choose
  selected pubkeys from their existing NIP-02 follows, or add all.

The friends bookmark feed reads public `kind:39701` bookmarks whose
authors are in the `deepmarks-friends` follow set. It also reads the
same friends' ordinary Nostr `kind:1` notes, extracts only `http(s)`
links, and renders those as link-only rows. Deepmarks does not render
the surrounding social commentary because the friends page is still a
bookmark/link surface, not a social timeline. Social-note links are not
included in global, popular, recent, public profile feeds, or browser
extension lists. The feature is web + native mobile only.

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

If the signed-in user has not saved a friend's link yet, the row shows a
`save` action that opens the normal Deepmarks save flow with the URL
prefilled. Friends links also show the same share action as other
public rows so the viewer can post the link to their own Nostr feed
without saving it first. Zap requests target the original bookmark event
for explicit Deepmarks bookmarks and the original `kind:1` event for
links extracted from social notes; if the friend does not advertise a
Lightning address, Deepmarks falls back to the normal site zap recipient.
Friends-feed zap totals use NIP-57 receipts for the same target event,
so zaps created outside Deepmarks still show up on social-note links.
Explicit `kind:39701` bookmarks win over social-note links for the same
`(friend, URL)` pair because they carry richer Deepmarks metadata such
as tags, descriptions, and archive state.

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

Collections must also stay single-author and NIP-compatible. Deepmarks
should not model multi-user mutation of one list event because Nostr
replaceable events are signed by exactly one author.

Use NIP-51 bookmark sets:

- `kind:30003`
- owner is the collection curator's pubkey
- `d=<collection-slug>`
- `title` tag for display
- `r` tags for web URLs
- `e` tags for Nostr events
- `a` tags for addressable Nostr events
- `t` tags for collection topics

Canonical Nostr identity is `30003:<owner-pubkey>:<collection-slug>`.
Deepmarks can expose a nicer web URL such as
`https://deepmarks.org/lists/<name>` when a unique site-level slug is
claimed, but the portable source of truth remains the author's signed
NIP-51 event.

If collaborative curation is needed later, keep it protocol-native by
aggregating multiple authors' own signed lists or accepting signed
suggestions that the owner explicitly merges into their list. Do not
pretend multiple users can directly edit the same replaceable event.
