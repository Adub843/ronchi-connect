'use strict';
/**
 * Remote support sessions.
 *
 * Life of a session:
 *   1. The customer reads their 9-digit code to a technician.
 *   2. The technician sends `session.connect` with the code.
 *   3. The customer's app shows a consent prompt (`session.request`) naming
 *      the technician. Nothing is shared until the customer clicks Allow.
 *   4. On Allow, both sides get each other's details and exchange WebRTC
 *      `signal` messages through this server to set up the direct link.
 *   5. More technicians can be invited (`session.invite`). The customer
 *      approves each person individually.
 *   6. Either side can end the session. A record is written to the audit log
 *      and the customer's code is replaced so the old one cannot be reused.
 *
 * Only signed-in technicians can use a code, and wrong guesses are rate
 * limited, so a code on its own is useless to an outsider.
 */
const crypto = require('crypto');
const { ProtocolError, text } = require('./errors');
const { RateLimiter, publicUser } = require('./auth');

const MAX_NOTES_LENGTH = 20000;
const MAX_CHAT_LENGTH = 4000;

class SessionManager {
  constructor(hub) {
    this.hub = hub;
    this.sessions = new Map(); // session id -> session
    this.codeLimiter = new RateLimiter(hub.config.maxFailedCodesPerWindow, hub.config.rateWindowSeconds);

    hub.on('session.connect', 'tech', (c, m) => this.connect(c, m));
    hub.on('session.join', 'tech', (c, m) => this.joinInvited(c, m));
    hub.on('session.cancel', 'tech', (c, m) => this.cancelRequest(c, m));
    hub.on('session.consent', 'host', (c, m) => this.consent(c, m));
    hub.on('session.permissions', 'host', (c, m) => this.setPermissions(c, m));
    hub.on('session.invite', 'tech', (c, m) => this.invite(c, m));
    hub.on('session.leave', 'tech', (c) => this.leave(c, 'left'));
    hub.on('session.end', 'any', (c) => this.endByParticipant(c));
    hub.on('session.chat', 'any', (c, m) => this.chat(c, m));
    hub.on('session.notes', 'tech', (c, m) => this.notes(c, m));
    hub.on('signal', 'any', (c, m) => this.signal(c, m));
    hub.on('history.list', 'tech', () => ({ sessions: hub.store.listSessionRecords() }));
  }

  get(sessionId) {
    return sessionId ? this.sessions.get(sessionId) || null : null;
  }

  // ---------------------------------------------------------------- joining

  connect(tech, msg) {
    const limiterKey = tech.user.id;
    if (this.codeLimiter.isBlocked(limiterKey)) {
      throw new ProtocolError('rate_limited', 'Too many wrong codes. Please wait a few minutes and try again.');
    }
    const code = String(msg.code || '').replace(/\D/g, '');
    const host = this.hub.hostsByCode.get(code);
    if (!host) {
      this.codeLimiter.recordFailure(limiterKey);
      throw new ProtocolError('bad_code', 'No computer is waiting with that code. Check the code with the customer.');
    }
    const session = this.get(host.sessionId) || this._create(host);
    return this._requestConsent(session, tech);
  }

  /** A technician who was invited by a teammate asks to join. The customer still has to approve. */
  joinInvited(tech, msg) {
    const session = this.get(msg.sessionId);
    if (!session || !session.invitedUserIds.has(tech.user.id)) {
      throw new ProtocolError('not_invited', 'That session is no longer available.');
    }
    return this._requestConsent(session, tech);
  }

  _create(host) {
    const session = {
      id: crypto.randomUUID(),
      host,
      techs: new Map(),          // peer id (connection id) -> { client, joinedAt }
      pending: new Map(),        // peer id -> { client, timer } waiting for customer consent
      invitedUserIds: new Set(),
      permissions: { control: false, files: false },
      startedAt: null,
      notes: '',
      chat: [],
      technicianLog: [],         // for the audit record
    };
    this.sessions.set(session.id, session);
    host.sessionId = session.id;
    return session;
  }

