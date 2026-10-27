'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('../src/renderer/vendor/three.min.js');
const Flight = require('../src/renderer/overlay/flight-paths.js');

const S = 20;
const SCREENS = [[1440, 900, 24], [1280, 800, 24], [1512, 982, 33], [1920, 1080, 36], [2560, 1440, 24], [1366, 728, 36]];
function seeded(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// the same numbers the overlay uses
function ctxFor(W, H, menubar, rng, recent) {
  const D = (H / 2) / Math.tan(THREE.MathUtils.degToRad(15));
  const perch = { x: (W - (S * 1.6 + 22)) - W / 2, y: H / 2 - (menubar + S * 1.2 + 10), z: 0 };
  return { W, H, S, D, menubar, rng, recent, at: perch, makeCurve: pts => Flight.makeCurve(THREE, D, pts) };
}
const onScreen = (p, W, H, D) => { const k = D / (D - p.z); return Math.abs(p.x * k) < W / 2 && Math.abs(p.y * k) < H / 2; };

test('flight: arrivals come in from off screen and land exactly on the perch, smoothly', () => {
  let fallbacks = 0, n = 0;
  for (const [W, H, mb] of SCREENS) for (let seed = 1; seed <= 60; seed++) {
    const ctx = ctxFor(W, H, mb, seeded(seed * 101 + W));
    const r = Flight.plan('entry', ctx);
    n++; if (r.fallback) fallbacks++;
    const end = r.curve.getPointAt(1), start = r.curve.getPointAt(0);
    assert.ok(end.distanceTo(new THREE.Vector3(ctx.at.x, ctx.at.y, 0)) < 1e-6, `${r.name} ends on the perch`);
    assert.equal(onScreen(start, W, H, ctx.D), false, `${r.name} starts off screen (${W}x${H})`);
    assert.ok(r.info.ok, `${r.name} passes its checks`);
    assert.ok(r.info.tightMid >= S * 3, `${r.name} has no sharp turns (${r.info.tightMid.toFixed(0)}px)`);
    assert.ok(r.duration >= 6500 && r.duration <= 10000, `${r.name} takes a sensible time (${r.duration})`);
    assert.ok(['calm', 'easy', 'playful'].includes(r.mood.name));
  }
  assert.ok(fallbacks / n < .01, `the plain fallback route is almost never needed (${fallbacks}/${n})`);
});

test('flight: departures lift off the perch and leave the screen without coming back', () => {
  for (const [W, H, mb] of SCREENS) for (let seed = 1; seed <= 60; seed++) {
    const ctx = ctxFor(W, H, mb, seeded(seed * 211 + H));
    const r = Flight.plan('exit', ctx);
    const start = r.curve.getPointAt(0), end = r.curve.getPointAt(1);
    assert.ok(start.distanceTo(new THREE.Vector3(ctx.at.x, ctx.at.y, 0)) < 1e-6, `${r.name} starts on the perch`);
    assert.equal(onScreen(end, W, H, ctx.D), false, `${r.name} ends off screen`);
    assert.ok(r.info.ok && r.info.inOut, `${r.name} passes its checks`);
    assert.ok(r.duration >= 4500 && r.duration <= 8500);
  }
});

test('flight: every visit is different from the last few, and every route gets flown', () => {
  for (const kind of ['entry', 'exit']) {
    const keep = kind === 'entry' ? 3 : 2, names = kind === 'entry' ? Flight.ENTRIES : Flight.EXITS;
    const rng = seeded(kind === 'entry' ? 7 : 11), log = [], approaches = new Set(), moods = new Set();
    for (let i = 0; i < 120; i++) {
      const r = Flight.plan(kind, ctxFor(1440, 900, 24, rng, log.slice(-keep)));
      assert.ok(!log.slice(-keep).includes(r.name), `${kind} ${i}: ${r.name} was flown in the last ${keep}`);
      log.push(r.name); if (r.approach) approaches.add(r.approach); moods.add(r.mood.name);
    }
    for (const n of names) assert.ok(log.includes(n), `${kind} route "${n}" is used`);
    if (kind === 'entry') assert.deepEqual([...approaches].sort(), ['level', 'rise', 'swoop']);
    assert.ok(moods.size === 3, `${kind}: all three moods turn up`);
  }
});

test('flight: the same pattern still comes out different each time', () => {
  const a = Flight.build('entry', 'loop', ctxFor(1440, 900, 24, seeded(1))).points;
  const b = Flight.build('entry', 'loop', ctxFor(1440, 900, 24, seeded(2))).points;
  const moved = a.some((p, i) => b[i] && Math.hypot(p.x - b[i].x, p.y - b[i].y) > 10) || a.length !== b.length;
  assert.ok(moved, 'two loops are not identical');
});

test('flight: every landing spot (corners and the middle of each side) gets smooth routes that end on it', () => {
  const spots = (W, H, I) => {
    const side = S * 1.6 + 22, xR = W - I.right - side, xL = I.left + side;
    const yT = I.top + S * 1.2 + 10, yB = H - I.bottom - (S * 1.6 + 18), yM = I.top + (H - I.top - I.bottom) * .42;
    return { tr: [xR, yT], tl: [xL, yT], br: [xR, yB], bl: [xL, yB], rm: [xR, yM], lm: [xL, yM] };
  };
  const setups = [[1440, 900, { top: 24, bottom: 76, left: 0, right: 0 }], [1920, 1032, { top: 36, bottom: 12, left: 0, right: 0 }], [1280, 800, { top: 24, bottom: 0, left: 70, right: 0 }]];
  let n = 0, fallbacks = 0;
  for (const [W, H, I] of setups) {
    const D = (H / 2) / Math.tan(THREE.MathUtils.degToRad(15));
    for (const [name, [px, py]] of Object.entries(spots(W, H, I))) {
      const at = { x: px - W / 2, y: H / 2 - py, z: 0 };
      for (let seed = 1; seed <= 12; seed++) for (const kind of ['entry', 'exit']) {
        const r = Flight.plan(kind, { W, H, S, D, insets: I, at, rng: seeded(seed * 31 + W + name.charCodeAt(0)), makeCurve: pts => Flight.makeCurve(THREE, D, pts) });
        n++; if (r.fallback) fallbacks++;
        const touch = kind === 'entry' ? r.curve.getPointAt(1) : r.curve.getPointAt(0);
        assert.ok(Math.hypot(touch.x - at.x, touch.y - at.y) < 1e-6, `${kind} at ${name} touches the spot`);
        if (!r.fallback) assert.ok(r.info.ok && r.info.tightMid >= S * 3, `${kind} at ${name} is smooth`);
      }
    }
  }
  assert.ok(fallbacks / n < .01, `the plain fallback is almost never needed (${fallbacks}/${n})`);
});
