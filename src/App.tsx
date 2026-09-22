import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, ExternalLink, FolderClock, FolderOpen,
  FolderPlus, GitBranch, Globe2, Image, Layers3, LayoutList, Maximize2, Monitor,
  Pencil, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Snowflake, Sparkles, Square, Trash2, X, Minus,
} from 'lucide-react';
import type { AppState, BrowserChoice, BrowserTab, Folder, Session, SessionSummary } from './types';
import { makeDemo } from './demo';

const api = window.tabline;
const launchPreferencesKey = 'tabline.launch-preferences';
type LaunchPreferences = { browser?: 'helium' | 'chrome'; executable?: string };
function readLaunchPreferences(): LaunchPreferences {
  try { return JSON.parse(localStorage.getItem(launchPreferencesKey) || '{}'); } catch { return {}; }
}
function writeLaunchPreferences(preferences: LaunchPreferences) {
  try { localStorage.setItem(launchPreferencesKey, JSON.stringify(preferences)); } catch {}
}
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const date = (time: number) => new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const duration = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; };
function domain(url: string) { try { return new URL(url).hostname.replace(/^www\./, '') || 'New tab'; } catch { return 'New tab'; } }
function siteName(tab: BrowserTab) { return domain(tab.originalUrl || tab.url).split('.')[0]; }
function siteColor(tab: BrowserTab) {
  const host = domain(tab.originalUrl || tab.url);
  if (host.includes('react')) return 'cyan';
  if (host.includes('github')) return 'purple';
  if (host.includes('figma')) return 'pink';
  if (host.includes('linear')) return 'violet';
  if (host.includes('vercel')) return 'slate';
  return 'blue';
}
function SiteIcon({ tab, size = '' }: { tab: BrowserTab; size?: string }) {
  const host = domain(tab.originalUrl || tab.url);
  return <span className={`site-icon ${siteColor(tab)} ${size}`}>
    {host.includes('react') ? <span className="react-symbol">⚛</span> : host.includes('github') ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 7c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.39.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.58c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg> : host.includes('vercel') ? <span>▲</span> : host.includes('linear') ? <span className="linear-symbol">◒</span> : host.includes('figma') ? <span className="figma-symbol">F</span> : host.includes('google') ? <span className="google-symbol">G</span> : <Globe2 size={16} />}
  </span>;
}

