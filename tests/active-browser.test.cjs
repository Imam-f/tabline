const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { resolveActiveEndpoint, localEndpoint, openDebuggingSettings } = require('../electron/active-browser.cjs');
const { SessionManager } = require('../electron/session-manager.cjs');
const { CDP } = require('../electron/cdp.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('opens the debugging setup tab in the chosen browser without enabling flags or taking ownership', async (t) => {
  let launched;
  let unreferenced = false;
  t.mock.method(require('node:child_process'), 'spawn', (executable, args, options) => {
    launched = { executable, args, options };
    const child = new (require('node:events').EventEmitter)();
    child.unref = () => { unreferenced = true; };
    process.nextTick(() => child.emit('spawn'));
    return child;
  });
  await openDebuggingSettings({ browser: 'chrome' }, [{ id: 'chrome', path: process.execPath }]);
  assert.equal(launched.executable, process.execPath);
  assert.deepEqual(launched.args, ['chrome://inspect/#remote-debugging']);
  assert.equal(launched.options.windowsHide, true);
  assert.equal(unreferenced, true);
  const profile = temp(t);
  await openDebuggingSettings({ browser: 'chrome', executable: process.execPath, userDataDir: profile }, []);
  assert.deepEqual(launched.args, [`--user-data-dir=${profile}`, 'chrome://inspect/#remote-debugging']);
  assert.throws(() => openDebuggingSettings({ browser: 'helium' }, []), /open chrome:\/\/inspect/);
});

test('discovers browser-level endpoint without requiring the permission-gated HTTP version endpoint', async (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '49321\r\n/devtools/browser/browser-id\r\n');
  assert.equal(await resolveActiveEndpoint({ userDataDir: dir }), 'ws://127.0.0.1:49321/devtools/browser/browser-id');
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '0\n/devtools/browser/id');
  await assert.rejects(resolveActiveEndpoint({ userDataDir: dir }), (error) => error.code === 'DEBUGGING_UNAVAILABLE' && /Click Allow/.test(error.message));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '49321\n/devtools/page/tab-id');
  await assert.rejects(resolveActiveEndpoint({ userDataDir: dir }), /Remote debugging is not enabled/);
});

test('only accepts local browser endpoints and resolves an explicit HTTP port', async (t) => {
  for (const address of ['ws://example.com:9222/devtools/browser/id', 'file:///tmp/x', 'ws://127.0.0.1:9222/devtools/page/id', 'ws://user:password@localhost:9222/devtools/browser/id', 'ws://localhost:9222/devtools/browser/id?token=x']) {
    assert.throws(() => localEndpoint(address));
  }
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/id` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(await resolveActiveEndpoint({ address: `http://localhost:${server.address().port}` }), `ws://127.0.0.1:${server.address().port}/devtools/browser/id`);
});

test('tracks an external browser, rejects duplicates, saves on disconnect and never closes the browser', async (t) => {
  const dir = temp(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const commands = [];
  let connection;
  server.on('connection', (socket) => {
    connection = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      commands.push(message.method);
      let result = {};
      if (message.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'tab', title: 'Existing tab', url: 'https://example.com' }] };
      if (message.method === 'Browser.getWindowForTarget') result = { windowId: 1, bounds: { left: 0, top: 0, width: 800, height: 600 } };
      if (message.method === 'Target.attachToTarget') result = { sessionId: 'page-session' };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const manager = new SessionManager(dir);
  t.after(async () => {
    await manager.stopAll();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = `ws://127.0.0.1:${server.address().port}/devtools/browser/id`;
  const state = await manager.attach({ browser: 'chrome', name: 'My browser', address });
  assert.equal(state.status, 'live');
  assert.equal(state.session.connectionMode, 'attached');
  assert.equal(state.session.tabs[0].title, 'Existing tab');
  assert.equal(state.session.browserDataDir, undefined);
  assert.equal(manager.activeController().inactivityInterval, null);
  await assert.rejects(manager.attach({ browser: 'chrome', address }), /already being tracked/);
  connection.send(JSON.stringify({ method: 'Target.targetInfoChanged', params: { targetInfo: { type: 'page', targetId: 'tab', title: 'Next', url: 'https://example.com/next' } } }));
  await new Promise((resolve) => manager.once('change', resolve));
  await manager.stop();
  const saved = manager.loadSession(state.session.id);
  assert.equal(saved.tabs[0].url, 'https://example.com/next');
  assert.equal(saved.tabs[0].openAtEnd, true);
  assert.ok(saved.endedAt);
  assert.ok(!commands.includes('Browser.close'));
  assert.equal(manager.latestProfileSession(), null);
  await manager.attach({ browser: 'chrome', address });
  connection.close();
  await new Promise((resolve) => manager.once('change', resolve));
  assert.equal(manager.snapshot().status, 'idle');
  assert.ok(manager.snapshot().session.endedAt);
});

test('connection denial cleans up and explains the Allow step', async (t) => {
  const dir = temp(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: () => false });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const manager = new SessionManager(dir);
  await assert.rejects(manager.attach({ browser: 'chrome', address: `ws://127.0.0.1:${server.address().port}/devtools/browser/id` }), /click Allow/);
  assert.equal(manager.controllers.size, 0);
  assert.equal(manager.pendingStatus, null);
});

test('permission handshake has a bounded timeout rather than hanging forever', async (t) => {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const client = new CDP(`ws://127.0.0.1:${server.address().port}/devtools/browser/id`);
  await assert.rejects(client.connect({ timeout: 50 }), /Click Allow/);
});
