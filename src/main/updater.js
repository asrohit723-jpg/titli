'use strict';
// Keeps Titli up to date without a trip to GitHub.
//   check:  read the signed latest-mac.json from the public releases repo
//   update: download this Mac's zip, check its size and SHA-256, unpack it, check it's a whole,
//           correctly signed Titli of the promised version, then quit, swap the app and reopen it.
// Files we download ourselves aren't quarantined, so the new version opens without the
// "Open Anyway" step. That's why every check above has to pass before anything is replaced.

const { app, net } = require('electron');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { verifyManifest, compareVersions } = require('../core/update-manifest');

const RELEASES = 'https://github.com/asrohit723-jpg/titli-releases/releases';
const FEED = `${RELEASES}/latest/download/latest-mac.json`;
const BUNDLE_ID = 'app.titli.mac';
const CHECK_EVERY = 6 * 3600 * 1000;
const PUBLIC_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, 'update-key.pem'), 'utf8'); } catch (e) { return null; } })();

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim()));
});

// /Applications/Titli.app/Contents/MacOS/Titli -> /Applications/Titli.app
function currentBundle() {
  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/Contents/MacOS/');
  return i < 0 ? null : exe.slice(0, i + 4);
}

// where the new version would go, or why it can't
function installTarget() {
  const bundle = currentBundle();
  if (!bundle) return { error: 'Updates work in the installed app.' };
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
    return { error: 'Drag Titli into your Applications folder and open it from there, then update.' };
  }
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); }
  catch (e) { return { error: `Titli can’t replace itself in ${path.dirname(bundle)}. Move it to Applications first.` }; }
  return { bundle };
}

function friendly(e) {
  const m = String(e && e.message || e);
  if (/ENOTFOUND|ECONN|ERR_INTERNET|ERR_NAME|ERR_NETWORK|ERR_CONNECTION|ETIMEDOUT|network/i.test(m)) return 'Couldn’t reach the internet. Try again in a moment.';
  if (/ENOSPC/.test(m)) return 'Your Mac is out of space for the update.';
  return m.length < 160 ? m : 'The update didn’t work. Try again.';
}

class Updater extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.manifest = null;
    this.state = {
      status: app.isPackaged ? 'idle' : 'dev',   // dev | idle | checking | uptodate | available | downloading | installing | error
      current: app.getVersion(), latest: null, notes: null, size: 0, progress: 0, error: null, checkedAt: 0
    };
  }

  snapshot() { return { ...this.state }; }
  _set(patch) { Object.assign(this.state, patch); this.emit('change', this.snapshot()); }

  start() {
    if (!app.isPackaged || !PUBLIC_KEY) return;
    setTimeout(() => this.check(), 20000);
    this._timer = setInterval(() => this.check(), CHECK_EVERY);
  }
  stop() { clearInterval(this._timer); }

  // a quiet check when the panel opens, at most once an hour
  maybeCheck() { if (Date.now() - this.state.checkedAt > 3600 * 1000) this.check(); }

  async check({ manual = false } = {}) {
    if (!app.isPackaged) { this._set({ status: 'dev' }); return; }
    if (!PUBLIC_KEY) { this._set({ status: 'error', error: 'This build can’t check for updates.' }); return; }
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return;
    const before = this.state.status;
    this._set({ status: 'checking', error: null });
    try {
      const res = await net.fetch(FEED, { cache: 'no-store' });
      if (res.status === 404) { this._set({ status: 'uptodate', checkedAt: Date.now() }); return; } // nothing published yet
      if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
      const m = verifyManifest(await res.text(), PUBLIC_KEY);
      const build = m.builds[process.arch];
      if (!build) throw new Error('There’s no update for this kind of Mac yet.');
      if (compareVersions(m.version, app.getVersion()) <= 0) {
        this.manifest = null;
        this._set({ status: 'uptodate', latest: m.version, notes: null, checkedAt: Date.now() });
        return;
      }
      const isNew = !this.manifest || this.manifest.version !== m.version;
      this.manifest = m;
      this._set({ status: 'available', latest: m.version, notes: typeof m.notes === 'string' ? m.notes.slice(0, 140) : null, size: build.size, checkedAt: Date.now() });
      if (isNew) this.emit('available', m.version);
    } catch (e) {
      this.log('update check failed:', e.message);
      const back = this.manifest ? 'available' : (manual ? 'error' : (before === 'checking' ? 'idle' : before));
      this._set({ status: back, error: manual ? friendly(e) : null, checkedAt: manual ? Date.now() : this.state.checkedAt });
    }
  }

  async update() {
    if (this.state.status !== 'available' || !this.manifest) return { ok: false };
    const target = installTarget();
    if (target.error) { this._set({ error: target.error }); return { ok: false, error: target.error }; }
    const m = this.manifest, b = m.builds[process.arch];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-update-'));
    let out = null, reader = null;
    const cleanup = () => {
      try { if (out) out.destroy(); } catch (e) { /* already closed */ }
      try { if (reader) reader.cancel(); } catch (e) { /* already done */ }
      fs.rm(dir, { recursive: true, force: true }, () => {});
    };
    this._set({ status: 'downloading', progress: 0, error: null });
    try {
      // 1. download, hashing as we go
      const zip = path.join(dir, b.file);
      const res = await net.fetch(`${RELEASES}/download/v${m.version}/${encodeURIComponent(b.file)}`, { cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}). Try again.`);
      const hash = crypto.createHash('sha256');
      out = fs.createWriteStream(zip);
      reader = res.body.getReader();
      let got = 0, lastTell = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > b.size) throw new Error('The download is bigger than it should be, so it wasn’t installed.');
        hash.update(value);
        if (!out.write(value)) await new Promise(r => out.once('drain', r));
        if (Date.now() - lastTell > 200) { lastTell = Date.now(); this._set({ progress: got / b.size }); }
      }
      await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
      out = null; reader = null;
      if (got !== b.size || hash.digest('hex') !== b.sha256) throw new Error('The download didn’t match what was published, so it wasn’t installed.');

      // 2. unpack and check it's the Titli we were promised
      this._set({ status: 'installing', progress: 1 });
      const unpacked = path.join(dir, 'new');
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      const fresh = path.join(unpacked, 'Titli.app');
      const plist = path.join(fresh, 'Contents', 'Info.plist');
      const id = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
      const ver = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
      if (id !== BUNDLE_ID || ver !== m.version) throw new Error('The download isn’t the expected Titli, so it wasn’t installed.');
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh]);

      // 3. once we've quit: move the old app aside, put the new one in place, reopen. Put the old one back if anything fails.
      const swap = [
        'APP="$1"; NEW="$2"; PID="$3"; TMP="$4"; OLD="$APP.old-$$"',
        'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done',
        'if mv "$APP" "$OLD"; then',
        '  if mv "$NEW" "$APP"; then rm -rf "$OLD"; else mv "$OLD" "$APP"; fi',
        'fi',
        'open "$APP"',
        'rm -rf "$TMP"'
      ].join('\n');
      spawn('/bin/sh', ['-c', swap, 'titli-update', target.bundle, fresh, String(process.pid), dir], { detached: true, stdio: 'ignore' }).unref();
      this.log('update ready, restarting into', m.version);
      setTimeout(() => app.quit(), 300);
      return { ok: true };
    } catch (e) {
      this.log('update failed:', e.message);
      cleanup();
      // keep the offer open, with the reason, so they can try again
      this._set({ status: 'available', error: friendly(e), progress: 0 });
      return { ok: false, error: friendly(e) };
    }
  }
}

module.exports = { Updater, installTarget, currentBundle };
