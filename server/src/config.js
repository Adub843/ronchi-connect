'use strict';
/**
 * Server configuration. Every setting comes from an environment variable so
 * the same code runs locally, in Docker and in tests. See deploy/.env.example.
 */
const path = require('path');

function int(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function loadConfig(overrides = {}) {
  return {
    port: int('PORT', 8080),
    // Folder holding users.json, chats.json and the session audit log.
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
    // Public website and installer downloads served by this process.
    websiteDir: process.env.WEBSITE_DIR || path.join(__dirname, '..', '..', 'website'),
    brandDir: process.env.BRAND_DIR || path.join(__dirname, '..', '..', 'brand'),
    downloadsDir: process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads'),
    // First-run administrator. Only used when no users exist yet.
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    // TURN relay (coturn). Leave TURN_HOST empty to run with STUN only.
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').filter(Boolean),
    turnHost: process.env.TURN_HOST || '',
    turnSecret: process.env.TURN_SECRET || '',
    turnTls: process.env.TURN_TLS === '1',
    turnTtlSeconds: int('TURN_TTL_SECONDS', 6 * 60 * 60),
    // Security limits.
    tokenTtlDays: int('TOKEN_TTL_DAYS', 30),
    consentTimeoutSeconds: int('CONSENT_TIMEOUT_SECONDS', 90),
    maxFailedLoginsPerWindow: int('MAX_FAILED_LOGINS', 8),
    maxFailedCodesPerWindow: int('MAX_FAILED_CODES', 6),
    rateWindowSeconds: int('RATE_WINDOW_SECONDS', 600),
    chatHistoryLimit: int('CHAT_HISTORY_LIMIT', 500),
    // Set to "1" when running behind Caddy/nginx so client IPs are read from X-Forwarded-For.
    trustProxy: process.env.TRUST_PROXY === '1',
    ...overrides,
  };
}

module.exports = { loadConfig };
