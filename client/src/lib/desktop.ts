/** State of the Windows app's own updater (desktop/main.cjs). */
export interface DesktopUpdateState {
  state: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error' | 'disabled';
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: string;
}

/** Bridge exposed by the Windows desktop app (desktop/preload.cjs). Undefined in a normal browser. */
export interface DesktopBridge {
  /** local: this PC's own database. remote: a company server. */
  mode?: 'local' | 'remote';
  appVersion?: string;
  /** Only in local mode. */
  chooseFolder?: (current?: string) => Promise<string | null>;
  openFolder?: (path: string) => Promise<void>;
  /** Open the start screen to choose another server or this PC only. */
  changeServer?: () => Promise<void>;
  updates?: {
    status: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateState>;
    installNow: () => Promise<void>;
    onChange: (listener: (s: DesktopUpdateState) => void) => () => void;
  };
}

declare global {
  interface Window {
    imsDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.imsDesktop;
