const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { CDP } = require('../electron/cdp.cjs');
const { upsertTarget, validStartUrl, browserCandidates, buildRestorePlan } = require('../electron/browser.cjs');
const { BrowserController } = require('../electron/browser.cjs');

test('tracks one lifetime per page, preserves opener and records actual navigations', () => {
  const session = { tabs: [] };
  assert.equal(upsertTarget(session, { type: 'service_worker', targetId: 'worker' }, 10), null);
  const tab = upsertTarget(session, { type: 'page', targetId: 'child', openerId: 'parent', url: 'https://example.com', title: '' }, 100);
  upsertTarget(session, { type: 'page', targetId: 'child', url: 'https://example.com', title: 'Example' }, 110);
  assert.equal(tab.navigations.length, 1);
  assert.equal(tab.navigations[0].title, 'Example');
  assert.equal(tab.openedAt, 100);
  assert.equal(tab.openerId, 'parent');
  assert.equal(tab.desktopId, 'unknown');
  assert.equal(tab.tabIndex, null);
  assert.equal(tab.openAtEnd, true);
  assert.deepEqual(tab.windowHistory, []);
  assert.equal(tab.groupId, null);
  upsertTarget(session, { type: 'page', targetId: 'child', url: 'https://example.com/next', title: 'Next' }, 200);
  assert.equal(session.tabs.length, 1);
  assert.equal(tab.navigations.length, 2);
  assert.equal(tab.url, 'https://example.com/next');
  assert.equal(tab.navigations[1].at, 200);
});

test('only accepts ordinary web URLs or a blank starting page', () => {
  assert.equal(validStartUrl('https://example.com'), 'https://example.com/');
  assert.equal(validStartUrl('about:blank'), 'about:blank');
  assert.equal(validStartUrl(''), 'about:blank');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', '--no-sandbox', 'chrome://settings', 'example.com']) assert.throws(() => validStartUrl(value));
});

test('browser discovery includes Chrome and Helium on supported platforms', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const candidates = browserCandidates(platform);
    assert.ok(candidates.helium.length > 0);
    assert.ok(candidates.chrome.length > 0);
  }
});

test('CDP correlates out-of-order responses and rejects pending work on disconnect', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const client = new CDP(`ws://127.0.0.1:${server.address().port}`);
  let socket;
  const requests = [];
  server.on('connection', (connection) => {
    socket = connection;
    connection.on('message', (raw) => {
      const message = JSON.parse(raw);
      requests.push(message);
      if (message.method === 'second') {
        connection.send(JSON.stringify({ id: message.id, result: { value: 2 } }));
        connection.send(JSON.stringify({ id: requests[0].id, result: { value: 1 } }));
      }
      if (message.method === 'fail') connection.send(JSON.stringify({ id: message.id, error: { message: 'Target closed' } }));
      if (message.method === 'wait') connection.close();
    });
  });
  try {
    await client.connect();
    const [first, second] = await Promise.all([client.send('first'), client.send('second', {}, 'flat-session')]);
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 2 });
    assert.equal(requests[1].sessionId, 'flat-session');
    await assert.rejects(client.send('fail'), /Target closed/);
    const event = new Promise((resolve) => client.once('Target.targetCreated', resolve));
    socket.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'new' } } }));
    assert.equal((await event).targetInfo.targetId, 'new');
    await assert.rejects(client.send('wait'), /disconnected/);
    assert.equal(client.pending.size, 0);
  } finally {
    client.close();
    for (const connection of server.clients) connection.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('merges tab-group events without requiring navigation activity', () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-group-')));
  controller.session = { tabs: [{ id: 'target', groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] }] };
  controller.onGroupInfo({ targetId: 'target', groupId: 7, groupTitle: 'Research', groupColor: 'blue', groupCollapsed: false });
  assert.equal(controller.session.tabs[0].groupTitle, 'Research');
  assert.equal(controller.session.tabs[0].groupHistory.length, 1);
  controller.onGroupInfo({ targetId: 'target', groupId: 7, groupTitle: 'Research', groupColor: 'blue', groupCollapsed: false });
  assert.equal(controller.session.tabs[0].groupHistory.length, 1);
  controller.onGroupInfo({ targetId: 'target', groupId: -1 });
  assert.equal(controller.session.tabs[0].groupId, null);
  assert.equal(controller.session.tabs[0].groupHistory.length, 2);
  clearTimeout(controller.persistTimer);
});

test('passes native window bounds and browser process to the desktop resolver on Windows', async (context) => {
  if (process.platform !== 'win32') return context.skip('Windows-only resolver');
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-desktop-')));
  controller.process = { pid: 4321 };
  let received;
  controller.desktopResolver = async (...args) => { received = args; return 'desktop-guid'; };
  assert.equal(await controller.getDesktopId('9', { left: 1, top: 2, width: 3, height: 4 }), 'desktop-guid');
  assert.deepEqual(received, ['9', { left: 1, top: 2, width: 3, height: 4 }, 4321]);
});

