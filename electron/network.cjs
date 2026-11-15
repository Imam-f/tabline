const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MirrorRoom } = require('./mirror-room.cjs');

const SESSION_ID = /^[a-f0-9-]{36}$/;
const MAX_RESPONSE = 64 * 1024 * 1024;

function peerUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter an HTTP(S) instance address, such as http://192.168.1.20:45831.');
  return url.origin;
}

function requestPeer(peer, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, peer.url);
    const data = body === undefined ? null : JSON.stringify(body);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${peer.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) request.destroy(new Error('The instance response is too large.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode !== 200) reject(new Error(value.error || `Instance returned HTTP ${response.statusCode}.`));
          else resolve(value);
        } catch { reject(new Error('The instance returned an invalid response.')); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error('Instance did not respond.')), data && route === '/v1/restore' ? 90000 : 5000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
    request.end(data);
  });
}

class NetworkManager extends EventEmitter {
  constructor(manager, dataDir, { pollInterval = 2000, getBrowsers = () => require('./browser.cjs').detectBrowsers() } = {}) {
    super();
    this.manager = manager;
    this.file = path.join(dataDir, 'network.json');
    this.pollInterval = pollInterval;
    this.getBrowsers = getBrowsers;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    const defaults = { mode: 'off', name: os.hostname(), port: 45831, token: randomBytes(24).toString('hex'), peers: [] };
    try { this.config = this.validate({ ...defaults, ...saved }); }
    catch { this.config = defaults; }
    this.instanceId = saved?.instanceId || randomUUID();
    this.peers = new Map();
    this.server = null;
    this.timer = null;
    this.error = null;
    this.restoring = false;
    this.generation = 0;
  }

  validate(options) {
    if (!['off', 'host', 'client'].includes(options.mode)) throw new Error('Invalid network mode.');
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    if (typeof options.token !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(options.token)) throw new Error('Use a connection token of 16–128 printable characters without spaces.');
    if (!Array.isArray(options.peers) || options.peers.length > 32) throw new Error('Connect up to 32 instances.');
    const peers = options.peers.map((peer) => {
      if (typeof peer.token !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(peer.token)) throw new Error('Each instance needs its connection token.');
      return { id: typeof peer.id === 'string' ? peer.id : randomUUID(), url: peerUrl(peer.url), token: peer.token };
    });
    if (new Set(peers.map((peer) => peer.url)).size !== peers.length || new Set(peers.map((peer) => peer.id)).size !== peers.length) throw new Error('An instance address can only be added once.');
    return { mode: options.mode, name: String(options.name || os.hostname()).slice(0, 80), port, token: options.token, peers };
  }

