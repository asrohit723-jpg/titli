'use strict';
// Titli lives in the menu bar on a Mac and by the clock on Windows. Click the butterfly (or press
// ⌥ Space / Ctrl+Alt+Space anywhere) to open the panel; right-click it to send a quick note without
// opening anything.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, powerMonitor, Notification, nativeImage, clipboard, shell, safeStorage } = require('electron');
const path = require('path');
const { Store } = require('../core/store');
const { NtfyRelay } = require('../core/relay');
const { TitliCore } = require('../core/titli');
const Taps = require('../core/taps');
const presence = require('../core/presence');
const { PresenceWatcher, helperPath } = require('./presence-watch');
const { panelBounds } = require('./position');
const { Overlay } = require('./overlay');
const { Delivery } = require('./delivery');
const { Updater } = require('./updater');

const DEV = process.argv.includes('--dev');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
// Mac: ⌥ Space if it's free (apps like Alfred often use it), else ⌃⌥ Space.
// Windows: Alt+Space belongs to the window menu there, so Ctrl+Alt+Space, else Ctrl+Shift+Space.
const SHORTCUTS = MAC
  ? [['Alt+Space', '⌥ Space'], ['Control+Alt+Space', '⌃⌥ Space']]
  : [['Control+Alt+Space', 'Ctrl+Alt+Space'], ['Control+Shift+Space', 'Ctrl+Shift+Space']];
let shortcut = null; // [accelerator, label] that we managed to register
const PANEL_W = 372, PANEL_H = 640;

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
if (MAC && app.dock) app.dock.hide();
if (WIN) app.setAppUserModelId('app.titli.mac'); // matches the installer's shortcut, so notifications show

let tray = null, panel = null, overlay = null, core = null, watcher = null, delivery = null, store = null, updater = null;
// TITLI_TEST_UPDATE=1: CI starts an older build, which updates itself straight away and logs to stdout
const TEST_UPDATE = process.env.TITLI_TEST_UPDATE === '1';
const log = (...a) => { if (DEV || TEST_UPDATE) console.log('[titli]', ...a); };

app.on('second-instance', () => showPanel());
app.on('window-all-closed', e => e.preventDefault()); // a menu-bar app keeps running

// Saved data (your keys, people and notes):
//   Windows: encrypted with a key Windows keeps for your account (DPAPI). It never asks for anything.
//   Mac: a file only your account can open. The Keychain would ask for your Mac password after updates (without
//     a paid Apple developer ID, macOS ties Keychain access to each exact build), and a frozen app waiting on a
//     password prompt is worse. Data that 0.1.45-0.1.51 encrypted is read once (the Keychain may ask one last
//     time) and saved back as a plain file, so the Keychain is never needed again.
function dataLock() {
  if (!app.isPackaged || process.env.TITLI_SMOKE || !(MAC || WIN)) return { crypt: null, encrypt: false };
  const crypt = { name: 'safeStorage', encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b) };
  let encrypt = false;
  if (WIN) { try { encrypt = safeStorage.isEncryptionAvailable(); } catch (e) { encrypt = false; } }
  return { crypt, encrypt };
}

app.whenReady().then(() => {
  if (process.env.TITLI_TEST_DATA) console.log('[titli] data check: opening saved data');
  store = new Store(path.join(app.getPath('userData'), 'titli.json'), dataLock());
  store.load();
  const relay = new NtfyRelay({ server: store.state.settings.relay });
  relay.on('warn', e => log('relay:', e.message));
  core = new TitliCore({ store, relay });
  core.on('warn', e => log('core:', e.message));
  overlay = new Overlay({ dev: DEV });
  watcher = new PresenceWatcher({ powerMonitor, helperPath: helperPath(app), log });
  delivery = new Delivery({ core, overlay, watcher, log });
  updater = new Updater({ log });
  updater.on('change', pushState);
  updater.on('available', v => notify('A new Titli is ready', `Version ${v}. Open Titli and tap Update.`));
  overlay.setProtection(!store.state.settings.allowCapture);

  createTray();
  createPanel();
  wireIpc();
  wireNotifications();

  core.on('changed', pushState);
  watcher.on('change', pushState);
  core.start();
  watcher.start();
  delivery.start();
  updater.start();

  powerMonitor.on('resume', () => relay.restart());
  powerMonitor.on('unlock-screen', () => relay.restart());

  shortcut = SHORTCUTS.find(([acc]) => { try { return globalShortcut.register(acc, togglePanel); } catch (e) { return false; } }) || null;
  if (!shortcut) log('no global shortcut available');
  applyLoginItem();

  // TITLI_TEST_DATA=write|read: CI checks the saved data stays readable (and encrypted) across versions, then quits
  if (process.env.TITLI_TEST_DATA) {
    const mode = process.env.TITLI_TEST_DATA;
    if (mode === 'write') { store.state.quick = ['keychain-check', ...store.state.quick.filter(q => q !== 'keychain-check')]; store.saveNow(); }
    let raw = ''; try { raw = require('fs').readFileSync(store.file, 'utf8'); } catch (e) { raw = ''; }
    console.log(`[titli] data ${mode}: encrypted=${store.encrypt} onDiskEncrypted=${/"titliEncrypted":1/.test(raw)} marker=${store.state.quick.includes('keychain-check')} unlockFailed=${store.unlockFailed} version=${app.getVersion()}`);
    setTimeout(() => app.exit(0), 300);
    return;
  }
  if (store.unlockFailed) setTimeout(() => notify('Titli started fresh', 'It couldn’t unlock what it had saved on this computer. Pair again with your people.'), 1500);
  if (!store.state.me.name && !TEST_UPDATE) setTimeout(showPanel, 600); // first run: say hello
  if (TEST_UPDATE) updater.check({ manual: true }).then(() => { log('test update: status', updater.state.status, updater.state.latest); return updater.update(); }).then(r => log('test update: result', JSON.stringify(r), updater.state.errorDetail || ''));
  if (process.env.TITLI_SMOKE) global.__titli = { panel, overlay, core, delivery, watcher, updater, showPanel, preview, store };
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (delivery) delivery.stop();
  if (updater) updater.stop();
  if (watcher) watcher.stop();
  if (core) core.stop();
});

