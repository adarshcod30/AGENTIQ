/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the AGENTIQ API. Actually read: see services/api.ts. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
