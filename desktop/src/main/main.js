'use strict';
/**
 * Electron main process.
 *
 * The window (src/renderer) holds all the screens and the WebRTC logic. It has
 * no direct access to the computer; anything that touches the operating
 * system goes through the small set of IPC calls registered here:
 * screen capture, mouse/keyboard injection, files, clipboard and the
 * always-visible session banner.
 *
 * Safety rules enforced in this file, independent of the window's code:
 *   - The screen can only be captured while a customer-approved session is active.
 *   - Input is only injected while that session has control enabled.
 *   - The banner with "End session" is shown for the whole session.
 *   - Ctrl+Alt+Shift+X ends the session from anywhere.
 */
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, protocol, net, session, screen, shell,
  desktopCapturer, dialog, clipboard, globalShortcut, nativeImage, Notification,
} = require('electron');

// Tests run several copies side by side with separate data folders.
if (process.env.RONCHI_USER_DATA) app.setPath('userData', process.env.RONCHI_USER_DATA);

const { brandDir, loadBrand, Settings } = require('./settings');
const { InputController } = require('./input');
const { IncomingFiles, OutgoingFiles } = require('./files');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const END_SESSION_SHORTCUT = 'Control+Alt+Shift+X';

// app:// serves the window's own files and the brand folder. Marking it secure
// lets the window use screen capture and the microphone.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow = null;
let bannerWindow = null;
let tray = null;
let quitting = false;
let technicianSignedIn = false;

const brand = loadBrand();
let settings;
const input = new InputController();
const incomingFiles = new IncomingFiles();
const outgoingFiles = new OutgoingFiles();

/** What the customer side of this computer is currently sharing. Set by the window, enforced here. */
const hostSession = { active: false, control: false, technicians: [], displayId: null };

// ------------------------------------------------------------------ windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0e1014',
    title: brand.productName,
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadURL('app://ui/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // The window only ever shows our own pages.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // A signed-in technician keeps running in the tray so calls and flags still reach them.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (hostSession.active) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['End session and close', 'Keep session'],
        defaultId: 1,
        message: 'A support session is in progress.',
        detail: 'Closing the window ends the session.',
      });
      if (choice === 1) return event.preventDefault();
    } else if (technicianSignedIn) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** Small always-on-top strip telling the customer their screen is being shared. */