/* ---------------- menu bar ---------------- */

function trayImage() {
  // Mac: a black template icon the menu bar tints. Windows: the coloured butterfly, readable on light and dark taskbars.
  const img = nativeImage.createFromPath(path.join(__dirname, '../../assets', MAC ? 'trayTemplate.png' : 'trayWin.png'));
  if (MAC) img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Titli');
  tray.on('click', togglePanel);
  if (WIN) tray.on('double-click', showPanel);
  tray.on('right-click', () => tray.popUpContextMenu(quickMenu()));
}

// right-click: send a quick note in one click, without opening the panel
function quickMenu() {
  const snap = core.snapshot();
  const circles = snap.circles.filter(c => c.members.length);
  const to = circles.find(c => c.id === snap.lastTo) || circles[0];
  const items = [];
  const up = updater && updater.snapshot();
  if (up && up.status === 'available') {
    items.push({ label: `Update Titli to ${up.latest}`, click: () => { showPanel(); updater.update(); } });
    items.push({ type: 'separator' });
  }
  if (!snap.me.name || !to) {
    items.push({ label: snap.me.name ? 'Pair with someone to start' : 'Set up Titli', click: showPanel });
  } else {
    const send = text => () => notifySent(core.send({ circleId: to.id, text, style: snap.settings.style }), to.name);
    items.push({ label: `Send to ${to.name}`, enabled: false });
    items.push({ label: `${to.tap}  ${Taps.label(to.tap) || 'One tap'}`, click: send(null) });
    // their own notes first, then the ones for everyone
    const notes = [...(snap.quickFor[to.id] || []), ...snap.quick.filter(q => !(snap.quickFor[to.id] || []).includes(q))];
    notes.forEach((q, i) => items.push({ label: q, accelerator: i < 9 ? String(i + 1) : undefined, click: send(q) }));
    if (circles.length > 1) {
      items.push({ type: 'separator' });
      items.push({ label: 'Send to', submenu: circles.map(c => ({ label: c.kind === 'group' ? `${c.name} (group)` : c.name, type: 'radio', checked: c.id === to.id, click: () => { store.state.lastTo = c.id; store.save(); pushState(); } })) });
    }
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Open Titli', accelerator: shortcut ? shortcut[0] : undefined, click: showPanel });
  items.push({ label: 'Quit Titli', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

/* ---------------- panel ---------------- */

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, show: false, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    transparent: true, backgroundColor: '#00000000', hasShadow: MAC, roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, '../preload/panel.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (MAC) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, '../renderer/panel/index.html'));
  panel.on('blur', () => { if (!panel.webContents.isDevToolsOpened() && Date.now() > pickingUntil) { panel.hide(); hiddenAt = Date.now(); } });
  panel.on('focus', () => stopPicking());
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', e => e.preventDefault());
}

function positionPanel() {
  let tb = null;
  try { tb = tray.getBounds(); } catch (e) { tb = null; }
  const hasTray = tb && tb.width > 0;
  const display = hasTray ? screen.getDisplayNearestPoint({ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  panel.setBounds(panelBounds({ tray: hasTray ? tb : null, work: display.workArea, width: PANEL_W, height: PANEL_H, platform: process.platform }));
}

function showPanel() {
  if (!panel) return;
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.send('panel:opened');
  if (updater) updater.maybeCheck();
}

// the system emoji picker can take focus from the panel: keep the panel open while it's up (a minute at most)
let pickingUntil = 0, pickTimer = null;
function startPicking() {
  if (!app.isEmojiPanelSupported()) return false;
  pickingUntil = Date.now() + 60 * 1000;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => { pickingUntil = 0; if (panel && panel.isVisible() && !panel.isFocused()) panel.hide(); }, 60 * 1000);
  app.showEmojiPanel();
  return true;
}
function stopPicking() { pickingUntil = 0; clearTimeout(pickTimer); }

// clicking the icon while the panel is open first blurs (and hides) it; don't pop it straight back up
let hiddenAt = 0;
function togglePanel() {
  if (panel && panel.isVisible()) panel.hide();
  else if (Date.now() - hiddenAt > 300) showPanel();
}

/* ---------------- talking to the panel ---------------- */

const CORE_CALLS = new Set(['setName', 'setSettings', 'addQuick', 'removeQuick', 'reorderQuick', 'createInvite', 'createGroupInvite', 'cancelInvite', 'joinCode', 'createGroup', 'leave', 'removeMember', 'setTap', 'send']);

function fullState() {
  const snap = core.snapshot();
  const p = delivery.status();
  return {
    ...snap,
    presence: { busy: p.busy, reason: p.reason, text: p.reason ? presence.REASON_TEXT[p.reason] : null, helper: watcher.helperOk },
    shortcut: shortcut ? shortcut[1] : null,
    platform: process.platform,
    dataProtected: !!(store && store.encrypt),
    version: app.getVersion(),
    update: updater ? updater.snapshot() : null
  };
}

let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel:state', fullState());
  }, 60);
}

function wireIpc() {
  const fromPanel = e => panel && e.sender === panel.webContents;
  ipcMain.handle('panel:state', e => fromPanel(e) ? fullState() : null);
  ipcMain.handle('panel:call', (e, method, args) => {
    if (!fromPanel(e) || !CORE_CALLS.has(method)) return { ok: false, error: 'Not allowed.' };
    try {
      const r = core[method](...(Array.isArray(args) ? args : [])) || { ok: true };
      if (method === 'setSettings') { applyLoginItem(); overlay.setProtection(!store.state.settings.allowCapture); delivery.tick(); }
      pushState();
      return r;
    } catch (err) {
      log('call failed', method, err);
      return { ok: false, error: 'Something went wrong. Please try again.' };
    }
  });
  ipcMain.handle('panel:ui', (e, action, arg) => {
    if (!fromPanel(e)) return false;
    if (action === 'hide') { stopPicking(); panel.hide(); }
    else if (action === 'emojiPicker') return startPicking();
    else if (action === 'emojiPicked') { const wasPicking = pickingUntil > 0; stopPicking(); if (wasPicking && panel.isVisible() && !panel.isFocused()) panel.focus(); }
    else if (action === 'quit') app.quit();
    else if (action === 'copy' && typeof arg === 'string' && arg.length < 4000) clipboard.writeText(arg);
    else if (action === 'copySecret' && typeof arg === 'string' && arg.length < 100) copySecret(arg);
    else if (action === 'open' && typeof arg === 'string' && /^https:\/\/(github\.com|docs\.ntfy\.sh)\//.test(arg)) shell.openExternal(arg);
    else if (action === 'preview') preview(typeof arg === 'string' ? arg : null);
    else if (action === 'checkUpdate') updater.check({ manual: true });
    else if (action === 'installUpdate') updater.update();
    return true;
  });
}

// an invite code: copied for pasting, then wiped from the clipboard after two minutes if it's still there
let clipTimer = null;
function copySecret(text) {
  clipboard.writeText(text);
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => { if (clipboard.readText() === text) clipboard.clear(); }, 2 * 60 * 1000);
}

// lands a butterfly on your own screen, to see how it looks or to film it
function preview(text) {
  core.s.inbox.push({ kind: 'note', id: 'preview-' + Date.now(), circleId: null, from: 'me', fromName: store.state.me.name || 'You', circleName: null, text: text || 'Thinking of you', style: store.state.settings.style, at: Date.now(), preview: true });
  core.emit('inbox');
  panel.hide();
}

/* ---------------- notifications ---------------- */

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

function notifySent(r) {
  if (r && !r.ok && r.error) notify('Titli', r.error);
}

function wireNotifications() {
  core.on('reaction', ({ fromName, r, text, g }) => {
    if (store.state.settings.notifyReactions) notify(`${fromName} reacted ${r}`, text ? `to “${text}”` : `to your ${Taps.word(g) || g}`);
  });
  core.on('paired', ({ name }) => notify('Paired', `You and ${name} can send each other butterflies now.`));
  core.on('joined', ({ name, group }) => notify(group, `${name} joined the group.`));
  core.on('unpaired', ({ name }) => notify('Titli', `You and ${name} are no longer connected on Titli.`));
  core.on('joinedGroup', ({ group }) => notify(group, 'You’re in. Send the first butterfly.'));
  core.on('removed', ({ group }) => notify('Titli', `You’re no longer in ${group}.`));
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!store.state.settings.openAtLogin, openAsHidden: true });
}
