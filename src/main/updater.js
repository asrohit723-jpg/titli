'use strict';
// Keeps Titli up to date without a trip to GitHub.
//   check:  read the signed latest-mac.json / latest-win.json from the public releases repo
//   update: download this computer's file and check its size and SHA-256 against the signed manifest.
//           Mac: unpack the zip, check it's a whole, correctly signed Titli of the promised version,
//                then quit, swap the app and reopen it.
//           Windows: run the installer silently; it replaces Titli and opens it again.
// Files we download ourselves aren't marked as "from the internet", so the new version opens without
// the "Open Anyway" / SmartScreen step. That's why every check has to pass before anything runs.

const { app, net } = require('electron');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { verifyManifest, compareVersions } = require('../core/update-manifest');

const RELEASES = 'https://github.com/asrohit723-jpg/titli-releases/releases';
const WIN = process.platform === 'win32';
const PLATFORM = WIN ? 'win' : 'mac';
const FEED = `${RELEASES}/latest/download/latest-${PLATFORM}.json`;
const BUNDLE_ID = 'app.titli.mac';
const CHECK_EVERY = 6 * 3600 * 1000;
const PUBLIC_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, 'update-key.pem'), 'utf8'); } catch (e) { return null; } })();

// a failure with a short message for people and the full story for the log and "Copy details"
class StepError extends Error {
  constructor(message, detail) { super(message); this.detail = detail || message; }
}

const run = (cmd, args, failMessage) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) return resolve(String(stdout).trim());
    reject(new StepError(failMessage, `${path.basename(cmd)} failed (${err.code != null ? err.code : err.signal}): ${String(stderr || err.message).trim()}`));
  });
});

// reads one string value from an app's Info.plist (XML, as electron-builder writes it) without plutil
function plistValue(file, key) {
  const xml = fs.readFileSync(file, 'utf8');
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1].trim() : null;
}

