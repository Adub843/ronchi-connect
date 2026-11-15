/**
 * The technician console: team sidebar on the left, and on the right either
 * the home tabs (Connect, History, Team) or the live remote session.
 */
import { h, icon, toast, modal, setChildren, initials, formatCode, formatDateTime, formatDuration, formatTime } from './ui.js';
import { brandMark } from './brand.js';
import { TeamUi } from './team-ui.js';
import { RemoteSession } from './remote-session.js';

const DENIED_REASONS = {
  declined: 'The customer declined the request.',
  timeout: 'The customer did not answer in time.',
  cancelled: 'Request cancelled.',
  ended: 'The session ended before you joined.',
};
const ENDED_REASONS = {
  customer_ended: 'The customer ended the session.',
  customer_disconnected: 'The customer\'s computer disconnected.',
  disconnected: 'Connection to the server was lost.',
  left: 'You left the session.',
};

export class TechConsole {
  /**
   * @param {TechClient} tech
   * @param {HostController} host   this computer's own customer side, for "my code"
   * @param {object} actions        { showCustomerView(), openSettings() }
   */
  constructor(tech, host, actions) {
    this.tech = tech;
    this.host = host;
    this.conn = tech.conn;
    this.actions = actions;
    this.session = null;   // RemoteSession while connected to a customer
    this.pending = null;   // { host } while waiting for the customer's consent
    this.tab = 'connect';

    this.team = new TeamUi(tech, {
      joinSession: (sessionId) => this._join(() => this.conn.request('session.join', { sessionId })),
      currentSession: () => this.session,
    });

    this.conn.on('session.started', (m) => this._onStarted(m));
    this.conn.on('session.denied', (m) => this._onDenied(m));

    this.meName = h('strong', {});
    this.statusSelect = h('select', { class: 'status-select', title: 'Your status', onchange: () => tech.setStatus(this.statusSelect.value).catch((e) => toast(e.message, 'error')) },
      h('option', { value: 'available' }, 'Available'), h('option', { value: 'busy' }, 'Busy'), h('option', { value: 'away' }, 'Away'));
    this.offlineNote = h('div', { class: 'offline-note', hidden: true }, 'Reconnecting to the server…');
    this.content = h('section', { class: 'console-content' });

    this.element = h('div', { class: 'view console-view' },
      h('aside', { class: 'sidebar' },
        brandMark('small'),
        h('div', { class: 'me' },
          this.meAvatar = h('div', { class: 'avatar' }),
          h('div', { class: 'who' }, this.meName, this.statusSelect)),
        this.team.callBar,
        h('div', { class: 'sidebar-title' }, 'Team',
          h('button', { type: 'button', class: 'link', title: 'Alert teammates that you need help', onclick: () => this.team.flagDialog() }, icon('flag', 14), 'Flag for help')),
        this.team.listElement,
        this.offlineNote,
        h('div', { class: 'sidebar-foot' },
          h('button', { type: 'button', class: 'icon-button ghost', title: 'Change password', onclick: () => this._passwordDialog() }, icon('lock', 16)),
          h('button', { type: 'button', class: 'icon-button ghost', title: 'Settings', onclick: () => actions.openSettings() }, icon('gear', 16)),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'link', onclick: () => this._signOut() }, icon('logout', 14), 'Sign out')),
      ),
      this.content,
      this.team.chatHolder,
    );

    tech.onChange(() => this._renderMe());
    this._renderMe();
    this.team.renderList();
    this._renderContent();
  }

  /** Callbacks for HostController.setUi() while the console is showing. */
  hostUi(customerHostUi) {
    return { ...customerHostUi, onChange: () => { customerHostUi.onChange(); this._renderOwnCode(); } };
  }

  _renderMe() {
    if (!this.tech.user) return;
    this.meName.textContent = this.tech.user.name;
    this.meAvatar.textContent = initials(this.tech.user.name);
    this.offlineNote.hidden = this.tech.online;
    this.statusSelect.value = this.tech.status;
  }

  // ------------------------------------------------------------------ home tabs

  _renderContent() {
    if (this.session) return setChildren(this.content, this.session.element);
    const tabs = [['connect', 'Connect', 'screen'], ['history', 'History', 'history']];
    if (this.tech.user && this.tech.user.role === 'admin') tabs.push(['team', 'Team', 'users']);
    const body = h('div', { class: 'tab-body' });
    setChildren(this.content,
      h('nav', { class: 'top-tabs' }, tabs.map(([id, label, iconName]) => h('button', {
        type: 'button', class: this.tab === id ? 'active' : '', id: `tab-${id}`,
        onclick: () => { this.tab = id; this._renderContent(); },
      }, icon(iconName, 16), label))),
      body);
    if (this.tab === 'connect') this._renderConnect(body);
    if (this.tab === 'history') this._renderHistory(body);
    if (this.tab === 'team') this._renderAdmin(body);
  }

  _renderConnect(body) {
    if (this.pending) {
      return setChildren(body, h('div', { class: 'connect-card glass waiting' },
        h('div', { class: 'spinner' }),
        h('h1', {}, 'Waiting for the customer to click Allow'),
        h('p', { class: 'lead' }, `${this.pending.host.deviceName} · ${this.pending.host.os}`),
        h('p', { class: 'hint' }, 'Ask them to click Allow on the prompt that just appeared on their screen.'),
        h('button', { type: 'button', class: 'secondary', onclick: () => this.conn.request('session.cancel').catch(() => {}) }, 'Cancel')));
    }
    const input = h('input', {
      type: 'text', id: 'code-input', class: 'code-input', inputMode: 'numeric', autocomplete: 'off',
      placeholder: '000 000 000', maxLength: 11, 'aria-label': 'Customer support code',
      oninput: () => { input.value = formatCode(input.value.replace(/\D/g, '').slice(0, 9)); },
    });
    const button = h('button', { type: 'submit', class: 'primary large', id: 'connect-button' }, icon('screen'), 'Connect');
    const form = h('form', { class: 'connect-form', onsubmit: (event) => {
      event.preventDefault();
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 9) return toast('The code has 9 digits.', 'error');
      this._join(() => this.conn.request('session.connect', { code }));
    } }, input, button);

    this.ownCode = h('span', { class: 'own-code' });
    setChildren(body,
      h('div', { class: 'connect-card glass' },
        h('p', { class: 'eyebrow' }, 'Remote support'),
        h('h1', {}, 'Connect to a customer'),
        h('p', { class: 'lead' }, 'Ask the customer to open Ronchi Connect and read you the code on their screen.'),
        form,
        h('p', { class: 'hint' }, icon('lock', 14), ' The customer approves every connection, and each session is recorded in History.')),
      h('div', { class: 'own-card glass' },
        h('div', {},
          h('strong', {}, 'Need a teammate on this computer?'),
          h('span', { class: 'hint' }, 'Give them this code and approve their request.')),
        this.ownCode,
        h('button', { type: 'button', class: 'link', onclick: () => this.actions.showCustomerView() }, 'Open customer screen')));
    this._renderOwnCode();
    input.focus();
  }

  _renderOwnCode() {
    if (this.ownCode) this.ownCode.textContent = this.host.code ? formatCode(this.host.code) : '— — —';
  }

  async _renderHistory(body) {
    setChildren(body, h('div', { class: 'spinner' }));
    try {
      const { sessions } = await this.conn.request('history.list');
      if (this.tab !== 'history' || this.session) return;
      if (!sessions.length) return setChildren(body, h('p', { class: 'empty' }, 'No sessions yet. Finished sessions appear here.'));
      setChildren(body, h('div', { class: 'panel glass' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['When', 'Customer computer', 'Technicians', 'Duration', 'Notes'].map((t) => h('th', {}, t)))),
        h('tbody', {}, sessions.map((record) => h('tr', { class: 'clickable', onclick: () => this._showRecord(record) },
          h('td', {}, formatDateTime(record.startedAt)),
          h('td', {}, record.host.deviceName),
          h('td', {}, [...new Set(record.technicians.map((t) => t.name))].join(', ')),
          h('td', {}, formatDuration(record.startedAt, record.endedAt)),
          h('td', { class: 'ellipsis' }, record.notes || '—')))))));
    } catch (err) {
      setChildren(body, h('p', { class: 'empty' }, err.message));
    }
  }

  _showRecord(record) {
    modal({
      title: `${record.host.deviceName} · ${formatDateTime(record.startedAt)}`,
      className: 'wide',
      body: [
        h('dl', { class: 'facts' },
          h('dt', {}, 'Duration'), h('dd', {}, formatDuration(record.startedAt, record.endedAt)),
          h('dt', {}, 'Technicians'), h('dd', {}, record.technicians.map((t) => `${t.name} (${formatTime(t.joinedAt)}–${formatTime(t.leftAt)})`).join(', ')),
          h('dt', {}, 'Computer'), h('dd', {}, `${record.host.os || 'Unknown'} · ${record.host.ip || ''}`),
          h('dt', {}, 'Allowed'), h('dd', {}, [record.permissions.control ? 'Control' : 'View only', record.permissions.files && 'File transfer'].filter(Boolean).join(', '))),
        h('h3', {}, 'Notes'),
        h('p', { class: 'pre' }, record.notes || 'No notes.'),
        record.chat.length > 0 && h('h3', {}, 'Chat'),
        record.chat.map((m) => h('p', { class: 'pre' }, h('strong', {}, `${m.from.name} `), h('span', { class: 'hint' }, formatTime(m.at)), `\n${m.text}`)),
      ],
    });
  }

  // ------------------------------------------------------------------ team administration (admins only)

  async _renderAdmin(body) {
    setChildren(body, h('div', { class: 'spinner' }));
    const reload = () => this._renderAdmin(body);
    try {
      const { users } = await this.conn.request('admin.users.list');
      if (this.tab !== 'team' || this.session) return;
      const field = (label, input) => h('label', { class: 'field' }, label, input);
      const username = h('input', { type: 'text', required: true, placeholder: 'jsmith' });
      const name = h('input', { type: 'text', required: true, placeholder: 'John Smith' });
      const password = h('input', { type: 'text', required: true, minLength: 10, placeholder: 'At least 10 characters' });
      const role = h('select', {}, h('option', { value: 'tech' }, 'Technician'), h('option', { value: 'admin' }, 'Administrator'));
      setChildren(body,
        h('div', { class: 'panel glass' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['Name', 'Username', 'Role', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, users.map((user) => h('tr', {},
            h('td', {}, user.name), h('td', {}, user.username), h('td', {}, user.role === 'admin' ? 'Administrator' : 'Technician'),
            h('td', { class: 'actions' },
              h('button', { type: 'button', class: 'link', onclick: () => this._resetPasswordDialog(user) }, 'Reset password'),
              user.id !== this.tech.user.id && h('button', { type: 'button', class: 'link danger', onclick: async () => {
                if (!window.confirm(`Remove ${user.name}? They will be signed out immediately.`)) return;
                try { await this.conn.request('admin.users.remove', { id: user.id }); reload(); } catch (err) { toast(err.message, 'error'); }
              } }, 'Remove'))))))),
        h('form', { class: 'panel glass add-user', onsubmit: async (event) => {
          event.preventDefault();
          try {
            await this.conn.request('admin.users.create', { username: username.value, name: name.value, password: password.value, role: role.value });
            toast(`${name.value} added. Give them their username and password.`, 'success');
            reload();
          } catch (err) { toast(err.message, 'error'); }
        } },
          h('h3', {}, 'Add a technician'),
          h('div', { class: 'grid' }, field('Full name', name), field('Username', username), field('Starting password', password), field('Role', role)),
          h('button', { type: 'submit', class: 'primary' }, icon('plus'), 'Add technician')));
    } catch (err) {
      setChildren(body, h('p', { class: 'empty' }, err.message));
    }
  }

  _resetPasswordDialog(user) {
    const password = h('input', { type: 'text', minLength: 10, placeholder: 'At least 10 characters' });
    const dialog = modal({
      title: `Reset password for ${user.name}`,
      body: h('label', { class: 'field' }, 'New password', password),
      actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: async () => {
          try { await this.conn.request('admin.users.setPassword', { id: user.id, password: password.value }); dialog.close(); toast('Password updated.', 'success'); }
          catch (err) { toast(err.message, 'error'); }
        } }, 'Save'),
      ],
    });
  }

  _passwordDialog() {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minLength: 10 });
    const dialog = modal({
      title: 'Change your password',
      body: [h('label', { class: 'field' }, 'Current password', current), h('label', { class: 'field' }, 'New password (at least 10 characters)', next)],
      actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: async () => {
          try {
            const reply = await this.conn.request('account.changePassword', { current: current.value, next: next.value });
            await window.ronchi.settings.setToken(reply.token);
            dialog.close();
            toast('Password changed.', 'success');
          } catch (err) { toast(err.message, 'error'); }
        } }, 'Change password'),
      ],
    });
  }

  async _signOut() {
    if (this.session) await this.session.leave();
    await this.tech.logout();
  }

  // ------------------------------------------------------------------ sessions

  /** Run a connect/join request and show the waiting state. */
  async _join(request) {
    if (this.session || this.pending) return toast('Finish your current session first.', 'error');
    try {
      const reply = await request();
      this.pending = { host: reply.host };
      this.tab = 'connect';
      this._renderContent();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  _onDenied({ reason }) {
    this.pending = null;
    this._renderContent();
    toast(DENIED_REASONS[reason] || 'The request was not accepted.', reason === 'cancelled' ? 'info' : 'error');
  }

  _onStarted(message) {
    this.pending = null;
    this.session = new RemoteSession(this.tech, message, {
      inviteTeammate: () => this.team.inviteDialog(),
      flagForHelp: () => this.team.flagDialog(),
      onEnded: (reason) => {
        this.session = null;
        this.tab = 'connect';
        this._renderContent();
        toast(ENDED_REASONS[reason] || 'The session has ended.');
      },
    });
    this._renderContent();
    this.session.stage.focus();
  }
}
