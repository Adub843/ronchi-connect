/**
 * Voice calls between technicians.
 *
 * The server rings the other person and passes the WebRTC setup messages;
 * the audio itself goes directly between the two computers, encrypted.
 *
 *   caller: start(userId) -> waits for 'call.accepted' -> sends the offer
 *   callee: 'call.incoming' -> accept() -> answers the offer
 */
export class CallManager {
  /**
   * @param {TechClient} tech
   * @param {object} ui  onChange(call | null), onIncoming(call), onNotice(text)
   */
  constructor(tech, ui) {
    this.tech = tech;
    this.conn = tech.conn;
    this.ui = ui;
    this.call = null; // { id, peer, direction, state: 'ringing' | 'connecting' | 'active', muted, startedAt }
    this.pc = null;
    this.localStream = null;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.ringtone = new Ringtone();
    this.signalQueue = Promise.resolve();

    this.conn.on('call.incoming', (m) => this._onIncoming(m));
    this.conn.on('call.accepted', (m) => this._onAccepted(m));
    this.conn.on('call.signal', (m) => {
      this.signalQueue = this.signalQueue.then(() => this._onSignal(m)).catch((err) => console.warn(err));
    });
    this.conn.on('call.ended', (m) => this._onEnded(m));
    this.conn.on('close', () => this._cleanup());
  }

  _changed() { this.ui.onChange(this.call); }

  async start(peer) {
    if (this.call) return this.ui.onNotice('You are already on a call.');
    try {
      const reply = await this.conn.request('call.invite', { to: peer.id });
      this.call = { id: reply.callId, peer, direction: 'out', state: 'ringing', muted: false };
      this.ringtone.start('out');
      this._changed();
    } catch (err) {
      this.ui.onNotice(err.message);
    }
  }

  _onIncoming({ callId, from }) {
    if (this.call) {
      // Already busy: decline automatically.
      this.conn.request('call.answer', { callId, accept: false }).catch(() => {});
      return;
    }
    this.call = { id: callId, peer: from, direction: 'in', state: 'ringing', muted: false };
    this.ringtone.start('in');
    window.ronchi.window.attention({ title: `${from.name} is calling`, body: 'Ronchi Connect voice call' });
    this.ui.onIncoming(this.call);
    this._changed();
  }

  async accept() {
    if (!this.call || this.call.direction !== 'in' || this.call.state !== 'ringing') return;
    this.ringtone.stop();
    this.call.state = 'connecting';
    this._changed();
    try {
      await this._preparePeer();
      await this.conn.request('call.answer', { callId: this.call.id, accept: true });
    } catch (err) {
      this.ui.onNotice(micMessage(err));
      this.hangUp();
    }
  }

  decline() {
    if (!this.call) return;
    this.conn.request('call.answer', { callId: this.call.id, accept: false }).catch(() => {});
    this._cleanup();
  }

  async _onAccepted({ callId }) {
    if (!this.call || this.call.id !== callId) return;
    this.ringtone.stop();
    this.call.state = 'connecting';
    this._changed();
    try {
      await this._preparePeer();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this._signal({ description: this.pc.localDescription.toJSON() });
    } catch (err) {
      this.ui.onNotice(micMessage(err));
      this.hangUp();
    }
  }

  /** Open the microphone and create the peer connection. */
  async _preparePeer() {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const pc = new RTCPeerConnection({ iceServers: this.tech.iceServers });
    this.pc = pc;
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    pc.ontrack = (event) => { this.audio.srcObject = event.streams[0]; };
    pc.onicecandidate = (event) => { if (event.candidate) this._signal({ candidate: event.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (!this.call) return;
      if (pc.connectionState === 'connected' && this.call.state !== 'active') {
        this.call.state = 'active';
        this.call.startedAt = Date.now();
        this._changed();
      } else if (pc.connectionState === 'failed') {
        this.ui.onNotice('The call could not connect.');
        this.hangUp();
      }
    };
  }

  _signal(data) {
    if (this.call) this.conn.request('call.signal', { callId: this.call.id, data }).catch(() => {});
  }

  async _onSignal({ callId, data }) {
    if (!this.call || this.call.id !== callId || !this.pc) return;
    if (data.description) {
      await this.pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this._signal({ description: this.pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      await this.pc.addIceCandidate(data.candidate);
    }
  }

  toggleMute() {
    if (!this.call || !this.localStream) return;
    this.call.muted = !this.call.muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !this.call.muted;
    this._changed();
  }

  hangUp() {
    if (!this.call) return;
    this.conn.request('call.end', { callId: this.call.id }).catch(() => {});
    this._cleanup();
  }

  _onEnded({ callId, reason }) {
    if (!this.call || this.call.id !== callId) return;
    const name = this.call.peer.name;
    const messages = {
      declined: `${name} declined the call.`,
      no_answer: this.call.direction === 'out' ? `${name} did not answer.` : `Missed call from ${name}.`,
      disconnected: `The call with ${name} was disconnected.`,
    };
    if (messages[reason]) this.ui.onNotice(messages[reason]);
    this._cleanup();
  }

  _cleanup() {
    this.ringtone.stop();
    if (this.pc) { this.pc.close(); this.pc = null; }
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
    this.audio.srcObject = null;
    if (this.call) { this.call = null; this._changed(); }
  }
}

function micMessage(err) {
  return err && (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
    ? 'No microphone is available. Check that one is connected and allowed.'
    : 'The call could not start.';
}

/** A simple generated ring so no sound files are needed. */
class Ringtone {
  start(direction) {
    this.stop();
    try {
      this.context = new AudioContext();
      const beep = () => {
        if (!this.context) return;
        const notes = direction === 'in' ? [660, 880] : [440];
        notes.forEach((frequency, index) => {
          const oscillator = this.context.createOscillator();
          const gain = this.context.createGain();
          const start = this.context.currentTime + index * 0.22;
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(direction === 'in' ? 0.18 : 0.06, start + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
          oscillator.connect(gain).connect(this.context.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.45);
        });
      };
      beep();
      this.timer = setInterval(beep, direction === 'in' ? 1600 : 3000);
    } catch { /* no audio device: ring silently */ }
  }

  stop() {
    clearInterval(this.timer);
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }
  }
}
