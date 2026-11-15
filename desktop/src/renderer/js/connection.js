/**
 * WebSocket connection to the Ronchi Connect server.
 *
 *   const conn = new ServerConnection(url);
 *   conn.on('presence', (msg) => ...);          // events pushed by the server
 *   const reply = await conn.request('auth.login', { username, password });
 *
 * request() rejects with an Error (with .code) when the server answers with an
 * error. The connection reconnects by itself; 'open' and 'close' events let
 * the owner sign in again and update the display.
 */
const REQUEST_TIMEOUT_MS = 15000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const KEEPALIVE_MS = 25000;

export class ServerConnection {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.pending = new Map();
    this.nextRequestId = 1;
    this.attempt = 0;
    this.closedByUs = false;
    this.ws = null;
  }

  get isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  on(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
    return () => this.listeners.get(type).delete(callback);
  }

  _emit(type, message) {
    for (const callback of this.listeners.get(type) || []) {
      try { callback(message); } catch (err) { console.error(`Listener for "${type}" failed`, err); }
    }
  }

  connect() {
    this.closedByUs = false;
    clearTimeout(this.reconnectTimer);
    let ws;
    try { ws = new WebSocket(this.url); } catch (err) { this._emit('close', { error: err }); return this._scheduleReconnect(); }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.keepalive = setInterval(() => this.request('ping').catch(() => {}), KEEPALIVE_MS);
      this._emit('open', {});
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'reply') {
        const waiting = this.pending.get(message.reqId);
        if (!waiting) return;
        this.pending.delete(message.reqId);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message);
        else waiting.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      } else {
        this._emit(message.type, message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.keepalive);
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(Object.assign(new Error('Connection to the server was lost.'), { code: 'disconnected' }));
      }
      this.pending.clear();
      this._emit('close', {});
      if (!this.closedByUs) this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  /** Change server address (from Settings) and reconnect. */
  setUrl(url) {
    this.url = url;
    if (this.ws) { const old = this.ws; this.ws = null; old.close(); clearInterval(this.keepalive); this._emit('close', {}); }
    this.connect();
  }

  request(type, payload = {}) {
    if (!this.isOpen) {
      return Promise.reject(Object.assign(new Error('Not connected to the server.'), { code: 'disconnected' }));
    }
    const reqId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(Object.assign(new Error('The server did not answer in time.'), { code: 'timeout' }));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type, reqId, ...payload }));
    });
  }
}