  snapshot() {
    return { config: this.config, instanceId: this.instanceId, listening: !!this.server?.listening, port: this.server?.address()?.port || null, addresses: Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => `http://${entry.address}:${this.config.port}`), error: this.error, restoring: this.restoring, peers: this.config.peers.map((peer) => ({ id: peer.id, url: peer.url, ...(this.peers.get(peer.id) || { connected: false, error: null, data: null }) })) };
  }

  publish() { this.emit('change', this.snapshot()); }

  async configure(options) {
    if (this.restoring) throw new Error('Wait for the current network restore to finish.');
    const config = this.validate(options);
    this.stop();
    this.config = config;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...config, instanceId: this.instanceId }), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    await this.start();
    return this.snapshot();
  }

  async start() {
    this.error = null;
    if (this.config.mode === 'off') { this.publish(); return; }
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.config.port, '0.0.0.0', resolve); });
      server.on('error', (error) => { this.error = error.message; this.publish(); });
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollInterval);
      this.timer.unref();
    } catch (error) { this.error = `Could not listen on port ${this.config.port}: ${error.message}`; server.close(); this.server = null; }
    this.publish();
  }

  stop() {
    this.generation++;
    clearInterval(this.timer);
    this.timer = null;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    for (const peer of this.config.peers) this.updateMirrors(peer.id, null);
    this.peers.clear();
  }

  sharedState() {
    const state = this.manager.snapshot();
    return { instanceId: this.instanceId, name: this.config.name, mode: this.config.mode, mirrorProtocol: 2, restoring: this.restoring, state: { ...state, debugPort: null, sessions: state.sessions.map((runtime) => ({ ...runtime, debugPort: null })) }, savedSessions: this.manager.listSessions() };
  }

  async handle(req, res) {
    const reply = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${this.config.token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: 'Connection token was rejected.' }); return; }
    try {
      if (req.method === 'POST' && ['/v1/mirror/connect', '/v1/mirror/sync', '/v1/mirror/disconnect'].includes(req.url)) {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 2 * 1024 * 1024) { reply(413, { error: 'Mirror update is too large.' }); return; }
        }
        const message = JSON.parse(body);
        if (!SESSION_ID.test(message.sessionId || '')) throw new Error('Invalid mirror session.');
        const controller = this.manager.controllers?.get(message.sessionId);
        if (!controller || controller.status !== 'live' || controller.session.mirror) throw new Error('The source session is not available for two-way mirroring.');
        if (req.url === '/v1/mirror/connect') {
          if (controller.companionMirrorProtocol !== 2 || !controller.lastCompanionSnapshotAt || Date.now() - controller.lastCompanionSnapshotAt > 15000) throw new Error('The source browser companion needs an update or is disconnected. Restart its session with the updated Tabline app.');
          if (!controller.mirrorRoom) {
            const room = new MirrorRoom(require('./remote-mirror.cjs').buildMirrorPlan(controller.session));
            controller.mirrorRoom = room;
            controller.session.twoWayMirror = true;
            controller.mirrorPlan = room.snapshot();
            controller.mirrorSync = async ({ base, observed }) => {
              controller.mirrorPlan = room.sync(base, observed);
              controller.publish();
              return controller.mirrorPlan;
            };
          }
          const clientId = randomUUID();
          controller.mirrorRoom.clients.add(clientId);
          controller.publish();
          reply(200, { roomId: controller.mirrorRoom.id, clientId, plan: controller.mirrorRoom.snapshot() });
        } else {
          const room = controller.mirrorRoom;
          if (!room || room.id !== message.roomId || !room.clients.has(message.clientId)) throw new Error('Mirror connection expired. Start a new remote mirror.');
          if (req.url === '/v1/mirror/disconnect') {
            room.clients.delete(message.clientId);
            if (!room.clients.size) {
              controller.mirrorRoom = null; controller.mirrorPlan = null; controller.mirrorSync = null;
              controller.session.twoWayMirror = false;
              controller.publish();
            }
            reply(200, { ok: true });
          } else {
            controller.mirrorPlan = room.sync(message.base, message.observed);
            controller.publish();
            reply(200, controller.mirrorPlan);
          }
        }
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/state') { reply(200, this.sharedState()); return; }
      if (req.method === 'GET' && req.url.startsWith('/v1/sessions/')) {
        const sessionId = req.url.slice('/v1/sessions/'.length);
        if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session ID.');
        const runtime = this.manager.snapshot().sessions.find((item) => item.session.id === sessionId);
        const session = runtime?.session || this.manager.loadSession(sessionId);
        // Omit metadata that belongs only to the source machine.
        const { browserDataDir, profileSourceSessionId, profileCopySkipped, restoredFromSessionId, folderId, order, ...portable } = session;
        reply(200, portable);
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/restore') { reply(404, { error: 'Unknown network operation.' }); return; }
      if (this.config.mode !== 'client') { reply(403, { error: 'Enable client mode on this machine to receive restore requests.' }); return; }
      if (this.restoring) { reply(409, { error: 'This client is already restoring a session.' }); return; }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { reply(413, { error: 'Restore request is too large.' }); return; }
      }
      const { sessionId, at } = JSON.parse(body);
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || (at !== undefined && (!Number.isFinite(at) || at < 0))) throw new Error('Invalid saved session or restore time.');
      // Check again after reading: two requests may arrive before either body finishes.
      if (this.restoring) { reply(409, { error: 'This client is already restoring a session.' }); return; }
      this.restoring = true;
      this.publish();
      try {
        const result = await this.manager.restoreSession(sessionId, at === undefined ? {} : { at });
        reply(200, { opened: result.opened, skipped: result.skipped, failed: result.failed, warnings: result.warnings });
      } finally { this.restoring = false; this.publish(); }
    } catch (error) { reply(400, { error: error.message }); }
  }

  poll() {
    const generation = this.generation;
    for (const peer of this.config.peers) {
      const previous = this.peers.get(peer.id);
      if (previous?.polling) continue;
      this.peers.set(peer.id, { ...previous, polling: true });
      requestPeer(peer, '/v1/state').then((data) => {
        if (generation !== this.generation) return;
        if (data.instanceId === this.instanceId) throw new Error('This address points to this instance.');
        if (!data.state || !Array.isArray(data.state.sessions) || !Array.isArray(data.savedSessions) || typeof data.name !== 'string') throw new Error('This address is not a compatible Tabline instance.');
        this.peers.set(peer.id, { connected: true, error: null, data, lastSeen: Date.now() });
        this.updateMirrors(peer.id, data);
        this.publish();
      }).catch((error) => {
        if (generation !== this.generation) return;
        this.updateMirrors(peer.id, null);
        this.peers.set(peer.id, { connected: false, error: error.message, data: previous?.data || null, lastSeen: previous?.lastSeen || null });
        this.publish();
      });
    }
  }

  async launchMirror(options) {
    if (this.config.mode === 'off') throw new Error('Enable network mode and connect a remote instance first.');
    const { peerId, sessionId } = options.mirror || {};
    const peer = this.peers.get(peerId);
    const source = peer?.data?.state.sessions.find((item) => item.session.id === sessionId);
    if (!peer?.connected || source?.status !== 'live') throw new Error('Choose a connected, live remote session.');
    if (source.session.mirror) throw new Error('A mirrored session cannot be used as a mirror source.');
    if (peer.data.mirrorProtocol !== 2) throw new Error('Update Tabline on the remote machine to enable two-way mirroring.');
    const browsers = this.getBrowsers();
    const available = browsers.map((item) => ({ ...item, path: options.mirrorExecutables?.[item.id] || item.path })).filter((item) => item.path);
    const browser = available.find((item) => item.id === source.session.browser) || available[0];
    if (!browser) throw new Error('Install Helium or Chrome on this machine to mirror a remote session.');
    const remote = this.config.peers.find((item) => item.id === peerId);
    const connection = await requestPeer(remote, '/v1/mirror/connect', { sessionId });
    let state;
    try { state = await this.manager.launch({ ...options, browser: browser.id, executable: browser.path, url: 'about:blank' }); }
    catch (error) { await requestPeer(remote, '/v1/mirror/disconnect', { sessionId, roomId: connection.roomId, clientId: connection.clientId }).catch(() => {}); throw error; }
    const controller = this.manager.controllers.get(state.activeSessionId);
    controller.session.mirror = { peerId, sessionId, instanceId: peer.data.instanceId, twoWay: true };
    controller.mirrorPlan = connection.plan;
    controller.mirrorSync = async ({ base, observed }) => {
      if (this.config.mode === 'off') throw new Error('Networking is disabled. Two-way mirror is paused.');
      const currentPeer = this.peers.get(peerId);
      const currentRemote = this.config.peers.find((item) => item.id === peerId);
      if (!currentRemote || !currentPeer?.connected || currentPeer.data.instanceId !== peer.data.instanceId) throw new Error('Remote mirror is disconnected. Local edits will sync after reconnection.');
      const plan = await requestPeer(currentRemote, '/v1/mirror/sync', { sessionId, roomId: connection.roomId, clientId: connection.clientId, base, observed });
      controller.mirrorPlan = plan;
      return plan;
    };
    let disconnected = false;
    controller.on?.('change', () => {
      if (disconnected || !['idle', 'error'].includes(controller.status)) return;
      disconnected = true;
      void requestPeer(remote, '/v1/mirror/disconnect', { sessionId, roomId: connection.roomId, clientId: connection.clientId }).catch(() => {});
    });
    this.updateMirrors(peerId, this.peers.get(peerId)?.connected ? this.peers.get(peerId).data : null);
    try { await controller.waitForMirror?.(); }
    catch (error) { await controller.stop(); throw error; }
    return this.manager.snapshot();
  }

  updateMirrors(peerId, data) {
    for (const controller of this.manager.controllers?.values() || []) {
      const mirror = controller.session?.mirror;
      if (controller.status !== 'live' || mirror?.peerId !== peerId) continue;
      const source = data?.state.sessions.find((item) => item.session.id === mirror.sessionId);
      if (!data || data.instanceId !== mirror.instanceId || !source || source.status !== 'live' || source.session.mirror) {
        if (controller.mirrorPlan) controller.pausedMirrorPlan = controller.mirrorPlan;
        controller.mirrorPlan = null;
        controller.lastError = 'Remote mirror paused. Waiting for its source session to reconnect.';
      } else {
        if (!mirror.twoWay) controller.mirrorPlan = require('./remote-mirror.cjs').buildMirrorPlan(source.session);
        else if (!controller.mirrorPlan) controller.mirrorPlan = controller.pausedMirrorPlan || null;
        if (controller.lastError?.startsWith('Remote mirror paused.')) controller.lastError = null;
      }
      controller.publish();
    }
  }

  async restorePeer(peerId, sessionId, at) {
    if (this.config.mode === 'off') throw new Error('Enable network mode first.');
    const peer = this.config.peers.find((item) => item.id === peerId);
    if (!peer) throw new Error('Instance is not configured.');
    if (!SESSION_ID.test(sessionId) || (at !== undefined && (!Number.isFinite(at) || at < 0))) throw new Error('Invalid saved session or restore time.');
    const result = await requestPeer(peer, '/v1/restore', { sessionId, ...(at === undefined ? {} : { at }) });
    this.poll();
    return result;
  }

  async importPeer(peerId, sessionId) {
    if (this.config.mode === 'off') throw new Error('Enable network mode first.');
    const peer = this.config.peers.find((item) => item.id === peerId);
    if (!peer) throw new Error('Instance is not configured.');
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid session ID.');
    const session = await requestPeer(peer, `/v1/sessions/${sessionId}`);
    return this.manager.importSession(session);
  }
}

module.exports = { NetworkManager, peerUrl };
