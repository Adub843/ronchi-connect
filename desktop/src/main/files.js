'use strict';
/**
 * Saves files received during a session into "Downloads/Ronchi Connect".
 * File names from the other side are never trusted: they are reduced to a
 * plain name so nothing can be written outside that folder.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

function safeName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180);
  return cleaned || 'file';
}

/** Pick a name that does not overwrite an existing file: report.pdf, report (1).pdf, ... */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

class IncomingFiles {
  constructor() {
    this.open = new Map(); // transfer id -> { stream, path, received, size }
  }

  folder() {
    const dir = path.join(app.getPath('downloads'), 'Ronchi Connect');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  begin(id, name, size) {
    if (!(size >= 0) || size > MAX_FILE_BYTES) throw new Error('File is too large.');
    const target = uniquePath(this.folder(), safeName(name));
    this.open.set(id, { stream: fs.createWriteStream(target), path: target, received: 0, size });
    return target;
  }

  append(id, chunk) {
    const file = this.open.get(id);
    if (!file) return;
    file.received += chunk.byteLength;
    if (file.received > file.size) { this.cancel(id); throw new Error('Received more data than announced.'); }
    file.stream.write(Buffer.from(chunk));
  }

  finish(id) {
    const file = this.open.get(id);
    if (!file) return null;
    this.open.delete(id);
    return new Promise((resolve) => file.stream.end(() => resolve(file.path)));
  }

  cancel(id) {
    const file = this.open.get(id);
    if (!file) return;
    this.open.delete(id);
    file.stream.destroy();
    fs.rm(file.path, { force: true }, () => {});
  }

  cancelAll() {
    for (const id of [...this.open.keys()]) this.cancel(id);
  }
}

module.exports = { IncomingFiles, safeName };

/**
 * Files the person on this computer chose to send. The window can only read
 * files that were picked through the system dialog, by an opaque id, never
 * by path.
 */
class OutgoingFiles {
  constructor() {
    this.picked = new Map(); // id -> { path, name, size }
    this.nextId = 1;
  }

  add(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('Not a file.');
    const id = `f${this.nextId++}`;
    this.picked.set(id, { path: filePath, name: path.basename(filePath), size: stat.size });
    return { id, name: path.basename(filePath), size: stat.size };
  }

  async read(id, offset, length) {
    const file = this.picked.get(id);
    if (!file) throw new Error('Unknown file.');
    const handle = await fs.promises.open(file.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, file.size - offset)));
      await handle.read(buffer, 0, buffer.length, offset);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  release(id) { this.picked.delete(id); }
}

module.exports.OutgoingFiles = OutgoingFiles;
