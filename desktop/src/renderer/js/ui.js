/**
 * Small DOM helpers shared by every screen. There is no framework: screens
 * build their elements with h() and update them directly.
 */

/**
 * Create an element. h('button', { class: 'primary', onclick: fn }, 'Save')
 * Attributes starting with "on" become event listeners. Children may be
 * strings, elements, arrays, or null/false (skipped). Strings are always
 * inserted as text, never as HTML, so user-supplied text is safe.
 */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value);
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace everything inside an element. */
export function setChildren(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}

/** Inline SVG icons (simple original line icons). */
const ICON_PATHS = {
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  chat: 'M4 5h16v11H9l-5 4z',
  flag: 'M5 21V4m0 1h13l-3 4 3 4H5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  screen: 'M3 5h18v12H3zM8 21h8M12 17v4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-.6-.6-1.5 1-1.9-1.4-1.4-1.9 1-1.5-.6L13 4h-2l-.6 2-1.5.6-1.9-1L5.6 7l1 1.9-.6 1.5L4 11v2l2 .6.6 1.5-1 1.9L7 18.4l1.9-1 1.5.6.6 2h2l.6-2 1.5-.6 1.9 1 1.4-1.4-1-1.9.6-1.5 2-.6z',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
  send: 'M4 20l17-8L4 4l3 8zM7 12h8',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  camera: 'M4 7h4l2-2h4l2 2h4v12H4zM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  clipboard: 'M8 5h8v3H8zM6 6H5v15h14V6h-1',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-7 9a7 7 0 0 1 14 0M17 4.5a3.5 3.5 0 0 1 0 6.5M19 20a7 7 0 0 0-2-5',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  mic: 'M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4zM6 11a6 6 0 0 0 12 0M12 17v3',
  micOff: 'M4 4l16 16M9.5 9.5v2a2.5 2.5 0 0 0 4 2M14.5 10V6.5a2.5 2.5 0 0 0-4.6-1.3M6 11a6 6 0 0 0 9.5 4.9M12 17v3',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v4l3 2',
  plus: 'M12 5v14M5 12h14',
  note: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] || '');
  svg.append(path);
  return svg;
}

/** Brief message at the bottom of the window. kind: 'info' | 'error' | 'success'. */
export function toast(message, kind = 'info', ms = 4500) {
  const element = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(element);
  setTimeout(() => element.remove(), ms);
}

/**
 * Show a modal dialog. Returns { element, close }. Pass `dismissable: false`
 * for prompts that must be answered (consent, incoming call).
 */
export function modal({ title, body, actions = [], dismissable = true, className = '' }) {
  const close = () => backdrop.remove();
  const dialog = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
    title && h('h2', {}, title),
    h('div', { class: 'modal-body' }, body),
    actions.length > 0 && h('div', { class: 'modal-actions' }, actions),
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (dismissable && e.target === backdrop) close(); } }, dialog);
  document.getElementById('overlays').append(backdrop);
  // Prompts that must be answered get no default button, so a stray Enter key cannot approve them.
  const focusable = dismissable ? dialog.querySelector('input, textarea, select, button.primary, button') : null;
  (focusable || dialog).focus();
  return { element: dialog, close };
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function formatCode(code) {
  return String(code || '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(startIso, endIso) {
  const minutes = Math.max(0, Math.round((new Date(endIso) - new Date(startIso)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