function showBanner() {
  if (bannerWindow) return sendBannerState();
  const width = 620;
  const area = screen.getPrimaryDisplay().workArea;
  bannerWindow = new BrowserWindow({
    width,
    height: 46,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    transparent: false,
    backgroundColor: '#b00d14',
    webPreferences: {
      preload: path.join(__dirname, 'banner-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bannerWindow.setAlwaysOnTop(true, 'screen-saver');
  bannerWindow.setVisibleOnAllWorkspaces(true);
  bannerWindow.loadURL('app://ui/banner.html');
  bannerWindow.webContents.once('did-finish-load', sendBannerState);
  // The banner cannot be closed while the session runs; closing it ends the session instead.
  bannerWindow.on('close', (event) => {
    if (hostSession.active && !quitting) {
      event.preventDefault();
      sendToWindow('host:endRequested');
    }
  });
  bannerWindow.on('closed', () => { bannerWindow = null; });
}

function sendBannerState() {
  if (bannerWindow && !bannerWindow.isDestroyed()) {
    bannerWindow.webContents.send('banner:state', {
      control: hostSession.control,
      technicians: hostSession.technicians,
      shortcut: END_SESSION_SHORTCUT.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + '),
    });
  }
}

function hideBanner() {
  if (bannerWindow && !bannerWindow.isDestroyed()) bannerWindow.destroy();
  bannerWindow = null;
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showMainWindow() {
  if (!mainWindow) return createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip(brand.productName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${brand.productName}`, click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

// ------------------------------------------------------------------ security setup

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const root = url.host === 'ui' ? RENDERER_DIR : url.host === 'brand' ? brandDir() : null;
    if (!root) return new Response('Not found', { status: 404 });
    const filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function registerPermissions() {
  const allowed = new Set(['media', 'display-capture']);
  const isOurs = (webContents) => webContents && webContents.getURL().startsWith('app://ui/');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isOurs(webContents) && allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
    isOurs(webContents) && allowed.has(permission)
  ));

  // getDisplayMedia() in the window lands here. We hand over the chosen screen,
  // and only while the customer has an approved session.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!hostSession.active) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = sources.find((s) => String(s.display_id) === String(hostSession.displayId)) || sources[0];
      callback(wanted ? { video: wanted } : {});
    } catch (err) {
      console.error('Screen capture failed:', err);
      try { callback({}); } catch { /* request already settled */ }
    }
  });
}

// ------------------------------------------------------------------ IPC

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, index) => ({
    id: String(d.id),
    label: `Screen ${index + 1}${d.id === primaryId ? ' (main)' : ''}`,
    primary: d.id === primaryId,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  }));
}

function applyHostSession(state) {
  const wasActive = hostSession.active;
  hostSession.active = Boolean(state.active);
  hostSession.control = hostSession.active && Boolean(state.control);
  hostSession.technicians = Array.isArray(state.technicians) ? state.technicians.map(String).slice(0, 10) : [];
  if (state.displayId) hostSession.displayId = String(state.displayId);
  if (!hostSession.displayId) hostSession.displayId = String(screen.getPrimaryDisplay().id);

  input.setDisplay(hostSession.displayId);
  input.setAllowed(hostSession.control);

  if (hostSession.active) {
    showBanner();
    if (!wasActive) {
      globalShortcut.register(END_SESSION_SHORTCUT, () => sendToWindow('host:endRequested'));
    }
  } else {
    hideBanner();
    globalShortcut.unregister(END_SESSION_SHORTCUT);
    incomingFiles.cancelAll();
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    brand,
    serverUrl: settings.serverUrl(brand),
    version: app.getVersion(),
    platform: process.platform,
    osName: `${os.type()} ${os.release()}`,
    deviceName: os.hostname(),
    inputAvailable: input.available(),
    startAsTechnician: process.argv.includes('--technician'),
  }));

  ipcMain.handle('settings:setServerUrl', (event, url) => {
    const value = String(url || '').trim();
    if (value && !/^wss?:\/\//.test(value)) throw new Error('Server address must start with wss:// or ws://');
    settings.setServerUrl(value);
    return settings.serverUrl(brand);
  });
  ipcMain.handle('settings:getToken', () => settings.getToken());
  ipcMain.handle('settings:setToken', (event, token) => settings.setToken(token ? String(token) : null));

  // ---- customer side
  ipcMain.handle('host:displays', () => listDisplays());
  ipcMain.handle('host:setSession', (event, state) => applyHostSession(state || {}));
  ipcMain.on('host:input', (event, inputEvent) => input.handle(inputEvent));
  ipcMain.on('banner:end', () => sendToWindow('host:endRequested'));
  ipcMain.on('banner:toggleControl', () => sendToWindow('host:toggleControlRequested'));

  // ---- technician side
  ipcMain.handle('tech:setSignedIn', (event, signedIn) => { technicianSignedIn = Boolean(signedIn); });
  ipcMain.handle('window:attention', (event, { title, body } = {}) => {
    // Used for incoming calls and flags: bring the window to the front even if it was in the tray.
    showMainWindow();
    mainWindow.flashFrame(true);
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => { if (mainWindow) { mainWindow.setAlwaysOnTop(false); mainWindow.flashFrame(false); } }, 4000);
    if (title && Notification.isSupported()) new Notification({ title: String(title), body: String(body || ''), icon: ICON }).show();
  });
  ipcMain.handle('window:setFullScreen', (event, on) => { if (mainWindow) mainWindow.setFullScreen(Boolean(on)); });

  // ---- shared
  ipcMain.handle('clipboard:read', () => clipboard.readText().slice(0, 1000000));
  ipcMain.handle('clipboard:write', (event, value) => clipboard.writeText(String(value || '').slice(0, 1000000)));

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths.map((p) => outgoingFiles.add(p));
  });
  ipcMain.handle('files:read', (event, id, offset, length) => outgoingFiles.read(String(id), Number(offset), Math.min(Number(length), 1 << 20)));
  ipcMain.handle('files:release', (event, id) => outgoingFiles.release(String(id)));
  ipcMain.handle('files:begin', (event, id, name, size) => path.basename(incomingFiles.begin(String(id), name, Number(size))));
  ipcMain.handle('files:append', (event, id, chunk) => incomingFiles.append(String(id), chunk));
  ipcMain.handle('files:finish', async (event, id) => {
    const saved = await incomingFiles.finish(String(id));
    return saved ? path.basename(saved) : null;
  });
  ipcMain.handle('files:cancel', (event, id) => incomingFiles.cancel(String(id)));
  ipcMain.handle('files:saveImage', async (event, name, bytes) => {
    const id = `img-${Date.now()}`;
    incomingFiles.begin(id, name, bytes.byteLength);
    incomingFiles.append(id, bytes);
    return path.basename(await incomingFiles.finish(id));
  });
  ipcMain.handle('files:openFolder', () => shell.openPath(incomingFiles.folder()));
}

// ------------------------------------------------------------------ lifecycle

const allowMultiple = process.env.RONCHI_ALLOW_MULTIPLE === '1';
if (!allowMultiple && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    settings = new Settings();
    registerAppProtocol();
    registerPermissions();
    registerIpc();
    createMainWindow();
    try { createTray(); } catch (err) { console.warn('Tray unavailable:', err.message); }
    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    input.setAllowed(false);
  });
  app.on('window-all-closed', () => {
    if (!technicianSignedIn || quitting) app.quit();
  });
}
