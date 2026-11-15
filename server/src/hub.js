'use strict';
/**
 * The WebSocket hub: accepts connections from desktop apps and routes messages.
 *
 * Two kinds of client connect here:
 *   host  a customer computer waiting for support. No account needed.
 *   tech  a signed-in Ronchi technician.
 *
 * Every message is JSON: { type, reqId?, ...fields }. If the client sends a
 * reqId the hub answers with { type: 'reply', reqId, ok, ... } so the app can
 * await a result. Events the server starts on its own have no reqId.
 * The full list of messages is in docs/PROTOCOL.md.
 *
 * The hub only carries small control messages. Screen video, input, files and
 * voice travel directly between the two computers over WebRTC (encrypted end
 * to end with DTLS) and never pass through this process.
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ProtocolError, text } = require('./errors');
const { RateLimiter, publicUser } = require('./auth');
const { buildIceServers } = require('./ice');
const { SessionManager } = require('./sessions');
const { TeamManager } = require('./team');
const { registerAdminHandlers } = require('./admin');

const HEARTBEAT_MS = 30000;
const MAX_MESSAGE_BYTES = 256 * 1024;

class Hub {
  constructor({ config, store, auth, log = console }) {
    this.config = config;
    this.store = store;
    this.auth = auth;
    this.log = log;

    this.clients = new Map();        // connection id -> client
    this.hostsByCode = new Map();    // 9-digit support code -> host client
    this.techsByUser = new Map();    // user id -> Set of that user's connections

    this.loginLimiter = new RateLimiter(config.maxFailedLoginsPerWindow, config.rateWindowSeconds);

    /** type -> { role, fn }. role is 'any', 'host', 'tech' or 'admin'. */
    this.handlers = new Map();
    this._registerCoreHandlers();
    this.sessions = new SessionManager(this);
    this.team = new TeamManager(this);
    registerAdminHandlers(this);
  }

  /** Register a message handler. Used by the feature modules. */
  on(type, role, fn) {
    this.handlers.set(type, { role, fn });
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.heartbeat = setInterval(() => this._checkHeartbeats(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients.values()) client.ws.terminate();
    if (this.wss) this.wss.close();
  }

  // ------------------------------------------------------------ connections

  _onConnection(ws, req) {
    const forwarded = this.config.trustProxy && req.headers['x-forwarded-for'];
    const client = {
      id: crypto.randomUUID(),
      ws,
      ip: forwarded ? String(forwarded).split(',')[0].trim() : req.socket.remoteAddress,
      role: null,          // becomes 'host' or 'tech'
      user: null,          // tech only
      token: null,         // tech only
      status: 'available', // tech only: available | busy | away
      device: null,        // host only: { deviceName, os, appVersion }
      code: null,          // host only: current support code
      sessionId: null,     // the remote session this connection is part of, if any
      alive: true,
      send: (type, payload = {}) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
      },
    };
    this.clients.set(client.id, client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => this._onMessage(client, data));
    ws.on('close', () => this._onClose(client));
    ws.on('error', () => ws.terminate());
  }

  async _onMessage(client, data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return client.send('reply', { ok: false, error: { code: 'bad_json', message: 'Message was not valid JSON.' } });
    }
    const { type, reqId } = message;
    const reply = (body) => { if (reqId !== undefined) client.send('reply', { reqId, ...body }); };
    try {
      const handler = this.handlers.get(type);
      if (!handler) throw new ProtocolError('unknown_type', `Unknown message type "${type}".`);
      this._checkRole(client, handler.role);
      const result = await handler.fn(client, message);
      reply({ ok: true, ...(result || {}) });
    } catch (err) {
      if (!(err instanceof ProtocolError)) this.log.error(`Handler for "${type}" failed:`, err);
      const error = err instanceof ProtocolError
        ? { code: err.code, message: err.message }
        : { code: 'server_error', message: 'Something went wrong on the server.' };
      reply({ ok: false, error });
    }
  }

  _checkRole(client, role) {
    if (role === 'any') return;
    if (role === 'host' && client.role === 'host') return;
    if (role === 'tech' && client.role === 'tech') return;
    if (role === 'admin' && client.role === 'tech' && client.user.role === 'admin') return;
    throw new ProtocolError('not_allowed', 'You are not allowed to do that.');
  }

  _onClose(client) {
    this.clients.delete(client.id);
    this.sessions.onDisconnect(client);
    if (client.role === 'host' && client.code) this.hostsByCode.delete(client.code);
    if (client.role === 'tech') {
      this.team.onDisconnect(client);
      const set = this.techsByUser.get(client.user.id);
      if (set) {
        set.delete(client);
        if (set.size === 0) this.techsByUser.delete(client.user.id);
      }
      this.broadcastPresence();
    }
  }

  _checkHeartbeats() {
    for (const client of this.clients.values()) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false;
      client.ws.ping();
    }
  }

  // ------------------------------------------------------------ core handlers

  _registerCoreHandlers() {
    this.on('ping', 'any', () => ({}));

    // A customer computer announces itself and receives a support code.
    this.on('host.register', 'any', (client, msg) => {
      if (client.role === 'tech') throw new ProtocolError('not_allowed', 'Technician connections cannot register as a customer computer.');
      if (client.sessionId) throw new ProtocolError('in_session', 'The code cannot change during a session.');
      client.role = 'host';
      client.device = {
        deviceName: text(msg.deviceName, 80) || 'Customer computer',
        os: text(msg.os, 40),
        appVersion: text(msg.appVersion, 20),
      };
      return this.assignHostCode(client);
    });

    this.on('host.newCode', 'host', (client) => {
      if (client.sessionId) throw new ProtocolError('in_session', 'The code cannot change during a session.');
      return this.assignHostCode(client);
    });

    this.on('auth.login', 'any', (client, msg) => {
      if (this.loginLimiter.isBlocked(client.ip)) {
        throw new ProtocolError('rate_limited', 'Too many failed sign-in attempts. Please wait a few minutes.');
      }
      const user = this.auth.checkPassword(msg.username, msg.password);
      if (!user) {
        this.loginLimiter.recordFailure(client.ip);
        throw new ProtocolError('bad_credentials', 'Wrong username or password.');
      }
      this.loginLimiter.reset(client.ip);
      return this._signIn(client, user, this.auth.issueToken(user.id));
    });

    // Sign back in after a restart or a dropped connection, using the saved token.
    this.on('auth.resume', 'any', (client, msg) => {
      const user = this.auth.userForToken(msg.token);
      if (!user) throw new ProtocolError('bad_token', 'Your sign-in has expired. Please sign in again.');
      return this._signIn(client, user, msg.token);
    });

    this.on('auth.logout', 'tech', (client) => {
      this.auth.revokeToken(client.token);
      // Close after the reply has been sent.
      setImmediate(() => client.ws.close());
    });

    this.on('account.changePassword', 'tech', (client, msg) => {
      if (!this.auth.checkPassword(client.user.username, msg.current)) {
        throw new ProtocolError('bad_credentials', 'Your current password is not correct.');
      }
      try { this.auth.setPassword(client.user.id, msg.next); } catch (err) { throw new ProtocolError('invalid', err.message); }
      // setPassword signed every device out; give this one a fresh token.
      client.token = this.auth.issueToken(client.user.id);
      return { token: client.token };
    });

    this.on('status.set', 'tech', (client, msg) => {
      if (!['available', 'busy', 'away'].includes(msg.status)) throw new ProtocolError('invalid', 'Unknown status.');
      for (const other of this.techsByUser.get(client.user.id) || []) other.status = msg.status;
      this.broadcastPresence();
    });
  }

  _signIn(client, user, token) {
    if (client.role === 'host') throw new ProtocolError('not_allowed', 'This connection is registered as a customer computer.');
    client.role = 'tech';
    client.user = user;
    client.token = token;
    if (!this.techsByUser.has(user.id)) this.techsByUser.set(user.id, new Set());
    this.techsByUser.get(user.id).add(client);
    this.broadcastPresence();
    return {
      user: publicUser(user),
      token,
      peerId: client.id,
      iceServers: buildIceServers(this.config, user.id),
      team: this.presenceList(),
    };
  }

  /** Give a host a fresh random support code. Old code stops working immediately. */
  assignHostCode(client) {
    if (client.code) this.hostsByCode.delete(client.code);
    let code;
    do {
      code = String(crypto.randomInt(0, 1000000000)).padStart(9, '0');
    } while (this.hostsByCode.has(code));
    client.code = code;
    this.hostsByCode.set(code, client);
    const result = { code, iceServers: buildIceServers(this.config, 'host') };
    client.send('host.code', result);
    return result;
  }

  // ------------------------------------------------------------ presence

  /** Everyone on the team with their current state, for the technician sidebar. */
  presenceList() {
    return this.store.listUsers().map((user) => {
      const connections = [...(this.techsByUser.get(user.id) || [])];
      const inSession = connections.map((c) => this.sessions.get(c.sessionId)).find(Boolean);
      return {
        ...publicUser(user),
        online: connections.length > 0,
        status: connections.length ? connections[0].status : 'offline',
        inSessionWith: inSession ? inSession.host.device.deviceName : null,
      };
    });
  }

  broadcastPresence() {
    const team = this.presenceList();
    for (const client of this.clients.values()) {
      if (client.role === 'tech') client.send('presence', { team });
    }
  }

  /** Send an event to every connection a user has open. Returns how many received it. */
  sendToUser(userId, type, payload) {
    const connections = this.techsByUser.get(userId) || [];
    for (const client of connections) client.send(type, payload);
    return connections.size || 0;
  }
}

module.exports = { Hub };
