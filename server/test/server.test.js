'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let srv;
before(async () => {
  srv = await startTestServer({ maxFailedCodesPerWindow: 3 });
  srv.auth.createUser({ username: 'aaron', name: 'Aaron', password: 'correct-horse-1' });
  srv.auth.createUser({ username: 'maria', name: 'Maria', password: 'correct-horse-2' });
});
after(() => srv.stop());

async function tech(username, password) {
  const client = await srv.connect();
  const reply = await client.request('auth.login', { username, password });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  client.me = reply.user;
  client.peerId = reply.peerId;
  return client;
}

async function host(deviceName = 'Filler line PC') {
  const client = await srv.connect();
  const reply = await client.request('host.register', { deviceName, os: 'Windows 11' });
  client.code = reply.code;
  return client;
}

/** Runs the whole consent flow and returns once the technician is in the session. */
async function startSession(techClient, hostClient, permissions = { control: true, files: true }) {
  const reply = await techClient.request('session.connect', { code: hostClient.code });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  const request = await hostClient.next('session.request');
  await hostClient.request('session.consent', { peerId: request.peer.peerId, accept: true, permissions });
  return techClient.next('session.started');
}

test('sign-in rejects a wrong password and accepts the right one', async () => {
  const client = await srv.connect();
  const bad = await client.request('auth.login', { username: 'aaron', password: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad_credentials');
  const good = await client.request('auth.login', { username: 'Aaron', password: 'correct-horse-1' });
  assert.equal(good.ok, true);
  assert.equal(good.user.name, 'Aaron');
  assert.ok(good.token.length > 20);
  assert.ok(Array.isArray(good.iceServers));
});

test('a saved token signs back in, and stops working after logout', async () => {
  const first = await tech('aaron', 'correct-horse-1');
  const { token } = await first.request('auth.login', { username: 'aaron', password: 'correct-horse-1' });
  const second = await srv.connect();
  assert.equal((await second.request('auth.resume', { token })).ok, true);
  await second.request('auth.logout');
  const third = await srv.connect();
  assert.equal((await third.request('auth.resume', { token })).error.code, 'bad_token');
});

test('passwords are stored hashed', () => {
  const user = srv.store.findUserByUsername('aaron');
  assert.ok(user.passwordHash.startsWith('scrypt$'));
  assert.ok(!JSON.stringify(srv.store.listUsers()).includes('correct-horse-1'));
});

test('a customer computer gets a 9-digit code without an account', async () => {
  const h = await host();
  assert.match(h.code, /^\d{9}$/);
});

test('someone who is not signed in cannot use a code', async () => {
  const h = await host();
  const stranger = await srv.connect();
  const reply = await stranger.request('session.connect', { code: h.code });
  assert.equal(reply.error.code, 'not_allowed');
});

test('nothing starts until the customer allows it, then signals are relayed both ways', async () => {
  const h = await host();
  const t = await tech('aaron', 'correct-horse-1');
  const reply = await t.request('session.connect', { code: h.code.replace(/(\d{3})(\d{3})/, '$1 $2 ') });
  assert.equal(reply.ok, true);
  assert.equal(reply.host.deviceName, 'Filler line PC');

  const request = await h.next('session.request');
  assert.equal(request.peer.name, 'Aaron');
  // Before consent the technician is not a member, so signaling is refused.
  assert.equal((await t.request('signal', { data: { x: 1 } })).error.code, 'no_session');

  await h.request('session.consent', { peerId: request.peer.peerId, accept: true, permissions: { control: true, files: false } });
  const started = await t.next('session.started');
  assert.deepEqual(started.permissions, { control: true, files: false });
  const joined = await h.next('session.techJoined');

  await h.request('signal', { to: joined.peer.peerId, data: { sdp: 'offer' } });
  assert.deepEqual((await t.next('signal')).data, { sdp: 'offer' });
  await t.request('signal', { data: { sdp: 'answer' } });
  const back = await h.next('signal');
  assert.equal(back.from, joined.peer.peerId);
  assert.deepEqual(back.data, { sdp: 'answer' });
  await h.request('session.end');
});

test('declining tells the technician and leaves no session behind', async () => {
  const h = await host();
  const t = await tech('aaron', 'correct-horse-1');
  await t.request('session.connect', { code: h.code });
  const request = await h.next('session.request');
  await h.request('session.consent', { peerId: request.peer.peerId, accept: false });
  assert.equal((await t.next('session.denied')).reason, 'declined');
  assert.equal(srv.hub.sessions.sessions.size, 0);
  assert.equal(srv.store.listSessionRecords().some((r) => r.id === request.sessionId), false);
});

test('an unanswered request times out', async () => {
  const quick = await startTestServerQuick();
  try {
    quick.auth.createUser({ username: 'tina', name: 'Tina', password: 'correct-horse-3' });
    const h = await quick.connect();
    const { code } = await h.request('host.register', { deviceName: 'PC' });
    const t = await quick.connect();
    await t.request('auth.login', { username: 'tina', password: 'correct-horse-3' });
    await t.request('session.connect', { code });
    assert.equal((await t.next('session.denied', 3000)).reason, 'timeout');
  } finally { await quick.stop(); }
});
function startTestServerQuick() { return startTestServer({ consentTimeoutSeconds: 1 }); }

test('the customer can switch to view-only during a session', async () => {
  const h = await host();
  const t = await tech('aaron', 'correct-horse-1');
  await startSession(t, h);
  await h.request('session.permissions', { permissions: { control: false, files: false } });
  assert.deepEqual((await t.next('session.permissions')).permissions, { control: false, files: false });
  // A technician cannot grant themselves permissions.
  assert.equal((await t.request('session.permissions', { permissions: { control: true } })).error.code, 'not_allowed');
  await h.request('session.end');
});

test('ending a session writes an audit record and replaces the code', async () => {
  const h = await host('Capper HMI');
  const t = await tech('aaron', 'correct-horse-1');
  const oldCode = h.code;
  const started = await startSession(t, h);
  await t.request('session.notes', { text: 'Replaced nozzle 4 recipe.' });
  await t.request('session.chat', { text: 'All set!' });
  await h.next('session.chat');
  await h.next('host.code'); // from registration
  await h.request('session.end');
  assert.equal((await t.next('session.ended')).reason, 'customer_ended');

  const fresh = await h.next('host.code');
  assert.notEqual(fresh.code, oldCode);
  const reuse = await t.request('session.connect', { code: oldCode });
  assert.equal(reuse.error.code, 'bad_code');

  const record = srv.store.listSessionRecords().find((r) => r.id === started.sessionId);
  assert.equal(record.host.deviceName, 'Capper HMI');
  assert.equal(record.technicians[0].name, 'Aaron');
  assert.equal(record.notes, 'Replaced nozzle 4 recipe.');
  assert.equal(record.chat[0].text, 'All set!');
  assert.ok(record.endedAt);
});

test('wrong codes are rate limited', async () => {
  const t = await tech('maria', 'correct-horse-2');
  for (let i = 0; i < 3; i++) {
    assert.equal((await t.request('session.connect', { code: '000000000' })).error.code, 'bad_code');
  }
  assert.equal((await t.request('session.connect', { code: '000000000' })).error.code, 'rate_limited');
  srv.hub.sessions.codeLimiter.reset(t.me.id);
});

test('an invited teammate joins only after the customer approves them too', async () => {
  const h = await host();
  const aaron = await tech('aaron', 'correct-horse-1');
  const maria = await tech('maria', 'correct-horse-2');
  const started = await startSession(aaron, h);

  // Without an invitation the session id alone is not enough.
  assert.equal((await maria.request('session.join', { sessionId: started.sessionId })).error.code, 'not_invited');

  await aaron.request('session.invite', { to: maria.me.id });
  const invite = await maria.next('session.invited');
  assert.equal(invite.from.name, 'Aaron');
  await maria.request('session.join', { sessionId: invite.sessionId });
  await h.next('session.techJoined'); // aaron
  const request = await h.next('session.request');
  assert.equal(request.peer.name, 'Maria');
  await h.request('session.consent', { peerId: request.peer.peerId, accept: true });
  const mariaStarted = await maria.next('session.started');
  assert.equal(mariaStarted.peers[0].name, 'Aaron');
  assert.equal((await aaron.next('session.peerJoined')).peer.name, 'Maria');

  // One technician leaving keeps the session alive for the other.
  await aaron.request('session.leave');
  assert.equal((await maria.next('session.peerLeft')).name, 'Aaron');
  assert.equal(srv.hub.sessions.sessions.size, 1);
  await maria.request('session.leave');
  assert.equal((await h.next('session.ended')).reason, 'technician_left');
});

test('presence shows who is online and who is in a session', async () => {
  const aaron = await tech('aaron', 'correct-horse-1');
  const h = await host('Monoblock 2');
  await startSession(aaron, h);
  const maria = await srv.connect();
  const reply = await maria.request('auth.login', { username: 'maria', password: 'correct-horse-2' });
  const entry = reply.team.find((u) => u.username === 'aaron');
  assert.equal(entry.online, true);
  assert.equal(entry.inSessionWith, 'Monoblock 2');
  await h.request('session.end');
});

test('direct chat is delivered and kept in history', async () => {
  const aaron = await tech('aaron', 'correct-horse-1');
  const maria = await tech('maria', 'correct-horse-2');
  await aaron.request('chat.send', { to: maria.me.id, text: 'Got a minute?' });
  assert.equal((await maria.next('chat.message')).message.text, 'Got a minute?');
  const history = await maria.request('chat.history', { with: aaron.me.id });
  assert.equal(history.messages.at(-1).text, 'Got a minute?');
});

test('flag for help reaches the teammate and their answer comes back', async () => {
  const aaron = await tech('aaron', 'correct-horse-1');
  const maria = await tech('maria', 'correct-horse-2');
  const sent = await aaron.request('flag.send', { to: maria.me.id, message: 'Stuck on servo fault' });
  assert.equal(sent.ok, true);
  const raised = await maria.next('flag.raised');
  assert.equal(raised.flag.message, 'Stuck on servo fault');
  await maria.request('flag.respond', { to: aaron.me.id, flagId: raised.flag.id, response: 'coming' });
  assert.equal((await aaron.next('flag.response')).response, 'coming');
});

test('voice call: ring, accept, relay setup messages, hang up', async () => {
  const aaron = await tech('aaron', 'correct-horse-1');
  const maria = await tech('maria', 'correct-horse-2');
  const { callId } = await aaron.request('call.invite', { to: maria.me.id });
  const ring = await maria.next('call.incoming');
  assert.equal(ring.from.name, 'Aaron');
  // Setup messages are refused until the call is answered.
  assert.equal((await aaron.request('call.signal', { callId, data: {} })).error.code, 'no_call');
  await maria.request('call.answer', { callId, accept: true });
  await aaron.next('call.accepted');
  await aaron.request('call.signal', { callId, data: { sdp: 'offer' } });
  assert.deepEqual((await maria.next('call.signal')).data, { sdp: 'offer' });
  await maria.request('call.end', { callId });
  assert.equal((await aaron.next('call.ended')).reason, 'hung_up');
});

test('only admins can manage accounts', async () => {
  const aaron = await tech('aaron', 'correct-horse-1');
  assert.equal((await aaron.request('admin.users.list')).error.code, 'not_allowed');
  const admin = await tech('admin', 'admin-password-1');
  const created = await admin.request('admin.users.create', { username: 'newtech', name: 'New Tech', password: 'long-enough-pw' });
  assert.equal(created.ok, true);
  const weak = await admin.request('admin.users.create', { username: 'weak', name: 'Weak', password: 'short' });
  assert.equal(weak.error.code, 'invalid');
  await admin.request('admin.users.remove', { id: created.user.id });
  assert.equal(srv.store.findUserByUsername('newtech'), null);
});

test('a customer connection cannot use technician features', async () => {
  const h = await host();
  assert.equal((await h.request('chat.history', { with: 'x' })).error.code, 'not_allowed');
  assert.equal((await h.request('auth.login', { username: 'aaron', password: 'correct-horse-1' })).error.code, 'not_allowed');
});

test('health endpoint and security headers', async () => {
  const res = await fetch(`${srv.httpUrl}/api/health`);
  assert.equal((await res.json()).ok, true);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
