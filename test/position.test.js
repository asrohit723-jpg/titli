'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { panelBounds } = require('../src/main/position');

const W = 372, H = 640;
const inside = (b, work) => b.x >= work.x && b.y >= work.y && b.x + b.width <= work.x + work.width && b.y + b.height <= work.y + work.height;

test('Mac: just under the menu-bar icon', () => {
  const work = { x: 0, y: 25, width: 1512, height: 957 };
  const b = panelBounds({ tray: { x: 1300, y: 0, width: 24, height: 24 }, work, width: W, height: H, platform: 'darwin' });
  assert.equal(b.y, 31);
  assert.equal(b.x, Math.round(1312 - W / 2));
  assert.ok(inside(b, work));
});

test('Mac: an icon at the far right still keeps the panel on screen', () => {
  const work = { x: 0, y: 25, width: 1512, height: 957 };
  const b = panelBounds({ tray: { x: 1500, y: 0, width: 24, height: 24 }, work, width: W, height: H, platform: 'darwin' });
  assert.ok(inside(b, work));
});

test('Windows, taskbar at the bottom: right above the tray icon', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1032 };            // 48px taskbar below
  const b = panelBounds({ tray: { x: 1700, y: 1040, width: 24, height: 32 }, work, width: W, height: H, platform: 'win32' });
  assert.equal(b.y + b.height, 1032 - 8, 'sits on top of the taskbar');
  assert.equal(b.x, Math.round(1712 - W / 2));
  assert.ok(inside(b, work));
});

test('Windows, taskbar at the top, left or right', () => {
  const top = { x: 0, y: 48, width: 1920, height: 1032 };
  const t = panelBounds({ tray: { x: 1700, y: 8, width: 24, height: 32 }, work: top, width: W, height: H, platform: 'win32' });
  assert.equal(t.y, 56); assert.ok(inside(t, top));

  const left = { x: 62, y: 0, width: 1858, height: 1080 };
  const l = panelBounds({ tray: { x: 19, y: 980, width: 24, height: 24 }, work: left, width: W, height: H, platform: 'win32' });
  assert.equal(l.x, 70); assert.ok(inside(l, left));

  const right = { x: 0, y: 0, width: 1858, height: 1080 };
  const r = panelBounds({ tray: { x: 1877, y: 980, width: 24, height: 24 }, work: right, width: W, height: H, platform: 'win32' });
  assert.equal(r.x + r.width, 1850); assert.ok(inside(r, right));
});

test('Windows, icon hidden under the ^ arrow or unknown: bottom right', () => {
  const work = { x: 0, y: 0, width: 1366, height: 728 };
  const b = panelBounds({ tray: null, work, width: W, height: H, platform: 'win32' });
  assert.equal(b.x + b.width, 1366 - 8);
  assert.equal(b.y + b.height, 728 - 8);
});

test('a short screen shrinks the panel instead of hiding part of it', () => {
  const work = { x: 0, y: 0, width: 1280, height: 600 };
  const b = panelBounds({ tray: { x: 1200, y: 610, width: 24, height: 24 }, work, width: W, height: H, platform: 'win32' });
  assert.equal(b.height, 600 - 16);
  assert.ok(inside(b, work));
});
