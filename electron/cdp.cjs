const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

class CDP extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url, { maxPayload: 32 * 1024 * 1024 });
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.on('error', () => {});
      this.socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id) {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result || {});
        } else if (message.method) {
          this.emit(message.method, message.params || {}, message.sessionId);
        }
      });
      this.socket.on('close', () => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Browser disconnected'));
        }
        this.pending.clear();
        this.emit('disconnect');
      });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser is not connected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket?.close(); }
}

module.exports = { CDP };
