const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BrowserController } = require('../electron/browser.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-freezing-setting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller = new BrowserController(dir);
  controller.status = 'live';
  controller.session = { tabs: [{ id: 'tab', title: 'Example', url: 'https://example.com', closedAt: null, extensionTabId: 1, extensionWindowId: 10, active: false, lastActiveAt: Date.now() - 11 * 60000, thumbnail: null }] };
  controller.capture = async () => 'data:image/jpeg;base64,eA==';
  return controller;
}

test('popup setting persists, applies across controllers, blocks freezing and still allows returning frozen tabs', async (t) => {
  const controller = fixture(t);
  await controller.startGroupBridge();
  t.after(() => new Promise((resolve) => controller.groupBridge.close(resolve)));
  const post = async (route, body) => {
    const response = await fetch(`${controller.bridgeOrigin()}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const info = { targetId: 'tab' };
  assert.equal((await post('/extension/status', info)).data.freezingEnabled, true);
  const frozen = await post('/extension/freeze', info);
  assert.ok(frozen.data.shortUrl);
  assert.deepEqual((await post('/extension/freezing-settings', { enabled: false })).data, { freezingEnabled: false });
  assert.equal((await post('/extension/status', info)).data.freezingEnabled, false);
  const second = new BrowserController(controller.dataDir);
  assert.equal(second.freezingEnabled(), false);
  for (const route of ['/extension/freeze', '/extension/freeze-all']) {
    const result = await post(route, info);
    assert.equal(result.status, 400);
    assert.match(result.data.error, /Freezing is disabled/);
  }
  await assert.rejects(controller.freezeTabById('tab'), /Freezing is disabled/);
  const returned = await post('/extension/unfreeze', info);
  assert.equal(returned.data.originalUrl, 'https://example.com');
  assert.equal((await post('/extension/freezing-settings', { enabled: 'false' })).status, 400);
  assert.equal(second.freezingEnabled(), false);
  await post('/extension/freezing-settings', { enabled: true });
  assert.equal(second.freezingEnabled(), true);
  assert.ok((await post('/extension/freeze', info)).data.shortUrl);
});

test('disabled freezing prevents the inactivity worker from capturing or navigating tabs', async (t) => {
  const controller = fixture(t);
  let captures = 0;
  let navigations = 0;
  controller.capture = async () => { captures++; return 'data:image/jpeg;base64,eA=='; };
  controller.navigateTab = async () => { navigations++; };
  controller.setFreezingEnabled(false);
  await controller.checkInactiveTabs();
  assert.equal(captures, 0);
  assert.equal(navigations, 0);
  assert.equal(controller.freezer.entries.length, 0);
  controller.setFreezingEnabled(true);
  await controller.checkInactiveTabs();
  assert.equal(captures, 1);
  assert.equal(navigations, 1);
});

test('disabling freezing while a screenshot is pending cancels the freeze', async (t) => {
  const controller = fixture(t);
  let finishCapture;
  controller.capture = () => new Promise((resolve) => { finishCapture = resolve; });
  const pending = controller.freezeTab({ targetId: 'tab' });
  controller.setFreezingEnabled(false);
  finishCapture('data:image/jpeg;base64,eA==');
  await assert.rejects(pending, /Freezing is disabled/);
  assert.equal(controller.freezer.entries.length, 0);
});

test('hands the current session bridge address to the companion and detaches from its worker', async (t) => {
  const controller = fixture(t);
  await controller.startGroupBridge();
  t.after(() => new Promise((resolve) => controller.groupBridge.close(resolve)));
  const calls = [];
  controller.client = { send: async (method, params) => {
    calls.push({ method, params });
    if (method === 'Target.attachToTarget') return { sessionId: 'worker-session' };
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  } };
  await controller.configureCompanion('worker');
  const expression = calls.find((call) => call.method === 'Runtime.evaluate').params.expression;
  assert.ok(expression.includes(JSON.stringify(controller.bridgeOrigin())));
  assert.match(expression, /Tabline companion/);
  assert.match(expression, /tablineBridgeOrigin/);
  assert.equal(calls.at(-1).method, 'Target.detachFromTarget');
  await controller.configureCompanion('worker');
  assert.equal(calls.length, 3, 'unchanged worker should only be configured once');
});
