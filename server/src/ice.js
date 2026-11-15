'use strict';
/**
 * Builds the ICE server list that both ends of a connection use to reach
 * each other through firewalls and NAT.
 *
 *   STUN  lets two computers discover their public addresses and connect
 *         directly (peer to peer) when their routers allow it.
 *   TURN  is our own relay (coturn). When a direct path is impossible,
 *         the already-encrypted traffic is relayed through it.
 *
 * TURN credentials are short lived and derived from a shared secret using
 * coturn's "use-auth-secret" scheme, so no relay password is ever stored in
 * the desktop app.
 */
const crypto = require('crypto');

function buildIceServers(config, label) {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnHost && config.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
    const username = `${expiry}:${label}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    const urls = [
      `turn:${config.turnHost}:3478?transport=udp`,
      `turn:${config.turnHost}:3478?transport=tcp`,
    ];
    // TLS on 5349 gets through firewalls that only allow HTTPS-like traffic. Needs a certificate on the relay.
    if (config.turnTls) urls.push(`turns:${config.turnHost}:5349?transport=tcp`);
    servers.push({
      urls,
      username,
      credential,
    });
  }
  return servers;
}

module.exports = { buildIceServers };
