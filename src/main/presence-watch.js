'use strict';
// Collects the signals that tell us whether now is a good moment for a butterfly:
//  - Electron's powerMonitor: sleep, screen lock, how long since the last keypress or mouse move
//  - a small native helper (native/mac or native/win): camera or microphone in use, something full screen
// If the helper is missing, Titli still works; it just can't see calls.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class PresenceWatcher extends EventEmitter {
  constructor({ powerMonitor, helperPath, log = () => {} }) {
    super();
    this.pm = powerMonitor;
    this.helperPath = helperPath;
    this.log = log;
    this.signals = { suspended: false, locked: false, idleSeconds: 0, cameraInUse: false, micInUse: false, fullscreen: false, screenShared: false };
    this.helperOk = false;
    this._proc = null;
    this._restarts = 0;
  }

  start() {
    const pm = this.pm;
    pm.on('suspend', () => this._set({ suspended: true }));
    pm.on('resume', () => this._set({ suspended: false, idleSeconds: 0 }));
    pm.on('lock-screen', () => this._set({ locked: true }));
    pm.on('unlock-screen', () => this._set({ locked: false }));
    this._idle = setInterval(() => {
      let idle = 0; try { idle = pm.getSystemIdleTime(); } catch (e) { idle = 0; }
      this._set({ idleSeconds: idle }, true);
    }, 2000);
    this._spawn();
  }

  stop() {
    clearInterval(this._idle);
    this._stopped = true;
    if (this._proc) this._proc.kill();
  }

  _spawn() {
    if (this._stopped || !this.helperPath || !fs.existsSync(this.helperPath)) {
      if (!this._warned) { this.log('presence helper not found; meeting detection is off'); this._warned = true; }
      return;
    }
    // the Windows helper is told our process id so it can stop when we do; the Mac one notices by itself
    const args = process.platform === 'win32' ? [String(process.pid)] : [];
    const p = spawn(this.helperPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    this._proc = p;
    let buf = '';
    p.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          this.helperOk = true; this._restarts = 0;
          this._set({ cameraInUse: !!j.camera, micInUse: !!j.mic, fullscreen: !!j.fullscreen, screenShared: !!j.sharing });
        } catch (e) { /* ignore partial lines */ }
      }
    });
    p.on('error', e => this.log('presence helper failed to start:', e.message));
    p.on('exit', () => {
      this._proc = null; this.helperOk = false;
      this._set({ cameraInUse: false, micInUse: false, fullscreen: false, screenShared: false });
      if (this._stopped) return;
      const wait = Math.min(60000, 2000 * 2 ** this._restarts++);
      setTimeout(() => this._spawn(), wait);
    });
  }

  _set(patch, quiet) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'idleSeconds') {
        const wasAway = this.signals.idleSeconds >= 120, isAway = v >= 120;
        this.signals.idleSeconds = v;
        if (wasAway !== isAway) changed = true;
      } else if (this.signals[k] !== v) { this.signals[k] = v; changed = true; }
    }
    if (changed || !quiet) this.emit('change', this.signals);
  }
}

function helperPath(app) {
  const win = process.platform === 'win32';
  const file = win ? 'titli-presence.exe' : 'titli-presence';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', file)
    : path.join(__dirname, '../../native', win ? 'win' : 'mac', 'bin', file);
}

module.exports = { PresenceWatcher, helperPath };
