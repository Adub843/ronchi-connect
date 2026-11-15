/**
 * Sends and receives files over a WebRTC data channel. Used in both
 * directions with the same code.
 *
 * Wire format on the "files" channel:
 *   text   {"t":"start","id":"...","name":"report.pdf","size":12345}
 *   binary chunk, chunk, chunk ...        (belongs to the file just started)
 *   text   {"t":"end","id":"..."}         or {"t":"cancel","id":"..."}
 * One file is sent at a time per direction, so chunks never interleave.
 *
 * Reading from and writing to disk happens in the main process
 * (src/main/files.js); this module only moves the bytes.
 */
const CHUNK_BYTES = 32 * 1024;
const BUFFER_HIGH_WATER = 1024 * 1024;

export class FileChannel {
  /**
   * @param {RTCDataChannel} channel
   * @param {object} options
   *   mayReceive()                    return false to refuse incoming files (permission off)
   *   onProgress({id,name,size,done,direction,state})   state: active | done | failed
   */
  constructor(channel, { mayReceive = () => true, onProgress = () => {} } = {}) {
    this.channel = channel;
    this.mayReceive = mayReceive;
    this.onProgress = onProgress;
    this.incoming = null;                 // file currently being received
    this.receiveQueue = Promise.resolve(); // keeps disk writes in order
    this.sendQueue = Promise.resolve();    // one outgoing file at a time
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER / 4;
    channel.addEventListener('message', (event) => {
      this.receiveQueue = this.receiveQueue.then(() => this._onMessage(event.data)).catch((err) => console.error(err));
    });
  }

  /** Queue a file that was picked with window.ronchi.files.pick(). */
  send(file) {
    this.sendQueue = this.sendQueue.then(() => this._send(file)).catch((err) => {
      console.error('File send failed', err);
      this.onProgress({ ...file, done: 0, direction: 'out', state: 'failed' });
    });
    return this.sendQueue;
  }

  async _send(file) {
    const progress = (done, state) => this.onProgress({ ...file, done, direction: 'out', state });
    this.channel.send(JSON.stringify({ t: 'start', id: file.id, name: file.name, size: file.size }));
    progress(0, 'active');
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      if (this.channel.readyState !== 'open') throw new Error('Connection closed during transfer.');
      const chunk = await window.ronchi.files.read(file.id, offset, CHUNK_BYTES);
      // Wait when the channel's buffer is full so memory use stays flat on big files.
      if (this.channel.bufferedAmount > BUFFER_HIGH_WATER) {
        await new Promise((resolve) => this.channel.addEventListener('bufferedamountlow', resolve, { once: true }));
      }
      this.channel.send(chunk);
      progress(Math.min(file.size, offset + chunk.byteLength), 'active');
    }
    this.channel.send(JSON.stringify({ t: 'end', id: file.id }));
    await window.ronchi.files.release(file.id);
    progress(file.size, 'done');
  }

  async _onMessage(data) {
    if (typeof data !== 'string') {
      if (!this.incoming) return;
      const file = this.incoming;
      try {
        await window.ronchi.files.append(file.id, data);
        file.done += data.byteLength;
        this.onProgress({ ...file, direction: 'in', state: 'active' });
      } catch (err) {
        this.incoming = null;
        this.onProgress({ ...file, direction: 'in', state: 'failed' });
      }
      return;
    }
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.t === 'start') {
      if (!this.mayReceive()) return; // chunks that follow are dropped because this.incoming stays null
      const id = `in-${message.id}-${Date.now()}`;
      const savedName = await window.ronchi.files.begin(id, message.name, message.size);
      this.incoming = { id, name: savedName, size: message.size, done: 0 };
      this.onProgress({ ...this.incoming, direction: 'in', state: 'active' });
    } else if (message.t === 'end' && this.incoming) {
      const file = this.incoming;
      this.incoming = null;
      await window.ronchi.files.finish(file.id);
      this.onProgress({ ...file, done: file.size, direction: 'in', state: 'done' });
    } else if (message.t === 'cancel' && this.incoming) {
      const file = this.incoming;
      this.incoming = null;
      await window.ronchi.files.cancel(file.id);
      this.onProgress({ ...file, direction: 'in', state: 'failed' });
    }
  }

  /** Call when the session ends so a half-received file is removed. */
  dispose() {
    if (this.incoming) {
      window.ronchi.files.cancel(this.incoming.id);
      this.onProgress({ ...this.incoming, direction: 'in', state: 'failed' });
      this.incoming = null;
    }
  }
}
