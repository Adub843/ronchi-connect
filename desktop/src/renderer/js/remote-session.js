/**
 * The technician's view of a customer's computer: live screen, mouse and
 * keyboard control, toolbar, and the side pane with chat, notes and files.
 *
 * Created by console.js when the server says the customer approved
 * (`session.started`). Everything real-time travels over one WebRTC
 * connection that the customer's computer opens:
 *   video track        the customer's screen
 *   "control" channel  our input events and small commands (see host-controller.js)
 *   "files" channel    file transfer in both directions
 */
import { h, icon, toast, setChildren, formatBytes, formatTime } from './ui.js';
import { FileChannel } from './file-transfer.js';

/** Key combinations the technician's own computer would swallow, offered as buttons. */
const KEY_COMBOS = [
  { label: 'Windows key', codes: ['MetaLeft'] },
  { label: 'Alt + Tab', codes: ['AltLeft', 'Tab'] },
  { label: 'Ctrl + Shift + Esc (Task Manager)', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
  { label: 'Alt + F4', codes: ['AltLeft', 'F4'] },
  { label: 'Win + R (Run)', codes: ['MetaLeft', 'KeyR'] },
  { label: 'Win + E (Explorer)', codes: ['MetaLeft', 'KeyE'] },
  { label: 'Win + D (Desktop)', codes: ['MetaLeft', 'KeyD'] },
  { label: 'Print Screen', codes: ['PrintScreen'] },
];

export class RemoteSession {
  /**
   * @param {TechClient} tech
   * @param {object} started    the `session.started` message
   * @param {object} actions    { onEnded(reason), inviteTeammate(), flagForHelp() }
   */
  constructor(tech, started, actions) {
    this.tech = tech;
    this.conn = tech.conn;
    this.id = started.sessionId;
    this.host = started.host;
    this.permissions = started.permissions;
    this.peers = started.peers;       // other technicians already in the session
    this.actions = actions;
    this.pc = null;
    this.control = null;
    this.files = null;
    this.hello = null;                // details the customer's app sends when the channel opens
    this.pressed = new Set();         // keys currently held, so we can release them on blur
    this.pendingMove = null;
    this.ended = false;
    this.transfers = new Map();
    this.unsubscribe = [];

    this._build(started);
    this._listen();
    this._connect();
  }

  // ------------------------------------------------------------------ server events

  _listen() {
    const on = (type, fn) => this.unsubscribe.push(this.conn.on(type, (m) => { if (m.sessionId === this.id) fn(m); }));
    on('signal', (m) => this._onSignal(m.data));
    on('session.permissions', (m) => { this.permissions = m.permissions; this._renderStatus(); });
    on('session.chat', (m) => this._addChat(m.message));
    on('session.notes', (m) => { this.notesBox.value = m.text; this.notesHint.textContent = `Updated by ${m.by}`; });
    on('session.peerJoined', (m) => { this.peers.push(m.peer); this._renderStatus(); toast(`${m.peer.name} joined the session.`); });
    on('session.peerLeft', (m) => {
      this.peers = this.peers.filter((p) => p.peerId !== m.peerId);
      this._renderStatus();
      toast(`${m.name} left the session.`);
    });
    on('session.ended', (m) => this._finish(m.reason));
    this.unsubscribe.push(this.conn.on('close', () => this._finish('disconnected')));
  }

  // ------------------------------------------------------------------ WebRTC

  _connect() {
    const pc = new RTCPeerConnection({ iceServers: this.tech.iceServers });
    this.pc = pc;
    pc.ontrack = (event) => {
      this.video.srcObject = event.streams[0] || new MediaStream([event.track]);
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') {
        this.control = event.channel;
        this.control.onmessage = (e) => this._onControlMessage(e.data);
      } else if (event.channel.label === 'files') {
        this.files = new FileChannel(event.channel, { onProgress: (p) => this._onTransfer(p) });
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) this.conn.request('signal', { data: { candidate: event.candidate.toJSON() } }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') { this._setOverlay(null); this._updateStats(); }
      else if (state === 'disconnected') this._setOverlay('Connection interrupted. Reconnecting…');
      else if (state === 'failed') this._setOverlay('The connection was lost. End the session and connect again.');
    };
    this.statsTimer = setInterval(() => this._updateStats(), 2000);
  }

  async _onSignal(data) {
    try {
      if (data.description) {
        await this.pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          await this.conn.request('signal', { data: { description: this.pc.localDescription.toJSON() } });
        }
      } else if (data.candidate) {
        await this.pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.warn('Signal could not be applied', err);
    }
  }

  /** Show whether traffic goes directly or through the relay, and the round-trip time. */
  async _updateStats() {
    if (!this.pc || this.pc.connectionState !== 'connected') return;
    const stats = await this.pc.getStats();
    let pair = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = [local, remote].some((c) => c && c.candidateType === 'relay');
    const ms = pair.currentRoundTripTime != null ? ` · ${Math.round(pair.currentRoundTripTime * 1000)} ms` : '';
    this.linkBadge.textContent = `${relayed ? 'Relayed' : 'Direct'}${ms}`;
    this.linkBadge.title = relayed
      ? 'Encrypted traffic is passing through the Ronchi relay server.'
      : 'Encrypted traffic is going directly between the two computers.';
  }

  // ------------------------------------------------------------------ control channel

  _send(message) {
    if (this.control && this.control.readyState === 'open') this.control.send(JSON.stringify(message));
  }

  _onControlMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.t === 'hello') {
      this.hello = message;
      this._renderDisplays(message.displays, message.displayId);
      this._renderStatus();
    } else if (message.t === 'display') {
      this.displaySelect.value = message.id;
    } else if (message.t === 'clipboard') {
      window.ronchi.clipboard.write(message.text);
      toast('The customer\'s clipboard text is now on your clipboard.', 'success');
    }
  }

  get canControl() {
    return Boolean(this.permissions.control && this.hello && this.hello.inputAvailable);
  }

  // ------------------------------------------------------------------ input capture

  /** Position of a mouse event as 0..1 across the remote screen, or null when outside the picture. */
  _position(event) {
    const video = this.video;
    if (!video.videoWidth) return null;
    const box = video.getBoundingClientRect();
    // The video is letterboxed (object-fit: contain), so work out where the picture really is.
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width;
    const y = (event.clientY - box.top - (box.height - height) / 2) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  _input(e) {
    if (this.canControl) this._send({ t: 'input', e });
  }

  _bindInput() {
    const stage = this.stage;
    stage.addEventListener('mousemove', (event) => {
      const p = this._position(event);
      if (!p) return;
      // Send at most one move per animation frame.
      if (!this.pendingMove) requestAnimationFrame(() => { this._input({ k: 'move', ...this.pendingMove }); this.pendingMove = null; });
      this.pendingMove = p;
    });
    stage.addEventListener('mousedown', (event) => {
      stage.focus();
      const p = this._position(event);
      if (!p) return;
      event.preventDefault();
      this._input({ k: 'move', ...p });
      this._input({ k: 'down', button: event.button });
    });
    stage.addEventListener('mouseup', (event) => {
      event.preventDefault();
      this._input({ k: 'up', button: event.button });
    });
    stage.addEventListener('contextmenu', (event) => event.preventDefault());
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      this._input({ k: 'wheel', dx: event.deltaX, dy: event.deltaY });
    }, { passive: false });
    stage.addEventListener('keydown', (event) => {
      event.preventDefault();
      this.pressed.add(event.code);
      this._input({ k: 'keydown', code: event.code });
    });
    stage.addEventListener('keyup', (event) => {
      event.preventDefault();
      this.pressed.delete(event.code);
      this._input({ k: 'keyup', code: event.code });
    });
    // If the window loses focus mid-keystroke, release everything so nothing sticks on the remote side.
    stage.addEventListener('blur', () => this._releaseKeys());
  }

  _releaseKeys() {
    for (const code of this.pressed) this._input({ k: 'keyup', code });
    this.pressed.clear();
  }

  _sendCombo(codes) {
    if (!this.canControl) return toast('Control is not allowed right now.', 'error');
    for (const code of codes) this._input({ k: 'keydown', code });
    for (const code of [...codes].reverse()) this._input({ k: 'keyup', code });
    this.stage.focus();
  }

  // ------------------------------------------------------------------ building the screen

  _build(started) {
    this.video = h('video', { autoplay: true, muted: true, playsInline: true });
    this.overlay = h('div', { class: 'stage-overlay' }, h('div', { class: 'spinner' }), h('p', {}, 'Connecting to the customer\'s computer…'));
    this.stage = h('div', { class: 'stage', tabIndex: 0 }, this.video, this.overlay);
    this._bindInput();

    this.linkBadge = h('span', { class: 'badge' }, 'Connecting');
    this.modeBadge = h('span', { class: 'badge' });
    this.peopleBadge = h('span', { class: 'badge subtle' });
    this.displaySelect = h('select', { title: 'Which screen to view', onchange: () => this._send({ t: 'display', id: this.displaySelect.value }) });
    const qualitySelect = h('select', { title: 'Picture quality', onchange: () => this._send({ t: 'quality', level: qualitySelect.value }) },
      h('option', { value: 'low' }, 'Low bandwidth'),
      h('option', { value: 'balanced', selected: true }, 'Balanced'),
      h('option', { value: 'high' }, 'Best quality'),
    );
    const keysSelect = h('select', { title: 'Send a key combination', onchange: () => {
      const combo = KEY_COMBOS[Number(keysSelect.value)];
      keysSelect.value = '';
      if (combo) this._sendCombo(combo.codes);
    } }, h('option', { value: '' }, 'Send keys…'), KEY_COMBOS.map((c, i) => h('option', { value: String(i) }, c.label)));
    const clipboardSelect = h('select', { title: 'Clipboard', onchange: async () => {
      const action = clipboardSelect.value;
      clipboardSelect.value = '';
      if (!this.canControl) return toast('Clipboard sharing needs control permission.', 'error');
      if (action === 'send') { this._send({ t: 'clipboard', text: await window.ronchi.clipboard.read() }); toast('Sent your clipboard text to the customer.', 'success'); }
      if (action === 'get') this._send({ t: 'clipboard-request' });
    } }, h('option', { value: '' }, 'Clipboard…'), h('option', { value: 'send' }, 'Send my clipboard'), h('option', { value: 'get' }, 'Get their clipboard'));

    // Icon-only buttons keep the toolbar on one line; the label shows as a tooltip.
    const toolButton = (name, label, onclick, className = 'tool', showLabel = false) =>
      h('button', { type: 'button', class: className, title: label, 'aria-label': label, onclick }, icon(name), showLabel && h('span', {}, label));

    // Two rows: who and how we are connected, then the tools.
    const toolbar = h('div', { class: 'session-toolbar' },
      h('div', { class: 'toolbar-row' },
        h('div', { class: 'session-title' }, h('strong', {}, started.host.deviceName), h('span', {}, started.host.os)),
        this.modeBadge, this.linkBadge, this.peopleBadge,
        h('div', { class: 'spacer' }),
        toolButton('flag', 'Flag for help', () => this.actions.flagForHelp(), 'tool', true),
        toolButton('close', 'Leave', () => this.leave(), 'tool danger', true)),
      h('div', { class: 'toolbar-row' },
        this.displaySelect, qualitySelect, keysSelect, clipboardSelect,
        h('div', { class: 'spacer' }),
        toolButton('camera', 'Save a screenshot', () => this._screenshot()),
        toolButton('expand', 'Full screen', () => this._toggleFullScreen()),
        toolButton('users', 'Invite a teammate', () => this.actions.inviteTeammate())),
    );

    this.element = h('div', { class: 'remote-session' },
      h('div', { class: 'session-main' }, toolbar, this.stage),
      this._buildSidePane(started),
    );
    this._renderStatus();
    for (const message of started.chat) this._addChat(message);
  }

  _buildSidePane(started) {
    // --- chat with the customer (and other technicians)
    this.chatList = h('div', { class: 'messages' });
    const chatInput = h('input', { type: 'text', placeholder: 'Message the customer…', maxLength: 4000 });
    const chatForm = h('form', { class: 'composer', onsubmit: (event) => {
      event.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      this.conn.request('session.chat', { text }).catch((err) => toast(err.message, 'error'));
    } }, chatInput, h('button', { type: 'submit', class: 'icon-button primary', title: 'Send' }, icon('send')));
    const chatTab = h('div', { class: 'pane-tab' },
      h('p', { class: 'hint' }, 'The customer sees this chat. It is saved with the session record.'),
      this.chatList, chatForm);

    // --- notes only technicians see
    this.notesHint = h('span', { class: 'hint' }, 'Only technicians see these notes. Saved with the session record.');
    this.notesBox = h('textarea', { class: 'notes', placeholder: 'Fault found, what was changed, parts needed…', value: started.notes || '' });
    let notesTimer;
    this.notesBox.addEventListener('input', () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => this.conn.request('session.notes', { text: this.notesBox.value }).catch(() => {}), 400);
    });
    const notesTab = h('div', { class: 'pane-tab', hidden: true }, this.notesHint, this.notesBox);

    // --- files
    this.fileList = h('div', { class: 'transfers' });
    const filesTab = h('div', { class: 'pane-tab', hidden: true },
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'secondary', onclick: () => this._sendFiles() }, icon('file'), 'Send files'),
        h('button', { type: 'button', class: 'secondary', onclick: () => this._requestFile() }, 'Request a file'),
      ),
      h('p', { class: 'hint' }, 'Received files are saved in Downloads / Ronchi Connect.'),
      this.fileList,
      h('button', { type: 'button', class: 'link', onclick: () => window.ronchi.files.openFolder() }, 'Open downloads folder'),
    );

    const tabs = [['Chat', chatTab, 'chat'], ['Notes', notesTab, 'note'], ['Files', filesTab, 'file']];
    const buttons = tabs.map(([label, pane, iconName], index) => h('button', {
      type: 'button', class: index === 0 ? 'active' : '',
      onclick: () => tabs.forEach(([, p], i) => { p.hidden = i !== index; buttons[i].classList.toggle('active', i === index); }),
    }, icon(iconName, 16), label));
    return h('aside', { class: 'session-pane' }, h('div', { class: 'tabs' }, buttons), chatTab, notesTab, filesTab);
  }

  _renderStatus() {
    const control = this.permissions.control;
    const inputMissing = this.hello && !this.hello.inputAvailable;
    this.modeBadge.textContent = control ? (inputMissing ? 'View only (control unavailable)' : 'Full control') : 'View only';
    this.modeBadge.className = `badge ${control && !inputMissing ? 'good' : 'warn'}`;
    this.modeBadge.title = control ? '' : 'The customer has not allowed control, or has paused it.';
    this.peopleBadge.textContent = this.peers.length ? `With ${this.peers.map((p) => p.name).join(', ')}` : '';
    this.peopleBadge.hidden = !this.peers.length;
  }

  _renderDisplays(displays, currentId) {
    setChildren(this.displaySelect, displays.map((d) => h('option', { value: d.id, selected: d.id === currentId }, `${d.label} · ${d.width}×${d.height}`)));
    this.displaySelect.hidden = displays.length < 2;
  }

  _setOverlay(text) {
    this.overlay.hidden = !text;
    if (text) this.overlay.querySelector('p').textContent = text;
  }

  _addChat(message) {
    const mine = message.from.id === this.tech.user.id;
    this.chatList.append(h('div', { class: `message ${mine ? 'mine' : ''} ${message.from.role === 'customer' ? 'customer' : ''}` },
      h('div', { class: 'meta' }, mine ? 'You' : message.from.name, ' · ', formatTime(message.at)),
      h('div', { class: 'bubble' }, message.text)));
    this.chatList.scrollTop = this.chatList.scrollHeight;
  }

  // ------------------------------------------------------------------ files and tools

  async _sendFiles() {
    if (!this.permissions.files) return toast('The customer has not allowed file transfer.', 'error');
    if (!this.files) return toast('Still connecting. Try again in a moment.', 'error');
    for (const file of await window.ronchi.files.pick()) this.files.send(file);
  }

  _requestFile() {
    if (!this.permissions.files) return toast('The customer has not allowed file transfer.', 'error');
    this._send({ t: 'file-request' });
    toast('Asked the customer to choose a file to send.');
  }

  _onTransfer(progress) {
    let row = this.transfers.get(progress.id);
    if (!row) {
      row = { bar: h('div', { class: 'bar' }), label: h('span', { class: 'hint' }) };
      row.element = h('div', { class: 'transfer' },
        h('div', { class: 'name' }, `${progress.direction === 'out' ? '↑' : '↓'} ${progress.name}`),
        h('div', { class: 'track' }, row.bar), row.label);
      this.transfers.set(progress.id, row);
      this.fileList.prepend(row.element);
    }
    const percent = progress.size ? Math.round((progress.done / progress.size) * 100) : 100;
    row.bar.style.width = `${percent}%`;
    row.element.classList.toggle('failed', progress.state === 'failed');
    row.label.textContent = progress.state === 'failed' ? 'Failed'
      : progress.state === 'done' ? `${formatBytes(progress.size)} · ${progress.direction === 'out' ? 'sent' : 'saved'}`
      : `${formatBytes(progress.done)} of ${formatBytes(progress.size)}`;
  }

  /** Save the current remote picture as a PNG in the downloads folder. */
  async _screenshot() {
    if (!this.video.videoWidth) return;
    const canvas = h('canvas', { width: this.video.videoWidth, height: this.video.videoHeight });
    canvas.getContext('2d').drawImage(this.video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = await window.ronchi.files.saveImage(`${this.host.deviceName} ${stamp}.png`, await blob.arrayBuffer());
    toast(`Screenshot saved as ${name}`, 'success');
  }

  _toggleFullScreen() {
    this.fullScreen = !this.fullScreen;
    document.body.classList.toggle('session-fullscreen', this.fullScreen);
    window.ronchi.window.setFullScreen(this.fullScreen);
    this.stage.focus();
  }

  // ------------------------------------------------------------------ ending

  async leave() {
    await this.conn.request('session.leave').catch(() => {});
    this._finish('left');
  }

  _finish(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.statsTimer);
    this.unsubscribe.forEach((off) => off());
    if (this.files) this.files.dispose();
    if (this.pc) this.pc.close();
    if (this.fullScreen) this._toggleFullScreen();
    this.actions.onEnded(reason, { host: this.host, notes: this.notesBox.value });
  }
}
