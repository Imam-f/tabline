const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const nullable = (check) => (value) => value === null || check(value);
const isString = (value) => typeof value === 'string';
const isId = (value) => isString(value) && value.length > 0;
const isInteger = Number.isInteger;
const isBoolean = (value) => typeof value === 'boolean';

function record(value, fields, required = []) {
  if (!isObject(value) || required.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid session data: missing required fields.');
  const result = {};
  for (const [key, check] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    if (!check(value[key])) throw new Error(`Invalid session data: ${key}.`);
    result[key] = value[key];
  }
  return result;
}

function history(value, fields, required) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid session data: history must be a list.');
  return value.map((entry) => record(entry, fields, required)).sort((a, b) => a.at - b.at);
}

function normalizeImportedSession(value) {
  const session = record(value, {
    name: isId, browser: (browser) => ['helium', 'chrome'].includes(browser),
    startedAt: isTime, endedAt: nullable(isTime), savedAt: isTime, tabs: Array.isArray,
  }, ['name', 'browser', 'startedAt', 'tabs']);
  session.name = session.name.trim().slice(0, 80);
  if (!session.name) throw new Error('Invalid session data: name.');
  if (session.endedAt != null && session.endedAt < session.startedAt) throw new Error('Invalid session data: session lifetime.');
  let end = Math.max(session.startedAt, session.endedAt ?? session.savedAt ?? 0);
  const noteTime = (at) => { end = Math.max(end, at || 0); };
  const ids = new Set();
  session.tabs = session.tabs.map((value) => {
    const tab = record(value, {
      id: isId, title: isString, url: isString, openedAt: isTime, closedAt: nullable(isTime),
      openAtEnd: isBoolean, openerId: nullable(isString), windowId: nullable(isString), desktopId: isString,
      extensionTabId: nullable(isInteger), extensionWindowId: nullable(isInteger), tabIndex: nullable(isInteger),
      pinned: isBoolean, active: isBoolean, focused: isBoolean, lastActiveAt: nullable(isTime),
      inactiveScreenshotAt: nullable(isTime), frozen: isBoolean, frozenSlug: nullable(isString), originalUrl: nullable(isString),
      groupId: nullable(isInteger), groupTitle: nullable(isString), groupColor: nullable(isString), groupCollapsed: isBoolean,
      thumbnail: nullable((image) => isString(image) && image.startsWith('data:image/')), thumbnailAt: nullable(isTime),
    }, ['id', 'title', 'url', 'openedAt']);
    if (ids.has(tab.id)) throw new Error('Invalid session data: duplicate tab IDs.');
    ids.add(tab.id);
    if (tab.openedAt < session.startedAt || (tab.closedAt != null && tab.closedAt < tab.openedAt)) throw new Error('Invalid session data: tab lifetime.');
    tab.closedAt ??= null;
    tab.openAtEnd ??= tab.closedAt === null || (session.endedAt != null && Math.abs(tab.closedAt - session.endedAt) < 2000);
    tab.openerId ??= null;
    tab.windowId ??= null;
    tab.desktopId ||= 'unknown';
    tab.thumbnail ??= null;
    tab.thumbnailAt ??= null;
    tab.groupId ??= null;
    tab.groupTitle ??= null;
    tab.groupColor ??= null;
    tab.groupCollapsed ??= false;
    tab.navigations = history(value.navigations, { url: isString, title: isString, at: isTime }, ['url', 'title', 'at']);
    tab.windowHistory = history(value.windowHistory, { windowId: isString, desktopId: isString, at: isTime }, ['windowId', 'desktopId', 'at']);
    tab.groupHistory = history(value.groupHistory, { groupId: nullable(isInteger), title: nullable(isString), color: nullable(isString), at: isTime }, ['groupId', 'title', 'color', 'at']);
    tab.orderHistory = history(value.orderHistory, { windowId: nullable(isInteger), index: isInteger, at: isTime }, ['windowId', 'index', 'at']);
    if (value.windowBounds != null) tab.windowBounds = record(value.windowBounds, {
      left: Number.isFinite, top: Number.isFinite, width: (n) => Number.isFinite(n) && n > 0,
      height: (n) => Number.isFinite(n) && n > 0, windowState: isString,
    }, ['left', 'top', 'width', 'height']);
    else tab.windowBounds = null;
    for (const at of [tab.openedAt, tab.closedAt, tab.thumbnailAt, tab.lastActiveAt, tab.inactiveScreenshotAt]) noteTime(at);
    for (const entry of [...tab.navigations, ...tab.windowHistory, ...tab.groupHistory, ...tab.orderHistory]) noteTime(entry.at);
    return tab;
  });
  session.activityHistory = history(value.activityHistory, { at: isTime, focusedWindowId: nullable(isString), windows: Array.isArray }, ['at', 'focusedWindowId', 'windows']).map((entry) => {
    noteTime(entry.at);
    return { ...entry, windows: entry.windows.map((window) => record(window, { windowId: isString, tabId: nullable(isString) }, ['windowId', 'tabId'])) };
  });
  session.id = randomUUID();
  session.endedAt = end;
  session.savedAt = Date.now();
  session.tabs.forEach((tab) => { tab.closedAt ??= end; });
  // Only timeline fields cross machines: profile paths, folder IDs, and restore
  // provenance belong to the source and must never select local browser data.
  return session;
}

async function readSessionImport(file) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SESSION_BYTES) throw new Error('Choose a JSON session file smaller than 64 MB.');
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > info.size) throw new Error('The session file changed while importing. Please try again.');
    try { return JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('This file is not valid JSON. Choose a Tabline session export.'); }
  } finally { await handle.close(); }
}

module.exports = { normalizeImportedSession, readSessionImport };
