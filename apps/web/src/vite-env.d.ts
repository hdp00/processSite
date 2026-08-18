/// <reference types="vite/client" />

declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_MODE?: "mock" | "remote";
  readonly VITE_MOCK_API_READ_DELAY_MS?: string;
  readonly VITE_MOCK_API_WRITE_DELAY_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
