'use strict';
// Titli lives in the menu bar. Click the butterfly (or press ⌥ Space anywhere) to open the panel;
// right-click it to send a quick note without opening anything.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, powerMonitor, Notification, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const { Store } = require('../core/store');
const { NtfyRelay } = require('../core/relay');
const { TitliCore } = require('../core/titli');
const presence = require('../core/presence');
const { PresenceWatcher, helperPath } = require('./presence-mac');
const { Overlay } = require('./overlay');
const { Delivery } = require('./delivery');

const DEV = process.argv.includes('--dev');
// ⌥ Space if it's free; apps like Alfred often use it, so fall back to ⌃⌥ Space
const SHORTCUTS = [['Alt+Space', '⌥ Space'], ['Control+Alt+Space', '⌃⌥ Space']];
let shortcut = null; // [accelerator, label] that we managed to register
const PANEL_W = 372, PANEL_H = 640;

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
if (process.platform === 'darwin' && app.dock) app.dock.hide();

let tray = null, panel = null, overlay = null, core = null, watcher = null, delivery = null, store = null;
const log = (...a) => { if (DEV) console.log('[titli]', ...a); };

app.on('second-instance', () => showPanel());
app.on('window-all-closed', e => e.preventDefault()); // a menu-bar app keeps running

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'titli.json'));
  store.load();
  const relay = new NtfyRelay({ server: store.state.settings.relay });
  relay.on('warn', e => log('relay:', e.message));
  core = new TitliCore({ store, relay });
  core.on('warn', e => log('core:', e.message));
  overlay = new Overlay({ dev: DEV });
  watcher = new PresenceWatcher({ powerMonitor, helperPath: helperPath(app), log });
  delivery = new Delivery({ core, overlay, watcher, log });
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

  // schedules: check twice a minute, and right after waking up
  core.checkSchedules();
  setInterval(() => core.checkSchedules(), 20000);
  powerMonitor.on('resume', () => { relay.restart(); setTimeout(() => core.checkSchedules(), 1500); });
  powerMonitor.on('unlock-screen', () => relay.restart());

  shortcut = SHORTCUTS.find(([acc]) => { try { return globalShortcut.register(acc, togglePanel); } catch (e) { return false; } }) || null;
  if (!shortcut) log('no global shortcut available');
  applyLoginItem();

  if (!store.state.me.name) setTimeout(showPanel, 600); // first run: say hello
  if (process.env.TITLI_SMOKE) global.__titli = { panel, overlay, core, delivery, watcher, showPanel, preview, store };
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (delivery) delivery.stop();
  if (watcher) watcher.stop();
  if (core) core.stop();
});

/* ---------------- menu bar ---------------- */

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '../../assets/trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Titli');
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(quickMenu()));
}

// right-click: send a quick note in one click, without opening the panel
function quickMenu() {
  const snap = core.snapshot();
  const circles = snap.circles.filter(c => c.members.length);
  const to = circles.find(c => c.id === snap.lastTo) || circles[0];
  const items = [];
  if (!snap.me.name || !to) {
    items.push({ label: snap.me.name ? 'Pair with someone to start' : 'Set up Titli', click: showPanel });
  } else {
    const send = text => () => notifySent(core.send({ circleId: to.id, text, style: snap.settings.style }), to.name);
    items.push({ label: `Send to ${to.name}`, enabled: false });
    items.push({ label: '♥  A heart', click: send(null) });
    snap.quick.forEach((q, i) => items.push({ label: q, accelerator: i < 9 ? String(i + 1) : undefined, click: send(q) }));
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
    transparent: true, backgroundColor: '#00000000', hasShadow: true, roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, '../preload/panel.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, '../renderer/panel/index.html'));
  panel.on('blur', () => { if (!panel.webContents.isDevToolsOpened()) panel.hide(); });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', e => e.preventDefault());
}

function positionPanel() {
  const tb = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x || 0, y: tb.y || 0 });
  const wa = display.workArea;
  let x = Math.round((tb.x || wa.x + wa.width) + (tb.width || 0) / 2 - PANEL_W / 2);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - PANEL_W - 8));
  const y = wa.y + 6;
  panel.setBounds({ x, y, width: PANEL_W, height: Math.min(PANEL_H, wa.height - 12) });
}

function showPanel() {
  if (!panel) return;
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.send('panel:opened');
}

function togglePanel() {
  if (panel && panel.isVisible()) panel.hide(); else showPanel();
}

/* ---------------- talking to the panel ---------------- */

const CORE_CALLS = new Set(['setName', 'setSettings', 'addQuick', 'removeQuick', 'createInvite', 'cancelInvite', 'joinCode', 'createGroup', 'leave', 'send', 'addSchedule', 'updateSchedule', 'removeSchedule', 'sendScheduleNow']);

function fullState() {
  const snap = core.snapshot();
  const p = delivery.status();
  return {
    ...snap,
    presence: { busy: p.busy, reason: p.reason, text: p.reason ? presence.REASON_TEXT[p.reason] : null, helper: watcher.helperOk },
    shortcut: shortcut ? shortcut[1] : null,
    version: app.getVersion()
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
    if (action === 'hide') panel.hide();
    else if (action === 'quit') app.quit();
    else if (action === 'copy' && typeof arg === 'string' && arg.length < 200) clipboard.writeText(arg);
    else if (action === 'open' && typeof arg === 'string' && /^https:\/\/(github\.com|docs\.ntfy\.sh)\//.test(arg)) shell.openExternal(arg);
    else if (action === 'preview') preview(typeof arg === 'string' ? arg : null);
    return true;
  });
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
  core.on('reaction', ({ fromName, r, text }) => {
    if (store.state.settings.notifyReactions) notify(`${fromName} reacted ${r}`, text ? `to “${text}”` : 'to your heart');
  });
  core.on('paired', ({ name }) => notify('Paired', `You and ${name} can send each other butterflies now.`));
  core.on('joined', ({ name, group }) => notify(group, `${name} joined the group.`));
  core.on('unpaired', ({ name }) => notify('Titli', `${name} unpaired from you.`));
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!store.state.settings.openAtLogin, openAsHidden: true });
}
