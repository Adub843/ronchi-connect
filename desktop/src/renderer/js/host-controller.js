/**
 * The customer ("host") side of a session: this computer's screen is shared.
 *
 * Responsibilities:
 *   - register with the server and keep the 9-digit support code current
 *   - show the consent prompt and do nothing until the person allows it
 *   - capture the screen and send it to each approved technician over WebRTC
 *   - apply the technician's mouse/keyboard input (only while control is allowed)
 *   - receive files, sync the clipboard, relay chat
 *   - end everything the moment the person clicks End session
 *
 * This class has no user interface of its own. The screens (customer-view.js
 * and the technician console) pass in a `ui` object with callbacks.
 */
import { FileChannel } from './file-transfer.js';

/** Video settings a technician can choose between. */
const QUALITY = {
  low: { maxBitrate: 900_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
  balanced: { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  high: { maxBitrate: 14_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
};

export class HostController {
  /**
   * @param {ServerConnection} connection  a connection used only for the host role
   * @param {object} info                  result of window.ronchi.info()
   */
  constructor(connection, info) {
    this.conn = connection;
    this.info = info;
    this.ui = {};                 // set with setUi()
    this.code = null;
    this.iceServers = [];
    this.connected = false;
    this.session = null;          // { id, permissions, peers: Map<peerId, peer> }
    this.prompts = new Map();     // peerId -> open consent prompt
    this.stream = null;
    this.displayId = null;
    this.sharing = false;
    this.onSharingChange = null;  // set by app.js

    this.conn.on('open', () => this._register());
    this.conn.on('close', () => { this.connected = false; this.code = null; this._teardown(); this._changed(); });
    this.conn.on('host.code', (m) => { this.code = m.code; this.iceServers = m.iceServers; this._changed(); });
    this.conn.on('session.request', (m) => this._onRequest(m));
    this.conn.on('session.requestClosed', (m) => this._closePrompt(m.peerId));
    this.conn.on('session.techJoined', (m) => this._onTechJoined(m));
    this.conn.on('session.techLeft', (m) => this._onTechLeft(m));
    this.conn.on('session.ended', () => {
      const wasSharing = Boolean(this.session && this.session.peers.size > 0);
      this._teardown();
      this._changed();
      if (wasSharing) this._notify('The support session has ended.');
    });
    this.conn.on('session.chat', (m) => this.ui.onChat && this.ui.onChat(m.message));
    this.conn.on('signal', (m) => this._onSignal(m));

    // Requests from the banner and the global shortcut arrive through the main process.
    window.ronchi.host.onEndRequested(() => this.endSession());
    window.ronchi.host.onToggleControlRequested(() => this.setControlAllowed(!this.session?.permissions.control));
  }

  /** Callbacks: onChange(), askConsent(request, isFirst) -> { result: Promise, close() }, onChat(msg), onFile(progress), onNotice(text) */
  setUi(ui) {
    this.ui = ui;
    this._changed();
  }

  _changed() {
    // Tell app.js when sharing starts or stops so it can switch screens.
    const sharing = Boolean(this.session && this.session.peers.size > 0);
    if (sharing !== this.sharing) {
      this.sharing = sharing;
      if (this.onSharingChange) this.onSharingChange(sharing);
    }
    if (this.ui.onChange) this.ui.onChange();
  }
  _notify(text) { if (this.ui.onNotice) this.ui.onNotice(text); }

  get technicianNames() {
    return this.session ? [...this.session.peers.values()].map((p) => p.info.name) : [];
  }

  async _register() {
    try {
      const reply = await this.conn.request('host.register', {
        deviceName: this.info.deviceName,
        os: this.info.osName,
        appVersion: this.info.version,
      });
      this.connected = true;
      this.code = reply.code;
      this.iceServers = reply.iceServers;
    } catch (err) {
      console.error('Could not register with the server', err);
    }
    this._changed();
  }

  async newCode() {
    await this.conn.request('host.newCode');
  }

  // ------------------------------------------------------------------ consent

  async _onRequest(message) {
    const isFirst = !this.session;
    if (!this.ui.askConsent) return this._answer(message.peer.peerId, false);
    window.ronchi.window.attention({ title: 'Ronchi Connect', body: `${message.peer.name} is asking to connect.` });
    const prompt = this.ui.askConsent(message, isFirst);
    this.prompts.set(message.peer.peerId, prompt);
    const answer = await prompt.result; // { accept, permissions } or null when the request went away
    if (!this.prompts.delete(message.peer.peerId) || !answer) return;
    if (answer.accept && isFirst) {
      this.session = { id: message.sessionId, permissions: answer.permissions, peers: new Map() };
    }
    await this._answer(message.peer.peerId, answer.accept, answer.permissions);
  }

  async _answer(peerId, accept, permissions) {
    try {
      await this.conn.request('session.consent', { peerId, accept, permissions });
    } catch (err) {
      if (err.code !== 'no_request') console.error(err);
      if (this.session && this.session.peers.size === 0) this._teardown();
    }
  }

  _closePrompt(peerId) {
    const prompt = this.prompts.get(peerId);
    if (prompt) { this.prompts.delete(peerId); prompt.close(); }
    if (this.session && this.session.peers.size === 0 && this.prompts.size === 0) { this._teardown(); this._changed(); }
  }

  // ------------------------------------------------------------------ connecting a technician

  async _onTechJoined({ sessionId, peer }) {
    if (!this.session) this.session = { id: sessionId, permissions: { control: false, files: false }, peers: new Map() };
    const entry = { info: peer, pc: null, control: null, files: null };
    this.session.peers.set(peer.peerId, entry);
    await this._syncMain();
    this._changed();
    try {
      const stream = await this._ensureStream();
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      entry.pc = pc;
      const sender = pc.addTrack(stream.getVideoTracks()[0], stream);
      entry.sender = sender;

      entry.control = pc.createDataChannel('control', { ordered: true });
      entry.control.onopen = () => this._sendHello(entry);
      entry.control.onmessage = (event) => this._onControlMessage(entry, event.data);

      entry.files = new FileChannel(pc.createDataChannel('files', { ordered: true }), {
        mayReceive: () => Boolean(this.session && this.session.permissions.files),
        onProgress: (p) => this.ui.onFile && this.ui.onFile(p),
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) this._signal(peer.peerId, { candidate: event.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this._notify(`The connection to ${peer.name} could not be established.`);
      };

      await pc.setLocalDescription(await pc.createOffer());
      this._signal(peer.peerId, { description: pc.localDescription.toJSON() });
      await this._applyQuality(entry, 'balanced');
    } catch (err) {
      console.error('Could not start sharing', err);
      this._notify('Screen sharing could not start on this computer.');
      this.endSession();
    }
  }

  _signal(peerId, data) {
    this.conn.request('signal', { to: peerId, data }).catch(() => {});
  }

  async _onSignal({ from, data }) {
    const entry = this.session && this.session.peers.get(from);
    if (!entry || !entry.pc) return;
    try {
      if (data.description) await entry.pc.setRemoteDescription(data.description);
      else if (data.candidate) await entry.pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.warn('Signal could not be applied', err);
    }
  }

  _onTechLeft({ peerId, name }) {
    if (!this.session) return;
    const entry = this.session.peers.get(peerId);
    if (entry) this._closePeer(entry);
    this.session.peers.delete(peerId);
    this._notify(`${name} left the session.`);
    this._syncMain();
    this._changed();
  }

  // ------------------------------------------------------------------ screen capture

  async _ensureStream() {
    if (this.stream) return this.stream;
    if (!this.displayId) {
      const displays = await window.ronchi.host.displays();
      this.displayId = (displays.find((d) => d.primary) || displays[0]).id;
      await this._syncMain();
    }
    // The main process answers this request with the selected screen (see main.js).
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    this.stream.getVideoTracks()[0].contentHint = 'detail';
    return this.stream;
  }

  /** Switch which monitor is shared, for every technician. */
  async _switchDisplay(displayId) {
    const displays = await window.ronchi.host.displays();
    if (!displays.some((d) => d.id === displayId) || displayId === this.displayId) return;
    this.displayId = displayId;
    await this._syncMain();
    const old = this.stream;
    this.stream = null;
    const stream = await this._ensureStream();
    for (const entry of this.session.peers.values()) {
      if (entry.sender) await entry.sender.replaceTrack(stream.getVideoTracks()[0]);
      this._sendControl(entry, { t: 'display', id: displayId });
    }
    if (old) old.getTracks().forEach((t) => t.stop());
  }

  async _applyQuality(entry, level) {
    const quality = QUALITY[level];
    if (!quality || !entry.sender) return;
    const params = entry.sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    Object.assign(params.encodings[0], quality);
    params.degradationPreference = 'maintain-resolution';
    try { await entry.sender.setParameters(params); } catch (err) { console.warn('Quality change failed', err); }
  }

  // ------------------------------------------------------------------ control channel

  async _sendHello(entry) {
    this._sendControl(entry, {
      t: 'hello',
      displays: await window.ronchi.host.displays(),
      displayId: this.displayId,
      inputAvailable: this.info.inputAvailable,
      platform: this.info.platform,
    });
  }

  _sendControl(entry, message) {
    if (entry.control && entry.control.readyState === 'open') entry.control.send(JSON.stringify(message));
  }

  async _onControlMessage(entry, raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const permissions = this.session ? this.session.permissions : {};
    switch (message.t) {
      case 'input':
        // The main process checks the permission again before injecting anything.
        if (permissions.control) window.ronchi.host.sendInput(message.e);
        break;
      case 'display':
        await this._switchDisplay(String(message.id));
        break;
      case 'quality':
        await this._applyQuality(entry, message.level);
        break;
      case 'clipboard':
        if (permissions.control) {
          await window.ronchi.clipboard.write(message.text);
          this._notify(`${entry.info.name} copied text to your clipboard.`);
        }
        break;
      case 'clipboard-request':
        if (permissions.control) this._sendControl(entry, { t: 'clipboard', text: await window.ronchi.clipboard.read() });
        break;
      case 'file-request':
        if (permissions.files) { this._notify(`${entry.info.name} asked you to send a file.`); this.sendFiles(); }
        break;
      default:
    }
  }

  /** The customer picks files to send to every technician in the session. */
  async sendFiles() {
    if (!this.session) return;
    const files = await window.ronchi.files.pick();
    for (const file of files) {
      for (const entry of this.session.peers.values()) if (entry.files) entry.files.send(file);
    }
  }

  sendChat(text) {
    return this.conn.request('session.chat', { text });
  }

  // ------------------------------------------------------------------ permissions and ending

  /** Pause or resume mouse/keyboard control. Viewing continues. */
  async setControlAllowed(allowed) {
    if (!this.session) return;
    this.session.permissions = { ...this.session.permissions, control: Boolean(allowed) };
    await this._syncMain();
    this._changed();
    await this.conn.request('session.permissions', { permissions: this.session.permissions }).catch(() => {});
  }

  /** Tell the main process what is allowed right now. It shows the banner and gates capture and input. */
  _syncMain() {
    const active = Boolean(this.session && this.session.peers.size > 0);
    return window.ronchi.host.setSession({
      active,
      control: active && this.session.permissions.control,
      technicians: this.technicianNames,
      displayId: this.displayId,
    });
  }

  async endSession() {
    if (!this.session) return;
    this._teardown();
    this._changed();
    await this.conn.request('session.end').catch(() => {});
  }

  _closePeer(entry) {
    if (entry.files) entry.files.dispose();
    if (entry.pc) entry.pc.close();
  }

  /** Stop sharing immediately. Safe to call more than once. */
  _teardown() {
    for (const prompt of this.prompts.values()) prompt.close();
    this.prompts.clear();
    if (this.session) for (const entry of this.session.peers.values()) this._closePeer(entry);
    this.session = null;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    window.ronchi.host.setSession({ active: false });
  }
}
