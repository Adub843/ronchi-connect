'use strict';
/**
 * Technician accounts: password hashing, sign-in tokens and rate limiting.
 *
 * Passwords are hashed with scrypt (built into Node) and a per-user salt.
 * Sign-in tokens are random 256-bit values; only their SHA-256 hash is stored,
 * so a leaked data folder does not contain usable tokens.
 */
const crypto = require('crypto');

const SCRYPT_KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Counts failures per key (an IP address or user id) inside a sliding time window. */
class RateLimiter {
  constructor(maxFailures, windowSeconds) {
    this.maxFailures = maxFailures;
    this.windowMs = windowSeconds * 1000;
    this.failures = new Map();
  }
  _recent(key) {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.failures.get(key) || []).filter((time) => time > cutoff);
    this.failures.set(key, list);
    return list;
  }
  isBlocked(key) { return this._recent(key).length >= this.maxFailures; }
  recordFailure(key) { this._recent(key).push(Date.now()); }
  reset(key) { this.failures.delete(key); }
}

class Auth {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  /** Creates the first administrator so a fresh server can be signed in to. */
  ensureFirstAdmin(log = console.log) {
    if (this.store.listUsers().length > 0) return;
    let password = this.config.adminPassword;
    const generated = !password;
    if (generated) password = crypto.randomBytes(12).toString('base64url');
    this.createUser({ username: this.config.adminUsername, name: 'Administrator', password, role: 'admin' });
    if (generated) {
      log(`\nFirst-run administrator created.\n  username: ${this.config.adminUsername}\n  password: ${password}\nSign in and change this password.\n`);
    }
  }

  validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }

  createUser({ username, name, password, role }) {
    username = String(username || '').trim().toLowerCase();
    name = String(name || '').trim() || username;
    if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
      throw new Error('Username must be 2-40 characters: letters, numbers, dot, dash or underscore.');
    }
    if (this.store.findUserByUsername(username)) throw new Error('That username is already taken.');
    this.validatePassword(password);
    const user = {
      id: crypto.randomUUID(),
      username,
      name: name.slice(0, 60),
      role: role === 'admin' ? 'admin' : 'tech',
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    this.store.saveUser(user);
    return user;
  }

  setPassword(userId, password) {
    const user = this.store.findUserById(userId);
    if (!user) throw new Error('User not found.');
    this.validatePassword(password);
    user.passwordHash = hashPassword(password);
    this.store.saveUser(user);
    // Changing a password signs the user out everywhere.
    this.store.removeTokens((t) => t.userId === userId);
  }

  checkPassword(username, password) {
    const user = this.store.findUserByUsername(username);
    // Hash even when the user is unknown so response time does not reveal which usernames exist.
    const stored = user ? user.passwordHash : hashPassword('unknown-user');
    return verifyPassword(password, stored) && user ? user : null;
  }

  issueToken(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.config.tokenTtlDays * 24 * 60 * 60 * 1000;
    this.store.removeTokens((t) => t.expiresAt < Date.now());
    this.store.addToken({ hash: sha256(token), userId, expiresAt });
    return token;
  }

  userForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const record = this.store.findToken(sha256(token));
    if (!record || record.expiresAt < Date.now()) return null;
    return this.store.findUserById(record.userId);
  }

  revokeToken(token) {
    if (typeof token !== 'string') return;
    const hash = sha256(token);
    this.store.removeTokens((t) => t.hash === hash);
  }
}

/** The fields of a user that are safe to send to other clients. */
function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role };
}

module.exports = { Auth, RateLimiter, publicUser, hashPassword, verifyPassword };
