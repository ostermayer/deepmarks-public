// Legacy redirect — the old BookmarkCard linked here before we moved
// public profiles to /u/[npub]. Keeps stale bookmarks + any external
// links pointing at /app/user/<id> working. The target accepts both
// bech32 npub and 64-char hex, so we can hand the id through as-is.

import { redirect } from '@sveltejs/kit';

export const prerender = false;

export function load({ params }: { params: { id: string } }): never {
  throw redirect(301, `/u/${params.id}`);
}
