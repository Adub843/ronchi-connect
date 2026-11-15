'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/app');

/** Start a server on a random port with a throwaway data folder. */
async function startTestServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronchi-test-'));
  const config = loadConfig({ port: 0, dataDir, adminPassword: 'admin-password-1', ...overrides });
  const quiet = { log() {}, error() {} };
  const ctx = createServer(config, quiet);
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  const url = `ws://127.0.0.1:${ctx.server.address().port}/ws`;
  const clients = [];
  return {
    ...ctx,
    config,
    url,
    httpUrl: `http://127.0.0.1:${ctx.server.address().port}`,
    connect: async () => { const c = await openClient(url); clients.push(c); return c; },
    async stop() {
      for (const c of clients) c.ws.terminate();
      ctx.hub.close();
      await new Promise((resolve) => ctx.server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A tiny test client: request() awaits the reply, next() awaits a pushed event. */
function openClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    const waiters = [];
    const pending = new Map();
    let nextId = 1;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'reply') {
        const p = pending.get(msg.reqId);
        if (p) { pending.delete(msg.reqId); p(msg); }
        return;
      }
      const index = waiters.findIndex((w) => w.type === msg.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
      else events.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      request(type, payload = {}) {
        const reqId = nextId++;
        ws.send(JSON.stringify({ type, reqId, ...payload }));
        return new Promise((res) => pending.set(reqId, res));
      },
      next(type, timeoutMs = 2000) {
        const index = events.findIndex((e) => e.type === type);
        if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`Timed out waiting for "${type}"`)), timeoutMs);
          waiters.push({ type, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      close() { ws.close(); },
    }));
  });
}

module.exports = { startTestServer };
