# Social Bookmark Imports

Deepmarks treats saved Nostr posts as bookmarks, not as a raw social
timeline. The post itself is normally a Nostr `kind:1` event. The save
record that says "this user bookmarked that post" is a separate event,
usually a NIP-51 list event from the user's existing Nostr client.

## Event Kinds

Supported bookmark sources:

- `kind:10003` — NIP-51 legacy bookmark list. Damus, Primal, Amethyst,
  Snort, and similar clients commonly use this for saved notes. Public
  refs live in `tags`; private refs can live in encrypted `content`.
- `kind:30003` — NIP-51 addressable bookmark set. Deepmarks imports
  third-party sets even when they are encrypted-only, as long as the
  signed event is otherwise valid and has a `d` tag.
- `kind:30001` — deprecated NIP-51 "categorized bookmarks/sets", the
  predecessor of `30003`. Older 2023–2024 clients still wrote bookmark
  sets here (commonly `d:"bookmark"`). Handled exactly like `30003` so
  those legacy sets are not silently dropped.
- `kind:39701` — Deepmarks web bookmark. If the URL points to a Nostr
  note page, Deepmarks treats that as a saved post bookmark.

Targets rendered in `/app/posts` are `kind:1` notes. A NIP-51 event is
only the pointer. The UI resolves the target event and renders it as a
post card when the target is available on `relay.deepmarks.org`.

## Public Ref Shapes

Deepmarks can import and render social bookmarks when the signed event
contains public refs in standard places:

```jsonc
{
  "kind": 10003,
  "pubkey": "<bookmarking-user>",
  "tags": [
    ["e", "<kind-1-note-id>", "wss://optional-source-relay"],
    ["r", "https://primal.net/e/<note-or-nevent>"],
    ["a", "30023:<pubkey>:<d-tag>"]
  ],
  "content": ""
}
```

For post bookmarks today, Deepmarks uses `e` refs and Nostr note URLs in
`r` refs. `a` refs are preserved as list data but article/addressable
rendering is a separate path.

Deepmarks also detects Nostr note URLs in public `kind:39701` bookmark
URLs, including `note1...`, `nevent1...`, and bare 64-hex event ids on
known Nostr web hosts such as `primal.net`, `damus.io`, and `njump.me`.
Relay hints from `nevent` refs are used as extra source relays when
fetching the target note.

## Server-Side Heavy Lifting

Clients should not fan out to every third-party relay just to show a
user's old Amethyst/Primal/Damus bookmarks. Box A does that work:

1. A successful NIP-98 auth records the pubkey as active.
2. Active pubkeys are registered for relay writes if needed.
3. Existing active pubkeys are queued for an onboarding scan at most
   once per hour using `dm:onboarding:auth-refresh:<pubkey>`.
4. The onboarding scanner reads the user's NIP-65 relay list, falling
   back to common discovery relays when needed.
5. It imports bookmark and account-state events:
   `39701`, `10003`, `30003`, `30001`, `10002`, plus identity/follow
   state needed by the app.
6. It extracts referenced `kind:1` note ids from public `e` tags, Nostr
   note URLs in `r` tags, and Nostr note URLs saved as `39701` bookmarks.
7. It fetches those exact `kind:1` targets from relay hints, the user's
   relays, and discovery relays, then forwards them to local strfry.

The one-time operator backfill uses the same queue:

```text
dm:registered:pubkeys -> dm:onboarding:queue
```

Before enqueueing a forced backfill, clear `dm:onboarding:done:<pubkey>`
so the scanner does not skip a pubkey that was scanned previously.

Authenticated-user refreshes use `dm:onboarding:priority-queue` instead
of the bulk backfill queue. The scanner checks that priority queue before
each normal item, so a returning user does not wait behind the full
one-time registered-pubkey scan.

## Limits

The scanner imports up to `5,000` source events per pubkey and fetches
up to `5,000` referenced `kind:1` note targets per scan. These caps
protect Box A from unbounded third-party relay reads while covering
large real user libraries.

The scanner can only derive target note ids from public tags. If the
target note cannot be found on the advertised or discovery relays during
the scan, the NIP-51 pointer may exist on our relay but `/app/posts`
will hide the unresolved target until a later scan or client request
finds it.

## Post Bookmark Actions

A saved post in `/app/posts` gets the same actions as a web URL
bookmark: view/add/edit **tags**, **read later**, **archive** + **download
archive**, **zap**, and **share**. The note content itself stays
read-only — only the user's own tags and metadata are editable.

A post references someone else's `kind:1` note, so the tags / read-later
/ archive state can't live on the note. They attach to a Deepmarks-native
bookmark keyed by the note's canonical URL (`nostrNoteArchiveUrl`,
e.g. `https://primal.net/e/<note1…>`):

- If the user already saved that note in Deepmarks, actions edit that
  bookmark in place.
- Otherwise the first tag / read-later / archive **adopts** the imported
  post by publishing a bookmark for it.

Adopt visibility **preserves origin**: a post imported from the user's
private NIP-51 list becomes a private (encrypted-set) bookmark; a
public-origin post follows the account's default-visibility setting. A
privately-bookmarked post is never silently republished as public.

The web app ships this immediately; the iOS/Android app and browser
extension pick it up on their next build.

## Private Encrypted Lists

Some clients may publish a `kind:10003` or `kind:30003` whose public
tags do not include bookmark refs and whose `content` carries private
encrypted NIP-51 tag arrays. Deepmarks stores and forwards that signed
event as ciphertext. The server does not decrypt it.

When the user signs in with an `nsec` or compatible signer, the app
fetches those mirrored NIP-51 events from `relay.deepmarks.org` and
decrypts private `content` locally. Current NIP-51 private content uses
NIP-44; Deepmarks also falls back to legacy NIP-04 payloads that carry
`?iv=`.

After local decrypt, the app parses private `e` tags and private Nostr
note URLs in `r` tags. It sends only those revealed target event ids and
relay hints to:

```text
POST /nostr/social-bookmarks/prefetch
```

That authenticated endpoint marks each exact target id in Redis with
`dm:bookmarked-note-target:<event-id>` so strfry accepts the imported
`kind:1`, fetches the signed target notes from relay hints / common
discovery relays, and republishes them into local strfry. The response
returns counts only.

Privacy boundary: encrypted NIP-51 ciphertext can be mirrored without
server knowledge. Once the client sends decrypted target ids for
prefetch, Deepmarks learns those bookmarked note ids. That is why the
decryption step stays on-device and the server receives only the
minimum event ids needed to make `/app/posts` render.
