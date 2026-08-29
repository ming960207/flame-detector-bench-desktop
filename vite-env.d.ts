/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_WS_URL?: string;
  readonly VITE_BACKEND_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly desktopRuntime?: {
    readonly backendHttpUrl: string;
    readonly backendWsUrl: string;
  };
}