export default function App() {
  const [state, setState] = useState<AppState>({ status: 'idle', session: null, debugPort: null, error: null });
  const [demo, setDemo] = useState<Session | null>(() => api ? null : makeDemo());
  const [archived, setArchived] = useState<Session | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(api ? null : 'react');
  const [view, setView] = useState<'timeline' | 'list'>('timeline');
  const [page, setPage] = useState<'workspace' | 'sessions'>('workspace');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [showLaunch, setShowLaunch] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showStop, setShowStop] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [showConnections, setShowConnections] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [timelineTime, setTimelineTime] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingSubfolder, setCreatingSubfolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ type: 'folder'; id: string } | { type: 'session'; id: string; ids: string[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [sessionDropTarget, setSessionDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const sessionSelectionAnchor = useRef<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [deletingSessionIds, setDeletingSessionIds] = useState<string[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const session = demo || archived || state.session;
  const isLive = !demo && !archived && state.status === 'live';
  const canRestore = !!api && !demo && !!session && !isLive && (state.status === 'idle' || state.status === 'error');
  const sessionNow = session?.endedAt || now;
  const restoreTime = timelineTime ?? sessionNow;
  const selected = session?.tabs.find((tab) => tab.id === selectedId) || null;
  const currentTab = session?.tabs.filter((tab) => !tab.closedAt && tab.active).sort((a, b) => Number(!!b.focused) - Number(!!a.focused) || Number(b.lastActiveAt || 0) - Number(a.lastActiveAt || 0))[0] || null;
  const openTabs = session?.tabs.filter((tab) => !tab.closedAt).length || 0;
  const connections = session?.tabs.filter((tab) => tab.openerId && session.tabs.some((parent) => parent.id === tab.openerId)).length || 0;
  const filtered = useMemo(() => session?.tabs.filter((tab) => {
    const matchesQuery = `${tab.title} ${tab.url}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (filter === 'all' || (filter === 'open' && !tab.closedAt) || (filter === 'closed' && !!tab.closedAt) || (filter === 'linked' && !!tab.openerId));
  }) || [], [session, query, filter]);
  const tabsAtTimelineTime = useMemo(() => filtered.filter((tab) => tab.openedAt <= restoreTime && (!tab.closedAt || tab.closedAt > restoreTime || (restoreTime >= sessionNow && tab.openAtEnd !== false))), [filtered, restoreTime, sessionNow]);

  useEffect(() => {
    if (!api) return;
    api.getState().then(setState).catch((error) => setToast(error.message));
    return api.onState(setState);
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape') { setShowLaunch(false); setShowHelp(false); setShowStop(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => { if (state.error) setToast(state.error); }, [state.error]);
  useEffect(() => { setTimelineTime(null); }, [session?.id]);
  useEffect(() => {
    if (selectedSessionIds.size > 1 && editingSessionId) {
      setEditingSessionId(null);
      setSessionName('');
    }
  }, [editingSessionId, selectedSessionIds.size]);

  async function action(operation: () => Promise<unknown>, success?: string) {
    try { await operation(); if (success) setToast(success); } catch (error) { setToast(error instanceof Error ? error.message : 'Something went wrong. Please try again.'); }
  }
  function focusTab(id: string) {
    if (isLive && api) void action(() => api.focusTab(id));
  }
  async function exportSession() {
    if (!session) return;
    if (api) { await action(async () => { if (await api.exportSession(session)) setToast('Session exported with thumbnails and tab connections.'); }); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'tabline-demo.json'; link.click(); URL.revokeObjectURL(url);
    setToast('Demo session exported.');
  }
  async function openSessions() {
    setPage('sessions');
    if (api) await action(refreshSessions);
  }
  async function refreshSessions() {
    if (!api) return;
    const [nextSessions, nextFolders] = await Promise.all([api.listSessions(), api.listFolders()]);
    setSessions(nextSessions);
    const sessionIds = new Set(nextSessions.map((item) => item.id));
    setSelectedSessionIds((ids) => new Set([...ids].filter((id) => sessionIds.has(id))));
    if (sessionSelectionAnchor.current && !sessionIds.has(sessionSelectionAnchor.current)) sessionSelectionAnchor.current = null;
    setFolders(nextFolders);
  }
  async function restoreSessionById(id: string) {
    if (!api) return;
    await action(async () => {
      const preferences = readLaunchPreferences();
      const result = await api.restoreSession(id, { ...preferences, at: id === session?.id ? restoreTime : undefined });
      setState(result.state);
      setArchived(null);
      setDemo(null);
      setSelectedSessionIds(new Set());
      sessionSelectionAnchor.current = null;
      setSelectedId(null);
      setPage('workspace');
      setQuery('');
      setFilter('all');
      const issues = result.skipped + result.failed;
       const browserWarning = result.warnings?.find((warning) => warning.startsWith('Saved browser '));
       setToast(`Restored ${result.opened} ${result.opened === 1 ? 'tab' : 'tabs'}${issues ? `; ${issues} could not be restored` : ''}${result.desktopFailed ? '; virtual desktop placement was unavailable' : ''}${browserWarning ? `; ${browserWarning}` : ''}.`);
    });
  }
  async function restoreSession(item: SessionSummary) { await restoreSessionById(item.id); }
  function exploreDemo() { setDemo(makeDemo()); setArchived(null); setSelectedId('react'); setPage('workspace'); setShowLaunch(false); setQuery(''); setFilter('all'); }
  function toggleFolder(id: string) { setCollapsedFolders((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function startCreateFolder() { setCreatingFolder(true); setCreatingSubfolder(null); setFolderName(''); setEditingFolderId(null); }
  function startCreateSubfolder(parentId: string) { setCreatingSubfolder(parentId); setCreatingFolder(false); setFolderName(''); setEditingFolderId(null); }
  function cancelCreateFolder() { setCreatingFolder(false); setCreatingSubfolder(null); setFolderName(''); }
  async function createFolder() {
    if (!api) return;
    const name = folderName.trim();
    if (!name) return;
    const parentId = creatingSubfolder;
    await action(async () => { await api.createFolder(name, parentId); setFolderName(''); setCreatingFolder(false); setCreatingSubfolder(null); await refreshSessions(); }, 'Folder created.');
  }
  function startRenameFolder(folder: Folder) { setEditingFolderId(folder.id); setFolderName(folder.name); setCreatingFolder(false); setCreatingSubfolder(null); }
  function cancelEditFolder() { setEditingFolderId(null); setFolderName(''); }
  async function renameFolder() {
    if (!api || !editingFolderId) return;
    const id = editingFolderId;
    const name = folderName.trim();
    if (!name) return;
    await action(async () => { await api.renameFolder(id, name); setEditingFolderId(null); setFolderName(''); await refreshSessions(); }, 'Folder renamed.');
  }
  async function deleteFolder(id: string) {
    if (!api) return;
    await action(async () => { await api.deleteFolder(id); if (editingFolderId === id) { setEditingFolderId(null); setFolderName(''); } await refreshSessions(); }, 'Folder deleted.');
  }
  async function moveSession(sessionId: string, folderId: string | null) {
    if (!api) return;
    await action(async () => { await api.setSessionFolder(sessionId, folderId); await refreshSessions(); });
  }
  function beginDrag(type: 'folder' | 'session', id: string, event: React.DragEvent) {
    const ids = type === 'session' && selectedSessionIds.has(id)
      ? visibleSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
      : [id];
    setDragging(type === 'session' ? { type, id, ids } : { type, id });
    setSessionDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
  function endDrag() { setDragging(null); setDropTarget(null); setSessionDropTarget(null); }
  async function dropOnFolder(folderId: string) {
    const drag = dragging;
    endDrag();
    if (!api || !drag) return;
    if (drag.type === 'folder' && drag.id !== folderId) await action(async () => { await api.setFolderParent(drag.id, folderId); await refreshSessions(); });
    else if (drag.type === 'session') await action(async () => { for (const id of drag.ids) await api.setSessionFolder(id, folderId); await refreshSessions(); });
  }
  async function dropOnRoot() {
    const drag = dragging;
    endDrag();
    if (!api || !drag) return;
    if (drag.type === 'folder') await action(async () => { await api.setFolderParent(drag.id, null); await refreshSessions(); });
    else if (drag.type === 'session') await action(async () => { for (const id of drag.ids) await api.setSessionFolder(id, null); await refreshSessions(); });
  }
  function dragOverSession(sessionId: string, event: React.DragEvent) {
    if (!dragging || dragging.type !== 'session') return;
    event.preventDefault();
    event.stopPropagation();
    if (dragging.ids.includes(sessionId)) { setSessionDropTarget(null); return; }
    event.dataTransfer.dropEffect = 'move';
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setDropTarget(null);
    setSessionDropTarget({ id: sessionId, position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' });
  }
  async function dropOnSession(targetSessionId: string, event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const drag = dragging;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const before = event.clientY < bounds.top + bounds.height / 2;
    endDrag();
    if (!api || !drag || drag.type !== 'session' || drag.ids.includes(targetSessionId)) return;
    const order = new Map(visibleSessionIds.map((id, index) => [id, index]));
    const ids = [...drag.ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)).reverse();
    await action(async () => { for (const id of ids) await api.reorderSession(id, targetSessionId, before); await refreshSessions(); });
  }
  function startRenameSession(item: SessionSummary) { setEditingSessionId(item.id); setSessionName(item.name); }
  function cancelRenameSession() { setEditingSessionId(null); setSessionName(''); }
  async function renameSession() {
    if (!api || !editingSessionId) return;
    const id = editingSessionId;
    const name = sessionName.trim();
    if (!name) return;
    await action(async () => { await api.renameSession(id, name); setEditingSessionId(null); setSessionName(''); await refreshSessions(); }, 'Session renamed.');
  }
  function requestDeleteSession(id: string) {
    setDeletingSessionIds(selectedSessionIds.size > 1 && selectedSessionIds.has(id) ? [...selectedSessionIds] : [id]);
  }
  async function deleteSessions() {
    if (!api || !deletingSessionIds?.length) return;
    const ids = deletingSessionIds;
    await action(async () => { for (const id of ids) await api.deleteSession(id); setDeletingSessionIds(null); await refreshSessions(); }, `${ids.length} ${ids.length === 1 ? 'session' : 'sessions'} deleted.`);
  }
  async function moveSelectedSessions(folderId: string | null) {
    if (!api || selectedSessionIds.size < 2) return;
    const ids = [...selectedSessionIds];
    await action(async () => { for (const id of ids) await api.setSessionFolder(id, folderId); await refreshSessions(); }, `${ids.length} sessions moved.`);
  }
  const folderChildren = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const folder of folders) {
      const key = folder.parentId || null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(folder);
    }
    return map;
  }, [folders]);
  const rootFolders = folderChildren.get(null) || [];
  const unfiledItems = sessions.filter((item) => !item.folderId);
  const folderOptions = useMemo(() => {
    const options: { folder: Folder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of folderChildren.get(parentId) || []) { options.push({ folder, depth }); walk(folder.id, depth + 1); }
    };
    walk(null, 0);
    return options;
  }, [folderChildren]);
  const visibleSessionIds = useMemo(() => {
    const ids: string[] = [];
    const addFolder = (folder: Folder) => {
      if (collapsedFolders.has(folder.id)) return;
      for (const child of folderChildren.get(folder.id) || []) addFolder(child);
      for (const item of sessions) if (item.folderId === folder.id) ids.push(item.id);
    };
    for (const folder of rootFolders) addFolder(folder);
    if (!collapsedFolders.has('unfiled')) for (const item of sessions) if (!item.folderId) ids.push(item.id);
    return ids;
  }, [collapsedFolders, folderChildren, rootFolders, sessions]);
  function selectSession(id: string, event: React.MouseEvent<HTMLButtonElement>) {
    const toggle = event.ctrlKey || event.metaKey;
    const anchor = sessionSelectionAnchor.current;
    const anchorIndex = anchor ? visibleSessionIds.indexOf(anchor) : -1;
    const clickedIndex = visibleSessionIds.indexOf(id);
    if (event.shiftKey && anchorIndex !== -1 && clickedIndex !== -1) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const range = visibleSessionIds.slice(start, end + 1);
      setSelectedSessionIds((previous) => {
        if (!toggle) return new Set(range);
        const next = new Set(previous);
        range.forEach((sessionId) => next.add(sessionId));
        return next;
      });
    } else if (toggle) {
      setSelectedSessionIds((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else {
      setSelectedSessionIds(new Set([id]));
    }
    sessionSelectionAnchor.current = id;
  }
  const renderFolder = (folder: Folder, depth: number): React.ReactNode => {
    const items = sessions.filter((item) => item.folderId === folder.id);
    const children = folderChildren.get(folder.id) || [];
    const collapsed = collapsedFolders.has(folder.id);
    const indent = depth * 18;
    const contentIndent = indent + 18;
    return <div className={`folder-section ${dropTarget === folder.id ? 'drop-target' : ''} ${dragging?.type === 'folder' && dragging.id === folder.id ? 'dragging' : ''}`} key={folder.id} onDragOver={(event) => { if (!dragging || dragging.id === folder.id) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(folder.id); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropTarget((target) => (target === folder.id ? null : target)); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropOnFolder(folder.id); }}>
      <div className="folder-header" style={{ paddingLeft: indent }}><button className="folder-toggle" draggable onClick={() => toggleFolder(folder.id)} aria-expanded={!collapsed} onDragStart={(event) => beginDrag('folder', folder.id, event)} onDragEnd={endDrag}>{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<FolderOpen size={15}/><strong>{folder.name}</strong><span className="folder-count">{items.length}</span></button>{editingFolderId === folder.id ? null : <div className="folder-actions"><button onClick={() => startCreateSubfolder(folder.id)} aria-label={`New folder inside ${folder.name}`}><FolderPlus size={13}/></button><button onClick={() => startRenameFolder(folder)} aria-label={`Rename ${folder.name}`}><Pencil size={13}/></button><button onClick={() => deleteFolder(folder.id)} aria-label={`Delete ${folder.name}`}><Trash2 size={13}/></button></div>}</div>
      {editingFolderId === folder.id && <div className="folder-edit" style={{ paddingLeft: indent }}><input autoFocus aria-label="Rename folder" value={folderName} onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') renameFolder(); if (event.key === 'Escape') cancelEditFolder(); }}/><button onClick={renameFolder} aria-label="Save folder name"><Check size={14}/></button><button onClick={cancelEditFolder} aria-label="Cancel"><X size={14}/></button></div>}
      {creatingSubfolder === folder.id && <div className="folder-edit" style={{ paddingLeft: indent + 18 }}><input autoFocus aria-label="Folder name" value={folderName} placeholder="Folder name" onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createFolder(); if (event.key === 'Escape') cancelCreateFolder(); }}/><button onClick={createFolder} aria-label="Create folder"><Check size={14}/></button><button onClick={cancelCreateFolder} aria-label="Cancel"><X size={14}/></button></div>}
      {!collapsed && <>{children.map((child) => renderFolder(child, depth + 1))}{items.map((item) => renderSession(item, contentIndent))}{children.length === 0 && items.length === 0 && <div className="folder-empty" style={{ paddingLeft: contentIndent }}>No sessions in this folder.</div>}</>}
      {collapsed && <div className="folder-separator" style={{ marginLeft: contentIndent }}/>} 
    </div>;
  };
  const renderSession = (item: SessionSummary, indent: number): React.ReactNode => <SessionRow key={item.id} item={item} options={folderOptions} indent={indent} onMove={moveSession} disabled={(state.status !== 'idle' && state.status !== 'error') || selectedSessionIds.size > 1} renameDisabled={selectedSessionIds.size > 1} selected={selectedSessionIds.has(item.id)} onSelect={(event) => selectSession(item.id, event)} dragging={dragging?.type === 'session' && dragging.ids.includes(item.id)} dropPosition={sessionDropTarget?.id === item.id ? sessionDropTarget.position : null} onDragStart={(event) => beginDrag('session', item.id, event)} onDragEnd={endDrag} onDragOver={(event) => dragOverSession(item.id, event)} onDrop={(event) => dropOnSession(item.id, event)} onView={() => action(async () => { setArchived(await api!.loadSession(item.id)); setDemo(null); setSelectedSessionIds(new Set()); sessionSelectionAnchor.current = null; setSelectedId(null); setPage('workspace'); setQuery(''); setFilter('all'); })} onRestore={() => restoreSession(item)} editing={editingSessionId === item.id && selectedSessionIds.size < 2} sessionName={sessionName} onSessionNameChange={setSessionName} onRenameStart={() => { if (selectedSessionIds.size < 2) startRenameSession(item); }} onRenameSave={renameSession} onRenameCancel={cancelRenameSession} onDelete={() => requestDeleteSession(item.id)}/>;

  return <div className="app-shell">
    <header className="window-titlebar">
      <div className="window-controls">
        <button onClick={() => api?.minimizeWindow()} aria-label="Minimize window"><Minus size={15}/></button>
        <button onClick={() => api?.toggleMaximizeWindow()} aria-label="Maximize or restore window"><Maximize2 size={13}/></button>
        <button className="window-close" onClick={() => api?.closeWindow()} aria-label="Close window"><X size={16}/></button>
      </div>
    </header>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('workspace'); }} aria-label="Tabline home"><span className="brand-mark"><span/><span/><span/></span><span>tabline<span className="brand-dot">.</span></span></a>
      <div className="nav-heading">WORKSPACE</div>
      <nav>
        <button className={`nav-item ${page === 'workspace' ? 'active' : ''}`} onClick={() => setPage('workspace')}><Activity size={18}/><span>Browser timeline</span></button>
        <button className={`nav-item ${page === 'sessions' ? 'active' : ''}`} onClick={openSessions}><FolderClock size={18}/><span>Saved sessions</span></button>
      </nav>
      <div className="sidebar-session-heading"><span>CURRENT SESSION</span></div>
      {session && <button className="current-session" onClick={() => setPage('workspace')}><span className={`tiny-dot ${isLive || demo ? 'green' : 'gray'}`}/><div><strong>{session.name}</strong><span>{demo ? 'Demo session' : isLive ? 'Recording your journey' : 'Saved locally'} · {session.tabs.length} tabs</span></div></button>}
      <div className="sidebar-bottom">
        <button className="nav-item help-button" onClick={() => setShowHelp(true)}><CircleHelp size={18}/><span>A little help</span><span className="help-key">?</span></button>
      </div>
    </aside>

    <div className="main-shell">
      <main>
         <section className="page-heading"><div><h1>{page === 'sessions' ? 'Pick up the thread.' : 'Your browsing, connected.'}</h1></div><CurrentContext tab={currentTab} live={isLive}/><button className="button primary" onClick={() => setShowLaunch(true)} disabled={state.status === 'launching' || state.status === 'stopping'}><Plus size={17}/>New session</button></section>

        {page === 'sessions' ? <section className="sessions-panel">
           <div className="section-heading"><h2>Saved sessions</h2><div className="section-heading-actions">{selectedSessionIds.size > 1 && <div className="session-selection-toolbar"><span>{selectedSessionIds.size} selected</span><label><span>Move to</span><select aria-label="Move selected sessions to folder" value="" onChange={(event) => moveSelectedSessions(event.target.value === '__unfiled' ? null : event.target.value || null)}><option value="">Choose folder</option><option value="__unfiled">Unfiled</option>{folderOptions.map(({ folder, depth: optionDepth }) => <option key={folder.id} value={folder.id}>{'\u00A0'.repeat(optionDepth * 2)}{folder.name}</option>)}</select></label><button className="button secondary" onClick={() => setDeletingSessionIds([...selectedSessionIds])}><Trash2 size={14}/>Delete selected</button></div>}<span className="section-count">{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}</span>{api && (creatingFolder ? <div className="folder-edit folder-edit-inline"><input autoFocus aria-label="Folder name" value={folderName} placeholder="Folder name" onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createFolder(); if (event.key === 'Escape') cancelCreateFolder(); }}/><button onClick={createFolder} aria-label="Create folder"><Check size={14}/></button><button onClick={cancelCreateFolder} aria-label="Cancel"><X size={14}/></button></div> : <button className="button secondary folder-new" onClick={startCreateFolder}><FolderPlus size={15}/>New folder</button>)}</div></div>
          {folders.length || sessions.length ? <div className={`sessions-groups ${dropTarget === 'root' ? 'drop-root' : ''}`} onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget('root'); } }} onDrop={(event) => { event.preventDefault(); dropOnRoot(); }}>
            {rootFolders.map((folder) => renderFolder(folder, 0))}
            {unfiledItems.length > 0 && <div className={`folder-section unfiled ${dropTarget === 'unfiled' ? 'drop-target' : ''}`} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget('unfiled'); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropOnRoot(); }}><div className="folder-header"><button className="folder-toggle" onClick={() => toggleFolder('unfiled')} aria-expanded={!collapsedFolders.has('unfiled')}>{collapsedFolders.has('unfiled') ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<FolderOpen size={15}/><strong>Unfiled</strong><span className="folder-count">{unfiledItems.length}</span></button></div>{!collapsedFolders.has('unfiled') && unfiledItems.map((item) => renderSession(item, 18))}<div className="folder-separator" style={{ marginLeft: 18 }}/></div>}
          </div> : <div className="empty-state"><FolderClock size={35}/><h3>A fresh start.</h3><p>Your browsing sessions are saved automatically as you explore.<br/>Launch a browser to start your first one.</p><button className="button primary" onClick={() => setShowLaunch(true)}><Plus size={16}/>Start a session</button></div>}
        </section> : <>
          <div className="stats-grid">
            <Stat icon={<Layers3 size={18}/>} label="Total tabs" value={session?.tabs.length || 0} detail="a trail of curiosity" color="purple"/>
            <Stat icon={<Monitor size={18}/>} label="Open right now" value={openTabs} detail={<><span className={`tiny-dot ${openTabs ? 'green' : 'gray'}`}/>{openTabs ? 'still exploring' : 'ready when you are'}</>} color="green"/>
            <Stat icon={<GitBranch size={18}/>} label="Tab connections" value={connections} detail="one thing led to another" color="orange"/>
            <Stat icon={<Clock3 size={18}/>} label="Session time" value={session ? duration(sessionNow - session.startedAt) : '0m 00s'} detail={session ? `started at ${clock(session.startedAt)}` : 'make time for discovery'} color="blue"/>
          </div>

          <section className="timeline-panel">
             <div className="session-bar"><div className="session-title"><span className={`session-symbol ${demo ? 'demo' : ''}`}>{demo ? <Sparkles size={17}/> : <Radio size={17}/>}</span><h2>{session?.name || 'Your next discovery starts here'}</h2>{demo ? <span className="badge demo-badge">DEMO</span> : isLive ? <span className="badge live-badge"><span className="tiny-dot green"/>LIVE</span> : session ? <span className="badge">SAVED</span> : null}</div><div className="session-actions">{session && <><span className="session-date">{date(session.startedAt)}</span><button className="icon-button" onClick={exportSession} aria-label="Export session" title="Export session as JSON"><ArrowDownToLine size={17}/></button></>}{canRestore && <button className="button small restore-session-inline" onClick={() => restoreSessionById(session.id)} title={`Restore tabs open at ${clock(restoreTime)}`}><RefreshCw size={13}/>Restore from here</button>}{isLive && <button className="button small stop-button" onClick={() => setShowStop(true)}><Square size={11} fill="currentColor"/>End session</button>}{(demo || archived) && api && <button className="icon-button" title="Return to current session" aria-label="Return to current session" onClick={() => { setDemo(null); setArchived(null); setSelectedId(null); }}><X size={17}/></button>}</div></div>
            <div className="timeline-toolbar"><div className="view-switch"><button className={view === 'timeline' ? 'selected' : ''} onClick={() => setView('timeline')}><Activity size={15}/>Timeline</button><button className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}><LayoutList size={15}/>Tab list</button></div><div className="toolbar-filters"><label className="search-field"><Search size={15}/><input ref={searchRef} aria-label="Search tabs" placeholder="Find a tab..." value={query} onChange={(event) => setQuery(event.target.value)}/>{query ? <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12}/></button> : <kbd>⌘ K</kbd>}</label><div className="select-wrap"><select aria-label="Filter tabs" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All tabs</option><option value="open">Open tabs</option><option value="closed">Closed tabs</option><option value="linked">Connected tabs</option></select><ChevronDown size={13}/></div></div></div>
            <div className={`timeline-content ${selected ? 'has-detail' : ''}`}>
              <div className="timeline-main">
                  {!session || !session.tabs.length ? <div className="empty-state launch-empty"><div className="empty-illustration"><span/><span/><span/><GitBranch size={30}/></div><span className="eyebrow">FOLLOW YOUR CURIOSITY</span><h3>Big ideas start with a new tab.</h3><p>Launch Helium or Chrome and watch your browsing<br/>journey come together, one connection at a time.</p><button className="button primary" onClick={() => setShowLaunch(true)}><Plus size={16}/>Launch a browser</button><button className="text-button" onClick={exploreDemo}>Or take a look around with a demo <ArrowRight size={14}/></button></div> : !filtered.length ? <div className="empty-state"><Search size={30}/><h3>No tabs on this trail.</h3><p>Try a different search or show all tabs.</p><button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></div> : view === 'timeline' ? <Timeline tabs={filtered} allTabs={session.tabs} session={session} now={sessionNow} time={restoreTime} onTimeChange={setTimelineTime} selectedId={selectedId} onSelect={setSelectedId} onFocus={focusTab} thumbnails={showThumbnails} connections={showConnections} zoom={zoom}/> : <TabList tabs={tabsAtTimelineTime} now={restoreTime} selectedId={selectedId} currentTabId={currentTab?.id || null} onSelect={setSelectedId} onFocus={focusTab}/>} 
                <div className="timeline-footer"><div className="legend"><span><i className="legend-line open"/>Open tab</span><span><i className="legend-line closed"/>Closed tab</span><button className={!showConnections ? 'muted' : ''} onClick={() => setShowConnections(!showConnections)} title="Toggle opener connections"><GitBranch size={13}/>Opened from</button></div><div className="zoom-controls"><button className={!showThumbnails ? 'muted' : ''} onClick={() => setShowThumbnails(!showThumbnails)} title="Toggle thumbnails" aria-label="Toggle thumbnails" aria-pressed={showThumbnails}><Image size={15}/></button><span className="control-divider"/><button onClick={() => setZoom(Math.max(1, zoom - 0.5))} disabled={zoom === 1} aria-label="Zoom out"><Minus size={14}/></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(4, zoom + 0.5))} disabled={zoom === 4} aria-label="Zoom in"><Plus size={14}/></button><button onClick={() => setZoom(1)} aria-label="Fit timeline" title="Fit timeline"><Maximize2 size={13}/></button></div></div>
              </div>
              {selected && session && <TabDetail tab={selected} session={session} now={sessionNow} onClose={() => setSelectedId(null)} onSelect={setSelectedId} isLive={isLive} onFocus={() => action(() => api!.focusTab(selected.id))} onCapture={() => action(async () => { const image = await api!.capture(selected.id); if (!image) throw new Error('This tab is no longer available for capture.'); }, 'Thumbnail refreshed.')} onFreeze={() => action(async () => { const result = await api!.freezeTab(selected.id); if (!result.shortUrl) throw new Error('This tab could not be frozen.'); }, 'Tab frozen into a local snapshot.')} onUnfreeze={() => action(async () => { const result = await api!.unfreezeTab(selected.id); if (!result.originalUrl) throw new Error('This tab could not be returned.'); }, 'Returned to the original page.')} onCloseTab={() => action(() => api!.closeTab(selected.id), 'Tab closed. Its place in your timeline is saved.')}/>}
            </div>
            <div className="connection-bar"><div><span className={`tiny-dot ${isLive ? 'green' : demo ? 'orange' : 'gray'}`}/>{demo ? <><strong>You’re exploring a demo</strong><span>·</span><span>Launch a browser to make this timeline yours.</span></> : isLive ? <><strong>Connected to {session?.browser === 'helium' ? 'Helium' : 'Chrome'}</strong><span>·</span><span>127.0.0.1:{state.debugPort}</span></> : <><strong>{archived || session?.endedAt ? 'Session saved locally' : 'Ready to connect'}</strong><span>·</span><span>{archived || session?.endedAt ? 'Your trail is right where you left it.' : 'Helium or Chrome. Your choice.'}</span></>}</div>{demo ? <button onClick={() => setShowLaunch(true)}>Connect your browser <ArrowRight size={13}/></button> : <span className="connection-note"><ShieldCheck size={13}/>{isLive ? 'Recording locally' : 'Only on your device'}</span>}</div>
          </section>
        </>}
      </main>
    </div>
    {showLaunch && <LaunchDialog onClose={() => setShowLaunch(false)} running={state.status === 'live' || state.status === 'launching' || state.status === 'stopping'} onDemo={exploreDemo} onLaunch={async (options) => { if (!api) return; await api.launch(options); setDemo(null); setArchived(null); setSelectedId(null); setPage('workspace'); setQuery(''); setFilter('all'); setShowLaunch(false); }}/>} 
    {showHelp && <Modal title="A map for your wandering mind." subtitle="A few small things to help you find your way." onClose={() => setShowHelp(false)}><div className="help-list"><div><Radio/><section><h3>Launch. Browse. See the story.</h3><p>Start a Helium or Chrome session. Tabline launches a separate browser profile with a local debug connection and tracks tabs as you browse.</p></section></div><div><GitBranch/><section><h3>One tab leads to another.</h3><p>Each row is a tab’s lifetime. Arrows show the parent tab reported by the browser. Tabs opened from the address bar or without an opener start a new thread.</p></section></div><div><Image/><section><h3>A little picture of where you’ve been.</h3><p>Thumbnails update after navigation and about every 20 seconds. Select a tab for its preview, navigation history, and browser controls. Some browser-internal pages may not allow screenshots.</p></section></div><div><ShieldCheck/><section><h3>Just on your device.</h3><p>Sessions, URLs, and thumbnails are saved locally in Tabline’s app data. Export a session as JSON to keep a portable copy. Ending a session closes its dedicated browser window.</p></section></div></div><button className="button primary full-width" onClick={() => setShowHelp(false)}>Got it, let’s explore <ArrowRight size={16}/></button></Modal>}
    {showStop && <Modal title="Call it a session?" subtitle="Your trail will be right here when you need it." onClose={() => setShowStop(false)}><p className="modal-description">This closes the browser launched by Tabline and saves your timeline, thumbnails, and connections on this device.</p><div className="modal-actions"><button className="button secondary" onClick={() => setShowStop(false)}>Keep exploring</button><button className="button primary" onClick={() => action(async () => { await api!.stop(); setShowStop(false); }, 'Session saved. A good place to pick up later.')}><Check size={16}/>End & save session</button></div></Modal>}
    {deletingSessionIds && <Modal title={deletingSessionIds.length === 1 ? 'Delete this session?' : `Delete ${deletingSessionIds.length} sessions?`} subtitle="This can’t be undone." onClose={() => setDeletingSessionIds(null)}><p className="modal-description">{deletingSessionIds.length === 1 ? `“${sessions.find((item) => item.id === deletingSessionIds[0])?.name || 'This session'}” and its saved tabs, thumbnails, and connections will be removed from this device.` : `${deletingSessionIds.length} saved sessions and their tabs, thumbnails, and connections will be removed from this device.`}</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeletingSessionIds(null)}>Keep it</button><button className="button primary" onClick={deleteSessions}><Trash2 size={16}/>{deletingSessionIds.length === 1 ? 'Delete session' : 'Delete sessions'}</button></div></Modal>}
    {toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16}/></button></div>}
  </div>;
}

function Stat({ icon, label, value, detail, color }: { icon: React.ReactNode; label: string; value: string | number; detail: React.ReactNode; color: string }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><div className="stat-value">{value}<span className="stat-detail">{detail}</span></div></div>;
}

type WindowTabGroup = { key: string; window: string; tabs: BrowserTab[] };
type DesktopTabGroup = { key: string; desktop: string; tabs: BrowserTab[]; windows: WindowTabGroup[] };

function groupTabsByDesktop(tabs: BrowserTab[]): DesktopTabGroup[] {
  const desktops = new Map<string, DesktopTabGroup>();
  for (const tab of tabs) {
    const desktop = tab.desktopId || 'unknown';
    const window = tab.windowId || 'unknown';
    let desktopGroup = desktops.get(desktop);
    if (!desktopGroup) {
      desktopGroup = { key: `desktop:${desktop}`, desktop, tabs: [], windows: [] };
      desktops.set(desktop, desktopGroup);
    }
    let windowGroup = desktopGroup.windows.find((group) => group.window === window);
    if (!windowGroup) {
      windowGroup = { key: `window:${desktop}:${window}`, window, tabs: [] };
      desktopGroup.windows.push(windowGroup);
    }
    desktopGroup.tabs.push(tab);
    windowGroup.tabs.push(tab);
  }
  return [...desktops.values()];
}

function locationLabel(value: string, unavailable: string) {
  return value === 'unknown' ? unavailable : value;
}

function desktopLabel(value: string) {
  return value === 'unknown' ? 'Virtual desktop unavailable' : `Virtual desktop ${value.length > 14 ? `${value.slice(0, 8)}...` : value}`;
}

function CurrentContext({ tab, live }: { tab: BrowserTab | null; live: boolean }) {
  const desktop = tab?.desktopId && tab.desktopId !== 'unknown' ? tab.desktopId : null;
  const desktopLabel = desktop ? (desktop.length > 14 ? `${desktop.slice(0, 8)}...` : desktop) : 'Unavailable';
  return <div className={`current-context ${tab ? '' : 'empty'}`} title={desktop || undefined}><span className="context-icon"><Monitor size={16}/></span><div className="context-copy"><span className="context-label"><span className={`tiny-dot ${live && tab ? 'green' : 'gray'}`}/>{live ? 'CURRENT BROWSER' : 'VIEWING'}</span><strong>{tab?.title || 'No active tab'}</strong><small>{tab ? domain(tab.originalUrl || tab.url) : 'Focus a browser window to see its state'}</small></div><div className="context-state"><span>Desktop {desktopLabel}</span><span>{tab?.windowId ? `Window ${tab.windowId}` : 'No window'}</span></div></div>;
}

function TabList({ tabs, now, selectedId, currentTabId, onSelect, onFocus }: { tabs: BrowserTab[]; now: number; selectedId: string | null; currentTabId: string | null; onSelect: (id: string) => void; onFocus: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const groups = groupTabsByDesktop(tabs);
  return <div className="tab-list"><div className="tab-list-heading"><span>PAGE</span><span>OPENED</span><span>DURATION</span><span>STATUS</span></div>{groups.map((desktopGroup) => { const desktopCollapsed = collapsed.has(desktopGroup.key); const current = desktopGroup.tabs.some((tab) => tab.id === currentTabId); return <Fragment key={desktopGroup.key}><button type="button" className={`tab-list-separator desktop-separator ${current ? 'current' : ''} ${desktopCollapsed ? 'collapsed' : ''}`} title={desktopGroup.desktop === 'unknown' ? undefined : desktopGroup.desktop} onClick={() => toggle(desktopGroup.key)} aria-expanded={!desktopCollapsed}><span className="group-mark"><Monitor size={12}/></span><strong>{desktopLabel(desktopGroup.desktop)}</strong><span className="group-count">{desktopGroup.tabs.length} {desktopGroup.tabs.length === 1 ? 'tab' : 'tabs'}</span>{current && <span className="current-group-label">CURRENT</span>}<span className="separator-chevron">{desktopCollapsed ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</span></button>{!desktopCollapsed && desktopGroup.windows.map((windowGroup) => { const windowCollapsed = collapsed.has(windowGroup.key); return <Fragment key={windowGroup.key}><button type="button" className={`tab-list-separator window-separator ${windowGroup.tabs.some((tab) => tab.id === currentTabId) ? 'current' : ''} ${windowCollapsed ? 'collapsed' : ''}`} onClick={() => toggle(windowGroup.key)} aria-expanded={!windowCollapsed}><span className="group-mark"><Monitor size={11}/></span><span>Window {locationLabel(windowGroup.window, 'unknown')}</span><span className="group-count">{windowGroup.tabs.length} {windowGroup.tabs.length === 1 ? 'tab' : 'tabs'}</span><span className="separator-chevron">{windowCollapsed ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</span></button>{!windowCollapsed && windowGroup.tabs.map((tab) => <button key={tab.id} className={`tab-list-row ${tab.id === selectedId ? 'selected' : ''} ${tab.id === currentTabId ? 'current' : ''}`} onClick={() => onSelect(tab.id)} onDoubleClick={() => { if (!tab.closedAt) onFocus(tab.id); }}><div className="tab-list-title"><SiteIcon tab={tab}/><div><strong>{tab.title}</strong><span>{domain(tab.originalUrl || tab.url)}</span></div></div><span>{clock(tab.openedAt)}</span><span>{duration((tab.closedAt || now) - tab.openedAt)}</span><span className={`status-label ${tab.closedAt ? 'closed' : tab.frozen ? 'frozen' : 'open'}`}><span className="tiny-dot"/>{tab.closedAt ? 'Closed' : tab.frozen ? 'Frozen' : 'Open'}</span></button>)}</Fragment>; })}</Fragment>; })}</div>;
}

function SessionRow({ item, options, onMove, onView, onRestore, disabled, renameDisabled, indent, selected, onSelect, dragging, dropPosition, onDragStart, onDragEnd, onDragOver, onDrop, editing, sessionName, onSessionNameChange, onRenameStart, onRenameSave, onRenameCancel, onDelete }: { item: SessionSummary; options: { folder: Folder; depth: number }[]; onMove: (sessionId: string, folderId: string | null) => void; onView: () => void; onRestore: () => void; disabled: boolean; renameDisabled: boolean; indent: number; selected: boolean; onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void; dragging: boolean; dropPosition: 'before' | 'after' | null; onDragStart: (event: React.DragEvent) => void; onDragEnd: () => void; onDragOver: (event: React.DragEvent) => void; onDrop: (event: React.DragEvent) => void; editing: boolean; sessionName: string; onSessionNameChange: (value: string) => void; onRenameStart: () => void; onRenameSave: () => void; onRenameCancel: () => void; onDelete: () => void }) {
  return <div className={`saved-session ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${dropPosition ? `drop-${dropPosition}` : ''} ${editing ? 'editing' : ''}`} style={{ paddingLeft: indent }} onDragOver={onDragOver} onDrop={onDrop}>{editing ? <div className="session-rename"><input autoFocus aria-label="Rename session" value={sessionName} onChange={(event) => onSessionNameChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onRenameSave(); if (event.key === 'Escape') onRenameCancel(); }}/><button onClick={onRenameSave} aria-label="Save session name"><Check size={14}/></button><button onClick={onRenameCancel} aria-label="Cancel"><X size={14}/></button></div> : <><button className="saved-session-view" draggable onClick={onSelect} onDoubleClick={onView} onDragStart={onDragStart} onDragEnd={onDragEnd} title="Click to select, double-click to open"><span className="saved-session-icon"><FolderClock size={22}/></span><div><strong>{item.name}</strong><span>{date(item.startedAt)} · {clock(item.startedAt)} · {item.browser === 'helium' ? 'Helium' : 'Chrome'}</span></div><span>{item.tabCount} tabs</span><ArrowRight size={18}/></button><label className="saved-session-folder" title="Move to folder"><FolderOpen size={13}/><span className="select-wrap"><select aria-label={`Move ${item.name} to folder`} value={item.folderId || ''} onChange={(event) => onMove(item.id, event.target.value || null)}><option value="">Unfiled</option>{options.map(({ folder, depth: optionDepth }) => <option key={folder.id} value={folder.id}>{'\u00A0'.repeat(optionDepth * 2)}{folder.name}</option>)}</select><ChevronDown size={13}/></span></label><div className="saved-session-actions"><button disabled={renameDisabled} onClick={onRenameStart} aria-label={`Rename ${item.name}`} title="Rename session"><Pencil size={13}/></button><button onClick={onDelete} aria-label={`Delete ${item.name}`} title="Delete session"><Trash2 size={13}/></button></div><button className="button secondary restore-session" disabled={disabled} onClick={onRestore}><RefreshCw size={14}/>Restore</button></>}</div>;
}

function Timeline({ tabs, allTabs, session, now, time, onTimeChange, selectedId, onSelect, onFocus, thumbnails, connections, zoom }: { tabs: BrowserTab[]; allTabs: BrowserTab[]; session: Session; now: number; time: number; onTimeChange: (time: number) => void; selectedId: string | null; onSelect: (id: string) => void; onFocus: (id: string) => void; thumbnails: boolean; connections: boolean; zoom: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return <TimelineCanvas groups={groupTabsByDesktop(tabs)} allTabs={allTabs} session={session} now={now} time={time} onTimeChange={onTimeChange} selectedId={selectedId} onSelect={onSelect} onFocus={onFocus} thumbnails={thumbnails} connections={connections} zoom={zoom} collapsed={collapsed} onToggle={toggle}/>;
}

function TimelineCanvas({ groups, allTabs, session, now, time, onTimeChange, selectedId, onSelect, onFocus, thumbnails, connections, zoom, collapsed, onToggle }: { groups: DesktopTabGroup[]; allTabs: BrowserTab[]; session: Session; now: number; time: number; onTimeChange: (time: number) => void; selectedId: string | null; onSelect: (id: string) => void; onFocus: (id: string) => void; thumbnails: boolean; connections: boolean; zoom: number; collapsed: Set<string>; onToggle: (key: string) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [draggingTime, setDraggingTime] = useState(false);
  const [containerWidth, setContainerWidth] = useState(700);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);
  const width = Math.max(containerWidth, 540) * zoom;
  const padding = 42;
  const plotWidth = width - padding - 30;
  const span = Math.max(60000, now - session.startedAt) * 1.075;
  const x = (time: number) => padding + Math.max(0, (time - session.startedAt) / span) * plotWidth;
  const nowX = x(time);
  const setTimeFromPointer = (event: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const position = Math.max(padding, Math.min(width - 30, event.clientX - bounds.left));
    const end = session.endedAt || now;
    onTimeChange(Math.round(Math.max(session.startedAt, Math.min(end, session.startedAt + ((position - padding) / plotWidth) * span))));
  };
  const startTimeDrag = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingTime(true);
    setTimeFromPointer(event);
  };
  const moveTimeDrag = (event: React.PointerEvent) => { if (draggingTime) setTimeFromPointer(event); };
  const endTimeDrag = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingTime(false);
  };
  const rowHeight = 60;
  const headerHeight = 35;
  const headingHeight = 34;

  const sections = groups.map((group) => ({ ...group, isCollapsed: collapsed.has(group.key), windows: group.windows.map((window) => ({ ...window, isCollapsed: collapsed.has(window.key) })) }));
  let cursor = headerHeight;
  const rowY = new Map<string, number>();
  const visibleTabs: BrowserTab[] = [];
  for (const section of sections) {
    cursor += headingHeight;
    if (!section.isCollapsed) {
      for (const window of section.windows) {
        cursor += headingHeight;
        if (!window.isCollapsed) {
          for (const tab of window.tabs) {
            rowY.set(tab.id, cursor + rowHeight / 2);
            visibleTabs.push(tab);
            cursor += rowHeight;
          }
        }
      }
    }
  }
  const contentHeight = Math.max(460, cursor + 34);

  const renderTab = (tab: BrowserTab) => {
    const left = x(tab.openedAt);
    const barWidth = Math.max(8, x(tab.closedAt || now) - left);
    const showImage = thumbnails && barWidth > 160;
    const number = allTabs.findIndex((item) => item.id === tab.id) + 1;
    return <div className={`timeline-row ${selectedId === tab.id ? 'selected' : ''}`} key={tab.id} style={{ height: rowHeight }}>
      <span className="row-number">{String(number).padStart(2, '0')}</span>
      <button title={`${tab.title}\n${tab.originalUrl || tab.url}\nOpened ${clock(tab.openedAt)}${tab.closedAt ? ` · Closed ${clock(tab.closedAt)}` : ' · Still open'}${tab.frozen ? '\nFrozen snapshot' : ''}${tab.groupTitle ? `\nGroup: ${tab.groupTitle}` : ''}`} aria-label={`View ${tab.title}`} className={`tab-bar ${siteColor(tab)} ${tab.closedAt ? 'is-closed' : ''} ${tab.frozen ? 'is-frozen' : ''} ${selectedId === tab.id ? 'is-selected' : ''} ${barWidth < 120 ? 'compact' : ''}`} style={{ left, width: barWidth }} onClick={() => onSelect(tab.id)} onDoubleClick={() => { if (!tab.closedAt) onFocus(tab.id); }}>
        {showImage && <span className="bar-thumbnail">{tab.thumbnail ? <img src={tab.thumbnail} alt={`Thumbnail of ${tab.title}`}/> : <Globe2 size={23}/>}</span>}
        <span className="bar-content"><span className="bar-title"><SiteIcon tab={tab} size="small"/><strong>{tab.title}</strong>{tab.frozen && <span className="group-chip frozen-chip">FROZEN</span>}{tab.groupTitle && <span className="group-chip" style={{ '--group-color': tab.groupColor || '#9ca8bb' } as React.CSSProperties}>{tab.groupTitle}</span>}{tab.closedAt && barWidth > 200 && <X size={11}/>}</span><span className="bar-subtitle">{domain(tab.originalUrl || tab.url)}<span>·</span>{duration((tab.closedAt || now) - tab.openedAt)}</span></span>
        {!tab.closedAt && <span className="bar-end-dot"/>}
      </button>
      {barWidth < 120 && <button className="overflow-tab-label" style={{ left: Math.min(left + barWidth + 7, width - 115) }} onClick={() => onSelect(tab.id)} onDoubleClick={() => { if (!tab.closedAt) onFocus(tab.id); }}>{siteName(tab)}</button>}
    </div>;
  };

  return <div className="timeline-scroll" ref={viewportRef}><div className="timeline-canvas" ref={canvasRef} style={{ width, minHeight: contentHeight }}>
    <div className="axis-header"><span className="axis-start">TIME</span>{Array.from({ length: 6 }, (_, i) => <span key={i} style={{ left: padding + i * plotWidth / 5 }}>{clock(session.startedAt + span * i / 5)}</span>)}</div>
    <div className="grid-lines">{Array.from({ length: 6 }, (_, i) => <i key={i} style={{ left: padding + i * plotWidth / 5 }}/>)}</div>
    <div className={`now-line ${draggingTime ? 'dragging' : ''}`} style={{ left: nowX }} role="slider" aria-label="Timeline position" aria-valuemin={session.startedAt} aria-valuemax={session.endedAt || now} aria-valuenow={time} tabIndex={0} onPointerDown={startTimeDrag} onPointerMove={moveTimeDrag} onPointerUp={endTimeDrag} onPointerCancel={endTimeDrag} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const step = Math.max(1000, Math.round(span / 100)); onTimeChange(Math.max(session.startedAt, Math.min(session.endedAt || now, time + (event.key === 'ArrowRight' ? step : -step)))); } }}><span>{clock(time)}</span><i/></div>
    {connections && <svg className="connections" width={width} height={contentHeight} aria-label="Tab opener connections"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#b09a7b" strokeWidth="1.2"/></marker><marker id="arrow-selected" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#d49b58" strokeWidth="1.2"/></marker></defs>{visibleTabs.map((tab) => {
      const openerId = tab.openerId;
      if (!openerId) return null;
      const parentY = rowY.get(openerId);
      if (parentY === undefined) return null;
      const parent = allTabs.find((item) => item.id === openerId);
      if (!parent) return null;
      const targetY = rowY.get(tab.id)!;
      const targetX = x(tab.openedAt);
      const sourceX = Math.max(x(parent.openedAt) + 9, targetX - 18);
      const sourceY = parentY + (parentY < targetY ? 24 : -24);
      const bend = parentY < targetY ? 9 : -9;
      const active = tab.id === selectedId || tab.openerId === selectedId;
      return <path key={tab.id} d={`M ${sourceX} ${sourceY} L ${sourceX} ${targetY - bend} Q ${sourceX} ${targetY} ${sourceX + 9} ${targetY} L ${targetX - 3} ${targetY}`} stroke={active ? '#d49b58' : '#b7aa98'} strokeWidth={active ? 1.6 : 1.2} opacity={active ? 1 : 0.65} fill="none" markerEnd={`url(#${active ? 'arrow-selected' : 'arrow'})`}/>;
    })}</svg>}
    <div className="timeline-rows">{sections.map((section) => <Fragment key={section.key}>
      <button type="button" className={`timeline-separator desktop-separator ${section.isCollapsed ? 'collapsed' : ''}`} onClick={() => onToggle(section.key)} aria-expanded={!section.isCollapsed}><span className="group-mark"><Monitor size={13}/></span><strong>{desktopLabel(section.desktop)}</strong><span className="group-count">{section.tabs.length} {section.tabs.length === 1 ? 'tab' : 'tabs'}</span><span className="separator-chevron">{section.isCollapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</span></button>
      {!section.isCollapsed && section.windows.map((window) => <Fragment key={window.key}>
        <button type="button" className={`timeline-separator timeline-window-separator ${window.isCollapsed ? 'collapsed' : ''}`} onClick={() => onToggle(window.key)} aria-expanded={!window.isCollapsed}><span className="group-mark"><Monitor size={12}/></span><strong>Window {locationLabel(window.window, 'unknown')}</strong><span className="group-count">{window.tabs.length} {window.tabs.length === 1 ? 'tab' : 'tabs'}</span><span className="separator-chevron">{window.isCollapsed ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</span></button>
        {!window.isCollapsed && window.tabs.map(renderTab)}
      </Fragment>)}
    </Fragment>)}</div>
    <div className="timeline-start-note" style={{ left: padding }}><span/>The start of something</div>
  </div></div>;
}

function TabDetail({ tab, session, now, onClose, onSelect, isLive, onFocus, onCapture, onFreeze, onUnfreeze, onCloseTab }: { tab: BrowserTab; session: Session; now: number; onClose: () => void; onSelect: (id: string) => void; isLive: boolean; onFocus: () => void; onCapture: () => void; onFreeze: () => void; onUnfreeze: () => void; onCloseTab: () => void }) {
  const [busy, setBusy] = useState(false);
  const opener = session.tabs.find((item) => item.id === tab.openerId);
  const children = session.tabs.filter((item) => item.openerId === tab.id);
  const index = session.tabs.indexOf(tab);
  return <aside className="tab-detail"><div className="detail-heading"><span>TAB DETAILS</span><div><button className="icon-button" aria-label="Previous tab" disabled={index === 0} onClick={() => onSelect(session.tabs[index - 1].id)}><ChevronLeft size={15}/></button><button className="icon-button" aria-label="Next tab" disabled={index === session.tabs.length - 1} onClick={() => onSelect(session.tabs[index + 1].id)}><ChevronRight size={15}/></button><button className="icon-button" aria-label="Close tab details" onClick={onClose}><X size={16}/></button></div></div><div className="detail-body">
     <div className="detail-preview">{tab.thumbnail ? <img src={tab.thumbnail} alt={`Preview of ${tab.title}`}/> : <div className="no-preview"><Globe2 size={32}/><span>{tab.closedAt ? 'No preview captured' : 'Waiting for a preview'}</span></div>}<span className="preview-badge"><span className={`tiny-dot ${tab.closedAt ? 'gray' : 'green'}`}/>{tab.closedAt ? 'Last snapshot' : tab.frozen ? 'Frozen snapshot' : 'Latest snapshot'}</span>{isLive && !tab.closedAt && !tab.frozen && <button disabled={busy} aria-label="Refresh thumbnail" title="Refresh thumbnail" onClick={async () => { setBusy(true); try { await onCapture(); } finally { setBusy(false); } }}><RefreshCw size={13} className={busy ? 'spinning' : ''}/></button>}</div>
     <div className="detail-tab-title"><SiteIcon tab={tab}/><div><h3>{tab.title}</h3>{tab.frozen && <span className="detail-group frozen-detail"><span/> Frozen snapshot</span>}{tab.groupTitle && <span className="detail-group" style={{ '--group-color': tab.groupColor || '#9ca8bb' } as React.CSSProperties}><span/> {tab.groupTitle}</span>}</div></div><div className="detail-url" title={tab.originalUrl || tab.url}>{(tab.originalUrl || tab.url).replace(/^https?:\/\//, '')}</div><span className={`status-label ${tab.closedAt ? 'closed' : tab.frozen ? 'frozen' : 'open'}`}><span className="tiny-dot"/>{tab.closedAt ? 'Closed tab' : tab.frozen ? 'Frozen snapshot' : 'Currently open'}</span>
    <div className="detail-metadata"><div><span>Opened at</span><strong>{clock(tab.openedAt)}<span className="seconds">:{String(new Date(tab.openedAt).getSeconds()).padStart(2, '0')}</span></strong></div><div><span>Time {tab.closedAt ? 'open' : 'so far'}</span><strong>{duration((tab.closedAt || now) - tab.openedAt)}</strong></div>{tab.closedAt && <div><span>Closed at</span><strong>{clock(tab.closedAt)}</strong></div>}</div>
    <div className="detail-section"><div className="detail-section-label"><GitBranch size={14}/><span>THE CONNECTION</span></div>{opener ? <><p>Opened from</p><button className="related-tab" onClick={() => onSelect(opener.id)}><SiteIcon tab={opener} size="small"/><span>{opener.title}</span><ArrowUpRight size={13}/></button></> : <p className="root-note">A fresh thread. No parent tab was reported.</p>}{children.length > 0 && <><p>Led to {children.length} {children.length === 1 ? 'new tab' : 'new tabs'}</p>{children.map((child) => <button className="related-tab" key={child.id} onClick={() => onSelect(child.id)}><SiteIcon tab={child} size="small"/><span>{child.title}</span><ArrowDownToLine size={12}/></button>)}</>}</div>
    <div className="detail-section navigation-section"><div className="detail-section-label"><Clock3 size={14}/><span>PAGE HISTORY</span><span className="count-pill">{tab.navigations.length}</span></div>{tab.navigations.slice(-4).reverse().map((nav, i) => <div className="navigation-item" key={`${nav.at}-${i}`}><span className="navigation-dot"/><div><strong title={nav.url}>{nav.title || domain(nav.url)}</strong><span>{clock(nav.at)}</span></div></div>)}{tab.navigations.length > 4 && <span className="history-more">+ {tab.navigations.length - 4} earlier pages in the export</span>}</div>
    {tab.groupHistory.length > 1 && <div className="detail-section navigation-section"><div className="detail-section-label"><Layers3 size={14}/><span>GROUP HISTORY</span><span className="count-pill">{tab.groupHistory.length - 1}</span></div>{tab.groupHistory.slice(1).reverse().map((group, i) => <div className="navigation-item" key={`${group.at}-${i}`}><span className="navigation-dot"/><div><strong>{group.title || 'Removed from tab group'}</strong><span>{clock(group.at)} · group membership event</span></div></div>)}</div>}
    {tab.windowHistory.length > 1 && <div className="detail-section navigation-section"><div className="detail-section-label"><Monitor size={14}/><span>WINDOW MOVEMENT</span><span className="count-pill">{tab.windowHistory.length - 1}</span></div>{tab.windowHistory.slice(1).reverse().map((move, i) => <div className="navigation-item" key={`${move.at}-${i}`}><span className="navigation-dot"/><div><strong>Moved to window {move.windowId}</strong><span>{clock(move.at)} · captured independently of page activity</span></div></div>)}</div>}
      {isLive && !tab.closedAt ? <div className="detail-actions"><button className="button secondary full-width" onClick={onFocus}>Go to tab<ExternalLink size={14}/></button>{tab.frozen ? <button className="button secondary full-width" onClick={onUnfreeze}><RefreshCw size={14}/>Return to original page</button> : <button className="button secondary full-width" onClick={onFreeze}><Snowflake size={14}/>Freeze tab</button>}<button className="text-button close-tab-button" onClick={onCloseTab}><X size={13}/>Close browser tab</button></div> : <div className="detail-footnote"><ShieldCheck size={12}/>{session.id === 'demo' ? 'A little preview of what\'s possible.' : 'This moment is saved on your device.'}</div>}
  </div></aside>;
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: React.ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const element = dialogRef.current;
    const focusable = () => Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') || []);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    element?.addEventListener('keydown', trap);
    return () => { element?.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialogRef}><div className="modal-top"><span className="modal-logo"><Layers3 size={23}/></span><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div><h2 id="modal-title">{title}</h2><p className="modal-subtitle">{subtitle}</p>{children}</div></div>;
}

function LaunchDialog({ onClose, onLaunch, onDemo, running }: { onClose: () => void; onLaunch: (options: { browser: 'helium' | 'chrome'; executable?: string; url: string; name: string }) => Promise<void>; onDemo: () => void; running: boolean }) {
  const preferences = useRef<LaunchPreferences | null>(null);
  if (!preferences.current) preferences.current = readLaunchPreferences();
  const [browsers, setBrowsers] = useState<BrowserChoice[]>([]);
  const [browser, setBrowser] = useState<'helium' | 'chrome'>(preferences.current.browser || 'helium');
  const [executable, setExecutable] = useState(preferences.current.executable || '');
  const [name, setName] = useState('A new rabbit hole');
  const [url, setUrl] = useState('https://www.google.com');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { api?.getBrowsers().then((items) => { setBrowsers(items); const saved = preferences.current; const savedUsable = !!saved?.executable || !!items.find((item) => item.id === saved?.browser)?.path; if (!savedUsable) setBrowser(items.find((item) => item.id === 'helium')?.path ? 'helium' : 'chrome'); }).catch((err) => setError(err.message)); }, []);
  return <Modal title="Where will curiosity take you?" subtitle="Start a fresh browser session. We’ll connect the dots." onClose={busy ? () => {} : onClose}>
    {!api ? <div className="desktop-notice"><Monitor size={19}/><div><strong>You’re in the web preview.</strong><p>Browser launching is available in the Electron desktop app. Run <code>npm run dev</code> from this project to connect a local browser.</p></div></div> : running ? <div className="desktop-notice"><Radio size={19}/><div><strong>A session is already running.</strong><p>End your current session before starting a new one.</p></div></div> : null}
    <form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { writeLaunchPreferences({ browser, executable }); await onLaunch({ browser, executable: executable || undefined, url, name }); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to launch the browser.'); } finally { setBusy(false); } }}>
      <label className="field-label">YOUR BROWSER</label><div className="browser-options">{(['helium', 'chrome'] as const).map((item) => <button type="button" key={item} className={`browser-option ${browser === item ? 'selected' : ''}`} onClick={() => { setBrowser(item); setExecutable(''); }}><span className={`browser-logo ${item}`}>{item === 'helium' ? <span>He</span> : <Globe2 size={24}/>}</span><span><strong>{item === 'helium' ? 'Helium' : 'Google Chrome'}</strong><small>{api ? browsers.find((b) => b.id === item)?.path ? 'Detected on your device' : 'Choose an executable' : 'Chromium-powered'}</small></span><span className="radio-circle">{browser === item && <span/>}</span></button>)}</div>
      <label className="field-label" htmlFor="session-name">SESSION NAME</label><input id="session-name" className="form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="A new rabbit hole" maxLength={80}/>
      <label className="field-label" htmlFor="start-url">STARTING PAGE</label><input id="start-url" className="form-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.google.com"/>
      <button type="button" className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><Settings2 size={14}/>Browser executable <ChevronDown size={13} className={advanced ? 'rotate' : ''}/></button>
      {advanced && <div className="executable-field"><input className="form-input" aria-label="Browser executable path" value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder={browsers.find((item) => item.id === browser)?.path || 'Full path to browser executable'}/><button type="button" className="button secondary" disabled={!api} onClick={async () => { try { const result = await api!.chooseExecutable(); if (result) setExecutable(result); } catch (err) { setError(String(err)); } }}><FolderOpen size={16}/>Browse</button></div>}
      <div className="profile-note"><ShieldCheck size={15}/><span>A dedicated browser profile. A localhost-only connection.<br/>Your usual browser stays right where it is.</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button type="submit" className="button primary full-width launch-submit" disabled={!api || running || busy}>{busy ? <RefreshCw size={16} className="spinning"/> : <ArrowUpRight size={17}/>} {busy ? 'Connecting your browser…' : `Launch ${browser === 'helium' ? 'Helium' : 'Chrome'}`}</button>
      {!running && <button type="button" className="text-button demo-link" onClick={onDemo}>Just looking? Explore a demo <ArrowRight size={14}/></button>}
    </form>
  </Modal>;
}
