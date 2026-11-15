/**
 * The signed-in technician: account, team presence and the server connection
 * used for all technician features. Screens listen with onChange().
 */
export class TechClient {
  constructor(connection) {
    this.conn = connection;
    this.user = null;        // { id, username, name, role }
    this.peerId = null;      // this connection's id inside sessions
    this.iceServers = [];
    this.team = [];          // everyone on the team with presence
    this.status = 'available';
    this.listeners = new Set();

    this.conn.on('presence', (m) => { this.team = m.team; this._changed(); });
    // After a dropped connection, sign back in with the saved token.
    this.conn.on('open', () => { if (this.user) this.resume().catch(() => this._signedOut()); });
    this.conn.on('close', () => this._changed());
  }

  onChange(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  _changed() { for (const callback of this.listeners) callback(); }

  get signedIn() { return Boolean(this.user); }
  get online() { return this.conn.isOpen; }
  get teammates() { return this.team.filter((member) => !this.user || member.id !== this.user.id); }
  member(id) { return this.team.find((m) => m.id === id) || null; }

  async _accept(reply) {
    this.user = reply.user;
    this.peerId = reply.peerId;
    this.iceServers = reply.iceServers;
    this.team = reply.team;
    await window.ronchi.settings.setToken(reply.token);
    await window.ronchi.tech.setSignedIn(true);
    if (this.status !== 'available') this.setStatus(this.status);
    this._changed();
  }

  async login(username, password) {
    await this._accept(await this.conn.request('auth.login', { username, password }));
  }

  /** Try the saved sign-in. Returns false when there is none or it has expired. */
  async resume() {
    const token = await window.ronchi.settings.getToken();
    if (!token) return false;
    try {
      await this._accept(await this.conn.request('auth.resume', { token }));
      return true;
    } catch (err) {
      if (err.code === 'bad_token') await window.ronchi.settings.setToken(null);
      throw err;
    }
  }

  async logout() {
    await this.conn.request('auth.logout').catch(() => {});
    await window.ronchi.settings.setToken(null);
    this._signedOut();
  }

  async _signedOut() {
    this.user = null;
    this.team = [];
    await window.ronchi.tech.setSignedIn(false);
    this._changed();
  }

  async setStatus(status) {
    this.status = status;
    await this.conn.request('status.set', { status });
  }
}
