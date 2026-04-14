/** Electron preload exposes `opencyto` on `window` (see `electron/preload.js`). */

export {};

declare global {
  interface Window {
    opencyto?: {
      version?: string;
      openFcsFiles?: () => Promise<string[]>;
      saveWorkspaceFile?: (content: string) => Promise<{ canceled?: boolean }>;
      loadWorkspaceFile?: () => Promise<{ canceled?: boolean; content?: string }>;
      appendDebugLog?: (message: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      getDebugLogPath?: () => Promise<string>;
      clearDebugLog?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    };
  }
}
