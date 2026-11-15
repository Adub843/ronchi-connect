/**
 * Team features in the technician console: who is online, direct chat,
 * "flag for help" alerts, voice calls and invitations to join a session.
 */
import { h, icon, toast, modal, setChildren, initials, formatTime } from './ui.js';
import { CallManager } from './calls.js';

const STATUS_LABELS = { available: 'Available', busy: 'Busy', away: 'Away', offline: 'Offline' };

export class TeamUi {
  /**
   * @param {TechClient} tech
   * @param {object} actions { joinSession(sessionId), currentSession() }
   */
  constructor(tech, actions) {
    this.tech = tech;
    this.conn = tech.conn;
    this.actions = actions;
    this.unread = new Map();      // user id -> unread message count
    this.openChat = null;         // { userId, list, element }

    this.listElement = h('div', { class: 'team-list' });
    this.callBar = h('div', { class: 'call-bar', hidden: true });
    this.chatHolder = h('div', { class: 'chat-holder' });

    this.calls = new CallManager(tech, {
      onChange: (call) => this._renderCall(call),
      onIncoming: (call) => this._showIncomingCall(call),
      onNotice: (text) => toast(text),
    });

    this.conn.on('chat.message', (m) => this._onChatMessage(m.message));
    this.conn.on('flag.raised', (m) => this._showFlag(m.flag));
    this.conn.on('flag.response', (m) => toast(
      m.response === 'coming' ? `${m.from.name} is on the way.` : `${m.from.name} can't help right now.`,
      m.response === 'coming' ? 'success' : 'info', 8000));
    this.conn.on('session.invited', (m) => this._showInvite(m));
    tech.onChange(() => this.renderList());
  }

  // ------------------------------------------------------------------ team list

  renderList() {
    const order = { available: 0, busy: 1, away: 2, offline: 3 };
    const members = [...this.tech.teammates].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    if (!members.length) {
      return setChildren(this.listElement, h('p', { class: 'hint pad' }, 'No teammates yet. An administrator can add them under Team.'));
    }
    setChildren(this.listElement, members.map((member) => {
      const unread = this.unread.get(member.id) || 0;
      const detail = member.inSessionWith ? `In session · ${member.inSessionWith}` : STATUS_LABELS[member.status];
      return h('div', { class: `member ${member.online ? '' : 'offline'}`, dataset: { user: member.username }, onclick: () => this.showChat(member.id) },
        h('div', { class: 'avatar' }, initials(member.name), h('span', { class: `presence ${member.inSessionWith ? 'busy' : member.status}` })),
        h('div', { class: 'who' }, h('strong', {}, member.name), h('span', {}, detail)),
        unread > 0 && h('span', { class: 'unread' }, String(unread)),
        h('div', { class: 'member-actions' },
          h('button', { type: 'button', class: 'icon-button ghost', title: `Call ${member.name}`, disabled: !member.online,
            onclick: (e) => { e.stopPropagation(); this.calls.start(member); } }, icon('phone', 16)),
          h('button', { type: 'button', class: 'icon-button ghost', title: `Flag ${member.name} for help`, disabled: !member.online,
            onclick: (e) => { e.stopPropagation(); this.flagDialog(member.id); } }, icon('flag', 16)),
        ));
    }));
  }

  // ------------------------------------------------------------------ direct chat

