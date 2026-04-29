// Nostr event kinds used by Deepmarks. Source: CLAUDE.md "Conventions around
// Nostr events" + the relay write-policy whitelist (kinds 39701, 9735).

export const KIND = {
  /** NIP-01 user profile metadata */
  profile: 0,
  /** NIP-01 short text note (used by flow H "share as post") */
  note: 1,
  /** NIP-09 deletion request (used by flow F when going public→private) */
  deletion: 5,
  /** NIP-57 zap request (signed by the zapper, sent to LNURL endpoint) */
  zapRequest: 9734,
  /** NIP-57 zap receipt (signed by deepmarks brand key, published by payment-proxy) */
  zapReceipt: 9735,
  /** NIP-02 contact list — the user's "following" graph */
  contacts: 3,
  /** NIP-51 mute list — pubkeys, hashtags, words, thread-event-ids the user wants hidden */
  muteList: 10000,
  /** NIP-65 relay list */
  relayList: 10002,
  /** NIP-B7 Blossom server list */
  blossomServers: 10063,
  /** NIP-51 private bookmark set (NIP-44 v2 encrypted) */
  privateBookmarkSet: 30003,
  /** NIP-B0 public web bookmark (replaceable by URL) */
  webBookmark: 39701
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];
