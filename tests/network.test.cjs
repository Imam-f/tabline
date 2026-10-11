const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { NetworkManager, peerUrl } = require('../electron/network.cjs');

const token = 'network-test-secret-token';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(20); }
  throw new Error('Timed out waiting for network state.');
}
function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-network-'));
  const id = randomUUID();
  const session = { id, name, browser: 'chrome', startedAt: 100, endedAt: null, tabs: [{ id: `${name}-tab`, title: name, url: 'https://example.com' }] };
  const calls = [];
  const manager = {
    snapshot: () => ({ status: 'live', session, sessions: [{ status: 'live', session, debugPort: 12345 }], debugPort: 12345 }),
    listSessions: () => [{ id, name, tabCount: 1 }],
    restoreSession: async (sessionId, options) => { assert.equal(sessionId, id, 'restore must use data owned by the receiving instance'); calls.push({ sessionId, options }); return { opened: 1, skipped: 0, failed: 0, warnings: [] }; },
  };
  const network = new NetworkManager(manager, directory, { pollInterval: 30 });
  t.after(() => { network.stop(); fs.rmSync(directory, { force: true, recursive: true }); });
  return { network, directory, manager, id, calls, session };
}
async function configure(network, mode, peers = []) {
  await network.configure({ ...network.config, mode, port: await freePort(), token, peers });
  assert.equal(network.snapshot().listening, mode !== 'off');
  return `http://127.0.0.1:${network.config.port}`;
}

test('multiple instances track independent live tabs, reconnect, and resume data on the client machine', async (t) => {
  const host = fixture(t, 'host');
  const client = fixture(t, 'client');
  const second = fixture(t, 'second');
  const clientUrl = await configure(client.network, 'client');
  const secondUrl = await configure(second.network, 'host');
  const peers = [{ id: 'client', url: clientUrl, token }, { id: 'second', url: secondUrl, token }];
  await configure(host.network, 'host', peers);
  await until(() => host.network.snapshot().peers.every((peer) => peer.connected));
  assert.deepEqual(host.network.snapshot().peers.map((peer) => peer.data.state.sessions[0].session.tabs[0].title), ['client', 'second']);
  assert.equal(host.network.snapshot().peers[0].data.state.debugPort, null);
  client.session.tabs[0].title = 'Changed remotely';
  await until(() => host.network.snapshot().peers[0].data.state.sessions[0].session.tabs[0].title === 'Changed remotely');
  assert.equal(host.session.tabs[0].title, 'host');
  assert.equal((await host.network.restorePeer('client', client.id, 101)).opened, 1);
  assert.deepEqual(client.calls, [{ sessionId: client.id, options: { at: 101 } }]);
  assert.deepEqual(host.calls, []);
  await assert.rejects(host.network.restorePeer('second', second.id), /client mode/);
  const clientConfig = client.network.config;
  client.network.stop();
  await until(() => !host.network.snapshot().peers[0].connected);
  assert.equal(host.network.snapshot().peers[0].data.state.sessions[0].session.tabs[0].title, 'Changed remotely');
  await client.network.configure(clientConfig);
  await until(() => host.network.snapshot().peers[0].connected);
});

test('network endpoints require a token, reject browser origins and unsafe restore arguments', async (t) => {
  const client = fixture(t, 'client');
  const url = await configure(client.network, 'client');
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${token}`, Origin: 'https://example.com' }]) {
    assert.equal((await fetch(`${url}/v1/state`, { headers })).status, 401);
  }
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${url}/v1/state`, { headers })).status, 200);
  for (const body of [{ sessionId: '../../file' }, { sessionId: client.id, at: 'yesterday' }, { sessionId: client.id, at: -1 }]) {
    assert.equal((await fetch(`${url}/v1/restore`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.deepEqual(client.calls, []);
  assert.equal((await fetch(`${url}/v1/restore`, { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
});

test('client waits without launching and serializes incoming restores', async (t) => {
  const client = fixture(t, 'waiting');
  const host = fixture(t, 'host');
  const url = await configure(client.network, 'client');
  await configure(host.network, 'host', [{ id: 'client', url, token }]);
  await until(() => host.network.snapshot().peers[0].connected);
  assert.deepEqual(client.calls, []);
  let finish;
  client.manager.restoreSession = () => new Promise((resolve) => { finish = resolve; });
  const pending = host.network.restorePeer('client', client.id);
  await until(() => client.network.restoring);
  await assert.rejects(host.network.restorePeer('client', client.id), /already restoring/);
  await assert.rejects(client.network.configure(client.network.config), /current network restore/);
  finish({ opened: 2, failed: 0, skipped: 0, warnings: [] });
  assert.equal((await pending).opened, 2);
  assert.equal(client.network.restoring, false);
  client.manager.restoreSession = async () => { throw new Error('Browser unavailable'); };
  await assert.rejects(host.network.restorePeer('client', client.id), /Browser unavailable/);
  assert.equal(client.network.restoring, false);
});

test('settings and instance identity persist; off mode stops sharing; invalid settings do not replace working settings', async (t) => {
  const instance = fixture(t, 'persisted');
  await configure(instance.network, 'host');
  const reloaded = new NetworkManager(instance.manager, instance.directory);
  assert.deepEqual(reloaded.config, instance.network.config);
  assert.equal(reloaded.instanceId, instance.network.instanceId);
  await assert.rejects(instance.network.configure({ ...instance.network.config, token: 'short' }), /token/);
  assert.equal(instance.network.snapshot().listening, true);
  await instance.network.configure({ ...instance.network.config, mode: 'off' });
  assert.equal(instance.network.snapshot().listening, false);
  await assert.rejects(instance.network.restorePeer('unknown', instance.id), /Enable network/);
});

test('bind conflicts, self connections and incorrect tokens are visible errors', async (t) => {
  const first = fixture(t, 'first');
  const second = fixture(t, 'second');
  const url = await configure(first.network, 'host');
  await second.network.configure({ ...second.network.config, mode: 'client', port: first.network.config.port });
  assert.match(second.network.snapshot().error, /Could not listen/);
  assert.equal(second.network.snapshot().listening, false);
  await first.network.configure({ ...first.network.config, peers: [{ id: 'self', url, token }] });
  await until(() => first.network.snapshot().peers[0].error);
  assert.match(first.network.snapshot().peers[0].error, /this instance/);
  await configure(second.network, 'host', [{ id: 'wrong', url, token: 'incorrect-secret-token' }]);
  await until(() => second.network.snapshot().peers[0].error);
  assert.match(second.network.snapshot().peers[0].error, /rejected/);
});

test('addresses accept only HTTP(S) instance origins', () => {
  assert.equal(peerUrl('http://192.168.1.10:45831'), 'http://192.168.1.10:45831');
  for (const value of ['file:///tmp/data', 'http://user:pass@localhost:1234', 'http://localhost/path', 'http://localhost/?token=secret']) assert.throws(() => peerUrl(value));
});
