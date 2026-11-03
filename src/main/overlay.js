'use strict';
// The see-through window the butterfly flies in. It covers the main screen, floats above everything
// (even the menu bar), lets every click pass through except on the butterfly and its note,
// and is hidden from screen sharing and screen recordings.

const { BrowserWindow, screen, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

// TITLI_OVERLAY_CLASSIC=1 (tests only): the older way, where the page tells main when the pointer is over it
const CLASSIC = process.env.TITLI_OVERLAY_CLASSIC === '1';
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

class Overlay extends EventEmitter {
  constructor({ dev = false } = {}) {
    super();
    this.dev = dev;
    this.win = null;
    this.ready = null;
    this.visible = false;
    this.protect = true;
    this.areas = null;      // where the note and the butterfly are, in window points
    this._poller = null;
    this._on = false;
    ipcMain.on('overlay:event', (e, ev) => {
      if (!this.win || e.sender !== this.win.webContents || !ev || typeof ev.type !== 'string') return;
      if (ev.type === 'interactive') { if (CLASSIC) this._interactive(!!ev.on); return; }
      if (ev.type === 'areas') { this._setAreas(ev); return; }
      this.emit('event', ev);
    });
    screen.on('display-metrics-changed', () => this._fit());
    screen.on('display-added', () => this._fit());
    screen.on('display-removed', () => this._fit());
  }

  // Mac: the whole screen; the butterfly keeps clear of the menu bar and the Dock (wherever it is).
  // Windows: the work area only (a topmost window the size of the whole screen makes Windows treat it
  // as a full-screen app), perching low enough to clear the title bar and close button of a maximised window.
  geometry() {
    const d = screen.getPrimaryDisplay();
    if (process.platform === 'win32') return { bounds: d.workArea, menubar: 36, insets: { top: 36, bottom: 12, left: 0, right: 0 } };
    const b = d.bounds, w = d.workArea;
    const insets = {
      top: Math.max(0, w.y - b.y), left: Math.max(0, w.x - b.x),
      bottom: Math.max(0, (b.y + b.height) - (w.y + w.height)), right: Math.max(0, (b.x + b.width) - (w.x + w.width))
    };
    return { bounds: b, menubar: insets.top, insets };
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return;
    const { bounds } = this.geometry();
    this.win = new BrowserWindow({
      ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, acceptFirstMouse: true, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true, roundedCorners: false,
      webPreferences: { preload: path.join(__dirname, '../preload/overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') this.win.setVisibleOnAllWorkspaces(true); // follows you across Spaces; never over full-screen apps
    this.win.setContentProtection(this.protect);     // invisible to screen sharing and recordings
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.ready = new Promise(res => this.win.webContents.once('did-finish-load', res));
    // the overlay only ever shows its own page: no links, no dropped files, no new windows
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', e => e.preventDefault());
    this.win.webContents.on('will-redirect', e => e.preventDefault());
    this.win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
    this.win.on('closed', () => { this.win = null; this.visible = false; });
  }

  async play(item, extra = {}) {
    this.ensure();
    await this.ready;
    this._fit();
    const { menubar, insets } = this.geometry();
    this.win.showInactive();
    this.visible = true;
    this.win.webContents.send('overlay:deliver', { item, menubar, insets, ...extra });
  }

  abort() { if (this.win && this.visible) this.win.webContents.send('overlay:abort'); }

  hide() {
    if (!this.win) return;
    this.areas = null; this._stopPolling();
    this._interactive(false);
    this.win.hide();
    this.visible = false;
  }

  // on by default; switched off only while someone is filming a reel
  setProtection(on) { this.protect = !!on; if (this.win && !this.win.isDestroyed()) this.win.setContentProtection(this.protect); }

  _interactive(on) {
    if (!this.win) return;
    this._on = !!on;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  // the page says where the note and the butterfly are; main watches the pointer itself and lets clicks in only there
  _setAreas(ev) {
    const note = ev.note && num(ev.note.x, -5000, 20000) && num(ev.note.y, -5000, 20000) && num(ev.note.w, 0, 3000) && num(ev.note.h, 0, 3000) ? ev.note : null;
    const bfly = ev.bfly && num(ev.bfly.x, -5000, 20000) && num(ev.bfly.y, -5000, 20000) && num(ev.bfly.r, 0, 400) ? ev.bfly : null;
    this.areas = note || bfly ? { note, bfly } : null;
    if (ev.marks && typeof ev.marks === 'object') this.marks = ev.marks;
    if (CLASSIC) return;
    if (this.areas) this._startPolling();
    else { this._stopPolling(); if (this._on) this._interactive(false); }
  }

  _startPolling() {
    if (this._poller) return;
    this._poller = setInterval(() => {
      if (!this.win || this.win.isDestroyed() || !this.visible || !this.areas) { this._stopPolling(); return; }
      const c = screen.getCursorScreenPoint(), b = this.win.getBounds();
      const x = c.x - b.x, y = c.y - b.y, { note, bfly } = this.areas;
      const inside = (!!note && x >= note.x && x <= note.x + note.w && y >= note.y && y <= note.y + note.h)
        || (!!bfly && Math.hypot(x - bfly.x, y - bfly.y) <= bfly.r);
      if (inside !== this._on) this._interactive(inside);
    }, 40);
  }

  _stopPolling() { clearInterval(this._poller); this._poller = null; }

  // where something on the page is on the physical screen (for the self-test that clicks it)
  screenPoint(p) {
    if (!this.win || !p) return null;
    const b = this.win.getBounds(), pt = { x: Math.round(b.x + p.x), y: Math.round(b.y + p.y) };
    return typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(pt) : pt;
  }

  _fit() {
    if (!this.win || this.win.isDestroyed()) return;
    const { bounds, menubar, insets } = this.geometry();
    this.win.setBounds(bounds);
    this.win.webContents.send('overlay:geometry', { menubar, insets });
  }
}

module.exports = { Overlay };
