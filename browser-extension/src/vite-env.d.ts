/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to '1' for the Apple-build variant (Safari extension and the
   *  future iOS standalone). Gates payment surfaces — see
   *  src/lib/build-flags.ts. */
  readonly VITE_APPLE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
