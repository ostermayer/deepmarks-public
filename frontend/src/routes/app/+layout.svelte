<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import Header from '$lib/components/Header.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import InstallPrompt from '$lib/components/InstallPrompt.svelte';
  import { isAuthenticated, session } from '$lib/stores/session';
  import { canSign } from '$lib/stores/session';
  import { createNip07Signer, isNip07Available } from '$lib/nostr/signers/nip07';

  // Public feeds any visitor (signed in or not) can browse. Everything
  // else under /app/ requires a session.
  const PUBLIC_APP_PATHS = ['/app/recent', '/app/popular'];

  onMount(async () => {
    if (session.hint || $isAuthenticated) return;
    const path = window.location.pathname;
    if (PUBLIC_APP_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return;

    // Auto-login from the deepmarks browser extension. The extension's
    // avatar link includes ?source=extension on routes that need a
    // session — when present, attempt a silent NIP-07 handshake before
    // bouncing the user to /login. If they have window.nostr and grant
    // the one-time getPublicKey approval, they land directly on the
    // page they came for. Other NIP-07 extensions (Alby, nos2x) are
    // also welcome here — same protocol.
    const params = new URLSearchParams(window.location.search);
    if (params.get('source') === 'extension' && isNip07Available()) {
      try {
        const signer = await createNip07Signer();
        await session.login(signer);
        // Strip the marker from the URL so it's not preserved on
        // share / bookmark / refresh.
        params.delete('source');
        const search = params.toString();
        history.replaceState({}, '', `${path}${search ? `?${search}` : ''}`);
        return;
      } catch {
        // Extension declined or absent under the hood — fall through.
      }
    }

    void goto(`/login?redirect=${encodeURIComponent(path)}`);
  });
</script>


<Header />

<slot />

<Footer />

<InstallPrompt />

