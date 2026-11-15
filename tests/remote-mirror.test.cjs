const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildMirrorPlan } = require('../electron/remote-mirror.cjs');
const { BrowserController } = require('../electron/browser.cjs');

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
    const context = vm.createContext({ chrome, bridgeOrigin: 'http://localhost', restoring: false,
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