  _requestConsent(session, tech) {
    if (tech.sessionId) throw new ProtocolError('in_session', 'You are already in a session. End it before starting another.');
    tech.sessionId = session.id;
    const timer = setTimeout(
      () => this._deny(session, tech.id, 'timeout'),
      this.hub.config.consentTimeoutSeconds * 1000,
    );
    session.pending.set(tech.id, { client: tech, timer });
    session.host.send('session.request', {
      sessionId: session.id,
      peer: this._peerInfo(tech),
      timeoutSeconds: this.hub.config.consentTimeoutSeconds,
    });
    return { sessionId: session.id, host: session.host.device };
  }

  cancelRequest(tech) {
    const session = this.get(tech.sessionId);
    if (session && session.pending.has(tech.id)) this._deny(session, tech.id, 'cancelled');
  }

  /** The customer answered the consent prompt. */
  consent(host, msg) {
    const session = this.get(host.sessionId);
    const request = session && session.pending.get(msg.peerId);
    if (!request) throw new ProtocolError('no_request', 'That request is no longer waiting.');
    if (!msg.accept) return this._deny(session, msg.peerId, 'declined');

    clearTimeout(request.timer);
    session.pending.delete(msg.peerId);
    const tech = request.client;
    const now = new Date().toISOString();
    if (!session.startedAt) {
      session.startedAt = now;
      session.permissions = this._cleanPermissions(msg.permissions);
    }
    const existingPeers = [...session.techs.values()].map((t) => this._peerInfo(t.client));
    session.techs.set(tech.id, { client: tech, joinedAt: now });
    session.technicianLog.push({ userId: tech.user.id, name: tech.user.name, joinedAt: now, leftAt: null });

    tech.send('session.started', {
      sessionId: session.id,
      host: host.device,
      permissions: session.permissions,
      peers: existingPeers,
      notes: session.notes,
      chat: session.chat,
    });
    // The host starts the WebRTC offer when it sees this.
    host.send('session.techJoined', { sessionId: session.id, peer: this._peerInfo(tech) });
    for (const other of session.techs.values()) {
      if (other.client !== tech) other.client.send('session.peerJoined', { sessionId: session.id, peer: this._peerInfo(tech) });
    }
    this.hub.broadcastPresence();
  }

  _deny(session, peerId, reason) {
    const request = session.pending.get(peerId);
    if (!request) return;
    clearTimeout(request.timer);
    session.pending.delete(peerId);
    request.client.sessionId = null;
    request.client.send('session.denied', { sessionId: session.id, reason });
    session.host.send('session.requestClosed', { sessionId: session.id, peerId, reason });
    this._endIfEmpty(session, 'no_technician');
  }

  // ---------------------------------------------------------------- during a session

  _memberSession(client) {
    const session = this.get(client.sessionId);
    const isMember = session && (session.host === client || session.techs.has(client.id));
    if (!isMember) throw new ProtocolError('no_session', 'You are not in a session.');
    return session;
  }

  /** The customer changes what technicians may do, e.g. switches to view-only. */
  setPermissions(host, msg) {
    const session = this._memberSession(host);
    session.permissions = this._cleanPermissions(msg.permissions);
    this._toTechs(session, 'session.permissions', { sessionId: session.id, permissions: session.permissions });
    return { permissions: session.permissions };
  }

  _cleanPermissions(input) {
    return { control: Boolean(input && input.control), files: Boolean(input && input.files) };
  }

  invite(tech, msg) {
    const session = this._memberSession(tech);
    const target = this.hub.store.findUserById(msg.to);
    if (!target) throw new ProtocolError('not_found', 'That teammate was not found.');
    session.invitedUserIds.add(target.id);
    const delivered = this.hub.sendToUser(target.id, 'session.invited', {
      sessionId: session.id,
      from: publicUser(tech.user),
      host: session.host.device,
    });
    if (!delivered) throw new ProtocolError('offline', `${target.name} is not online.`);
  }

  /** Relay a WebRTC signaling message between the host and one technician. */
  signal(client, msg) {
    const session = this._memberSession(client);
    if (client === session.host) {
      const tech = session.techs.get(msg.to);
      if (!tech) throw new ProtocolError('not_found', 'That technician is not in the session.');
      tech.client.send('signal', { sessionId: session.id, from: 'host', data: msg.data });
    } else {
      session.host.send('signal', { sessionId: session.id, from: client.id, data: msg.data });
    }
  }

