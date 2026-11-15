'use strict';
/**
 * End-to-end test: starts a real server and three copies of the desktop app
 * (one customer, two technicians) and drives a full support session.
 *
 *   Linux (headless):  xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e.js
 *   Windows / macOS:   node test/e2e.js
 *
 * Needs the `playwright` package (npm i -D playwright) and the server's
 * dependencies installed (cd ../server && npm install).
 * Pass a folder as the first argument to keep screenshots of each stage.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { loadConfig } = require('../../server/src/config');
const { createServer } = require('../../server/src/app');

const APP_DIR = path.join(__dirname, '..');
const shotsDir = process.argv[2] || null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ronchi-e2e-'));
const apps = [];

/**
 * Technician copies get Chromium's fake microphone so voice calls work on a
 * machine with no audio hardware. The customer copy does not, so its screen
 * capture is the real thing.
 */
async function launch(name, serverUrl, { fakeMicrophone = false } = {}) {
  const fakeMedia = fakeMicrophone ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [];
  const app = await electron.launch({
    executablePath: require('electron'),
    cwd: APP_DIR,
    args: [APP_DIR, '--no-sandbox', ...fakeMedia],
    env: {
      ...process.env,
      RONCHI_SERVER_URL: serverUrl,
      RONCHI_ALLOW_MULTIPLE: '1',
      RONCHI_USER_DATA: path.join(tmp, name),
      XDG_DOWNLOAD_DIR: path.join(tmp, name, 'Downloads'),
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', (err) => console.log(`[${name}] page error:`, err.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console error:`, m.text()); });
  return { app, page, name };
}

async function shot(client, label) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  await client.page.screenshot({ path: path.join(shotsDir, `${label}.png`) });
}

async function signIn(client, username, password) {
  await client.page.getByRole('button', { name: 'Technician sign-in' }).click();
  await client.page.fill('#username', username);
  await client.page.fill('#password', password);
  await client.page.click('#sign-in');
  await client.page.waitForSelector('#code-input');
}

const step = (text) => console.log(`\n• ${text}`);

async function main() {
  step('start server');
  const config = loadConfig({ port: 0, dataDir: path.join(tmp, 'server-data'), adminPassword: 'admin-password-1', consentTimeoutSeconds: 60 });
  const srv = createServer(config, { log() {}, error: console.error });
  srv.auth.createUser({ username: 'aaron', name: 'Aaron Lewis', password: 'correct-horse-1' });
  srv.auth.createUser({ username: 'maria', name: 'Maria Rossi', password: 'correct-horse-2' });
  srv.auth.createUser({ username: 'luca', name: 'Luca Bianchi', password: 'correct-horse-3' });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `ws://127.0.0.1:${srv.server.address().port}/ws`;

  step('launch customer app and two technician apps');
  const customer = await launch('customer', serverUrl);
  const aaron = await launch('aaron', serverUrl, { fakeMicrophone: true });
  const maria = await launch('maria', serverUrl, { fakeMicrophone: true });

  step('customer sees a 9-digit code without signing in');
  await customer.page.waitForSelector('#support-code');
  const code = (await customer.page.textContent('#support-code')).replace(/\D/g, '');
  assert.match(code, /^\d{9}$/);
  await shot(customer, '01-customer-code');

  step('technicians sign in and see each other online');
  await signIn(aaron, 'aaron', 'correct-horse-1');
  await signIn(maria, 'maria', 'correct-horse-2');
  await aaron.page.waitForSelector('.member[data-user="maria"]:not(.offline)');
  await shot(aaron, '02-technician-console');

  step('technician enters the code; customer gets a consent prompt');
  await aaron.page.fill('#code-input', code);
  await aaron.page.click('#connect-button');
  await customer.page.waitForSelector('#consent-allow');
  assert.match(await customer.page.textContent('.modal'), /Aaron Lewis/);
  await shot(customer, '03-consent-prompt');
  await shot(aaron, '04-waiting-for-consent');
  // Nothing is shared yet: the main process still reports no active session.
  assert.equal(customer.app.windows().length, 1, 'banner must not exist before consent');

  step('customer clicks Allow; technician sees the live screen');
  await customer.page.click('#consent-allow');
  await aaron.page.waitForFunction(() => {
    const video = document.querySelector('.stage video');
    return video && video.videoWidth > 0;
  }, null, { timeout: 30000 });
  await aaron.page.waitForFunction(() => /Full control|View only/.test(document.querySelector('.session-toolbar').textContent));
  await customer.page.waitForSelector('#end-session');
  await aaron.page.waitForTimeout(1500);
  await shot(aaron, '05-remote-session');
  await shot(customer, '06-customer-in-session');

  step('the always-on-top banner is showing on the customer computer');
  const banner = customer.app.windows().find((w) => w.url().endsWith('banner.html'));
  assert.ok(banner, 'banner window should be open during a session');
  await banner.waitForFunction(() => /Aaron Lewis/.test(document.getElementById('text').textContent));
  if (shotsDir) await banner.screenshot({ path: path.join(shotsDir, '07-banner.png') });

  step('session chat reaches the customer');
  await aaron.page.fill('.session-pane .composer input', 'Hi, I can see your screen now.');
  await aaron.page.press('.session-pane .composer input', 'Enter');
  await customer.page.waitForFunction(() => document.body.textContent.includes('I can see your screen now.'));

  step('technician controls the customer mouse and keyboard');
  const controlWorks = await aaron.page.evaluate(() => /Full control/.test(document.querySelector('.session-toolbar').textContent));
  if (controlWorks) {
    // Aim at the chat box in the customer's window, click it and type through the remote view.
    const target = await customer.page.evaluate(() => {
      const box = document.querySelector('.customer-card .composer input').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    const geometry = await customer.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
      win.show(); win.focus();
      return { content: win.getContentBounds(), display: screen.getPrimaryDisplay().bounds };
    });
    const nx = (geometry.content.x + target.x) / geometry.display.width;
    const ny = (geometry.content.y + target.y) / geometry.display.height;
    const stage = await aaron.page.evaluate(() => {
      const video = document.querySelector('.stage video');
      const box = video.getBoundingClientRect();
      const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
      const w = video.videoWidth * scale; const h = video.videoHeight * scale;
      return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, w, h };
    });
    await aaron.page.mouse.click(stage.left + nx * stage.w, stage.top + ny * stage.h);
    await aaron.page.waitForTimeout(500);
    await aaron.page.keyboard.type('typed remotely', { delay: 40 });
    await customer.page.waitForFunction(
      () => document.querySelector('.customer-card .composer input').value === 'typed remotely', null, { timeout: 10000 });
    console.log('  remote typing arrived in the customer window');
  } else {
    console.log('  SKIPPED: input injection is not available on this machine');
  }

  step('customer pauses control; technician sees View only');
  await customer.page.getByRole('button', { name: 'Pause control' }).click();
  await aaron.page.waitForFunction(() => /View only/.test(document.querySelector('.session-toolbar').textContent));
  await customer.page.getByRole('button', { name: 'Allow control' }).click();
  await aaron.page.waitForFunction(() => /Full control|control unavailable/.test(document.querySelector('.session-toolbar').textContent));

  step('technician sends a file to the customer');
  const sample = path.join(tmp, 'recipe-update.txt');
  fs.writeFileSync(sample, 'nozzle 4 = 250 ml\n'.repeat(5000));
  await aaron.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, sample);
  await aaron.page.locator('.session-pane .tabs button', { hasText: 'Files' }).click();
  await aaron.page.getByRole('button', { name: 'Send files' }).click();
  await aaron.page.waitForFunction(() => /sent/.test(document.querySelector('.session-pane .transfers').textContent), null, { timeout: 15000 });
  await customer.page.waitForFunction(() => /Received/.test(document.querySelector('.customer-card .transfers').textContent), null, { timeout: 15000 });
  const downloads = await customer.app.evaluate(({ app }) => app.getPath('downloads'));
  const received = path.join(downloads, 'Ronchi Connect', 'recipe-update.txt');
  assert.equal(fs.readFileSync(received, 'utf8'), fs.readFileSync(sample, 'utf8'), 'received file must match');

  step('technician writes notes and flags a teammate for help');
  await aaron.page.locator('.session-pane .tabs button', { hasText: 'Notes' }).click();
  await aaron.page.fill('.notes', 'Updated fill volume on nozzle 4.');
  await aaron.page.locator('.session-toolbar button[title="Flag for help"]').click();
  await aaron.page.fill('.modal textarea', 'Servo fault on the capper, can you look?');
  await aaron.page.getByRole('button', { name: 'Send flag' }).click();
  await maria.page.waitForFunction(() => document.body.textContent.includes('Servo fault on the capper'));
  await shot(maria, '08-flag-alert');

  step('flagged teammate joins; the customer must approve them as well');
  await maria.page.getByRole('button', { name: 'Join session' }).click();
  await customer.page.waitForSelector('#consent-allow');
  assert.match(await customer.page.textContent('.modal'), /Maria Rossi/);
  await customer.page.click('#consent-allow');
  await maria.page.waitForFunction(() => {
    const video = document.querySelector('.stage video');
    return video && video.videoWidth > 0;
  }, null, { timeout: 30000 });
  await maria.page.waitForFunction(() => document.querySelector('.notes').value.includes('nozzle 4'));
  await shot(maria, '09-second-technician');

  step('direct chat between technicians');
  await maria.page.locator('.member[data-user="aaron"]').click();
  await maria.page.fill('.chat-popover .composer input', 'I am in. Looking at the capper now.');
  await maria.page.press('.chat-popover .composer input', 'Enter');
  await aaron.page.waitForFunction(() => document.body.textContent.includes('Looking at the capper now.'));

  step('voice call: ring, answer, connected, hang up');
  await maria.page.locator('.chat-popover .chat-head button[title="Call"]').click();
  await aaron.page.getByRole('button', { name: 'Answer' }).click();
  await maria.page.waitForFunction(() => /\d:\d\d/.test(document.querySelector('.call-bar').textContent), null, { timeout: 20000 });
  await shot(maria, '10-voice-call');
  await aaron.page.locator('.call-bar button[title="Hang up"]').click();
  await maria.page.waitForSelector('.call-bar', { state: 'hidden' });

  step('customer ends the session; everything stops');
  await customer.page.click('#end-session');
  await aaron.page.waitForSelector('#code-input');
  await maria.page.waitForSelector('#code-input');
  await customer.page.waitForSelector('#support-code');
  const newCode = (await customer.page.textContent('#support-code')).replace(/\D/g, '');
  assert.notEqual(newCode, code, 'a used code must be replaced');
  await customer.page.waitForTimeout(500);
  assert.ok(!customer.app.windows().some((w) => w.url().endsWith('banner.html')), 'banner must close');

  step('the session is in History with notes');
  await aaron.page.click('#tab-history');
  await aaron.page.waitForFunction(() => document.body.textContent.includes('Updated fill volume on nozzle 4.'));
  await shot(aaron, '11-history');
  const record = srv.store.listSessionRecords()[0];
  assert.deepEqual(record.technicians.map((t) => t.name).sort(), ['Aaron Lewis', 'Maria Rossi']);
  assert.equal(record.endReason, 'customer_ended');

  console.log('\nAll end-to-end checks passed.');
  for (const app of apps) await app.close();
  srv.hub.close();
  srv.server.close();
}

main().catch(async (err) => {
  console.error('\nEND-TO-END TEST FAILED\n', err);
  if (shotsDir) for (const app of apps) {
    for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shotsDir, `fail-${apps.indexOf(app)}-${i}.png`) }).catch(() => {});
  }
  for (const app of apps) await app.close().catch(() => {});
  process.exit(1);
});
