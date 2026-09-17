export interface Navigation { url: string; title: string; at: number }
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  openedAt: number;
  closedAt: number | null;
  openAtEnd?: boolean;
  openerId: string | null;
  windowId: string | null;
  desktopId: string;
  windowBounds?: { left: number; top: number; width: number; height: number; windowState?: string } | null;
  windowHistory: Array<{ windowId: string; desktopId: string; at: number }>;
  extensionTabId?: number | null;
  extensionWindowId?: number | null;
  tabIndex?: number | null;
  pinned?: boolean;
  active?: boolean;
  orderHistory?: Array<{ windowId: number | null; index: number; at: number }>;
  groupId: number | null;
  groupTitle: string | null;
  groupColor: string | null;
  groupCollapsed: boolean;
  groupHistory: Array<{ groupId: number | null; title: string | null; color: string | null; at: number }>;
  thumbnail: string | null;
  thumbnailAt: number | null;
  navigations: Navigation[];
}
export interface Session {
  id: string;
  name: string;
  browser: 'helium' | 'chrome';
  startedAt: number;
  endedAt: number | null;
  restoredFromSessionId?: string;
  tabs: BrowserTab[];
}
export interface AppState {
  status: 'idle' | 'launching' | 'live' | 'stopping' | 'error';
  session: Session | null;
  debugPort: number | null;
  error: string | null;
}
export interface BrowserChoice { id: 'helium' | 'chrome'; name: string; path: string | null }
export interface LaunchOptions { browser: 'helium' | 'chrome'; executable?: string; url: string; name: string }
export interface SessionSummary { id: string; name: string; startedAt: number; endedAt: number | null; browser: string; tabCount: number }
export interface RestoreResult { state: AppState; requested: number; opened: number; skipped: number; failed: number; desktopFailed: number; groupsRestored: boolean; warnings: string[] }
export interface TablineAPI {
  getState(): Promise<AppState>;
  getBrowsers(): Promise<BrowserChoice[]>;
  chooseExecutable(): Promise<string | null>;
  launch(options: LaunchOptions): Promise<AppState>;
  stop(): Promise<void>;
  focusTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  capture(id: string): Promise<string | undefined>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<Session>;
  restoreSession(id: string, options?: { executable?: string }): Promise<RestoreResult>;
  exportSession(session: Session): Promise<boolean>;
  onState(callback: (state: AppState) => void): () => void;
}
declare global { interface Window { tabline?: TablineAPI } }
