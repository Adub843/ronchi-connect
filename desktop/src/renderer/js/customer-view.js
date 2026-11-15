/**
 * The customer screen: what someone sees when they open the app to get help.
 * It has three states: connecting, ready (showing the code), and in a session.
 * It is deliberately plain: one code to read out, one button to stop.
 */
import { h, icon, toast, modal, setChildren, formatCode, formatBytes, formatTime } from './ui.js';
import { brandMark, getBrand } from './brand.js';

/**
 * Consent prompt. Returns { result, close } as HostController expects.
 * `result` resolves to { accept, permissions } or to null if the request went away.
 */
export function askConsent(request, isFirst) {
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });
  const control = h('input', { type: 'checkbox', checked: true });
  const files = h('input', { type: 'checkbox', checked: true });
  const seconds = h('span', {}, String(request.timeoutSeconds));
  let remaining = request.timeoutSeconds;
  const timer = setInterval(() => { remaining -= 1; seconds.textContent = String(Math.max(0, remaining)); }, 1000);

  const answer = (accept) => {
    clearInterval(timer);
    dialog.close();
    settle({ accept, permissions: { control: control.checked, files: files.checked } });
  };
  const dialog = modal({
    title: isFirst ? 'Allow remote support?' : 'Another technician wants to join',
    dismissable: false,
    className: 'consent',
    body: [
      h('div', { class: 'consent-who' },
        h('div', { class: 'avatar large' }, icon('screen', 26)),
        h('div', {}, h('strong', {}, request.peer.name), h('span', {}, `${getBrand().company} technician`))),
      h('p', {}, isFirst
        ? 'This person will be able to see your screen. You stay in charge and can end the session at any time.'
        : 'They will see your screen with the same permissions as the current session.'),
      isFirst && h('div', { class: 'consent-options' },
        h('label', {}, control, h('span', {}, h('strong', {}, 'Allow mouse and keyboard control'), 'Untick to let them watch only.')),
        h('label', {}, files, h('span', {}, h('strong', {}, 'Allow file transfer'), 'Files they send are saved in your Downloads folder.'))),
      h('p', { class: 'hint' }, 'Only allow this if you are on the phone with Ronchi and expected this request. Closes in ', seconds, ' seconds.'),
    ],
    actions: [
      h('button', { type: 'button', class: 'secondary', id: 'consent-decline', onclick: () => answer(false) }, 'Decline'),
      h('button', { type: 'button', class: 'primary', id: 'consent-allow', onclick: () => answer(true) }, icon('check'), 'Allow'),
    ],
  });
  return { result, close: () => { clearInterval(timer); dialog.close(); settle(null); } };
}

export class CustomerView {
  /**
   * @param {HostController} host
   * @param {object} actions { openTechnicianSignIn(), openSettings(), backLabel?, onBack? }
   */
  constructor(host, actions, info) {
    this.host = host;
    this.actions = actions;
    this.info = info;
    this.chat = [];
    this.transfers = new Map();
    this.card = h('div', { class: 'customer-card glass' });
    this.element = h('div', { class: 'view customer-view' },
      h('header', { class: 'customer-header' }, brandMark('large')),
      h('main', {}, this.card),
      h('footer', { class: 'customer-footer' },
        h('span', {}, icon('lock', 14), 'Encrypted end to end. Nothing is shared until you click Allow.'),
        h('span', { class: 'spacer' }),
        this.backLink = h('button', { type: 'button', class: 'link', onclick: () => actions.openTechnicianSignIn() }, 'Technician sign-in'),
        h('button', { type: 'button', class: 'icon-button ghost', title: 'Settings', onclick: () => actions.openSettings() }, icon('gear', 16)),
        h('span', { class: 'version' }, `v${info.version}`),
      ),
    );
    this.renderedState = null;
  }

  /** Callbacks for HostController.setUi(). */
  hostUi() {
    return {
      onChange: () => this.render(),
      askConsent,
      onNotice: (text) => toast(text),
      onChat: (message) => { this.chat.push(message); this._renderChat(); },
      onFile: (progress) => this._onTransfer(progress),
    };
  }

  setTechnicianLinkLabel(label) { this.backLink.textContent = label; }

  render() {
    const host = this.host;
    const sharing = host.session && host.session.peers.size > 0;
    const state = sharing ? 'session' : host.code ? 'ready' : 'connecting';
    // Rebuild only when the state changes, so typing in the chat box is not interrupted.
    if (state !== this.renderedState) {
      this.renderedState = state;
      this.card.className = `customer-card glass ${state}`;
      if (state === 'connecting') setChildren(this.card, this._connecting());
      if (state === 'ready') setChildren(this.card, this._ready());
      if (state === 'session') { this.chat = []; setChildren(this.card, this._session()); }
    }
    if (state === 'ready') this.codeElement.textContent = formatCode(host.code);
    if (state === 'session') this._updateSession();
  }

