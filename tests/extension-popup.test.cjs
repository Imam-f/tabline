const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = fs.readFileSync(path.join(__dirname, '../electron/tabline-extension/popup.js'), 'utf8');

async function openPopup(saved, { connected = false, debuggerUnavailable = false, noTab = false } = {}) {
  const elements = Object.fromEntries(['disable-freezing', 'title', 'url', 'status', 'freeze', 'return', 'whitelist', 'close', 'freeze-all', 'error', 'reconnect'].map((id) => [id, {
    id,
    disabled: id === 'disable-freezing', checked: false, hidden: true, textContent: '', listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
  }]));
  const calls = [];
  const context = {
    AbortSignal,
    document: { getElementById: (id) => elements[id], querySelectorAll: () => ['freeze', 'return', 'whitelist', 'close', 'freeze-all', 'reconnect'].map((id) => elements[id]) },
    window: { close() {} },
    chrome: {
      runtime: {},
      storage: { local: { get: async () => ({ ...saved }), set: async (value) => Object.assign(saved, value) } },
      tabs: { query(_query, callback) { callback(noTab ? [] : [{ id: 1, windowId: 1, title: 'Example', url: 'https://example.com' }]); } },
      debugger: { getTargets(callback) { if (debuggerUnavailable) throw new Error('Debugger is unavailable'); callback([{ tabId: 1, targetId: 'target' }]); } },
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (!connected) throw new Error('Tabline is offline');
      const status = { freezable: true, frozen: false, whitelisted: false, freezingEnabled: true };
      return { ok: true, json: async () => status };
    },
  };
  await vm.runInNewContext(popup, context);
  return { elements, calls, setConnected: (value) => { connected = value; } };
}

test('freezing checkbox stays usable offline, saves the preference and restores it when reopened', async () => {
  const saved = {};
  const { elements } = await openPopup(saved);
  assert.equal(elements['disable-freezing'].disabled, false);
  assert.equal(elements.reconnect.hidden, false);
  assert.equal(elements.reconnect.disabled, false);
  assert.equal(elements.error.hidden, true);
  assert.match(elements.status.textContent, /Tabline is not connected/);
  assert.equal(elements.title.textContent, 'Example');
  elements['disable-freezing'].checked = true;
  await elements['disable-freezing'].listeners.change();
  assert.equal(saved.freezingEnabled, false);
  assert.equal(saved.freezingPending, true);
  assert.equal(elements['disable-freezing'].checked, true);
  assert.equal(elements['disable-freezing'].disabled, false);
  assert.match(elements.status.textContent, /will apply when Tabline reconnects/);
  const reopened = await openPopup(saved);
  assert.equal(reopened.elements['disable-freezing'].checked, true);
  assert.equal(reopened.elements['disable-freezing'].disabled, false);
});

test('retry connection discovers the current session port and clears the disconnected state', async () => {
  const saved = { tablineBridgeOrigin: 'http://127.0.0.1:48321' };
  const { elements, calls, setConnected } = await openPopup(saved);
  assert.equal(elements.reconnect.hidden, false);
  saved.tablineBridgeOrigin = 'http://127.0.0.1:48322';
  setConnected(true);
  await elements.reconnect.listeners.click();
  assert.equal(elements.reconnect.hidden, true);
  assert.equal(elements.error.hidden, true);
  assert.equal(elements.freeze.disabled, false);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:48322/extension/status');
});

test('tab lookup and debugger failures do not disable the global freezing preference', async () => {
  for (const options of [{ debuggerUnavailable: true }, { noTab: true }]) {
    const saved = {};
    const { elements } = await openPopup(saved, options);
    assert.equal(elements['disable-freezing'].disabled, false);
    elements['disable-freezing'].checked = true;
    await elements['disable-freezing'].listeners.change();
    assert.equal(saved.freezingEnabled, false);
  }
});

test('connected checkbox applies the setting immediately and keeps freeze actions disabled', async () => {
  const saved = {};
  const { elements, calls } = await openPopup(saved, { connected: true });
  elements['disable-freezing'].checked = true;
  await elements['disable-freezing'].listeners.change();
  assert.ok(calls.some((call) => call.url.endsWith('/extension/freezing-settings') && call.body.enabled === false));
  assert.equal(saved.freezingPending, false);
  assert.equal(elements.freeze.disabled, true);
  assert.equal(elements['freeze-all'].disabled, true);
  assert.equal(elements.return.disabled, false);
});

test('pending offline preference is not overwritten by an older server setting', async () => {
  const saved = { freezingEnabled: false, freezingPending: true };
  const { elements } = await openPopup(saved, { connected: true });
  assert.equal(elements['disable-freezing'].checked, true);
  assert.equal(saved.freezingEnabled, false);
});

test('background worker retries the saved preference when Tabline reconnects', async () => {
  const saved = { freezingEnabled: false, freezingPending: true };
  let connected = false;
  let interval;
  const applied = [];
  const event = { addListener() {} };
  const chrome = {
    storage: { local: { get: async () => ({ ...saved }), set: async (value) => Object.assign(saved, value) } },
    debugger: { getTargets: (callback) => callback([]) },
    tabs: { query: () => Promise.resolve([]) },
    windows: { getAll: () => Promise.resolve([]), onFocusChanged: event },
    runtime: { onInstalled: event, onStartup: event },
    alarms: { onAlarm: event, create() {} },
  };
  for (const name of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onUpdated', 'onActivated', 'onHighlighted', 'onMoved', 'onReplaced']) chrome.tabs[name] = event;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/tabline-extension/background.js'), 'utf8'), {
    chrome, crypto: require('node:crypto'), AbortSignal,
    setInterval: (callback) => { interval = callback; },
    fetch: async (url, options) => {
      if (url.endsWith('/extension/freezing-settings')) {
        if (!connected) throw new Error('Offline');
        applied.push(JSON.parse(options.body).enabled);
      }
      return { status: 204, ok: true };
    },
  });
  await new Promise(setImmediate);
  assert.equal(saved.freezingPending, true);
  connected = true;
  interval();
  await new Promise(setImmediate);
  assert.deepEqual(applied, [false]);
  assert.equal(saved.freezingPending, false);
});