const LOG_FILE = () => path.join(app.getPath('logs'), 'updates.log');
function logToFile(line) {
  try { fs.mkdirSync(path.dirname(LOG_FILE()), { recursive: true }); fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} ${line}\n`); } catch (e) { /* best effort */ }
}

// /Applications/Titli.app/Contents/MacOS/Titli -> /Applications/Titli.app
function currentBundle() {
  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/Contents/MacOS/');
  return i < 0 ? null : exe.slice(0, i + 4);
}

// where the new version would go, or why it can't
function installTarget() {
  if (WIN) return app.isPackaged ? { bundle: null } : { error: 'Updates work in the installed app.' };
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
  if (/ENOSPC/.test(m)) return 'Your computer is out of space for the update.';
  return m.length < 200 ? m : m.slice(0, 197) + '…';
}
const detailOf = e => String((e && (e.detail || e.stack || e.message)) || e).slice(0, 3000);

class Updater extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.manifest = null;
    this.state = {
      status: app.isPackaged ? 'idle' : 'dev',   // dev | idle | checking | uptodate | available | downloading | installing | error
      current: app.getVersion(), latest: null, notes: null, size: 0, progress: 0, error: null, errorDetail: null, checkedAt: 0
    };
  }

  snapshot() { return { ...this.state }; }
  _set(patch) { Object.assign(this.state, patch); this.emit('change', this.snapshot()); }

  start() {
    if (!app.isPackaged || !PUBLIC_KEY) return;
    sweepOldDownloads();
    this._reportFailedSwap();
    setTimeout(() => this.check(), 20000);
    this._timer = setInterval(() => this.check(), CHECK_EVERY);
  }
  stop() { clearInterval(this._timer); }

  // the swap happens after we quit; if the last thing it logged was a failure, say so once we're back
  _reportFailedSwap() {
    let last = '';
    try { last = fs.readFileSync(LOG_FILE(), 'utf8').trim().split('\n').pop() || ''; } catch (e) { return; }
    if (!/SWAP FAILED/.test(last)) return;
    const blocked = /not permitted/i.test(last);
    this._set({
      error: blocked
        ? 'macOS stopped Titli from replacing itself. Allow Titli in System Settings → Privacy & Security → App Management, then update again.'
        : 'The last update couldn’t replace Titli, so you still have this version. Try again.',
      errorDetail: last
    });
    logToFile('reported the failed swap');
  }

  // a quiet check when the panel opens, at most once an hour
  maybeCheck() { if (Date.now() - this.state.checkedAt > 3600 * 1000) this.check(); }

  async check({ manual = false } = {}) {
    if (!app.isPackaged) { this._set({ status: 'dev' }); return; }
    if (!PUBLIC_KEY) { this._set({ status: 'error', error: 'This build can’t check for updates.' }); return; }
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return;
    const before = this.state.status;
    this._set({ status: 'checking', error: null, errorDetail: null });
    try {
      const res = await net.fetch(FEED, { cache: 'no-store' });
      if (res.status === 404) { this._set({ status: 'uptodate', checkedAt: Date.now() }); return; } // nothing published yet
      if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
      const m = verifyManifest(await res.text(), PUBLIC_KEY, { platform: PLATFORM });
      const build = m.builds[process.arch];
      if (!build) throw new Error('There’s no update for this kind of computer yet.');
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
      this.log('update check failed:', detailOf(e));
      logToFile(`check failed: ${detailOf(e)}`);
      const back = this.manifest ? 'available' : (manual ? 'error' : (before === 'checking' ? 'idle' : before));
      this._set({ status: back, error: manual ? friendly(e) : null, errorDetail: manual ? detailOf(e) : null, checkedAt: manual ? Date.now() : this.state.checkedAt });
    }
  }

  async update() {
    if (this.state.status !== 'available' || !this.manifest) return { ok: false };
    const target = installTarget();
    if (target.error) { this._set({ error: target.error, errorDetail: `install target: ${app.getPath('exe')}` }); return { ok: false, error: target.error }; }
    const m = this.manifest, b = m.builds[process.arch];
    let dir;
    try { dir = workDir(); }
    catch (e) { this._set({ error: 'Titli couldn’t make a folder for the update.', errorDetail: detailOf(e) }); return { ok: false }; }
    let out = null, reader = null;
    const cleanup = () => {
      try { if (out) out.destroy(); } catch (e) { /* already closed */ }
      try { if (reader) reader.cancel(); } catch (e) { /* already done */ }
      fs.rm(dir, { recursive: true, force: true }, () => {});
    };
    this._set({ status: 'downloading', progress: 0, error: null, errorDetail: null });
    logToFile(`updating ${app.getVersion()} -> ${m.version} (${process.platform} ${process.arch})`);
    try {
      // 1. download, hashing as we go
      const file = path.join(dir, b.file);
      const res = await net.fetch(`${RELEASES}/download/v${m.version}/${encodeURIComponent(b.file)}`, { cache: 'no-store' });
      if (!res.ok || !res.body) throw new StepError(`The download failed (${res.status}). Try again.`, `download ${res.status} ${res.url}`);
      const hash = crypto.createHash('sha256');
      out = fs.createWriteStream(file);
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
      const digest = hash.digest('hex');
      if (got !== b.size || digest !== b.sha256) throw new StepError('The download didn’t match what was published, so it wasn’t installed.', `size ${got}/${b.size}, sha256 ${digest} vs ${b.sha256}`);

      this._set({ status: 'installing', progress: 1 });
      if (WIN) {
        // 2w. the installer (verified above) replaces Titli quietly and opens it again; we just get out of its way
        spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        this.log('installer started for', m.version);
      logToFile(`verified ${m.version}, running the installer`);
        setTimeout(() => app.quit(), 300);
        return { ok: true };
      }

      // 2. unpack and check it's the Titli we were promised. Unpack under a name that isn't an app yet
      //    (Titli.update) and rename it at the end: recent macOS can refuse to create the symlinks inside
      //    a half-unpacked .app ("Operation not permitted"). ditto is the fallback.
      const unpacked = path.join(dir, 'new');
      const fresh = path.join(unpacked, 'Titli.app');
      await unpack(file, unpacked, fresh);
      const plist = path.join(fresh, 'Contents', 'Info.plist');
      let id = null, ver = null;
      try { id = plistValue(plist, 'CFBundleIdentifier'); ver = plistValue(plist, 'CFBundleShortVersionString'); }
      catch (e) { throw new StepError('The update was missing pieces, so it wasn’t installed.', `Info.plist: ${e.message}`); }
      if (id !== BUNDLE_ID || ver !== m.version) throw new StepError('The download isn’t the expected Titli, so it wasn’t installed.', `bundle ${id} ${ver}, expected ${BUNDLE_ID} ${m.version}`);
      // a whole, correctly signed app: Apple Silicon Macs won't open one that isn't, so never swap one in
      await run('/usr/bin/codesign', ['--verify', '--deep', fresh], 'The new version’s signature didn’t check out, so it wasn’t installed.');

      // 3. once we've quit: move the old app aside, put the new one in place, reopen. Put the old one back if anything fails.
      //    The outcome goes in the log, so if the swap fails the next launch can say why.
      const swap = [
        'APP="$1"; NEW="$2"; PID="$3"; TMP="$4"; LOG="$5"; OLD="$APP.old-$$"',
        'stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
        'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done',
        'if err="$(mv "$APP" "$OLD" 2>&1)"; then',
        '  if err="$(mv "$NEW" "$APP" 2>&1)"; then rm -rf "$OLD"; echo "$(stamp) swapped in the new version" >> "$LOG"',
        '  else mv "$OLD" "$APP"; echo "$(stamp) SWAP FAILED putting the new version in place: $err" >> "$LOG"; fi',
        'else echo "$(stamp) SWAP FAILED moving the old version aside: $err" >> "$LOG"; fi',
        'open "$APP"',
        'rm -rf "$TMP"'
      ].join('\n');
      spawn('/bin/sh', ['-c', swap, 'titli-update', target.bundle, fresh, String(process.pid), dir, LOG_FILE()], { detached: true, stdio: 'ignore' }).unref();
      this.log('update ready, restarting into', m.version);
      logToFile(`verified ${m.version}, swapping ${target.bundle} and reopening`);
      setTimeout(() => app.quit(), 300);
      return { ok: true };
    } catch (e) {
      this.log('update failed:', detailOf(e));
      logToFile(`update failed: ${friendly(e)} | ${detailOf(e)}`);
      cleanup();
      // keep the offer open, with the reason, so they can try again
      this._set({ status: 'available', error: friendly(e), errorDetail: detailOf(e), progress: 0 });
      return { ok: false, error: friendly(e) };
    }
  }
}

// bsdtar renames the top folder on the way out (Titli.app -> Titli.update); ditto can't, so it's the fallback
async function unpack(zip, into, fresh) {
  fs.mkdirSync(into, { recursive: true });
  const staged = path.join(into, 'Titli.update');
  try {
    await run('/usr/bin/bsdtar', ['-x', '-f', zip, '-C', into, '-s', '/^Titli\\.app/Titli.update/S'], 'Couldn’t unpack the update.');
    fs.renameSync(staged, fresh);
    return;
  } catch (e) {
    logToFile(`bsdtar unpack failed, trying ditto: ${detailOf(e)}`);
    fs.rmSync(into, { recursive: true, force: true });
  }
  await run('/usr/bin/ditto', ['-x', '-k', zip, into], 'Couldn’t unpack the update.');
}

// Where an update is downloaded and unpacked: Titli's own folder, by its real path.
// Not the system temp folder: on macOS 15 its path goes through a symlink (/var -> /private/var),
// and ditto then refuses to create the app's own symlinks there ("Operation not permitted").
function updatesRoot() { return path.join(app.getPath('userData'), 'updates'); }
function workDir() {
  fs.mkdirSync(updatesRoot(), { recursive: true });
  return fs.mkdtempSync(path.join(fs.realpathSync(updatesRoot()), 'titli-update-'));
}

// downloads left behind by earlier updates (a Windows installer can't delete the folder it ran from)
function sweepOldDownloads() {
  for (const root of [updatesRoot(), os.tmpdir()]) {
    fs.readdir(root, (err, names) => {
      if (err) return;
      for (const n of names) {
        if (!n.startsWith('titli-update-')) continue;
        const p = path.join(root, n);
        fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > 3600 * 1000) fs.rm(p, { recursive: true, force: true }, () => {}); });
      }
    });
  }
}

module.exports = { Updater, installTarget, currentBundle };