  _connecting() {
    return [
      h('div', { class: 'spinner' }),
      h('h1', {}, 'Connecting to Ronchi…'),
      h('p', { class: 'lead' }, 'Check that this computer has an internet connection.'),
    ];
  }

  _ready() {
    this.codeElement = h('div', { class: 'code', id: 'support-code', 'aria-live': 'polite' });
    return [
      h('p', { class: 'eyebrow' }, h('span', { class: 'dot good' }), 'Ready for support'),
      h('h1', {}, 'Your support code'),
      this.codeElement,
      h('div', { class: 'row center' },
        h('button', { type: 'button', class: 'secondary', onclick: async () => {
          await window.ronchi.clipboard.write(formatCode(this.host.code));
          toast('Code copied.', 'success');
        } }, icon('copy'), 'Copy'),
        h('button', { type: 'button', class: 'secondary', onclick: () => this.host.newCode().catch((e) => toast(e.message, 'error')) }, icon('refresh'), 'New code'),
      ),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Read this code'), ' to your Ronchi technician.'),
        h('li', {}, h('strong', {}, 'Click Allow'), ' when their name appears on your screen.'),
        h('li', {}, h('strong', {}, 'Stay in control.'), ' A red bar shows the whole time, with an End session button.')),
      !this.info.inputAvailable && h('p', { class: 'hint warn' }, 'Remote control is not available on this computer, so technicians will be able to view only.'),
    ];
  }

  _session() {
    this.whoElement = h('h1', {});
    this.modeElement = h('p', { class: 'lead' });
    this.controlButton = h('button', { type: 'button', class: 'secondary', onclick: () => this.host.setControlAllowed(!this.host.session.permissions.control) });
    this.chatList = h('div', { class: 'messages' });
    this.fileList = h('div', { class: 'transfers' });
    const chatInput = h('input', { type: 'text', placeholder: 'Message your technician…', maxLength: 4000 });
    return [
      h('p', { class: 'eyebrow live' }, h('span', { class: 'dot live' }), 'Session in progress'),
      this.whoElement,
      this.modeElement,
      h('div', { class: 'row center' },
        this.controlButton,
        h('button', { type: 'button', class: 'secondary', onclick: () => this.host.sendFiles() }, icon('file'), 'Send a file'),
        h('button', { type: 'button', class: 'primary danger', id: 'end-session', onclick: () => this.host.endSession() }, icon('close'), 'End session'),
      ),
      this.chatList,
      h('form', { class: 'composer', onsubmit: (event) => {
        event.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        this.host.sendChat(text).catch((err) => toast(err.message, 'error'));
      } }, chatInput, h('button', { type: 'submit', class: 'icon-button primary', title: 'Send' }, icon('send'))),
      this.fileList,
    ];
  }

  _updateSession() {
    const names = this.host.technicianNames;
    const control = this.host.session.permissions.control;
    this.whoElement.textContent = `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} connected`;
    this.modeElement.textContent = control
      ? 'They can see your screen and use your mouse and keyboard.'
      : 'They can see your screen but cannot control it.';
    setChildren(this.controlButton, control ? 'Pause control' : 'Allow control');
  }

  _renderChat() {
    if (!this.chatList) return;
    setChildren(this.chatList, this.chat.map((message) => h('div', { class: `message ${message.from.role === 'customer' ? 'mine' : ''}` },
      h('div', { class: 'meta' }, message.from.role === 'customer' ? 'You' : message.from.name, ' · ', formatTime(message.at)),
      h('div', { class: 'bubble' }, message.text))));
    this.chatList.scrollTop = this.chatList.scrollHeight;
  }

  _onTransfer(progress) {
    if (!this.fileList) return;
    let row = this.transfers.get(progress.id);
    if (!row || !row.isConnected) {
      row = h('div', { class: 'transfer' });
      this.transfers.set(progress.id, row);
      this.fileList.prepend(row);
    }
    const verb = progress.direction === 'in' ? 'Received' : 'Sent';
    const status = progress.state === 'done' ? `${verb} · ${formatBytes(progress.size)}`
      : progress.state === 'failed' ? 'Failed'
      : `${formatBytes(progress.done)} of ${formatBytes(progress.size)}`;
    setChildren(row, h('div', { class: 'name' }, progress.name), h('span', { class: 'hint' }, status),
      progress.state === 'done' && progress.direction === 'in'
        && h('button', { type: 'button', class: 'link', onclick: () => window.ronchi.files.openFolder() }, 'Show in folder'));
  }
}