  async showChat(userId) {
    const member = this.tech.member(userId);
    if (!member) return;
    this.unread.delete(userId);
    this.renderList();
    const list = h('div', { class: 'messages' });
    const input = h('input', { type: 'text', placeholder: `Message ${member.name}…`, maxLength: 4000 });
    const element = h('div', { class: 'chat-popover glass' },
      h('div', { class: 'chat-head' },
        h('div', { class: 'avatar' }, initials(member.name)),
        h('strong', {}, member.name),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon-button ghost', title: 'Call', onclick: () => this.calls.start(member) }, icon('phone', 16)),
        h('button', { type: 'button', class: 'icon-button ghost', title: 'Close', onclick: () => this.closeChat() }, icon('close', 16))),
      list,
      h('form', { class: 'composer', onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        this.conn.request('chat.send', { to: userId, text }).catch((err) => toast(err.message, 'error'));
      } }, input, h('button', { type: 'submit', class: 'icon-button primary', title: 'Send' }, icon('send'))));
    this.openChat = { userId, list, element };
    setChildren(this.chatHolder, element);
    input.focus();
    try {
      const history = await this.conn.request('chat.history', { with: userId });
      if (this.openChat && this.openChat.userId === userId) {
        setChildren(list, history.messages.map((m) => this._bubble(m)));
        list.scrollTop = list.scrollHeight;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  closeChat() {
    this.openChat = null;
    setChildren(this.chatHolder);
  }

  _bubble(message) {
    const mine = message.from === this.tech.user.id;
    return h('div', { class: `message ${mine ? 'mine' : ''}` },
      h('div', { class: 'meta' }, formatTime(message.at)),
      h('div', { class: 'bubble' }, message.text));
  }

  _onChatMessage(message) {
    const otherId = message.from === this.tech.user.id ? message.to : message.from;
    if (this.openChat && this.openChat.userId === otherId) {
      this.openChat.list.append(this._bubble(message));
      this.openChat.list.scrollTop = this.openChat.list.scrollHeight;
      return;
    }
    if (message.from !== this.tech.user.id) {
      this.unread.set(otherId, (this.unread.get(otherId) || 0) + 1);
      this.renderList();
      const sender = this.tech.member(otherId);
      toast(`${sender ? sender.name : 'Teammate'}: ${message.text.slice(0, 80)}`);
    }
  }

  // ------------------------------------------------------------------ flag for help

  /** Ask who to flag and what to say. `presetUserId` preselects a teammate. */
  flagDialog(presetUserId = 'all') {
    const online = this.tech.teammates.filter((m) => m.online);
    if (!online.length) return toast('Nobody else is online right now.', 'error');
    const target = h('select', {},
      h('option', { value: 'all' }, 'Everyone online'),
      online.map((m) => h('option', { value: m.id, selected: m.id === presetUserId }, m.name)));
    const message = h('textarea', { rows: 3, maxLength: 500, placeholder: 'What do you need help with?' });
    const session = this.actions.currentSession();
    const dialog = modal({
      title: 'Flag for help',
      body: [
        h('label', { class: 'field' }, 'Who', target),
        h('label', { class: 'field' }, 'Message', message),
        session && h('p', { class: 'hint' }, `They will also get a button to join your session with ${session.host.deviceName}.`),
      ],
      actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: async () => {
          try {
            await this.conn.request('flag.send', { to: target.value, message: message.value });
            dialog.close();
            toast('Flag sent.', 'success');
          } catch (err) { toast(err.message, 'error'); }
        } }, icon('flag'), 'Send flag'),
      ],
    });
  }

  /** A teammate flagged us: pop the window to the front and show the alert. */
  _showFlag(flag) {
    window.ronchi.window.attention({ title: `${flag.from.name} needs help`, body: flag.message });
    const respond = (response) => this.conn.request('flag.respond', { to: flag.from.id, flagId: flag.id, response }).catch(() => {});
    const dialog = modal({
      title: `${flag.from.name} needs help`,
      className: 'alert',
      dismissable: false,
      body: [
        h('p', { class: 'flag-message' }, flag.message),
        flag.customer && h('p', { class: 'hint' }, `In a session with ${flag.customer}.`),
      ],
      actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => { respond('busy'); dialog.close(); } }, 'Can\'t right now'),
        h('button', { type: 'button', class: 'secondary', onclick: () => { respond('coming'); dialog.close(); this.showChat(flag.from.id); } }, icon('chat'), 'Reply in chat'),
        flag.sessionId
          ? h('button', { type: 'button', class: 'primary', onclick: () => { respond('coming'); dialog.close(); this.actions.joinSession(flag.sessionId); } }, icon('screen'), 'Join session')
          : h('button', { type: 'button', class: 'primary', onclick: () => { respond('coming'); dialog.close(); this.calls.start(flag.from); } }, icon('phone'), 'Call them'),
      ],
    });
  }

  // ------------------------------------------------------------------ session invitations

  /** Pick a teammate to bring into the current session. The customer still approves them. */
  inviteDialog() {
    const online = this.tech.teammates.filter((m) => m.online);
    if (!online.length) return toast('Nobody else is online right now.', 'error');
    const dialog = modal({
      title: 'Invite a teammate to this session',
      body: [
        h('p', { class: 'hint' }, 'The customer will be asked to approve them.'),
        h('div', { class: 'pick-list' }, online.map((member) => h('button', { type: 'button', class: 'secondary', onclick: async () => {
          try {
            await this.conn.request('session.invite', { to: member.id });
            toast(`Invitation sent to ${member.name}.`, 'success');
          } catch (err) { toast(err.message, 'error'); }
          dialog.close();
        } }, h('div', { class: 'avatar' }, initials(member.name)), member.name))),
      ],
    });
  }

  _showInvite({ sessionId, from, host }) {
    window.ronchi.window.attention({ title: `${from.name} invited you`, body: `Join the session with ${host.deviceName}` });
    const dialog = modal({
      title: `${from.name} invited you to a session`,
      className: 'alert',
      body: h('p', {}, `Customer computer: ${host.deviceName}`),
      actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Not now'),
        h('button', { type: 'button', class: 'primary', onclick: () => { dialog.close(); this.actions.joinSession(sessionId); } }, icon('screen'), 'Join session'),
      ],
    });
  }

  // ------------------------------------------------------------------ voice calls

  _showIncomingCall(call) {
    if (this.incomingDialog) this.incomingDialog.close();
    this.incomingDialog = modal({
      title: 'Incoming call',
      className: 'alert call',
      dismissable: false,
      body: h('div', { class: 'consent-who' },
        h('div', { class: 'avatar large ringing' }, initials(call.peer.name)),
        h('div', {}, h('strong', {}, call.peer.name), h('span', {}, 'is calling you'))),
      actions: [
        h('button', { type: 'button', class: 'primary danger', onclick: () => this.calls.decline() }, 'Decline'),
        h('button', { type: 'button', class: 'primary good', onclick: () => this.calls.accept() }, icon('phone'), 'Answer'),
      ],
    });
  }

  _renderCall(call) {
    if (this.incomingDialog && (!call || call.state !== 'ringing')) { this.incomingDialog.close(); this.incomingDialog = null; }
    clearInterval(this.callTimer);
    this.callBar.hidden = !call;
    if (!call) return;
    const status = h('span', {});
    const update = () => {
      if (call.state === 'ringing') status.textContent = call.direction === 'out' ? 'Ringing…' : 'Incoming…';
      else if (call.state === 'connecting') status.textContent = 'Connecting…';
      else {
        const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
        status.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }
    };
    update();
    if (call.state === 'active') this.callTimer = setInterval(update, 1000);
    setChildren(this.callBar,
      h('div', { class: 'avatar' }, initials(call.peer.name)),
      h('div', { class: 'who' }, h('strong', {}, call.peer.name), status),
      call.state === 'active' && h('button', { type: 'button', class: `icon-button ${call.muted ? 'warn' : 'ghost'}`, title: call.muted ? 'Unmute' : 'Mute',
        onclick: () => this.calls.toggleMute() }, icon(call.muted ? 'micOff' : 'mic', 16)),
      h('button', { type: 'button', class: 'icon-button danger', title: 'Hang up', onclick: () => this.calls.hangUp() }, icon('phone', 16)));
  }
}
