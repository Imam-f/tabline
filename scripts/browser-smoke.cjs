// Real-browser integration check: uses an isolated, temporary profile and local fixture pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { BrowserController, detectBrowsers } = require('../electron/browser.cjs');

const waitFor = async (predicate, label, timeout = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

(async () => {
  const browser = detectBrowsers().find((item) => item.path);
  const executable = process.env.TABLINE_BROWSER_PATH || browser?.path;
  if (!executable) throw new Error('Install Chrome/Helium or set TABLINE_BROWSER_PATH to run the real-browser smoke test.');
  const tempParent = process.env.TABLINE_TEST_TEMP || os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(tempParent, 'tabline-smoke-'));
  const controller = new BrowserController(dataDir);
  const server = http.createServer((request, response) => {
    const name = request.url === '/child' ? 'Child tab' : request.url === '/next' ? 'Next page' : 'Parent tab';
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<html><head><title>${name}</title></head><body style="margin:0;background:#eef3e3;font:24px system-ui;padding:60px"><h1>${name}</h1><p>Tabline real-browser integration fixture.</p><a href="/child" target="_blank" rel="opener">Open child</a></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await controller.launch({ browser: browser?.id || 'chrome', executable, name: 'Integration test', url: base });
    assert.equal(controller.status, 'live');
    const parent = await waitFor(() => controller.session.tabs.find((tab) => tab.title === 'Parent tab'), 'initial tab');
    const { sessionId } = await controller.client.send('Target.attachToTarget', { targetId: parent.id, flatten: true });
    await controller.client.send('Runtime.evaluate', { expression: `window.open('${base}/child', '_blank')`, userGesture: true }, sessionId);
    const child = await waitFor(() => controller.session.tabs.find((tab) => tab.title === 'Child tab'), 'child tab');
    assert.equal(child.openerId, parent.id, 'child tab should retain its opener');
    await controller.capture(child.id);
    assert.ok(child.thumbnail?.startsWith('data:image/jpeg;base64,'), 'captures real tab thumbnail');
    assert.ok(child.thumbnail.length > 1000, 'thumbnail has image content');
    await controller.client.send('Page.navigate', { url: `${base}/next` }, sessionId);
    await waitFor(() => parent.url === `${base}/next`, 'navigation');
    assert.ok(parent.navigations.length >= 2, 'navigation history should grow');
    await controller.focusTab(parent.id);
    await controller.closeTab(child.id);
    await waitFor(() => child.closedAt, 'closed-tab timestamp');
    assert.ok(child.closedAt >= child.openedAt);
    await assert.rejects(controller.focusTab(child.id), /no longer open/);
    await controller.stop();
    assert.ok(controller.session.endedAt);
    assert.ok(controller.session.tabs.every((tab) => tab.closedAt));
    assert.equal(controller.listSessions().length, 1);
    const saved = controller.loadSession(controller.session.id);
    assert.equal(saved.tabs.find((tab) => tab.id === child.id).openerId, parent.id);
    assert.ok(saved.tabs.find((tab) => tab.id === child.id).thumbnail);
    console.log('PASS: browser launch, discovery, opener arrows, JPEG capture, navigation, focus, closure, and session persistence.');
  } finally {
    await controller.stop();
    clearTimeout(controller.persistTimer);
    await new Promise((resolve) => server.close(resolve));
    // Chromium may hold profile locks briefly after Browser.close.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { console.log(`Temporary browser profile remains at ${dataDir}`); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
