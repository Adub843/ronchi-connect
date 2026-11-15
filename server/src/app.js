'use strict';
/**
 * Builds the HTTP server: the public website, installer downloads, a health
 * check and the WebSocket hub. Kept separate from index.js so tests can start
 * a server on a random port.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Store } = require('./store');
const { Auth } = require('./auth');
const { Hub } = require('./hub');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};

function createServer(config, log = console) {
  const store = new Store(config.dataDir);
  const auth = new Auth(store, config);
  auth.ensureFirstAdmin(log.log ? log.log.bind(log) : console.log);
  const hub = new Hub({ config, store, auth, log });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => { res.set(SECURITY_HEADERS); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, name: 'ronchi-connect', hosts: hub.hostsByCode.size }));

  // Lists the installers in the downloads folder so the website can link to whatever is there.
  app.get('/api/downloads', (req, res) => {
    let files = [];
    try { files = fs.readdirSync(config.downloadsDir).filter((f) => /\.(exe|dmg|AppImage|deb)$/i.test(f)); } catch { /* none yet */ }
    res.json({
      files: files.map((name) => ({
        name,
        url: `/downloads/${encodeURIComponent(name)}`,
        platform: /\.exe$/i.test(name) ? 'windows' : /\.dmg$/i.test(name) ? 'mac' : 'linux',
        size: fs.statSync(path.join(config.downloadsDir, name)).size,
      })),
    });
  });
  app.use('/downloads', express.static(config.downloadsDir, { dotfiles: 'deny', index: false }));
  app.use('/brand', express.static(config.brandDir, { dotfiles: 'deny', index: false }));
  app.use(express.static(config.websiteDir, { dotfiles: 'deny', extensions: ['html'] }));

  const server = http.createServer(app);
  hub.attach(server);
  return { server, hub, store, auth };
}

module.exports = { createServer };
