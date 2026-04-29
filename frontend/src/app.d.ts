// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }

  // NIP-07 detection only — full surface is owned by NDK's NDKNip07Signer.
  interface Window {
    nostr?: unknown;
  }
}

export {};
