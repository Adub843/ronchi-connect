'use strict';
/**
 * Small file-backed data store.
 *
 * A support team is tens of people, not millions, so plain JSON files are
 * enough and keep the server free of a database to install and back up.
 * Everything that touches the disk lives in this file; to move to SQLite or
 * Postgres later, re-implement this class with the same methods.
 *
 *   users.json       technician accounts (password hashes, never plain text)
 *   tokens.json      hashed sign-in tokens
 *   chats.json       direct messages between technicians
 *   sessions.jsonl   append-only audit log, one finished session per line
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.users = this._read('users.json', []);
    this.tokens = this._read('tokens.json', []);
    this.chats = this._read('chats.json', {});
  }

  _file(name) {
    return path.join(this.dataDir, name);
  }

  _read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this._file(name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw new Error(`Cannot read ${name}: ${err.message}`);
    }
  }

  /** Write to a temp file then rename, so a crash never leaves a half-written file. */
  _write(name, value) {
    const tmp = this._file(`${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this._file(name));
  }

  // ---- users ----
  listUsers() { return this.users; }
  findUserById(id) { return this.users.find((u) => u.id === id) || null; }
  findUserByUsername(username) {
    const wanted = String(username || '').trim().toLowerCase();
    return this.users.find((u) => u.username === wanted) || null;
  }
  saveUser(user) {
    const index = this.users.findIndex((u) => u.id === user.id);
    if (index === -1) this.users.push(user); else this.users[index] = user;
    this._write('users.json', this.users);
  }
  removeUser(id) {
    this.users = this.users.filter((u) => u.id !== id);
    this.tokens = this.tokens.filter((t) => t.userId !== id);
    this._write('users.json', this.users);
    this._write('tokens.json', this.tokens);
  }

  // ---- sign-in tokens ----
  addToken(record) {
    this.tokens.push(record);
    this._write('tokens.json', this.tokens);
  }
  findToken(hash) {
    return this.tokens.find((t) => t.hash === hash) || null;
  }
  removeTokens(predicate) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => !predicate(t));
    if (this.tokens.length !== before) this._write('tokens.json', this.tokens);
  }

  // ---- direct chat ----
  /** Conversations are keyed by the two user ids sorted, so A↔B and B↔A share one history. */
  static chatKey(a, b) { return [a, b].sort().join(':'); }
  getChat(a, b) { return this.chats[Store.chatKey(a, b)] || []; }
  addChatMessage(message, limit) {
    const key = Store.chatKey(message.from, message.to);
    const list = this.chats[key] || (this.chats[key] = []);
    list.push(message);
    if (list.length > limit) list.splice(0, list.length - limit);
    this._write('chats.json', this.chats);
  }

  // ---- session audit log ----
  appendSessionRecord(record) {
    fs.appendFileSync(this._file('sessions.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  /** Most recent sessions first. */
  listSessionRecords(limit = 200) {
    let text;
    try { text = fs.readFileSync(this._file('sessions.jsonl'), 'utf8'); } catch { return []; }
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((line) => JSON.parse(line));
  }
}

module.exports = { Store };
