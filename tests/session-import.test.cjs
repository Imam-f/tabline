const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserController, upsertTarget, buildRestorePlan } = require('../electron/browser.cjs');
const { normalizeImportedSession, readSessionImport } = require('../electron/session-import.cjs');

function fixture() {
  const session = { id: 'demo', name: 'Imported trail', browser: 'chrome', startedAt: 100, endedAt: null, savedAt: 600, tabs: [] };
  const parent = upsertTarget(session, { type: 'page', targetId: 'parent', url: 'https://example.com', title: 'Parent' }, 100);
  const child = upsertTarget(session, { type: 'page', targetId: 'child', openerId: 'parent', url: 'https://example.com/child', title: 'Child' }, 200);
  parent.closedAt = 400;
  parent.openAtEnd = false;
  child.thumbnail = 'data:image/jpeg;base64,aGVsbG8=';
  child.thumbnailAt = 500;
  child.windowId = '1';
  child.groupId = 3;
  child.groupTitle = 'Research';
  child.groupColor = 'blue';
  child.tabIndex = 1;
  child.windowHistory = [{ windowId: '1', desktopId: 'desktop', at: 200 }];
  child.groupHistory = [{ groupId: 3, title: 'Research', color: 'blue', at: 300 }];
  session.activityHistory = [{ at: 450, focusedWindowId: '1', windows: [{ windowId: '1', tabId: 'child' }] }];
  session.browserDataDir = '../../local-profile';
  session.profileSourceSessionId = 'local-profile';
  session.restoredFromSessionId = 'local-profile';
  session.folderId = 'local-folder';
  session.order = 0;
  return session;
}

test('imports persist independent copies and preserve timeline, thumbnails, groups, and restore selection', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller = new BrowserController(dir);
  const source = fixture();
  const first = controller.importSession(source);
  const second = controller.importSession(source);
  assert.notEqual(first.id, source.id);
  assert.notEqual(first.id, second.id);
  assert.equal(controller.listSessions().length, 2);
  assert.deepEqual(controller.loadSession(first.id), first);
  assert.equal(first.endedAt, 600);
  assert.equal(first.tabs[1].closedAt, 600);
  assert.equal(source.tabs[1].closedAt, null, 'import must not mutate the source');
  assert.equal(first.tabs[0].openAtEnd, false);
  assert.equal(first.tabs[1].openAtEnd, true);
  for (const key of ['navigations', 'windowHistory', 'groupHistory', 'thumbnail', 'groupId', 'groupTitle', 'tabIndex']) assert.deepEqual(first.tabs[1][key], source.tabs[1][key]);
  assert.deepEqual(first.activityHistory, source.activityHistory);
  assert.equal(first.tabs[1].openerId, 'parent');
  for (const key of ['browserDataDir', 'profileSourceSessionId', 'restoredFromSessionId', 'folderId', 'order']) assert.equal(Object.hasOwn(first, key), false);
  assert.deepEqual(buildRestorePlan(first).windows[0].tabs.map((tab) => tab.sourceId), ['child']);
  assert.deepEqual(buildRestorePlan(first, 250).windows.flatMap((window) => window.tabs.map((tab) => tab.sourceId)).sort(), ['child', 'parent']);
});

test('older exports receive defaults and ended sessions keep their end time', () => {
  const source = { name: 'Old session', browser: 'helium', startedAt: 100, endedAt: 300, savedAt: 900, tabs: [{ id: 'a', title: 'Page', url: 'https://example.com', openedAt: 100, closedAt: 300 }] };
  const imported = normalizeImportedSession(source);
  assert.equal(imported.endedAt, 300);
  assert.equal(imported.tabs[0].openAtEnd, true);
  assert.deepEqual(imported.tabs[0].navigations, []);
  assert.deepEqual(imported.tabs[0].windowHistory, []);
  assert.equal(imported.tabs[0].desktopId, 'unknown');
  assert.equal(buildRestorePlan(imported).requested, 1);
});

test('malformed sessions fail before any session is saved', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-invalid-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller = new BrowserController(dir);
  const invalid = [null, [], {}, { ...fixture(), browser: 'firefox' }, { ...fixture(), startedAt: Infinity }, { ...fixture(), endedAt: 50 }, { ...fixture(), tabs: {} }];
  for (const change of [
    (session) => { session.tabs.push(session.tabs[0]); },
    (session) => { session.tabs[0].openedAt = -1; },
    (session) => { session.tabs[0].navigations = {}; },
    (session) => { session.tabs[0].groupHistory[0] = { at: 'later' }; },
    (session) => { session.tabs[0].thumbnail = 'https://example.com/tracker'; },
    (session) => { session.activityHistory[0].windows = [null]; },
  ]) { const source = fixture(); change(source); invalid.push(source); }
  for (const source of invalid) assert.throws(() => controller.importSession(source), /Invalid session data/);
  assert.deepEqual(controller.listSessions(), []);
});

test('file import reads JSON and BOM exports, rejects invalid, oversized, and non-file inputs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-file-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(fixture()));
  assert.deepEqual(await readSessionImport(file), fixture());
  fs.writeFileSync(file, '{broken');
  await assert.rejects(readSessionImport(file), /not valid JSON/);
  const descriptor = fs.openSync(file, 'w');
  fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
  await assert.rejects(readSessionImport(file), /smaller than 64 MB/);
  await assert.rejects(readSessionImport(dir));
});
