'use strict';
// The see-through window the butterfly flies in. It covers the main screen, floats above everything
// (even the menu bar), lets every click pass through except on the butterfly and its note,
// and is hidden from screen sharing and screen recordings.

const { BrowserWindow, screen, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

class Overlay extends EventEmitter {
  constructor({ dev = false } = {}) {
    super();
    this.dev = dev;
    this.win = null;
    this.ready = null;
    this.visible = false;
    this.protect = true;
    ipcMain.on('overlay:event', (e, ev) => {
      if (!this.win || e.sender !== this.win.webContents || !ev || typeof ev.type !== 'string') return;
      if (ev.type === 'interactive') { this._interactive(!!ev.on); return; }
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
    this._interactive(false);
    this.win.hide();
    this.visible = false;
  }

  // on by default; switched off only while someone is filming a reel
  setProtection(on) { this.protect = !!on; if (this.win && !this.win.isDestroyed()) this.win.setContentProtection(this.protect); }

  _interactive(on) {
    if (!this.win) return;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  _fit() {
    if (!this.win || this.win.isDestroyed()) return;
    const { bounds, menubar, insets } = this.geometry();
    this.win.setBounds(bounds);
    this.win.webContents.send('overlay:geometry', { menubar, insets });
  }
}

module.exports = { Overlay };