  /** Chat that everyone in the session sees, including the customer. */
  chat(client, msg) {
    const session = this._memberSession(client);
    const body = text(msg.text, MAX_CHAT_LENGTH);
    if (!body) return;
    const entry = {
      from: client === session.host
        ? { role: 'customer', name: 'Customer' }
        : { role: 'tech', name: client.user.name, id: client.user.id },
      text: body,
      at: new Date().toISOString(),
    };
    session.chat.push(entry);
    this._toAll(session, 'session.chat', { sessionId: session.id, message: entry });
  }

  /** Shared notes that only technicians see. Saved with the audit record. */
  notes(tech, msg) {
    const session = this._memberSession(tech);
    session.notes = String(msg.text || '').slice(0, MAX_NOTES_LENGTH);
    for (const other of session.techs.values()) {
      if (other.client !== tech) other.client.send('session.notes', { sessionId: session.id, text: session.notes, by: tech.user.name });
    }
  }

  // ---------------------------------------------------------------- leaving and ending

  /** One technician leaves; the session continues if others remain. */
  leave(tech, reason) {
    const session = this.get(tech.sessionId);
    if (!session) return;
    if (session.pending.has(tech.id)) return this._deny(session, tech.id, 'cancelled');
    if (!session.techs.has(tech.id)) return;
    session.techs.delete(tech.id);
    tech.sessionId = null;
    const entry = session.technicianLog.find((t) => t.userId === tech.user.id && !t.leftAt);
    if (entry) entry.leftAt = new Date().toISOString();
    const event = { sessionId: session.id, peerId: tech.id, name: tech.user.name, reason };
    session.host.send('session.techLeft', event);
    this._toTechs(session, 'session.peerLeft', event);
    this._endIfEmpty(session, 'technician_left');
    this.hub.broadcastPresence();
  }

  /** `session.end`: the customer ends it for everyone; a technician just leaves. */
  endByParticipant(client) {
    const session = this.get(client.sessionId);
    if (!session) return;
    if (client === session.host) this._end(session, 'customer_ended');
    else this.leave(client, 'left');
  }

  onDisconnect(client) {
    const session = this.get(client.sessionId);
    if (!session) return;
    if (client === session.host) this._end(session, 'customer_disconnected');
    else this.leave(client, 'disconnected');
  }

  _endIfEmpty(session, reason) {
    if (session.techs.size === 0 && session.pending.size === 0) this._end(session, reason);
  }

  _end(session, reason) {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    const endedAt = new Date().toISOString();
    for (const request of session.pending.values()) {
      clearTimeout(request.timer);
      request.client.sessionId = null;
      request.client.send('session.denied', { sessionId: session.id, reason: 'ended' });
    }
    for (const tech of session.techs.values()) {
      tech.client.sessionId = null;
      tech.client.send('session.ended', { sessionId: session.id, reason });
    }
    session.host.sessionId = null;
    session.host.send('session.ended', { sessionId: session.id, reason });

    // Only sessions the customer actually approved are worth an audit record.
    if (session.startedAt) {
      for (const entry of session.technicianLog) if (!entry.leftAt) entry.leftAt = endedAt;
      this.hub.store.appendSessionRecord({
        id: session.id,
        startedAt: session.startedAt,
        endedAt,
        endReason: reason,
        host: { ...session.host.device, ip: session.host.ip },
        technicians: session.technicianLog,
        permissions: session.permissions,
        notes: session.notes,
        chat: session.chat,
      });
    }
    // A used code is never valid again.
    if (this.hub.clients.has(session.host.id)) this.hub.assignHostCode(session.host);
    this.hub.broadcastPresence();
  }

  // ---------------------------------------------------------------- helpers

  _peerInfo(tech) {
    return { peerId: tech.id, ...publicUser(tech.user) };
  }
  _toTechs(session, type, payload) {
    for (const tech of session.techs.values()) tech.client.send(type, payload);
  }
  _toAll(session, type, payload) {
    session.host.send(type, payload);
    this._toTechs(session, type, payload);
  }
}

module.exports = { SessionManager };
