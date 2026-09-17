export interface Navigation { url: string; title: string; at: number }
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  openedAt: number;
  closedAt: number | null;
  openerId: string | null;
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
  exportSession(session: Session): Promise<boolean>;
  onState(callback: (state: AppState) => void): () => void;
}
declare global { interface Window { tabline?: TablineAPI } }