test('builds a restore plan from tabs that were open at shutdown in strip order', () => {
  const session = { id: 'source', endedAt: 1000, tabs: [
    { id: 'closed', url: 'https://closed.example', openAtEnd: false, extensionWindowId: 1, tabIndex: 0 },
    { id: 'second', url: 'https://second.example', openAtEnd: true, extensionWindowId: 1, tabIndex: 2, pinned: false, openedAt: 20, openerId: 'first', groupId: 4 },
    { id: 'first', url: 'https://first.example', openAtEnd: true, extensionWindowId: 1, tabIndex: 1, pinned: true, active: true, openedAt: 10, openerId: null, groupId: 4 },
    { id: 'internal', url: 'chrome://settings', openAtEnd: true, extensionWindowId: 2, tabIndex: 0 },
  ] };
  const plan = buildRestorePlan(session);
  assert.equal(plan.requested, 3);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.windows.length, 1);
  assert.deepEqual(plan.windows[0].tabs.map((tab) => tab.sourceId), ['first', 'second']);
  assert.equal(plan.windows[0].tabs[1].openerSourceId, 'first');
});

test('tracks tab strip moves without duplicating unchanged order history', () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-order-')));
  controller.session = { tabs: [{ id: 'target', url: 'https://example.com', title: 'Example', tabIndex: null, extensionWindowId: null, orderHistory: [], groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] }] };
  controller.onGroupInfo({ targetId: 'target', tabId: 8, windowId: 2, index: 0, pinned: true, active: true, groupId: -1 });
  controller.onGroupInfo({ targetId: 'target', tabId: 8, windowId: 2, index: 0, pinned: true, active: true, groupId: -1 });
  controller.onGroupInfo({ targetId: 'target', tabId: 8, windowId: 2, index: 3, pinned: true, active: false, groupId: -1 });
  assert.equal(controller.session.tabs[0].tabIndex, 3);
  assert.equal(controller.session.tabs[0].pinned, true);
  assert.equal(controller.session.tabs[0].active, false);
  assert.equal(controller.session.tabs[0].orderHistory.length, 2);
  clearTimeout(controller.persistTimer);
});

test('moves correlated restored windows to their saved virtual desktops', async () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-desktop-restore-')));
  const bounds = { left: 10, top: 20, width: 800, height: 600 };
  controller.process = { pid: 123 };
  controller.session = { tabs: [{ id: 'new-target', windowId: '9', windowBounds: bounds }] };
  let received;
  controller.desktopMover = async (...args) => { received = args; return true; };
  const warnings = await controller.restoreVirtualDesktops({ windows: [{ sourceWindowId: 'old-window', desktopId: '11111111-1111-1111-1111-111111111111' }] }, [{ sourceWindowId: 'old-window', targetId: 'new-target' }]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(received, ['9', bounds, 123, '11111111-1111-1111-1111-111111111111']);
});

test('localhost group bridge applies group color metadata to the matching tab', async () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-group-bridge-')));
  controller.session = { tabs: [{ id: 'target', windowId: '42', url: 'https://example.com', title: 'Example', groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] }] };
  await controller.startGroupBridge();
  try {
    const response = await fetch('http://127.0.0.1:17637/tab-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabs: [{ targetId: 'target', windowId: 42, url: 'https://example.com', title: 'Example', groupId: 9, groupTitle: 'Research', groupColor: 'purple', groupCollapsed: false }] }) });
    assert.equal(response.status, 204);
    assert.equal(controller.session.tabs[0].groupId, 9);
    assert.equal(controller.session.tabs[0].groupTitle, 'Research');
    assert.equal(controller.session.tabs[0].groupColor, 'purple');
    assert.equal(controller.session.tabs[0].groupHistory.length, 1);
  } finally {
    controller.groupBridge.close();
    clearTimeout(controller.persistTimer);
  }
});

test('group updates catch an ungrouped tab moved into a group without a target ID', () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-group-move-')));
  controller.session = { tabs: [{ id: 'target', windowId: '42', url: 'https://example.com', title: 'Example', groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] }] };
  controller.onGroupInfo({ windowId: 42, url: 'https://example.com', title: 'Example', groupId: 12, groupTitle: 'Research', groupColor: 'cyan', groupCollapsed: false });
  assert.equal(controller.session.tabs[0].groupId, 12);
  assert.equal(controller.session.tabs[0].groupColor, 'cyan');
  assert.equal(controller.session.tabs[0].groupHistory.length, 1);
  clearTimeout(controller.persistTimer);
});

test('ambiguous group updates are ignored instead of coloring the wrong duplicate tab', () => {
  const controller = new BrowserController(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tabline-group-ambiguous-')));
  controller.session = { tabs: [
    { id: 'one', windowId: '42', url: 'https://example.com', title: 'Example', groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] },
    { id: 'two', windowId: '42', url: 'https://example.com', title: 'Example', groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [] },
  ] };
  controller.onGroupInfo({ windowId: 42, url: 'https://example.com', title: 'Example', groupId: 12, groupTitle: 'Research', groupColor: 'cyan', groupCollapsed: false });
  assert.equal(controller.session.tabs[0].groupId, null);
  assert.equal(controller.session.tabs[1].groupId, null);
  clearTimeout(controller.persistTimer);
});
