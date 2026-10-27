/* Flight routes for the butterfly, so no two visits look the same.
   An arrival is three parts, each picked at random and then jittered: where it comes in from, a figure
   it flies on the way (a lazy loop, a figure eight, a drift on the breeze...), and how it settles onto
   the corner perch. A departure is a lift-off and one of several ways out. Every flight also gets a mood
   (calm, easy or playful) that sets how fast it beats and how long it glides, and routes used recently
   are skipped. Each route is checked before it is flown: no turn tighter than a butterfly would make,
   and once it is on screen it stays on screen until it lands (or, leaving, it doesn't come back).
   Routes are drawn in screen points (origin at the screen centre, x right, y up) plus a depth z toward the
   viewer (camera at z = D), so what is checked is exactly what you see; makeCurve turns them into 3D. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TitliFlight = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const MOODS = {
    calm:    { name: 'calm',    freq: 2.9, glide: [1.4, 2.2], flaps: [2, 3], speed: .86, weave: .9 },
    easy:    { name: 'easy',    freq: 3.2, glide: [1.0, 1.7], flaps: [3, 4], speed: 1,   weave: 1 },
    playful: { name: 'playful', freq: 3.6, glide: [.5, 1.0],  flaps: [3, 5], speed: 1.14, weave: 1.5 },
  };

  function tools(ctx) {
    const { W, H, S, D } = ctx, rng = ctx.rng || Math.random;
    const r = (a, b) => a + rng() * (b - a);
    const pick = list => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
    const top = H / 2 - (ctx.menubar || 24) - S * 2.2;
    const box = { x0: -W / 2 + S * 3, x1: W / 2 - S * 3, y0: -H / 2 + S * 3, y1: top };
    const zf = () => D * r(.02, .045);                       // usual cruising depth
    const p = (x, y, z) => ({ x, y, z: z == null ? zf() : z });
    const keepIn = q => ({ x: clamp(q.x, box.x0, box.x1), y: clamp(q.y, box.y0, box.y1), z: q.z });
    const wob = (q, k = 1) => keepIn({ x: q.x + r(-1, 1) * W * .025 * k, y: q.y + r(-1, 1) * H * .03 * k, z: q.z });
    return { W, H, S, D, rng, r, pick, box, zf, p, keepIn, wob, OFFX: W / 2 + W * .1, OFFY: H / 2 + H * .14 };
  }

  /* ---------- the last stretch onto the perch P ---------- */
  const APPROACHES = {
    // level from the left at about perch height (well below the menu bar), easing in at the end
    level: (t, P) => [
      t.p(P.x - t.W * t.r(.27, .33), P.y - t.H * t.r(.03, .07)),
      t.p(P.x - t.W * t.r(.1, .13), P.y + t.S * t.r(.5, .9), t.D * .012),
      t.p(P.x - t.S * 1.6, P.y + t.S * .55, t.D * .004)],
    // rising from below and turning onto the perch
    rise: (t, P) => [
      t.p(P.x - t.W * t.r(.2, .26), P.y - t.H * t.r(.3, .38)),
      t.p(P.x - t.W * t.r(.07, .1), P.y - t.H * t.r(.13, .17), t.D * .015),
      t.p(P.x - t.S * 2, P.y - t.S * 1.4, t.D * .006)],
    // a dip under the perch, then up into it
    swoop: (t, P) => [
      t.p(P.x - t.W * t.r(.32, .36), P.y - t.H * t.r(0, .04)),
      t.p(P.x - t.W * t.r(.15, .18), P.y - t.H * t.r(.16, .2)),
      t.p(P.x - t.W * .06, P.y - t.H * .1, t.D * .012),
      t.p(P.x - t.S * 1.9, P.y - t.S * 1.1, t.D * .005)],
  };

  /* ---------- arrivals: where it comes from and what it flies on the way ---------- */
  const ENTRIES = {
    // in from the lower right, a wide arc across the screen and back (the original route, now jittered)
    sweep: (t, P) => {
      // the turn at the left is half an ellipse, so it stays round however the rest is jittered
      const cx = -t.W * t.r(.06, .1), rx = t.W * t.r(.13, .17), yb = P.y - t.H * t.r(.5, .58), yt = P.y - t.H * t.r(.05, .08);
      const cy = (yb + yt) / 2, ry = (yt - yb) / 2, on = a => t.p(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      return { moods: ['easy', 'calm'], approach: ['level', 'swoop'], pts: [
        t.p(t.OFFX, yb + t.H * t.r(-.04, .1)),
        t.wob(t.p(t.W * t.r(.24, .32), yb - t.H * t.r(0, .05)), .5),
        t.p(cx + rx * .4, yb), on(Math.PI * 1.25), on(Math.PI), on(Math.PI * .75), t.p(cx + rx * .4, yt)] };
    },

    // in from the left edge, rising and falling on the breeze
    drift: (t, P) => {
      const approach = t.rng() < .5 ? 'level' : 'rise';
      const y0 = t.H * t.r(-.3, .15), n = t.rng() < .5 ? 3 : 4, amp = t.H * t.r(.04, .07);
      const xs = -t.W / 2 + t.W * .1, xe = P.x - t.W * .42, ye = approach === 'rise' ? P.y - t.H * t.r(.44, .52) : P.y - t.H * t.r(.04, .14);
      const pts = [t.p(-t.OFFX, y0)], flip = t.rng() < .5 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        pts.push(t.wob(t.p(xs + (xe - xs) * k, y0 + (ye - y0) * k + (i % 2 ? amp : -amp) * flip * (i === n - 1 ? .4 : 1)), .4));
      }
      return { moods: ['calm', 'easy'], approach: [approach], pts };
    },

    // one lazy loop in the middle of the screen, tilted a little toward you
    loop: (t, P) => {
      const R = Math.max(t.S * 4.5, t.H * t.r(.11, .15)), c = { x: -t.W * t.r(.02, .2), y: t.H * t.r(-.14, .06) };
      const ccw = t.rng() < .5, zs = t.zf(), zd = t.D * t.r(.03, .07), ph = t.r(0, TAU);
      const pts = ccw
        ? [t.p(c.x - R * 1.4 - t.W * t.r(.14, .22), -t.OFFY), t.p(c.x - R * 1.4, c.y - R, zs)]
        : [t.p(-t.OFFX, c.y + R * t.r(.7, 1.3)), t.p(c.x - R * 1.5, c.y + R, zs)];
      const a0 = ccw ? -Math.PI / 2 : Math.PI / 2, dir = ccw ? 1 : -1;
      for (let k = 0; k <= 8; k++) {
        const a = a0 + dir * TAU * k / 8;
        pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a), z: zs + zd * Math.sin(a + ph) * (k === 0 || k === 8 ? 0 : 1) });
      }
      pts.push(t.p(c.x + R * 1.5, c.y + (ccw ? -R * .9 : R * 1.05), zs));
      return { moods: ['easy', 'playful'], approach: ccw ? ['rise'] : ['level'], pts };
    },

    // down from the top of the screen in a long dive, then up to the perch
    dive: (t, P) => {
      const xe = P.x - t.W * t.r(.42, .5), x0 = xe - t.W * t.r(.42, .5);
      return { moods: ['easy', 'playful'], approach: ['rise'], pts: [
        t.p(x0, t.OFFY),
        t.wob(t.p(x0 + t.W * .06, t.H * t.r(.12, .2)), .5),
        t.wob(t.p(x0 + t.W * .14, -t.H * t.r(.1, .16)), .5),
        t.wob(t.p(x0 + t.W * .27, -t.H * t.r(.27, .32)), .4),
        t.wob(t.p(xe, -t.H * t.r(.16, .24)), .5)] };
    },

    // a playful zig-zag up the screen from the bottom left
    zigzag: (t, P) => {
      const from = { x: -t.W * t.r(.36, .44), y: -t.H * t.r(.25, .4) }, to = { x: P.x - t.W * .42, y: P.y - t.H * t.r(.15, .28) };
      const n = 3 + Math.floor(t.rng() * 2), amp = t.H * t.r(.03, .05), flip = t.rng() < .5 ? 1 : -1;
      const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      const pts = [t.p(from.x - t.W * .16, -t.OFFY), t.p(from.x, from.y)];
      for (let i = 1; i <= n; i++) {
        const k = i / (n + 1), s = (i % 2 ? amp : -amp) * flip;
        pts.push(t.keepIn(t.p(from.x + dx * k + nx * s, from.y + dy * k + ny * s)));
      }
      pts.push(t.p(to.x, to.y));
      return { moods: ['playful'], approach: ['level'], pts };
    },

    // a figure eight before it lands
    eight: (t, P) => {
      const c = { x: -t.W * t.r(.05, .16), y: t.H * t.r(-.1, .04) }, A = t.W * t.r(.17, .2);
      const Bmin = Math.sqrt(t.S * 4 * A), Bmax = Math.max(Bmin, Math.min(A * A / (t.S * 16), t.H * .21)), B = t.r(Bmin, Bmax);
      const up = t.rng() < .5 ? 1 : -1, zs = t.zf();
      const pts = up > 0
        ? [t.p(c.x - A * .5 - t.W * .2, -t.OFFY), t.p(c.x - A * .5, c.y - B * .5, zs)]
        : [t.p(-t.OFFX, c.y + B * t.r(.8, 1.4)), t.p(c.x - A * .55, c.y + B * .55, zs)];
      for (let k = 0; k <= 32; k++) {
        const s = TAU * k / 32;
        pts.push({ x: c.x + A * Math.sin(s), y: c.y + up * B * Math.sin(s) * Math.cos(s), z: zs + t.D * .02 * Math.sin(s) });
      }
      pts.push(t.p(c.x + A * .5, c.y + up * B * .5, zs));
      return { moods: ['playful', 'easy'], approach: up > 0 ? ['level'] : ['rise'], pts };
    },

    // from right beside you: it starts close, big, and flies away into the screen
    flyby: (t, P) => {
      const left = t.rng() < .6, sx = left ? -1 : 1;
      return { moods: ['easy'], approach: left ? ['level', 'rise'] : ['level'], pts: [
        t.p(sx * t.W * t.r(.6, .66), -t.H * t.r(.6, .66), t.D * t.r(.34, .38)),
        t.p(sx * t.W * t.r(.34, .38), -t.H * t.r(.26, .3), t.D * .2),
        ...(left
          ? [t.p(-t.W * t.r(.15, .19), -t.H * t.r(.08, .12), t.D * .1), t.p(-t.W * t.r(0, .04), P.y - t.H * t.r(.3, .36), t.D * .05)]
          : (() => {   // from the right it swings round through the left in half an ellipse, then heads for the perch
            const cx = -t.W * t.r(.04, .08), rx = t.W * t.r(.13, .16), yb = -t.H * t.r(.1, .14), yt = P.y - t.H * t.r(.05, .08);
            const cy = (yb + yt) / 2, ry = (yt - yb) / 2, on = (a, z) => t.p(cx + rx * Math.cos(a), cy + ry * Math.sin(a), z);
            return [t.p(cx + rx * .6, yb, t.D * .1), on(Math.PI * 1.25, t.D * .07), on(Math.PI, t.D * .05), on(Math.PI * .75, t.D * .04), t.p(cx + rx * .4, yt, t.D * .03)];
          })())] };
    },

    // a few random waypoints, never doubling back on itself
    wander: (t, P) => {
      const starts = [
        () => [t.p(-t.OFFX, t.H * t.r(-.3, .25))],
        () => [t.p(-t.W * t.r(.1, .4), -t.OFFY)],
        () => [t.p(-t.W * t.r(.15, .4), t.OFFY)]];
      const end = { x: P.x - t.W * .3, y: P.y - t.H * .05 };
      for (let tries = 0; tries < 30; tries++) {
        const pts = t.pick(starts)(), n = 2 + Math.floor(t.rng() * 2);
        for (let i = 0; i < n; i++) pts.push(t.p(t.W * t.r(-.4, .18), t.H * t.r(-.36, .2)));
        const chain = pts.concat([t.p(end.x, end.y)]);
        let ok = true;
        for (let i = 1; i < chain.length - 1 && ok; i++) {
          const a = chain[i - 1], b = chain[i], c = chain[i + 1];
          const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
          if (lv < t.W * .17 || (ux * vx + uy * vy) / (lu * lv) < .2) ok = false;
        }
        if (ok) return { moods: ['calm', 'easy', 'playful'], approach: ['level'], pts };
      }
      return ENTRIES.sweep(t, P);
    },
  };

  /* ---------- departures from the perch at c ---------- */
  // a little hop off the perch, already turning toward where it's headed
  function liftoff(t, c, next) {
    const a = Math.atan2(next.y - c.y, next.x - c.x), up = Math.cos(a) < 0 ? -1 : 1, b = a + up * t.r(.25, .55), d = t.S * t.r(2.4, 3);
    return [t.p(c.x + Math.cos(b) * d, c.y + Math.sin(b) * d, t.D * .008)];
  }
  const EXITS = {
    // out over the top left, the original way (jittered)
    away: (t, c) => ({ moods: ['easy', 'calm'], pts: [
      t.wob(t.p(c.x - t.W * t.r(.12, .16), c.y + t.S * t.r(-.6, .6)), .4),
      t.wob(t.p(c.x - t.W * t.r(.28, .32), c.y - t.H * t.r(.08, .13)), .3),
      t.p(c.x - t.W * t.r(.41, .44), c.y + t.H * t.r(.09, .12)),
      t.p(c.x - t.W * t.r(.3, .34), t.H * .84)] }),

    // a deep swing down across the screen, then up and off the top
    up: (t, c) => ({ moods: ['easy', 'playful'], pts: [
      t.p(c.x - t.W * t.r(.1, .12), c.y - t.H * t.r(.18, .22)),
      t.p(c.x - t.W * t.r(.26, .3), c.y - t.H * t.r(.4, .46)),
      t.p(c.x - t.W * t.r(.46, .5), c.y - t.H * t.r(.36, .42)),
      t.p(c.x - t.W * t.r(.58, .62), c.y - t.H * t.r(.08, .14)),
      t.p(c.x - t.W * t.r(.62, .68), t.OFFY)] }),

    // down past the note and out of the right edge
    right: (t, c) => ({ moods: ['easy', 'calm'], pts: [
      t.p(c.x - t.W * t.r(.1, .12), c.y - t.H * t.r(.12, .15)),
      t.p(c.x - t.W * t.r(.2, .23), c.y - t.H * t.r(.3, .34)),
      t.p(c.x - t.W * t.r(.17, .2), c.y - t.H * t.r(.5, .55)),
      t.p(c.x - t.W * t.r(.04, .07), c.y - t.H * t.r(.63, .68)),
      t.p(t.OFFX, c.y - t.H * t.r(.66, .74))] }),

    // one loop to say goodbye, then off to the left
    loop: (t, c) => {
      const R = Math.max(t.S * 4.5, t.H * t.r(.1, .13)), C = { x: c.x - t.W * t.r(.24, .3), y: c.y - t.H * t.r(.24, .3) }, zs = t.zf();
      const pts = [t.p(C.x + R * 1.5, C.y + R, zs)];
      for (let k = 0; k <= 8; k++) { const a = Math.PI / 2 + TAU * k / 8; pts.push({ x: C.x + R * Math.cos(a), y: C.y + R * Math.sin(a), z: zs }); }
      pts.push(t.p(C.x - R * 1.5, C.y + R, zs), t.p(C.x - R * 1.5 - t.W * t.r(.16, .2), C.y + R * t.r(.4, .8)), t.p(-t.OFFX, C.y - t.H * t.r(0, .16)));
      return { moods: ['playful', 'easy'], pts };
    },

    // it flies out toward you and past your shoulder
    toward: (t, c) => ({ moods: ['easy'], pts: [
      t.p(c.x - t.W * t.r(.12, .16), c.y - t.H * t.r(.1, .14), t.D * .06),
      t.p(c.x - t.W * t.r(.28, .32), c.y - t.H * t.r(.33, .38), t.D * .2),
      t.p(c.x - t.W * t.r(.5, .56), -t.H * t.r(.36, .42), t.D * .42),
      t.p(c.x - t.W * t.r(.66, .74), -t.H * .9, t.D * .62)] }),

    // a long drift across to the left edge
    drift: (t, c) => {
      const amp = t.H * t.r(.04, .07), y1 = c.y - t.H * t.r(.2, .5), pts = [t.p(c.x - t.W * t.r(.14, .18), c.y - t.H * t.r(.06, .1))];
      const xs = c.x - t.W * .32, xe = -t.W * .38, n = 3;
      for (let i = 0; i < n; i++) { const k = i / (n - 1); pts.push(t.wob(t.p(xs + (xe - xs) * k, pts[0].y + (y1 - pts[0].y) * k + (i % 2 ? -amp : amp)), .4)); }
      pts.push(t.p(-t.OFFX, y1 + amp));
      return { moods: ['calm', 'easy'], pts };
    },
  };

  /* ---------- from screen points to a 3D curve ----------
     The spline runs through the screen positions (depth counts only a little toward its spacing, so the
     on-screen shape stays smooth), then each point is pushed back to the depth it should be seen at. */
  const DEPTH_WEIGHT = .35;
  function makeCurve(THREE, D, points) {
    const spline = new THREE.CatmullRomCurve3(points.map(q => new THREE.Vector3(q.x, q.y, (q.z || 0) * DEPTH_WEIGHT)), false, 'centripetal');
    const curve = new THREE.Curve();
    curve.getPoint = (u, target) => {
      const v = spline.getPoint(u, target || new THREE.Vector3()), z = v.z / DEPTH_WEIGHT, k = (D - z) / D;
      return v.set(v.x * k, v.y * k, z);
    };
    return curve;
  }

  /* ---------- checks ---------- */
  // what the eye sees: the route projected onto the screen, its length, its tightest turns, and when it is on screen
  function inspect(curve, t, kind) {
    const N = 240, pr = [];
    for (let i = 0; i <= N; i++) {
      const q = curve.getPointAt(i / N), k = t.D / Math.max(1, t.D - q.z);
      pr.push({ u: i / N, x: q.x * k, y: q.y * k });
    }
    let length = 0, tightMid = Infinity, tightEnds = Infinity, finite = true;
    const edge = t.S * 1.5, onScreen = q => Math.abs(q.x) < t.W / 2 + edge && Math.abs(q.y) < t.H / 2 + edge;
    const ends = kind === 'entry' ? (u => u > .88) : (u => u < .12);
    for (let i = 0; i <= N; i++) {
      const b = pr[i];
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) finite = false;
      if (i > 0) length += Math.hypot(b.x - pr[i - 1].x, b.y - pr[i - 1].y);
      if (i === 0 || i === N) continue;
      const a = pr[i - 1], c = pr[i + 1];
      const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ac = Math.hypot(c.x - a.x, c.y - a.y);
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
      const rad = area < 1e-9 ? Infinity : ab * bc * ac / (4 * area);
      if (ends(b.u)) tightEnds = Math.min(tightEnds, rad); else tightMid = Math.min(tightMid, rad);
    }
    // arrivals come in from off screen and stay on once they are in; departures go off and stay off
    const vis = pr.map(onScreen);
    let flips = 0;
    for (let i = 1; i <= N; i++) if (vis[i] !== vis[i - 1]) flips++;
    const inOut = kind === 'entry' ? (!vis[0] && vis[N] && flips === 1) : (vis[0] && !vis[N] && flips === 1);
    const ok = finite && inOut && tightMid >= t.S * 3 && tightEnds >= t.S * (kind === 'entry' ? 2 : 1.7);
    return { ok, length, tightMid, tightEnds, inOut };
  }

  function pickMood(t, names) {
    const m = MOODS[t.pick(names)];
    return Object.assign({}, m, { freq: m.freq + t.r(-.12, .12) });
  }

  function build(kind, name, ctx, t) {
    t = t || tools(ctx);
    const at = ctx.at, fig = (kind === 'entry' ? ENTRIES : EXITS)[name](t, at);
    if (kind !== 'entry') return { fig, approach: null, points: [{ x: at.x, y: at.y, z: at.z || 0 }].concat(liftoff(t, at, fig.pts[0]), fig.pts) };
    const approach = typeof fig.approach === 'string' ? fig.approach : t.pick(fig.approach);
    return { fig, approach, points: fig.pts.concat(APPROACHES[approach](t, at), [{ x: at.x, y: at.y, z: 0 }]) };
  }

  /* ---------- the planner ----------
     ctx: { W, H, S, D, menubar, at: perch (entry) or start point (exit), makeCurve(points), recent: [names], rng } */
  function plan(kind, ctx) {
    const t = tools(ctx), at = ctx.at, entry = kind === 'entry';
    const table = entry ? ENTRIES : EXITS, names = Object.keys(table);
    let pool = names.filter(n => !(ctx.recent || []).includes(n));
    if (!pool.length) pool = names;
    for (let attempt = 0; attempt < 40; attempt++) {
      const name = t.pick(attempt < 30 ? pool : names);
      const { fig, points, approach } = build(kind, name, ctx, t);
      const curve = ctx.makeCurve(points), info = inspect(curve, t, kind);
      if (!info.ok) continue;
      const mood = pickMood(t, fig.moods);
      // about as quick as the original flights, a touch slower when calm and quicker when playful
      const speed = (entry ? .3 : .15) * mood.speed;
      const duration = clamp(info.length / speed, entry ? 6500 : 4500, entry ? 10000 : 8500);
      return { kind, name, approach, points, curve, mood, duration, info };
    }
    return fallback(kind, ctx, t);
  }

  // the original routes, exactly: always fine, used only if nothing else passes the checks
  function fallback(kind, ctx, t) {
    const { W, H, S, D } = t, P = ctx.at, v = (x, y, z) => ({ x, y, z: z || 0 });
    const points = kind === 'entry'
      ? [v(W * .6, P.y - H * .5, D * .03), v(W * .3, P.y - H * .6, D * .04), v(-W * .02, P.y - H * .52, D * .04), v(-W * .22, P.y - H * .34, D * .04), v(-W * .24, P.y - H * .12, D * .035),
        v(-W * .08, P.y + H * .02, D * .03), v(P.x - W * .3, P.y + H * .04, D * .022), v(P.x - W * .12, P.y + S * 2.4, D * .012), v(P.x - S * 1.2, P.y + S * .9, D * .004), v(P.x, P.y, 0)]
      : [v(P.x, P.y, P.z), v(P.x - S * 2, P.y + S * 1.6, D * .008), v(P.x - W * .14, P.y + S * .4, D * .02), v(P.x - W * .3, P.y - H * .1, D * .03), v(P.x - W * .42, P.y + H * .1, D * .035), v(P.x - W * .34, H * .84, D * .04)];
    const curve = ctx.makeCurve(points);
    return { kind, name: kind === 'entry' ? 'sweep' : 'away', approach: kind === 'entry' ? 'level' : null, points, curve, mood: Object.assign({}, MOODS.easy),
      duration: kind === 'entry' ? 8400 : 7000, info: inspect(curve, t, kind), fallback: true };
  }

  return { plan, build, inspect, tools, makeCurve, MOODS, ENTRIES: Object.keys(ENTRIES), EXITS: Object.keys(EXITS), APPROACHES: Object.keys(APPROACHES) };
});
