const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { BrowserController, detectBrowsers } = require('../electron/browser.cjs');
const { SessionManager } = require('../electron/session-manager.cjs');
const { NetworkManager } = require('../electron/network.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (const start = Date.now(); Date.now() - start < 25000;) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-mirror-smoke-'));
  const source = new BrowserController(path.join(directory, 'source'));
  const local = new SessionManager(path.join(directory, 'local'));
  const remote = new NetworkManager({ controllers: new Map(), snapshot: () => ({ sessions: [source.snapshot()] }), listSessions: () => [] }, path.join(directory, 'remote'));
  const receiver = new NetworkManager(local, path.join(directory, 'receiver'), { pollInterval: 250 });
  const server = http.createServer((request, response) => { response.end(`<html><title>${request.url}</title><body>${request.url}</body></html>`); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // Default to Chrome to exercise branded builds that ignore --load-extension.
    const preferred = process.env.TABLINE_MIRROR_BROWSER || 'chrome';
    const browser = detectBrowsers().find((item) => item.id === preferred && item.path) || detectBrowsers().find((item) => item.path);
    assert.ok(browser, 'Install Chrome or Helium for the browser integration check.');
    await source.launch({ browser: browser.id, url: `${origin}/first` });
    remote.manager.controllers.set(source.session.id, source);
    await until(() => source.lastCompanionSnapshotAt, 'source companion ready');
    const token = 'tabline-mirror-smoke-token';
    const port = await freePort();
    await remote.configure({ ...remote.config, mode: 'host', port, token });
    await receiver.configure({ ...receiver.config, mode: 'client', port: await freePort(), peers: [{ id: 'source', url: `http://127.0.0.1:${port}`, token }] });
    await until(() => receiver.peers.get('source')?.connected, 'remote connection');
    const state = await receiver.launchMirror({ name: 'Mirror integration', mirror: { peerId: 'source', sessionId: source.session.id } });
    const mirror = local.controllers.get(state.activeSessionId);
    const open = () => mirror.session.tabs.filter((tab) => !tab.closedAt);
    assert.equal(mirror.session.browser, browser.id, 'browser must follow source automatically');
    await until(() => open().some((tab) => tab.url === `${origin}/first`), 'initial mirrored page');
    console.log('PASS: initial network mirror and companion handshake');
    const { targetId } = await source.client.send('Target.createTarget', { url: `${origin}/second`, newWindow: true });
    await source.client.send('Target.activateTarget', { targetId });
    await until(() => open().some((tab) => tab.url === `${origin}/second`) && new Set(open().map((tab) => tab.windowId)).size === 2, 'second mirrored window');
    await until(() => open().some((tab) => tab.url === `${origin}/second` && tab.active), 'active mirrored tab');
    console.log('PASS: remote window creation and active tab');
    await source.navigateTab(targetId, `${origin}/changed`);
    await until(() => open().some((tab) => tab.url === `${origin}/changed`), 'mirrored navigation');
    await source.client.send('Target.closeTarget', { targetId });
    await until(() => open().length === 1 && open()[0].url === `${origin}/first`, 'mirrored window closure');
    console.log('PASS: navigation and remote tab/window closure');
    await mirror.navigateTab(open()[0].id, `${origin}/from-mirror`);
    const sourceOpen = () => source.session.tabs.filter((tab) => !tab.closedAt);
    await until(() => sourceOpen().some((tab) => tab.url === `${origin}/from-mirror`), 'reverse navigation');
    const { targetId: reverseId } = await mirror.client.send('Target.createTarget', { url: `${origin}/reverse-window`, newWindow: true });
    await mirror.client.send('Target.activateTarget', { targetId: reverseId });
    await until(() => sourceOpen().some((tab) => tab.url === `${origin}/reverse-window` && tab.active) && new Set(sourceOpen().map((tab) => tab.windowId)).size === 2, 'reverse window creation and active tab');
    await mirror.client.send('Target.closeTarget', { targetId: reverseId });
    await until(() => sourceOpen().length === 1 && sourceOpen()[0].url === `${origin}/from-mirror`, 'reverse window closure');
    console.log('PASS: reverse navigation, new window, active tab, and closure');
    remote.stop();
    await until(() => !receiver.peers.get('source')?.connected, 'disconnection detected');
    await mirror.navigateTab(open()[0].id, `${origin}/offline-edit`);
    await remote.start();
    await until(() => sourceOpen().some((tab) => tab.url === `${origin}/offline-edit`), 'offline edit replay after reconnect');
    await delay(2500);
    assert.equal(open().length, 1, 'no echo-created duplicate tabs');
    assert.equal(sourceOpen().length, 1, 'no echo-created source duplicates');
    assert.equal(open()[0].url, `${origin}/offline-edit`, 'navigation must not bounce back');
    console.log('PASS: offline edits survive reconnect without feedback loops');
    await mirror.stop();
    const next = await receiver.launchMirror({ name: 'Second mirror', mirror: { peerId: 'source', sessionId: source.session.id } });
    const second = local.controllers.get(next.activeSessionId);
    assert.equal(second.session.profileSourceSessionId, null, 'mirrors must not inherit obsolete companions');
    await until(() => second.session.tabs.some((tab) => !tab.closedAt && tab.url === `${origin}/offline-edit`), 'second mirror in fresh profile');
    console.log('PASS: subsequent mirrors do not inherit stale companion state');
  } finally {
    receiver.stop(); remote.stop();
    await local.stopAll(); await source.stop();
    await new Promise((resolve) => server.close(resolve));
    console.log(`Test data: ${directory}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
