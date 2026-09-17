const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

class VirtualDesktopResolver {
  constructor(scriptPath = path.join(__dirname, 'virtual-desktop.ps1')) {
    this.scriptPath = scriptPath;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  resolve(windowId, processId, bounds) {
    return this.request('resolve', windowId, processId, bounds, null, 'unknown');
  }

  move(windowId, processId, bounds, desktopId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(desktopId || '')) return Promise.resolve(false);
    return this.request('move', windowId, processId, bounds, desktopId, false);
  }

  request(action, windowId, processId, bounds, desktopId, fallback) {
    if (process.platform !== 'win32' || !windowId || !processId || !Number.isFinite(bounds?.left) || !Number.isFinite(bounds?.top)) return Promise.resolve(fallback);
    this.start();
    if (!this.child?.stdin.writable) return Promise.resolve(fallback);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fallback);
      }, 10000);
      this.pending.set(id, { action, fallback, resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, windowId, processId, bounds, desktopId })}\n`, (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(fallback);
      });
    });
  }

  start() {
    if (this.child) return;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      request.resolve(request.action === 'move' ? !!message.moved : message.desktopId || 'unknown');
    });
    child.once('error', () => this.onExit(child));
    child.once('exit', () => this.onExit(child));
  }

  onExit(child) {
    if (this.child !== child) return;
    this.child = null;
    for (const { fallback, resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(fallback);
    }
    this.pending.clear();
  }

  dispose() {
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const { fallback, resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(fallback);
    }
    this.pending.clear();
  }
}

module.exports = { VirtualDesktopResolver };
