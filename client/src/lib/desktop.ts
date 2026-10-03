/** Bridge exposed by the Windows desktop app (desktop/preload.cjs). Undefined in a normal browser. */
export interface DesktopBridge {
  chooseFolder: (current?: string) => Promise<string | null>;
  openFolder: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    imsDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.imsDesktop;
