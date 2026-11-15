const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { BrowserController, upsertTarget, buildRestorePlan } = require('../electron/browser.cjs');

function controller(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-sources-'));
  const c = new BrowserController(dir);
  c.session = { tabs: [], activityHistory: [] };
  t.after(() => {
    for (const timer of c.captureTimers.values()) clearTimeout(timer);
    c.groupBridge?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return c;
}
const page = (targetId, openerId) => ({ type: 'page', targetId, url: 'https://same.example', title: 'Same', openerId });
const event = { sourceTabId: 10, tabId: 20, timeStamp: 123 };

test('focus from responsive tabs is recorded before later suspended-tab batches finish', async (t) => {
  const c = controller(t);
  for (let i = 0; i < 17; i++) {
    const tab = upsertTarget(c.session, page(`tab-${i}`));
    tab.windowId = '1';
  }
  c.status = 'live';
  let release;
  const suspended = new Promise((resolve) => { release = resolve; });
  let secondBatch;
  const reachedSecondBatch = new Promise((resolve) => { secondBatch = resolve; });
  c.client = { send: async (method, params, sessionId, options) => {
    assert.equal(options.timeout, 300, 'focus commands must use a short timeout');
    if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
    if (method === 'Runtime.evaluate') {
      if (sessionId === 'tab-16') { secondBatch(); await suspended; throw new Error('Sleeping renderer'); }
      return { result: { value: { visible: sessionId === 'tab-0', focused: sessionId === 'tab-0' } } };
    }
    return {};
  } };
  const sampling = c.refreshActivityFromCdp();
  await reachedSecondBatch;
  assert.equal(c.session.tabs[0].focused, true);
  assert.ok(c.lastActivityObservedAt);
  c.onTarget(page('child'), { created: true });
  assert.equal(c.session.tabs.at(-1).openerId, 'tab-0');
  assert.equal(c.session.tabs.at(-1).openerSource, 'focused-tab');
  release();
  await sampling;
  assert.equal(c.activityBusy, false);
});

test('new tabs infer the previously focused active tab and explicit sources replace inference', (t) => {
  const c = controller(t);
  c.onTarget(page('parent'));
  c.onTarget(page('other'));
  c.session.tabs[0].windowId = '1';
  c.session.tabs[1].windowId = '2';
  c.recordActivity([{ windowId: '1', tabId: 'parent' }, { windowId: '2', tabId: 'other' }], '1');
  c.onTarget(page('child'), { created: true });
  const child = c.session.tabs.find((tab) => tab.id === 'child');
  assert.equal(child.openerId, 'parent');
  assert.equal(child.openerSource, 'focused-tab');
  c.onTarget(page('child', 'other'));
  assert.equal(child.openerId, 'other');
  assert.equal(child.openerSource, 'cdp');
  c.onTabSources({ relationships: [{ ...event, targetId: 'child', sourceTargetId: 'parent' }] });
  assert.equal(child.openerId, 'parent');
  assert.equal(child.openerSource, 'navigation');
  c.onTarget(page('child', 'other'));
  assert.equal(child.openerId, 'parent');
  assert.equal(child.openerSource, 'navigation');
});

test('partial focus samples preserve a focused tab until that tab responds', async (t) => {
  const c = controller(t);
  for (let i = 0; i < 17; i++) upsertTarget(c.session, { ...page(`tab-${i}`), windowId: '1' });
  c.recordActivity([{ windowId: '1', tabId: 'tab-16' }], '1');
  c.status = 'live';
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  c.client = { send: async (method, params, sessionId) => {
    if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
    if (method === 'Runtime.evaluate') {
      if (sessionId === 'tab-16') { reached(); await blocked; }
      return { result: { value: { visible: false, focused: false } } };
    }
    return {};
  } };
  const sampling = c.refreshActivityFromCdp();
  await waiting;
  assert.equal(c.session.tabs[16].focused, true, 'unsampled focused tab must survive early batches');
  assert.equal(c.session.tabs[16].active, true);
  release();
  await sampling;
  assert.equal(c.session.tabs[16].focused, false, 'an actual blur response clears focus');
});

test('discovery, updates, stale focus, closed parents, and unfocused windows do not infer parents', (t) => {
  const c = controller(t);
  c.onTarget(page('parent'));
  c.session.tabs[0].windowId = '1';
  const focus = (windowId = '1') => c.recordActivity([{ windowId: '1', tabId: 'parent' }], windowId);
  focus();
  c.onTarget(page('existing'));
  c.onTarget(page('existing'), { created: true });
  assert.equal(c.session.tabs[1].openerId, null);
  c.lastActivityObservedAt = Date.now() - 5000;
  c.onTarget(page('stale'), { created: true });
  assert.equal(c.session.tabs[2].openerId, null);
  focus(null);
  c.onTarget(page('unfocused'), { created: true });
  assert.equal(c.session.tabs[3].openerId, null);
  focus();
  c.session.tabs[0].closedAt = Date.now();
  c.onTarget(page('closed-parent'), { created: true });
  assert.equal(c.session.tabs[4].openerId, null);
});

test('inferred provenance survives import and explicit CDP opener wins at creation', (t) => {
  const c = controller(t);
  Object.assign(c.session, { id: require('node:crypto').randomUUID(), name: 'Inferred sources', browser: 'helium', startedAt: 1 });
  c.onTarget(page('parent'));
  c.session.tabs[0].windowId = '1';
  c.recordActivity([{ windowId: '1', tabId: 'parent' }], '1');
  c.onTarget(page('child'), { created: true });
  c.onTarget(page('explicit', 'different'), { created: true });
  assert.equal(c.session.tabs[2].openerId, 'different');
  assert.equal(c.session.tabs[2].openerSource, 'cdp');
  const imported = c.importSession(JSON.parse(JSON.stringify(c.session)));
  assert.equal(imported.tabs[1].openerSource, 'focused-tab');
  assert.equal(imported.tabs[1].openerId, 'parent');
});

test('exact source bindings survive duplicate URLs, delayed targets, and stale CDP metadata', (t) => {
  const c = controller(t);
  c.onTarget(page('unrelated'));
  c.onTarget(page('parent'));
  assert.deepEqual(c.onTabSources({ relationships: [event] }).acknowledged, []);
  // URL-derived extensionTabId fields must never resolve a source event.
  c.onGroupInfo({ tabId: 20, url: 'https://same.example', groupId: -1 });
  c.onTabSnapshot({ source: 'worker', sequence: 2, tabs: [{ tabId: 10, targetId: 'parent' }, { tabId: 20, targetId: 'child' }] });
  c.onTarget(page('child', 'unrelated'));
  const child = c.session.tabs.find((tab) => tab.id === 'child');
  assert.equal(child.openerId, 'parent');
  c.onTarget(page('child', 'unrelated'));
  assert.equal(child.openerId, 'parent');
  assert.equal(c.session.tabs[0].openerId, null);
  assert.deepEqual(c.onTabSources({ relationships: [event] }).acknowledged, [event]);
  c.onTabSources({ relationships: [{ ...event, sourceTabId: 30, sourceTargetId: 'unrelated', timeStamp: 200 }] });
  assert.equal(child.openerId, 'parent');
  const plan = buildRestorePlan(c.session);
  assert.equal(plan.windows.flatMap((window) => window.tabs).find((tab) => tab.sourceId === 'child').openerSourceId, 'parent');
});

test('relationship HTTP validation is atomic and retries wait for both targets', async (t) => {
  const c = controller(t);
  await c.startGroupBridge();
  const post = (relationships) => fetch(`${c.bridgeOrigin()}/tab-sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relationships }) });
  assert.equal((await post([event, { ...event, tabId: '20' }])).status, 400);
  assert.equal(c.pendingTabSources.size, 0);
  assert.equal((await post([{ ...event, sourceTabId: 20 }])).status, 400);
  const bound = { ...event, sourceTargetId: 'parent', targetId: 'child' };
  assert.deepEqual(await (await post([bound])).json(), { acknowledged: [] });
  c.onTarget(page('child'));
  assert.equal(c.session.tabs[0].openerId, null);
  c.onTarget(page('parent'));
  assert.deepEqual((await (await post([bound])).json()).acknowledged, [event]);
  assert.equal(c.session.tabs[0].openerId, 'parent');
});

test('snapshot sequences are tracked separately per worker and CDP remains a fallback', (t) => {
  const c = controller(t);
  c.onTarget(page('child', 'fallback'));
  const snapshot = (source, sequence, tabId) => c.onTabSnapshot({ source, sequence, tabs: [{ tabId, targetId: 'child' }] });
  snapshot('old', 10, 20);
  snapshot('new', 2, 20);
  snapshot('old', 9, 99);
  snapshot('new', 1, 98);
  assert.equal(c.exactTabTargets.has(99), false);
  assert.equal(c.exactTabTargets.has(98), false);
  assert.equal(c.session.tabs[0].openerId, 'fallback');
  upsertTarget(c.session, { ...page('child'), openerId: undefined });
  assert.equal(c.session.tabs[0].openerId, 'fallback');
});

test('URL-derived tab identity and undiscovered exact targets cannot assign a source', (t) => {
  const c = controller(t);
  c.onTarget(page('unrelated'));
  const unrelated = c.session.tabs[0];
  c.onGroupInfo({ tabId: 10, url: unrelated.url, title: unrelated.title });
  assert.equal(unrelated.extensionTabId, 10, 'legacy group matching is deliberately exercised');
  c.onTarget(page('child'));
  c.onTabSources({ relationships: [{ ...event, targetId: 'child' }] });
  assert.equal(c.session.tabs[1].openerId, null, 'URL-derived identity is never a source binding');
  c.onTabSnapshot({ tabs: [{ targetId: 'not-yet-discovered', tabId: 30, url: unrelated.url, title: unrelated.title, groupId: 7 }] });
  assert.equal(unrelated.groupId, null, 'unknown exact target must not fall through to another page');
  c.onTarget(page('parent'));
  c.onTabSnapshot({ tabs: [{ tabId: 10, targetId: 'parent' }] });
  assert.equal(c.session.tabs[1].openerId, 'parent');
});

test('explicit creation links persist, import, and restore through the existing openerId field', (t) => {
  const c = controller(t);
  Object.assign(c.session, { id: require('node:crypto').randomUUID(), name: 'Sources', browser: 'chrome', startedAt: 1 });
  c.onTarget(page('parent'));
  c.onTarget(page('child', 'weaker'));
  c.onTabSources({ relationships: [{ ...event, targetId: 'child', sourceTargetId: 'parent' }] });
  const saved = JSON.parse(fs.readFileSync(path.join(c.dataDir, 'sessions', `${c.session.id}.json`), 'utf8'));
  assert.equal(saved.tabs[1].openerId, 'parent');
  assert.equal(Object.hasOwn(saved, 'explicitOpeners'), false);
  const imported = c.importSession(saved);
  assert.equal(imported.tabs[1].openerId, 'parent');
  assert.equal(buildRestorePlan(imported).windows.flatMap((window) => window.tabs).find((tab) => tab.sourceId === 'child').openerSourceId, 'parent');
});

function extension(t, initial = []) {
  const listeners = {};
  const eventApi = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const eventObject = (names) => Object.fromEntries(names.map((name) => [name, eventApi(name)]));
  const state = { targets: [], posts: [], saved: initial, fail: false, ack: false, warnings: [] };
  const chrome = {
    tabs: { ...eventObject(['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onUpdated', 'onActivated', 'onHighlighted', 'onMoved', 'onReplaced']), query: async () => [] },
    windows: { ...eventObject(['onFocusChanged']), getAll: async () => [] },
    runtime: eventObject(['onInstalled', 'onStartup']),
    webNavigation: { onCreatedNavigationTarget: eventApi('navigationTarget') },
    debugger: { getTargets: (cb) => cb(state.targets) },
    storage: { session: { get: async () => ({ tablineSources: structuredClone(state.saved) }), set: async (value) => { state.saved = structuredClone(value.tablineSources); } } },
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID: () => 'worker' }, AbortSignal, console: { warn: (...args) => state.warnings.push(args) }, setInterval: (fn) => { state.tick = fn; }, fetch: async (url, options) => {
    if (!url.endsWith('/tab-sources')) return { status: 204 };
    const body = JSON.parse(options.body);
    state.posts.push(body);
    if (state.fail) throw new Error('bridge offline');
    return { ok: true, json: async () => ({ acknowledged: state.ack ? body.relationships.map(({ tabId, sourceTabId, timeStamp }) => ({ tabId, sourceTabId, timeStamp })) : [] }) };
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/tabline-extension/background.js'), 'utf8'), context);
  state.emit = (details) => listeners.navigationTarget(details);
  state.settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
  return state;
}

test('extension emits native navigation relationships, retries missing bindings/offline bridge, and removes only acknowledged events', async (t) => {
  const s = extension(t);
  await s.settle();
  s.fail = true;
  s.emit({ ...event, url: 'https://same.example' });
  await s.settle();
  assert.deepEqual(s.posts[0], { relationships: [event] });
  assert.equal(s.saved.length, 1);
  assert.ok(s.warnings.length);
  s.fail = false;
  // chrome.debugger.TargetInfo uses id, unlike CDP TargetInfo.targetId.
  s.targets = [{ type: 'page', tabId: 10, id: 'parent' }, { type: 'page', tabId: 20, id: 'child' }, { type: 'page', tabId: 30, id: 'unrelated' }];
  s.tick();
  await s.settle();
  assert.deepEqual(s.posts.at(-1).relationships[0], { ...event, sourceTargetId: 'parent', targetId: 'child' });
  assert.equal(s.saved.length, 1);
  s.ack = true;
  s.tick();
  await s.settle();
  assert.equal(s.saved.length, 0);
});

test('extension resumes outbox after worker restart and reports expired unresolved events', async (t) => {
  const persisted = { ...event, targetId: 'child', sourceTargetId: 'parent', queuedAt: Date.now() };
  const s = extension(t, [persisted]);
  await s.settle();
  assert.equal(s.posts.length, 1);
  assert.deepEqual(s.posts[0].relationships[0], { ...event, targetId: 'child', sourceTargetId: 'parent' });
  const expired = extension(t, [{ ...event, queuedAt: Date.now() - 300001 }]);
  await expired.settle();
  assert.equal(expired.posts.length, 0);
  assert.equal(expired.saved.length, 0);
  assert.equal(expired.warnings.length, 1);
  const manifest = require('../electron/tabline-extension/manifest.json');
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.ok(manifest.permissions.includes('storage'));
});
