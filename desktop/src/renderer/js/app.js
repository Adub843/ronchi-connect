/**
 * Start-up and screen switching.
 *
 * One app serves both audiences:
 *   customer view   the default. Shows the support code. No account.
 *   sign-in         reached from "Technician sign-in".
 *   console         the technician workspace, after signing in.
 *
 * Two server connections are used so the roles stay separate on the server:
 * one registers this computer as a host (so it can receive help), the other
 * carries the signed-in technician.
 */
import { h, icon, toast, modal, setChildren } from './ui.js';
import { applyBrand, brandMark } from './brand.js';
import { ServerConnection } from './connection.js';
import { HostController } from './host-controller.js';
import { TechClient } from './tech-client.js';
import { CustomerView } from './customer-view.js';
import { TechConsole } from './tech-console.js';

const root = document.getElementById('app');

async function start() {
  const info = await window.ronchi.info();
  applyBrand(info.brand);

  const hostConnection = new ServerConnection(info.serverUrl);
  const techConnection = new ServerConnection(info.serverUrl);
  const host = new HostController(hostConnection, info);
  const tech = new TechClient(techConnection);

  let techConsole = null;
  let wantCustomerView = false; // a signed-in technician chose to look at the customer screen

  const openSettings = () => settingsDialog(info, [hostConnection, techConnection]);
  const customerView = new CustomerView(host, {
    openTechnicianSignIn: () => { wantCustomerView = false; render(); if (!tech.signedIn) showSignIn(); },
    openSettings,
  }, info);

  function showSignIn() {
    if (!techConnection.ws) techConnection.connect();
    setChildren(root, signInView(tech, { back: () => render() }));
  }

  /** Decide which screen to show from the current state. */
  function render() {
    const beingHelped = Boolean(host.session && host.session.peers.size > 0);
    if (tech.signedIn && !beingHelped && !wantCustomerView) {
      if (!techConsole) techConsole = new TechConsole(tech, host, {
        showCustomerView: () => { wantCustomerView = true; render(); },
        openSettings,
      });
      host.setUi(techConsole.hostUi(customerView.hostUi()));
      if (root.firstChild !== techConsole.element) setChildren(root, techConsole.element);
    } else {
      customerView.setTechnicianLinkLabel(tech.signedIn ? 'Back to technician console' : 'Technician sign-in');
      host.setUi(customerView.hostUi());
      if (root.firstChild !== customerView.element) setChildren(root, customerView.element);
    }
    document.body.classList.toggle('in-console', root.firstChild !== customerView.element);
  }

  // Switch screens when a technician signs in or out, and when this computer starts or stops being helped.
  let wasSignedIn = false;
  tech.onChange(() => {
    if (tech.signedIn !== wasSignedIn) {
      wasSignedIn = tech.signedIn;
      if (!tech.signedIn) techConsole = null;
      render();
    }
  });
  host.onSharingChange = () => render();

  render();
  hostConnection.connect();

  // A technician who signed in before goes straight to the console.
  if (await window.ronchi.settings.getToken()) {
    techConnection.connect();
    const off = techConnection.on('open', async () => {
      off();
      try { await tech.resume(); } catch { if (info.startAsTechnician) showSignIn(); }
    });
  } else if (info.startAsTechnician) {
    showSignIn();
  }
}

function signInView(tech, { back }) {
  const username = h('input', { type: 'text', id: 'username', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary large', id: 'sign-in' }, 'Sign in');
  const form = h('form', { class: 'signin-card glass', onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      await tech.login(username.value, password.value);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  } },
    h('p', { class: 'eyebrow' }, 'Technicians'),
    h('h1', {}, 'Sign in'),
    h('label', { class: 'field' }, 'Username', username),
    h('label', { class: 'field' }, 'Password', password),
    error,
    submit,
    h('button', { type: 'button', class: 'link', onclick: back }, 'Back to the customer screen'));
  setTimeout(() => username.focus());
  return h('div', { class: 'view customer-view' }, h('header', { class: 'customer-header' }, brandMark('large')), h('main', {}, form));
}

function settingsDialog(info, connections) {
  const url = h('input', { type: 'text', value: connections[0].url, spellcheck: false });
  const dialog = modal({
    title: 'Settings',
    body: [
      h('label', { class: 'field' }, 'Server address', url),
      h('p', { class: 'hint' }, 'Only change this if Ronchi support asks you to. Leave empty to use the default.'),
      h('p', { class: 'hint' }, `${info.brand.productName} ${info.version} · ${info.osName}`),
    ],
    actions: [
      h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          const saved = await window.ronchi.settings.setServerUrl(url.value);
          for (const connection of connections) if (connection.ws) connection.setUrl(saved); else connection.url = saved;
          dialog.close();
          toast('Server address saved.', 'success');
        } catch (err) { toast(err.message.replace(/^Error invoking remote method [^:]+: Error: /, ''), 'error'); }
      } }, icon('check'), 'Save'),
    ],
  });
}

start().catch((err) => {
  console.error(err);
  setChildren(root, h('p', { class: 'empty' }, `Ronchi Connect could not start: ${err.message}`));
});
