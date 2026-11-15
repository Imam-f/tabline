const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildMirrorPlan } = require('../electron/remote-mirror.cjs');
const { BrowserController } = require('../electron/browser.cjs');
const { PassThrough } = require('node:stream');
const { loadCompanion } = require('../electron/extension-loader.cjs');
const { MirrorRoom } = require('../electron/mirror-room.cjs');

test('extension loading uses the pipe and handles fragmented protocol responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let command = '';
  input.on('data', (chunk) => { command += chunk; });
  const result = loadCompanion({ stdio: [null, null, null, input, output] }, 'test-extension');
  assert.equal(JSON.parse(command.slice(0, -1)).method, 'Extensions.loadUnpacked');
  output.write('{"id":1,"result":');
  output.write('{"id":"companion"}}\0');
  assert.deepEqual(await result, { id: 'companion' });
  assert.equal(output.listenerCount('data'), 0);
});

test('extension loading reports browser rejection and missing responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rejected = loadCompanion({ stdio: [null, null, null, input, output] }, 'test-extension');
  output.write('{"id":1,"error":{"message":"Extension blocked"}}\0');
  await assert.rejects(rejected, /Extension blocked/);
  await assert.rejects(loadCompanion({ stdio: [null, null, null, input, output] }, 'test-extension', 5), /did not load/);
});

test('managed mirror workers are not interrupted by startup debugger attachment', () => {
  const controller = Object.create(BrowserController.prototype);
  controller.session = { tabs: [] };
  controller.mirrorCompanionManaged = true;
  controller.configureCompanion = () => { throw new Error('must not attach during mirror worker startup'); };
  controller.onTarget({ type: 'service_worker', targetId: 'worker', url: 'chrome-extension://companion/background.js' });
});

test('mirror launch waits for acknowledgement and reports failure instead of succeeding blank', async () => {
  const controller = Object.create(BrowserController.prototype);
  controller.status = 'live';
  await assert.rejects(controller.waitForMirror(1), /could not connect/);
  controller.lastMirrorAppliedAt = Date.now();
  await controller.waitForMirror();
});

test('mirror plans retain windows, active tabs and desktop positions without copying machine IDs', () => {
  const plan = buildMirrorPlan({ id: 'remote', tabs: [
    { id: 'a', url: 'https://example.com', extensionWindowId: 1, desktopId: 'foreign-guid', desktopIndex: 2, active: true, focused: true, tabIndex: 1 },
    { id: 'b', url: 'chrome://newtab/', extensionWindowId: 1, tabIndex: 0 },
    { id: 'closed', url: 'https://closed.example', closedAt: 123 },
    { id: 'c', url: 'https://other.example', extensionWindowId: 2 },
  ] });
  assert.equal(plan.windows.length, 2);
  assert.equal(plan.windows[0].desktopIndex, 2);
  assert.equal(plan.windows[1].desktopIndex, null);
  assert.equal(plan.windows[0].focused, true);
  assert.deepEqual(plan.windows[0].tabs.map((tab) => tab.sourceId), ['b', 'a']);
  assert.equal(plan.windows[0].tabs[0].url, 'about:blank');
  assert.equal(plan.windows[0].tabs[1].active, true);
  assert.equal(buildMirrorPlan({ id: 'empty', tabs: [] }).windows.length, 0);
});

test('mirror moves only its mapped window by desktop number, never by a remote GUID', async () => {
  const moves = [];
  const controller = Object.create(BrowserController.prototype);
  Object.assign(controller, {
    status: 'live', process: { pid: 123 },
    session: { tabs: [{ id: 'local-tab', extensionWindowId: 7, windowId: 'local-window', windowBounds: { left: 0, top: 0 }, desktopIndex: 0 }] },
    mirrorPlan: { windows: [{ sourceWindowId: 'source-window', desktopId: 'foreign-guid', desktopIndex: 2 }] },
    refreshTargetLocation: async () => {}, publish() {},
    desktopIndexMover: async (...args) => { moves.push(args); return true; },
  });
  await controller.applyMirrorDesktops({ windows: [{ sourceWindowId: 'source-window', extensionWindowId: 7 }] });
  assert.equal(moves.length, 1);
  assert.equal(moves[0][0], 'local-window');
  assert.equal(moves[0][3], 2);
  controller.session.tabs[0].desktopIndex = 2;
  await controller.applyMirrorDesktops({ windows: [{ sourceWindowId: 'source-window', extensionWindowId: 7 }] });
  assert.equal(moves.length, 1, 'already placed windows must not move again');
  controller.mirrorPlan = null;
  await controller.applyMirrorDesktops({ windows: [{ sourceWindowId: 'source-window', extensionWindowId: 7 }] });
  assert.equal(moves.length, 1, 'paused mirrors must not act on stale mappings');
});

