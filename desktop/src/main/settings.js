'use strict';
/**
 * Branding and per-computer settings.
 *
 * Branding (name, colours, logo, default server) ships with the app in the
 * `brand` folder. Settings a person changes on their own computer (a custom
 * server address, the saved technician sign-in) are stored in the operating
 * system's per-user app data folder.
 */
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/** The brand folder sits next to the app when packaged and at the repo root in development. */
function brandDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'brand')
    : path.join(__dirname, '..', '..', '..', 'brand');
}

function loadBrand() {
  const defaults = {
    productName: 'Ronchi Connect',
    company: 'Ronchi America',
    tagline: '',
    accentColor: '#d4121a',
    serverUrl: 'ws://localhost:8080/ws',
    websiteUrl: '',
    supportPhone: '',
    logoFile: '',
    backgrounds: [],
  };
  let brand = defaults;
  try {
    brand = { ...defaults, ...JSON.parse(fs.readFileSync(path.join(brandDir(), 'brand.json'), 'utf8')) };
  } catch (err) {
    console.warn('brand.json could not be read, using defaults:', err.message);
  }
  // Only reference files that are really present, as app:// URLs the window can load.
  const exists = (relative) => relative && fs.existsSync(path.join(brandDir(), relative));
  return {
    ...brand,
    logoUrl: exists(brand.logoFile) ? `app://brand/${brand.logoFile}` : null,
    backgroundUrls: (brand.backgrounds || [])
      .filter((name) => exists(path.join('backgrounds', name)))
      .map((name) => `app://brand/backgrounds/${encodeURIComponent(name)}`),
  };
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /** Server address: environment variable (for testing), then a saved override, then the brand default. */
  serverUrl(brand) {
    return process.env.RONCHI_SERVER_URL || this.data.serverUrl || brand.serverUrl;
  }
  setServerUrl(url) {
    if (url) this.data.serverUrl = url; else delete this.data.serverUrl;
    this._save();
  }

  /**
   * The technician sign-in token is encrypted with the operating system's
   * keychain (Windows DPAPI, macOS Keychain, libsecret) when available.
   */
  getToken() {
    const stored = this.data.token;
    if (!stored) return null;
    try {
      if (stored.encrypted) return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
      return stored.value;
    } catch { return null; }
  }
  setToken(token) {
    if (!token) delete this.data.token;
    else if (safeStorage.isEncryptionAvailable()) {
      this.data.token = { encrypted: true, value: safeStorage.encryptString(token).toString('base64') };
    } else {
      this.data.token = { encrypted: false, value: token };
    }
    this._save();
  }
}

module.exports = { brandDir, loadBrand, Settings };
