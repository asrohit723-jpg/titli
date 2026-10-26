'use strict';
// Starts Titli, opens the panel, lands a preview butterfly and saves screenshots. Used in CI and local checks:
//   xvfb-run -a npx electron scripts/smoke.js   (Linux)   or   npx electron scripts/smoke.js   (Mac)
process.env.TITLI_SMOKE = '1';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const out = process.env.TITLI_SMOKE_OUT || path.join(__dirname, '../dist/smoke');
app.setPath('userData', path.join(out, 'userdata'));
require('../src/main/main.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const save = async (wc, name) => { const img = await wc.capturePage(); fs.writeFileSync(path.join(out, name), img.toPNG()); };

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const errors = [];
  await wait(1500);
  const t = global.__titli;
  for (const w of [t.panel.webContents]) w.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  t.showPanel();
  await wait(2000);   // a fresh window needs a moment for its first paint
  await save(t.panel.webContents, 'panel-onboarding.png');
  t.core.setName('Rohit');
  await wait(400);
  await save(t.panel.webContents, 'panel-main.png');
  // CI machines look 'away' (no one is typing), so don't hold the butterfly for that here
  t.core.setSettings({ holdWhenAway: false, holdInMeetings: false });
  const seen = [];
  t.overlay.on('event', ev => seen.push(ev.type));
  t.preview('Thinking of you');
  await wait(1200);
  t.overlay.win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push('overlay: ' + msg); });
  await wait(15000);
  await save(t.overlay.win.webContents, 'overlay-landed.png');
  fs.writeFileSync(path.join(out, 'errors.txt'), errors.join('\n'));
  const ok = seen.includes('shown') && errors.length === 0;
  console.log(`SMOKE_${ok ? 'OK' : 'FAILED'} events=${seen.join(',')} errors=${errors.length}`);
  app.exit(ok ? 0 : 1);
});