test('mirror reconciles navigation, tab moves, active tabs and removals across polling and worker restart', async () => {
  let nextId = 10;
  let plan;
  let saved = {};
  let focusCount = 0;
  const windows = new Set([1]);
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'about:blank', index: 0 }]]);
  const callback = (fn) => (...args) => { const cb = args.pop(); cb(fn(...args)); };
  const chrome = {
    runtime: {}, storage: { session: { get: async () => structuredClone(saved), set: async (value) => { saved = structuredClone(value); } } },
    tabs: {
      create: callback((options) => { const tab = { ...options, id: nextId++, index: 0 }; tabs.set(tab.id, tab); return tab; }),
      update: callback((id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); }),
      move: callback((id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); }),
      remove: callback((ids) => { for (const id of ids) tabs.delete(id); }),
    },
    windows: {
      create: callback(() => { const id = nextId++; windows.add(id); return { id }; }),
      update: callback(() => { focusCount++; }),
    },
  };
  const source = fs.readFileSync(require.resolve('../electron/tabline-extension/background.js'), 'utf8');
  const createWorker = () => {
    const context = vm.createContext({ chrome, URL, crypto: require('node:crypto').webcrypto, bridgeOrigin: 'http://localhost', restoring: false,
      queryTabs: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      queryWindows: async () => [...windows].map((id) => ({ id })), sendSnapshot: async () => {},
      fetch: async (url) => ({ status: url.endsWith('/mirror') ? 200 : 204, json: async () => plan }),
    });
    vm.runInContext(source.slice(source.indexOf('function callChrome('), source.indexOf('async function executeRestore(')) + source.slice(source.indexOf('let mirroring = false;'), source.indexOf('chrome.tabs.onCreated')), context);
    return () => vm.runInContext('checkMirror()', context);
  };
  let poll = createWorker();
  plan = { sourceSessionId: 'remote', windows: [{ sourceWindowId: 'w1', focused: true, tabs: [{ sourceId: 'a', url: 'https://a.example', active: true, pinned: false }] }] };
  await poll();
  const aId = saved.mirror.tabs.a;
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get(aId).active, true);
  await poll();
  assert.equal(focusCount, 1, 'unchanged polling must not steal focus repeatedly');
  poll = createWorker();
  plan.windows.push({ sourceWindowId: 'w2', tabs: [{ sourceId: 'b', url: 'https://b.example', active: true }] });
  await poll();
  assert.equal(saved.mirror.tabs.a, aId);
  const bId = saved.mirror.tabs.b;
  plan.windows = [{ sourceWindowId: 'w2', tabs: [{ sourceId: 'a', url: 'https://changed.example', active: true, pinned: true }] }];
  await poll();
  assert.equal(tabs.has(bId), false);
  assert.equal(tabs.get(aId).windowId, saved.mirror.windows.w2);
  assert.equal(tabs.get(aId).url, 'https://changed.example');
  assert.equal(tabs.get(aId).pinned, true);
});

test('two-way mirroring retains user edits made while a remote layout is being applied', async () => {
  const room = new MirrorRoom({ sourceSessionId: 'source', windows: [{ sourceWindowId: 'w', tabs: [{ sourceId: 'a', url: 'https://a.example/', index: 0, pinned: false, active: true }] }] });
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'about:blank', index: 0 }]]);
  let saved = {};
  let nextId = 10;
  let cycles = 0;
  let updates = 0;
  const callback = (fn) => (...args) => { const done = args.pop(); done(fn(...args)); };
  const chrome = {
    runtime: {}, storage: { session: { get: async () => structuredClone(saved), set: async (value) => { saved = structuredClone(value); } } },
    tabs: {
      create: callback((options) => { const tab = { ...options, id: nextId++, index: tabs.size }; tabs.set(tab.id, tab); return tab; }),
      update: callback((id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); }),
      move: callback((id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); }),
      remove: callback((ids) => { for (const id of ids) tabs.delete(id); }),
    }, windows: { update: callback(() => {}) },
  };
  const source = fs.readFileSync(require.resolve('../electron/tabline-extension/background.js'), 'utf8');
  const context = vm.createContext({ chrome, URL, crypto: require('node:crypto').webcrypto, bridgeOrigin: 'http://localhost', restoring: false,
    queryTabs: async () => [...tabs.values()].map((tab) => ({ ...tab })),
    queryWindows: async () => [{ id: 1, focused: true }],
    sendSnapshot: async () => {
      // These actions happen after reconciliation but before its acknowledgement.
      cycles++;
      if (cycles === 1) {
        const a = [...tabs.values()][0];
        a.url = 'https://user-navigation.example/';
        tabs.set(100, { id: 100, windowId: 1, url: 'https://user-tab.example/', index: 1, active: false });
      }
      if (cycles === 2) tabs.delete(saved.mirror.tabs.a);
    },
    fetch: async (url, options) => {
      if (url.endsWith('/mirror-sync')) {
        const { base, observed } = JSON.parse(options.body);
        const result = room.sync(base, observed);
        if (updates++ === 0) tabs.get(100).url = 'https://during-network.example/';
        return { ok: true, json: async () => result };
      }
      return { status: 200, json: async () => url.endsWith('/mirror-result') ? { desktops: {} } : room.snapshot() };
    },
  });
  vm.runInContext(source.slice(source.indexOf('function callChrome('), source.indexOf('async function executeRestore(')) + source.slice(source.indexOf('let mirroring = false;'), source.indexOf('chrome.tabs.onCreated')), context);
  await vm.runInContext('checkMirror()', context);
  await vm.runInContext('checkMirror()', context);
  assert.equal(room.snapshot().windows[0].tabs.length, 2, 'new tabs created during apply must reach the source');
  assert.equal(room.snapshot().windows[0].tabs.find((tab) => tab.sourceId === 'a').url, 'https://user-navigation.example/');
  await vm.runInContext('checkMirror()', context);
  assert.equal(room.snapshot().windows[0].tabs.length, 1, 'closing during apply must not resurrect the tab');
  assert.equal(room.snapshot().windows[0].tabs[0].url, 'https://during-network.example/', 'edits during a network round trip must also reach the source');
});
