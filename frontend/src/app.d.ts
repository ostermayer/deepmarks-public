// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }

  // NIP-07 detection only — full surface is owned by NDK's NDKNip07Signer.
  interface DeepmarksNip07Provider {
    __deepmarks?: boolean;
    deepmarks?: { extension?: boolean };
    getPublicKey(): Promise<string>;
    signEvent(event: unknown): Promise<{ sig: string }>;
    getRelays?: () => Promise<Record<string, { read: boolean; write: boolean }>>;
    nip04?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
    nip44?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
  }

  interface Window {
    BarcodeDetector?: {
      new(options?: { formats?: string[] }): {
        detect(source: CanvasImageSource | HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
      };
    };
    nostr?: DeepmarksNip07Provider;
    deepmarks?: {
      extension?: {
        installed?: boolean;
        nwc?: {
          get(): Promise<{
            walletPubkey: string;
            relayUrl: string;
            lud16?: string;
            connectedAt: number;
          } | null>;
          connect(uri: string): Promise<{
            walletPubkey: string;
            relayUrl: string;
            lud16?: string;
            connectedAt: number;
          }>;
          clear(): Promise<true>;
        };
        archive?: {
          reconcile(): Promise<{
            reconciled: number;
            abandoned: number;
            pending: number;
          }>;
        };
      };
      nostr?: DeepmarksNip07Provider;
    };
  }
}

interface ImportMetaEnv {
  /** Set to '1' for the iOS-bound build (Capacitor wrapper for the
   *  App Store). Strips in-app payment surfaces — see
   *  src/lib/build-flags.ts. */
  readonly VITE_APPLE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
