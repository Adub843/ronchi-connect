'use strict';
/**
 * Turns input events from a technician into real mouse and keyboard actions
 * on this computer, using nut.js.
 *
 * Events arrive from the renderer as small objects:
 *   { k: 'move', x, y }             x and y are 0..1 across the shared screen
 *   { k: 'down' | 'up', button }    button is 0 left, 1 middle, 2 right
 *   { k: 'wheel', dx, dy }
 *   { k: 'keydown' | 'keyup', code } code is a KeyboardEvent.code such as "KeyA"
 *
 * Nothing is injected unless `setAllowed(true)` has been called, which main.js
 * only does while the customer has an approved session with control enabled.
 */
const { screen } = require('electron');

/** KeyboardEvent.code -> nut.js Key name, for keys whose names differ. */
const KEY_ALIASES = {
  Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter', Space: 'Space',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper',
  CapsLock: 'CapsLock', NumLock: 'NumLock', ScrollLock: 'ScrollLock', PrintScreen: 'Print', Pause: 'Pause',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ContextMenu: 'Menu',
  Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket',
  Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Grave',
  Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadMultiply: 'Multiply', NumpadDivide: 'Divide',
  NumpadDecimal: 'Decimal', NumpadEnter: 'Enter',
};

function nutKeyName(code) {
  if (KEY_ALIASES[code]) return KEY_ALIASES[code];
  let match;
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1];
  if ((match = /^Digit(\d)$/.exec(code))) return `Num${match[1]}`;
  if ((match = /^Numpad(\d)$/.exec(code))) return `NumPad${match[1]}`;
  if ((match = /^F(\d{1,2})$/.exec(code))) return `F${match[1]}`;
  return null;
}

class InputController {
  constructor() {
    this.allowed = false;
    this.displayId = null;
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.queue = Promise.resolve();
    this.nut = null;
  }

  /** nut.js is loaded on first use so the app still starts if the native module is missing. */
  _load() {
    if (this.nut) return this.nut;
    const nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.mouse.config.mouseSpeed = 100000;
    nut.keyboard.config.autoDelayMs = 0;
    this.nut = nut;
    return nut;
  }

  /** Reports whether input injection works on this computer. */
  available() {
    try { this._load(); return true; } catch { return false; }
  }

  setAllowed(allowed) {
    this.allowed = Boolean(allowed);
    if (!this.allowed) this.releaseAll();
  }

  setDisplay(displayId) {
    this.displayId = displayId;
  }

  /** Convert a 0..1 position on the shared display to the pixel position nut.js expects. */
  _toScreenPoint(x, y) {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(this.displayId)) || screen.getPrimaryDisplay();
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const dip = {
      x: display.bounds.x + clamp(x) * (display.bounds.width - 1),
      y: display.bounds.y + clamp(y) * (display.bounds.height - 1),
    };
    // Electron works in scaled "DIP" units. Windows and X11 want physical pixels; macOS uses the same units.
    if (process.platform === 'win32') return screen.dipToScreenPoint(dip);
    if (process.platform === 'linux') return { x: dip.x * display.scaleFactor, y: dip.y * display.scaleFactor };
    return dip;
  }

  /** Apply one event. Events run strictly in order. */
  handle(event) {
    if (!this.allowed || !event) return;
    this.queue = this.queue.then(() => this._apply(event)).catch((err) => {
      console.warn('Input event failed:', err.message);
    });
  }

  async _apply(event) {
    if (!this.allowed) return;
    const { mouse, keyboard, Button, Key, Point } = this._load();
    const buttons = [Button.LEFT, Button.MIDDLE, Button.RIGHT];
    switch (event.k) {
      case 'move': {
        const p = this._toScreenPoint(event.x, event.y);
        await mouse.setPosition(new Point(Math.round(p.x), Math.round(p.y)));
        break;
      }
      case 'down':
      case 'up': {
        const button = buttons[event.button];
        if (button === undefined) return;
        if (event.k === 'down') { this.pressedButtons.add(button); await mouse.pressButton(button); }
        else { this.pressedButtons.delete(button); await mouse.releaseButton(button); }
        break;
      }
      case 'wheel': {
        const steps = (v) => Math.min(20, Math.max(1, Math.round(Math.abs(v) / 40)));
        if (event.dy > 0) await mouse.scrollDown(steps(event.dy));
        if (event.dy < 0) await mouse.scrollUp(steps(event.dy));
        if (event.dx > 0) await mouse.scrollRight(steps(event.dx));
        if (event.dx < 0) await mouse.scrollLeft(steps(event.dx));
        break;
      }
      case 'keydown':
      case 'keyup': {
        const key = Key[nutKeyName(event.code)];
        if (key === undefined) return;
        if (event.k === 'keydown') { this.pressedKeys.add(key); await keyboard.pressKey(key); }
        else { this.pressedKeys.delete(key); await keyboard.releaseKey(key); }
        break;
      }
      default:
    }
  }

  /** Let go of anything still held so a dropped connection never leaves a key stuck down. */
  releaseAll() {
    if (!this.nut) return;
    const { mouse, keyboard } = this.nut;
    const keys = [...this.pressedKeys];
    const buttons = [...this.pressedButtons];
    this.pressedKeys.clear();
    this.pressedButtons.clear();
    this.queue = this.queue.then(async () => {
      for (const key of keys) await keyboard.releaseKey(key);
      for (const button of buttons) await mouse.releaseButton(button);
    }).catch(() => {});
  }
}

module.exports = { InputController, nutKeyName };
