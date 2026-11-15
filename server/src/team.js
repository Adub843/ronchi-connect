'use strict';
/**
 * Technician-to-technician features: direct chat, "flag for help" alerts and
 * voice calls. Voice audio itself travels peer to peer over WebRTC; this
 * module only rings the other person and relays the call setup messages.
 */
const crypto = require('crypto');
const { ProtocolError, text } = require('./errors');
const { publicUser } = require('./auth');

const RING_TIMEOUT_MS = 45000;
const MAX_CHAT_LENGTH = 4000;

class TeamManager {
  constructor(hub) {
    this.hub = hub;
    this.calls = new Map(); // call id -> { id, caller, calleeUserId, callee, timer }

    hub.on('chat.send', 'tech', (c, m) => this.chatSend(c, m));
    hub.on('chat.history', 'tech', (c, m) => this.chatHistory(c, m));
    hub.on('flag.send', 'tech', (c, m) => this.flagSend(c, m));
    hub.on('flag.respond', 'tech', (c, m) => this.flagRespond(c, m));
    hub.on('call.invite', 'tech', (c, m) => this.callInvite(c, m));
    hub.on('call.answer', 'tech', (c, m) => this.callAnswer(c, m));
    hub.on('call.signal', 'tech', (c, m) => this.callSignal(c, m));
    hub.on('call.end', 'tech', (c, m) => this.callEnd(c, m));
  }

  _user(id) {
    const user = this.hub.store.findUserById(id);
    if (!user) throw new ProtocolError('not_found', 'That teammate was not found.');
    return user;
  }

  // ---------------------------------------------------------------- direct chat

  chatSend(client, msg) {
    const to = this._user(msg.to);
    const body = text(msg.text, MAX_CHAT_LENGTH);
    if (!body) throw new ProtocolError('invalid', 'Message is empty.');
    const message = {
      id: crypto.randomUUID(),
      from: client.user.id,
      to: to.id,
      text: body,
      at: new Date().toISOString(),
    };
    this.hub.store.addChatMessage(message, this.hub.config.chatHistoryLimit);
    this.hub.sendToUser(to.id, 'chat.message', { message });
    if (to.id !== client.user.id) this.hub.sendToUser(client.user.id, 'chat.message', { message });
    return { message };
  }

  chatHistory(client, msg) {
    const other = this._user(msg.with);
    return { with: other.id, messages: this.hub.store.getChat(client.user.id, other.id) };
  }

  // ---------------------------------------------------------------- flag for help

  /** Pops an alert on one teammate's screen, or on everyone's when `to` is "all". */
  flagSend(client, msg) {
    const session = this.hub.sessions.get(client.sessionId);
    const flag = {
      id: crypto.randomUUID(),
      from: publicUser(client.user),
      message: text(msg.message, 500) || 'I need a hand.',
      sessionId: session ? session.id : null,
      customer: session ? session.host.device.deviceName : null,
      at: new Date().toISOString(),
    };
    let delivered = 0;
    if (msg.to === 'all') {
      for (const userId of this.hub.techsByUser.keys()) {
        if (userId !== client.user.id) delivered += this.hub.sendToUser(userId, 'flag.raised', { flag });
      }
    } else {
      delivered = this.hub.sendToUser(this._user(msg.to).id, 'flag.raised', { flag });
    }
    if (!delivered) throw new ProtocolError('offline', 'Nobody is online to receive the flag.');
    // Flagging from inside a session also invites the recipients to it.
    if (session) {
      const targets = msg.to === 'all' ? [...this.hub.techsByUser.keys()] : [msg.to];
      for (const userId of targets) session.invitedUserIds.add(userId);
    }
    return { flag, delivered };
  }

  flagRespond(client, msg) {
    const response = msg.response === 'coming' ? 'coming' : 'busy';
    this.hub.sendToUser(this._user(msg.to).id, 'flag.response', {
      flagId: text(msg.flagId, 64),
      from: publicUser(client.user),
      response,
    });
  }

  // ---------------------------------------------------------------- voice calls

  callInvite(caller, msg) {
    const callee = this._user(msg.to);
    if (callee.id === caller.user.id) throw new ProtocolError('invalid', 'You cannot call yourself.');
    const call = { id: crypto.randomUUID(), caller, calleeUserId: callee.id, callee: null, timer: null };
    const rang = this.hub.sendToUser(callee.id, 'call.incoming', { callId: call.id, from: publicUser(caller.user) });
    if (!rang) throw new ProtocolError('offline', `${callee.name} is not online.`);
    call.timer = setTimeout(() => this._finish(call, 'no_answer'), RING_TIMEOUT_MS);
    this.calls.set(call.id, call);
    return { callId: call.id };
  }

  callAnswer(client, msg) {
    const call = this.calls.get(msg.callId);
    if (!call || call.calleeUserId !== client.user.id || call.callee) {
      throw new ProtocolError('no_call', 'That call is no longer ringing.');
    }
    if (!msg.accept) return this._finish(call, 'declined');
    clearTimeout(call.timer);
    call.callee = client;
    // Stop the ringing on the callee's other devices.
    for (const other of this.hub.techsByUser.get(client.user.id) || []) {
      if (other !== client) other.send('call.ended', { callId: call.id, reason: 'answered_elsewhere' });
    }
    // The caller creates the WebRTC offer when it sees this.
    call.caller.send('call.accepted', { callId: call.id, by: publicUser(client.user) });
  }

  callSignal(client, msg) {
    const call = this.calls.get(msg.callId);
    if (!call || !call.callee) throw new ProtocolError('no_call', 'That call is not connected.');
    const other = client === call.caller ? call.callee : client === call.callee ? call.caller : null;
    if (!other) throw new ProtocolError('not_allowed', 'You are not part of that call.');
    other.send('call.signal', { callId: call.id, data: msg.data });
  }

  callEnd(client, msg) {
    const call = this.calls.get(msg.callId);
    if (!call) return;
    const involved = client === call.caller || client === call.callee
      || (!call.callee && client.user.id === call.calleeUserId);
    if (involved) this._finish(call, 'hung_up');
  }

  _finish(call, reason) {
    if (!this.calls.delete(call.id)) return;
    clearTimeout(call.timer);
    const event = { callId: call.id, reason };
    call.caller.send('call.ended', event);
    if (call.callee) call.callee.send('call.ended', event);
    else this.hub.sendToUser(call.calleeUserId, 'call.ended', event);
  }

  onDisconnect(client) {
    for (const call of [...this.calls.values()]) {
      if (call.caller === client || call.callee === client) this._finish(call, 'disconnected');
    }
  }
}

module.exports = { TeamManager };
