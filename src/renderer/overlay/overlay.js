(() => {
  'use strict';
  // The butterfly: a small 3D model drawn with three.js. Wings are painted on canvases at start-up,
  // flight is a flap-and-glide model with banked turns, and the overlay app below drives it.
  const $ = s => document.querySelector(s);
  const glCanvas = $('#gl');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const smooth01 = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const easeInOutSine = k => (1 - Math.cos(Math.PI * k)) / 2;
  const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  const lerpAngle = (a, b, t) => a + angDiff(b, a) * t;
  const wait = ms => new Promise(r => setTimeout(r, reduce ? 0 : ms));
  const BUTTERFLY_SIZE = 20; // half-wingspan in screen points
  let MENUBAR = 24;

  /* ---------- renderer ---------- */
  let renderer;
  try {
    if (!window.THREE) throw new Error('three.js did not load');
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, premultipliedAlpha: true });
  } catch (e) {
    $('#glFail').hidden = false; return;
  }
  renderer.setClearColor(0x000000, 0);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
  scene.add(new THREE.HemisphereLight(0xfff1e6, 0x4a3a40, 1.1));
  const dirLight = new THREE.DirectionalLight(0xffffff, .75); dirLight.position.set(-.4, .8, 1); scene.add(dirLight);
  let W = 1, H = 1, D = 1, S = 1;

  /* ---------- wing artwork: fine ink lines, deep roses, ink-dipped tails ---------- */
  const TEX = 512;
  // Shapes: start point, then cubic segments [c1x,c1y,c2x,c2y,x,y] in 0..1 wing space (x outward from the body, y up).
  const FORE = [[0.03,0.10],[0.15,0.40,0.55,0.90,0.90,0.98],[0.97,1.00,1.00,0.92,0.98,0.84],[0.90,0.62,0.88,0.42,0.92,0.26],[0.93,0.20,0.86,0.14,0.76,0.13],[0.50,0.08,0.20,0.06,0.03,0.10]];
  const HIND = [[0.03,0.94],[0.30,1.00,0.62,0.98,0.80,0.88],[0.98,0.76,0.95,0.50,0.78,0.40],[0.68,0.34,0.60,0.30,0.54,0.26],[0.53,0.16,0.52,0.06,0.48,0.02],[0.46,0.00,0.42,0.01,0.42,0.04],[0.42,0.12,0.40,0.20,0.36,0.24],[0.20,0.36,0.06,0.60,0.03,0.94]];
  const WINGS = {
    fore: { shape: FORE, hub: [0.05, 0.11], veins: [53, 46, 39, 32, 25, 18, 11, 5], chains: [[0.8, 0, 7], [0.54, 1, 6], [0.32, 2, 5]],
      roses: [{ x: .36, y: .36, r: .17, rot: .4, leaves: [[-24, .15], [122, .12]] }, { x: .69, y: .69, r: .075, rot: 1.6, bud: true, leaves: [[212, .08], [32, .07]] }], wash: false },
    hind: { shape: HIND, hub: [0.05, 0.90], veins: [-6, -18, -30, -42, -54, -64, -73], chains: [[0.78, 0, 6], [0.5, 1, 5]],
      roses: [{ x: .37, y: .66, r: .125, rot: 1.1, leaves: [[-42, .11], [162, .095]] }], wash: true }
  };
  const STYLES = {
    rose:     { grad:['#FFF6EC','#FFE9E6','#F7C9D0','#E99FB0'], root:'#FFD9A8', memAlpha:.9, ink:'#8A3A58', inkA:.7, rose:{ deep:'#B23A5E', base:'#E8718F', rim:'#FFD6DF', core:'#8E2A4C', line:'#7A2A48' }, leaf:['#A9C4A0','#7A9C7E'], leafLine:'#5E7A62', leafVein:'#E6F0DE', pearl:'#FFFFFF', under:'#F6E6E6', irid:.3, spec:.3,  body:0x5a3246, glint:[1,.86,.7] },
    peony:    { grad:['#FFFFFF','#FFF2F6','#FFD9E6','#F6B8CF'], root:'#FFE4EC', memAlpha:.9, ink:'#B06A8A', inkA:.6, rose:{ deep:'#C9668C', base:'#F4A3BE', rim:'#FFEAF1', core:'#A24C72', line:'#9A4E70' }, leaf:['#BFD6B8','#8FB092'], leafLine:'#6C8A70', leafVein:'#EEF6EA', pearl:'#FFFFFF', under:'#F9ECF1', irid:.3, spec:.3,  body:0x6a4458, glint:[1,.84,.9] },
    gold:     { grad:['#FFFBF0','#FFF2DC','#F9DFB6','#E9C58C'], root:'#FFE2A6', memAlpha:.9, ink:'#B8862E', inkA:.75, rose:{ deep:'#B23A5E', base:'#E8718F', rim:'#FFD6DF', core:'#8E2A4C', line:'#9A5A2A' }, leaf:['#B9C48E','#8A9A66'], leafLine:'#7E6A30', leafVein:'#F4EAC8', pearl:'#FFF4D6', under:'#F3E6CC', irid:.25, spec:.7,  body:0x6e5026, glint:[1,.9,.6] },
    midnight: { grad:['#2A2238','#221B2F','#1A1424','#120E1A'], root:'#5A3E6C', memAlpha:.95, ink:'#E6C98A', inkA:.8, rose:{ deep:'#9E2A4E', base:'#E85C7C', rim:'#FFC6D2', core:'#6E1A36', line:'#3A1222' }, leaf:['#6E9A7E','#3E6650'], leafLine:'#E6C98A', leafVein:'#F0DDB0', pearl:'#F6E3B8', under:'#2A2230', irid:.45, spec:.8, body:0x1a1424, glint:[1,.92,.72] }
  };
  const toPx = v => [(0.02 + 0.96 * v[0]) * TEX, (1 - (0.02 + 0.96 * v[1])) * TEX];
  function trace(x, shape) {
    x.beginPath(); const s0 = toPx(shape[0]); x.moveTo(s0[0], s0[1]);
    for (let i = 1; i < shape.length; i++) {
      const s = shape[i], a = toPx([s[0], s[1]]), b = toPx([s[2], s[3]]), c = toPx([s[4], s[5]]);
      x.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
    }
    x.closePath();
  }
  function bez(p0, p1, p2, p3, t) { const m = 1 - t; return [m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0], m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1]]; }
  function outlineUV(shape, per) {
    const pts = []; let p0 = shape[0];
    for (let i = 1; i < shape.length; i++) {
      const s = shape[i], a = [s[0], s[1]], b = [s[2], s[3]], c = [s[4], s[5]];
      for (let k = 0; k < per; k++) pts.push(bez(p0, a, b, c, k / per));
      p0 = c;
    }
    return pts;
  }
  function edgePoint(pts, hub, deg) {
    const th = deg * Math.PI / 180; let best = null, bd = 1e9;
    for (const p of pts) {
      const dx = p[0] - hub[0], dy = p[1] - hub[1];
      if (Math.hypot(dx, dy) < 0.28) continue;
      const d = Math.abs(angDiff(Math.atan2(dy, dx), th));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  const qpt = (A, M, B, t) => { const m = 1 - t; return [m*m*A[0] + 2*m*t*M[0] + t*t*B[0], m*m*A[1] + 2*m*t*M[1] + t*t*B[1]]; };

  // a soft green leaf with an ink outline and pale veins
  function drawLeaf(x, bx, by, len, ang, st) {
    x.save(); x.translate(bx, by); x.rotate(ang);
    x.beginPath(); x.moveTo(0, 0);
    x.bezierCurveTo(len * .25, -len * .36, len * .72, -len * .32, len, 0);
    x.bezierCurveTo(len * .72, len * .32, len * .25, len * .36, 0, 0);
    const g = x.createLinearGradient(0, -len * .3, 0, len * .3);
    g.addColorStop(0, st.leaf[0]); g.addColorStop(1, st.leaf[1]);
    x.fillStyle = g; x.fill();
    x.lineWidth = Math.max(1.3, len * .028); x.strokeStyle = st.leafLine; x.stroke();
    x.strokeStyle = st.leafVein; x.globalAlpha = .75; x.lineWidth = Math.max(1, len * .022);
    x.beginPath(); x.moveTo(len * .06, 0); x.quadraticCurveTo(len * .5, len * .03, len * .88, 0); x.stroke();
    for (const f of [.3, .5, .68]) {
      x.beginPath(); x.moveTo(len * f, len * .015); x.lineTo(len * (f + .12), -len * .13);
      x.moveTo(len * f, len * .015); x.lineTo(len * (f + .12), len * .14); x.stroke();
    }
    x.globalAlpha = 1; x.restore();
  }
  // one cupped petal, drawn outward from the flower's centre along +x
  function petal(x, a, L, w, P, lw) {
    x.save(); x.rotate(a);
    x.beginPath(); x.moveTo(L * .06, -w * .4);
    x.bezierCurveTo(L * .38, -w * 1.1, L * 1.02, -w * .95, L, 0);
    x.bezierCurveTo(L * 1.02, w * .95, L * .38, w * 1.1, L * .06, w * .4);
    x.quadraticCurveTo(-L * .02, 0, L * .06, -w * .4);
    x.closePath();
    const g = x.createRadialGradient(0, 0, L * .05, 0, 0, L * 1.02);
    g.addColorStop(0, P.deep); g.addColorStop(.5, P.base); g.addColorStop(.86, P.base); g.addColorStop(1, P.rim);
    x.fillStyle = g; x.fill();
    x.lineWidth = lw; x.strokeStyle = P.line; x.stroke();
    // the turned-back edge that makes a petal read as a petal
    x.beginPath(); x.moveTo(L * .56, -w * .72);
    x.bezierCurveTo(L * .84, -w * .5, L * .86, w * .5, L * .56, w * .72);
    x.lineWidth = lw * 1.25; x.strokeStyle = P.rim; x.globalAlpha = .85; x.stroke();
    x.globalAlpha = .5; x.lineWidth = lw * .8; x.strokeStyle = P.line;
    x.beginPath(); x.moveTo(L * .22, w * .18); x.quadraticCurveTo(L * .4, w * .3, L * .5, w * .16); x.stroke();
    x.globalAlpha = 1; x.restore();
  }
  function drawRose(x, cx, cy, R, rot, st, bud) {
    const P = st.rose, lw = Math.max(1.3, R * .034);
    x.save(); x.translate(cx, cy);
    const layers = bud ? [[4, 1, .58, 0], [3, .66, .5, .8]] : [[5, 1, .56, 0], [5, .76, .52, .63], [4, .52, .48, .25]];
    layers.forEach(([n, k, wr, off]) => { for (let i = 0; i < n; i++) petal(x, rot + off + i * Math.PI * 2 / n, R * k, R * k * wr, P, lw); });
    const cr = R * (bud ? .36 : .3);
    const g = x.createRadialGradient(-cr * .2, -cr * .25, cr * .1, 0, 0, cr);
    g.addColorStop(0, P.base); g.addColorStop(1, P.core);
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, cr, 0, Math.PI * 2); x.fill();
    x.lineWidth = lw; x.strokeStyle = P.line; x.stroke();
    // the tight spiral at the heart of the rose
    for (let j = 0; j < 3; j++) {
      const r = cr * (.78 - j * .22), a0 = rot + j * 2.1, ox = cr * .08 * j, oy = -cr * .05 * j;
      x.beginPath(); x.arc(ox, oy, r, a0, a0 + 3.4);
      x.strokeStyle = P.line; x.lineWidth = lw * .9; x.stroke();
      x.beginPath(); x.arc(ox, oy, Math.max(.5, r - lw * .9), a0 + .3, a0 + 2.2);
      x.strokeStyle = P.rim; x.globalAlpha = .7; x.lineWidth = lw * .8; x.stroke(); x.globalAlpha = 1;
    }
    x.restore();
  }

  function paintWing(kind, st) {
    const wd = WINGS[kind], shape = wd.shape;
    const c = document.createElement('canvas'); c.width = c.height = TEX;
    const x = c.getContext('2d');
    const hub = toPx(wd.hub);
    x.save(); trace(x, shape); x.clip();
    const mg0 = x.createRadialGradient(hub[0], hub[1], TEX * .04, hub[0], hub[1], TEX * 1.08);
    st.grad.forEach((col, i) => mg0.addColorStop(i / (st.grad.length - 1), col));
    x.globalAlpha = st.memAlpha; x.fillStyle = mg0; x.fillRect(0, 0, TEX, TEX); x.globalAlpha = 1;

    if (wd.wash) {
      const wc = document.createElement('canvas'); wc.width = wc.height = TEX; const wx = wc.getContext('2d');
      trace(wx, shape); wx.fillStyle = st.rose.base; wx.fill();
      wx.globalCompositeOperation = 'destination-in';
      let mg = wx.createLinearGradient(0, TEX * .66, 0, TEX * .88); mg.addColorStop(0, 'rgba(0,0,0,0)'); mg.addColorStop(1, 'rgba(0,0,0,1)');
      wx.fillStyle = mg; wx.fillRect(0, 0, TEX, TEX);
      wx.globalCompositeOperation = 'source-over';
      wx.strokeStyle = st.rose.base; wx.lineJoin = 'round';
      for (const w of [170, 140, 112, 88, 66, 46, 28]) { wx.globalAlpha = .16; wx.lineWidth = w; trace(wx, shape); wx.stroke(); }
      wx.globalAlpha = 1; wx.globalCompositeOperation = 'destination-in';
      mg = wx.createLinearGradient(0, TEX * .38, 0, TEX * .72); mg.addColorStop(0, 'rgba(0,0,0,0)'); mg.addColorStop(1, 'rgba(0,0,0,1)');
      wx.fillStyle = mg; wx.fillRect(0, 0, TEX, TEX);
      x.globalAlpha = .55; x.drawImage(wc, 0, 0); x.globalAlpha = 1;
    }

    // dark wing root
    const rg = x.createRadialGradient(hub[0], hub[1], 0, hub[0], hub[1], TEX * .3);
    rg.addColorStop(0, st.root); rg.addColorStop(1, 'rgba(255,255,255,0)');
    x.globalAlpha = .8; x.fillStyle = rg; x.fillRect(0, 0, TEX, TEX); x.globalAlpha = 1;

    // veins and cross-veins: the stained-glass cells
    const pts = outlineUV(shape, 60);
    const veins = wd.veins.map(deg => {
      const E = toPx(edgePoint(pts, wd.hub, deg)), dx = E[0] - hub[0], dy = E[1] - hub[1];
      const M = [(hub[0] + E[0]) / 2 - dy * .05, (hub[1] + E[1]) / 2 + dx * .05];
      return { E, M };
    });
    x.strokeStyle = st.ink; x.lineCap = 'round'; x.lineJoin = 'round'; x.globalAlpha = st.inkA;
    x.lineWidth = TEX * .008;
    veins.forEach(v => { x.beginPath(); x.moveTo(hub[0], hub[1]); x.quadraticCurveTo(v.M[0], v.M[1], v.E[0], v.E[1]); x.stroke(); });
    x.lineWidth = TEX * .006;
    wd.chains.forEach(([f, i0, i1]) => {
      for (let i = i0; i < i1; i++) {
        const A = qpt(hub, veins[i].M, veins[i].E, f), B = qpt(hub, veins[i + 1].M, veins[i + 1].E, f);
        const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, ox = mx - hub[0], oy = my - hub[1], ol = Math.hypot(ox, oy) || 1, bend = Math.hypot(B[0] - A[0], B[1] - A[1]) * .14;
        x.beginPath(); x.moveTo(A[0], A[1]); x.quadraticCurveTo(mx + ox / ol * bend, my + oy / ol * bend, B[0], B[1]); x.stroke();
      }
    });

    x.globalAlpha = 1;
    // leaves under roses, then roses
    wd.roses.forEach(r => {
      const p = toPx([r.x, r.y]), R = r.r * TEX;
      r.leaves.forEach(([deg, len]) => {
        const a = -deg * Math.PI / 180;
        drawLeaf(x, p[0] + Math.cos(a) * R * .78, p[1] + Math.sin(a) * R * .78, len * TEX, a, st);
      });
    });
    wd.roses.forEach(r => { const p = toPx([r.x, r.y]); drawRose(x, p[0], p[1], r.r * TEX, r.rot, st, r.bud); });
    x.restore();

    x.lineWidth = TEX * .03; x.strokeStyle = st.ink; x.lineJoin = 'round'; x.globalAlpha = .28; trace(x, shape); x.stroke();
    x.lineWidth = TEX * .011; x.globalAlpha = 1; trace(x, shape); x.stroke();
    x.fillStyle = st.pearl;
    const ring = outlineUV(shape, 10); let cxp = 0, cyp = 0;
    ring.forEach(q => { cxp += q[0]; cyp += q[1]; }); cxp /= ring.length; cyp /= ring.length;
    ring.forEach((q, i) => { if (i % 2) return; const pp = toPx(q), dx = cxp - q[0], dy = cyp - q[1], L = Math.hypot(dx, dy) || 1;
      x.beginPath(); x.arc(pp[0] + dx / L * TEX * .028, pp[1] - dy / L * TEX * .028, TEX * .0065, 0, Math.PI * 2); x.fill(); });
    const tex = new THREE.CanvasTexture(c); tex.anisotropy = maxAniso; return tex;
  }
  const texCache = {};
  function wingTextures(key) {
    if (!texCache[key]) { const st = STYLES[key]; texCache[key] = { fore: paintWing('fore', st), hind: paintWing('hind', st) }; }
    return texCache[key];
  }

  /* ---------- wing shader: soft light, pearly sheen on the paper and gold ---------- */
  const WING_VS = `
    uniform float uFlex; uniform float uTime;
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main(){
      vUv = uv;
      vec3 p = position;
      float s = uv.x;
      p.z += uFlex * s * s * 0.12 + sin(uTime * 2.0 + s * 3.0) * 0.003 * s;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`;
  const WING_FS = `
    uniform sampler2D uMap; uniform float uIrid; uniform float uSpec; uniform float uTime;
    uniform vec3 uUnder; uniform vec3 uLight;
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main(){
      vec4 base = texture2D(uMap, vUv);
      if (base.a < 0.02) discard;
      vec3 N = normalize(gl_FrontFacing ? vN : -vN);
      vec3 col = base.rgb;
      if (!gl_FrontFacing) col = mix(col, uUnder, 0.35);
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      float diff = 0.84 + 0.16 * max(dot(N, uLight), 0.0);
      float fres = pow(1.0 - clamp(abs(dot(N, vV)), 0.0, 1.0), 2.0);
      vec3 irid = 0.5 + 0.5 * cos(6.28318 * (fres * 1.2 + vUv.x * 0.4 + vec3(0.0, 0.33, 0.67)) + uTime * 0.3);
      float spec = pow(max(dot(reflect(-uLight, N), vV), 0.0), 24.0);
      vec3 outc = col * diff + (irid - 0.5) * uIrid * lum * (0.4 + fres) + vec3(spec * uSpec * lum);
      gl_FragColor = vec4(outc * vec3(1.0, 0.99, 0.97), base.a);
    }`;
  const LIGHT = new THREE.Vector3(-.35, .55, .78).normalize();
  function wingMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uIrid: { value: .2 }, uSpec: { value: .2 }, uTime: { value: 0 }, uFlex: { value: 0 }, uUnder: { value: new THREE.Color('#eeeeee') }, uLight: { value: LIGHT } },
      vertexShader: WING_VS, fragmentShader: WING_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false
    });
  }

  /* ---------- the butterfly: slender swallowtail ---------- */
  const bfly = new THREE.Group(); bfly.rotation.order = 'ZXY'; bfly.visible = false; scene.add(bfly);
  const foreGeo = new THREE.PlaneGeometry(1, 1, 12, 12); foreGeo.translate(.5, .4, 0);
  const hindGeo = new THREE.PlaneGeometry(.92, 1, 12, 12); hindGeo.translate(.46, -.47, 0);
  const foreMat = wingMat(), hindMat = wingMat();
  const foreR = new THREE.Mesh(foreGeo, foreMat), foreL = new THREE.Mesh(foreGeo, foreMat);
  const hindR = new THREE.Mesh(hindGeo, hindMat), hindL = new THREE.Mesh(hindGeo, hindMat);
  foreL.scale.x = -1; hindL.scale.x = -1;
  foreR.position.set(.015, 0, .003); foreL.position.set(-.015, 0, .003);
  hindR.position.set(.015, 0, 0); hindL.position.set(-.015, 0, 0);
  [hindR, hindL].forEach(m => { m.renderOrder = 1; });
  [foreR, foreL].forEach(m => { m.renderOrder = 2; });
  bfly.add(hindR, hindL, foreR, foreL);

  const bodyMat = new THREE.MeshStandardMaterial({ color: STYLES.rose.body, roughness: .7, metalness: 0 });
  const sph = new THREE.SphereGeometry(1, 24, 16);
  const thorax = new THREE.Mesh(sph, bodyMat); thorax.scale.set(.058, .15, .058); thorax.position.set(0, .03, .05);
  const abdomen = new THREE.Mesh(sph, bodyMat); abdomen.scale.set(.042, .31, .042); abdomen.position.set(0, -.32, .045);
  const head = new THREE.Mesh(sph, bodyMat); head.scale.setScalar(.048); head.position.set(0, .2, .055);
  [thorax, abdomen, head].forEach(m => bfly.add(m));
  const antennae = [];
  [-1, 1].forEach(sd => {
    const pivot = new THREE.Group(); pivot.position.set(0, .23, .06);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(.01 * sd, 0, 0), new THREE.Vector3(.05 * sd, .15, .01), new THREE.Vector3(.12 * sd, .31, 0), new THREE.Vector3(.2 * sd, .43, 0)]);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, .012, 6, false), bodyMat);
    const tip = new THREE.Mesh(sph, bodyMat); tip.scale.setScalar(.028); tip.position.copy(curve.getPoint(1));
    pivot.add(tube, tip); bfly.add(pivot); antennae.push({ pivot, sd });
  });

  // faint contact shadow on the glass
  const shC = document.createElement('canvas'); shC.width = shC.height = 128;
  { const x = shC.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(0,0,0,.8)'); g.addColorStop(.55, 'rgba(0,0,0,.25)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shC), transparent: true, depthWrite: false, color: 0x3a1428, opacity: .16 }));
  shadow.renderOrder = 0; shadow.visible = false; scene.add(shadow);

  /* ---------- sparse warm glints ---------- */
  const PN = 120;
  const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pSize = new Float32Array(PN), pAlpha = new Float32Array(PN);
  const pVel = new Float32Array(PN * 2), pLife = new Float32Array(PN), pMax = new Float32Array(PN), pBase = new Float32Array(PN);
  let pHead = 0, pAlive = 0;
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
  pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
  pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1));
  const pMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale;
      varying vec3 vC; varying float vA;
      void main(){ vC = aColor; vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      varying vec3 vC; varying float vA;
      void main(){ if (vA < 0.01) discard; float r = length(gl_PointCoord - 0.5);
        float k = smoothstep(0.5, 0.0, r) * 0.5 + smoothstep(0.16, 0.0, r);
        gl_FragColor = vec4(vC * k, k * vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(pGeo, pMat); points.frustumCulled = false; points.renderOrder = 5; scene.add(points);
  let glintCol = STYLES.rose.glint;
  function emit(x, y, z, vx, vy, life, size) {
    const i = pHead; pHead = (pHead + 1) % PN;
    pPos[i*3] = x; pPos[i*3+1] = y; pPos[i*3+2] = z; pVel[i*2] = vx; pVel[i*2+1] = vy;
    pLife[i] = life; pMax[i] = life; pBase[i] = size; pCol[i*3] = glintCol[0]; pCol[i*3+1] = glintCol[1]; pCol[i*3+2] = glintCol[2];
  }
  function updateParticles(dt) {
    let alive = 0;
    for (let i = 0; i < PN; i++) {
      if (pLife[i] <= 0) { pAlpha[i] = 0; continue; }
      pLife[i] -= dt;
      if (pLife[i] <= 0) { pAlpha[i] = 0; continue; }
      alive++;
      const k = 1 - pLife[i] / pMax[i];
      pVel[i*2] *= .985; pVel[i*2+1] *= .99;
      pPos[i*3] += pVel[i*2] * dt; pPos[i*3+1] += pVel[i*2+1] * dt;
      pAlpha[i] = .42 * Math.max(0, Math.sin(Math.PI * k));
      pSize[i] = pBase[i] * (1 - .4 * k);
    }
    pGeo.attributes.position.needsUpdate = true; pGeo.attributes.aAlpha.needsUpdate = true;
    pGeo.attributes.aSize.needsUpdate = true; pGeo.attributes.aColor.needsUpdate = true;
    pAlive = alive;
  }
  const tmpV = new THREE.Vector3();
  function glintFrom(mesh, lx, ly) {
    tmpV.set(lx, ly, 0); mesh.localToWorld(tmpV);
    emit(tmpV.x, tmpV.y, tmpV.z, rand(-.08, .08) * S, rand(.12, .3) * S, rand(1.6, 2.4), rand(2.5, 4));
  }

  /* ---------- style ---------- */
  function applyStyle(key) {
    const st = STYLES[key], t = wingTextures(key);
    foreMat.uniforms.uMap.value = t.fore; hindMat.uniforms.uMap.value = t.hind;
    [foreMat, hindMat].forEach(m => { m.uniforms.uIrid.value = st.irid; m.uniforms.uSpec.value = st.spec; m.uniforms.uUnder.value.set(st.under); });
    bodyMat.color.setHex(st.body);
    glintCol = st.glint;
    kick();
  }

  /* ---------- where it perches ---------- */
  let state = 'idle';            // idle | flying | landing | waiting | reading | leaving
  let perchMode = 'corner';      // corner (top right) | edge (bottom right, during a meeting)
  function perchPx(mode) {
    const mb = MENUBAR, side = S * 1.6 + 22;
    if (mode === 'edge') return { x: W - side, y: H - S * 1.6 - W * .02 };
    return { x: W - side, y: mb + S * 1.2 + 10 };
  }
  const pxToWorld = p => new THREE.Vector3(p.x - W / 2, H / 2 - p.y, 0);
  const worldToPx = v => ({ x: W / 2 + v.x, y: H / 2 - v.y });
  const perchHeading = mode => mode === 'edge' ? .3 : .22;
  function resize() {
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    const pr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
    D = (H / 2) / Math.tan(THREE.MathUtils.degToRad(15));
    camera.aspect = W / H; camera.near = D * .05; camera.far = D * 4; camera.position.set(0, 0, D); camera.updateProjectionMatrix();
    // really small: about a 40px wingspan, like a charm hanging in the corner
    S = BUTTERFLY_SIZE; bfly.scale.setScalar(S);
    pMat.uniforms.uScale.value = D * pr;
    if (state === 'waiting' || state === 'reading' || state === 'landing') { bfly.position.copy(pxToWorld(perchPx(perchMode))); placeOverlays(); }
    kick();
  }

  /* ---------- wing motion ----------
     Modelled on real butterfly flight: a burst of 2-4 beats lifts the body, then the wings are held in a
     shallow V and it sinks in a glide, so the path scallops. The body pitches a quarter-cycle behind the
     wings, and turns are banked: it rolls into the turn a beat before the heading changes. */
  const DOWN = .45;   // the downstroke is a touch quicker than the upstroke
  const strokeA = (u, lo, hi) => u < DOWN ? hi + (lo - hi) * easeInOutSine(u / DOWN) : lo + (hi - lo) * easeInOutSine((u - DOWN) / (1 - DOWN));
  const uAtUp = (a, lo, hi) => DOWN + Math.acos(1 - 2 * clamp((a - lo) / (hi - lo), 0, 1)) / Math.PI * (1 - DOWN);
  const GLIDE_A = .62;  // wings held in a V while gliding
  const wing = { mode: 'hold', a: 1.3, aH: 1.3, prev: 1.3, flex: 0, u: 0, freq: 3.2, lo: -.25, hi: 1.08, phase: 'flap', flaps: 3, burstT: 0, glideT: 0, blend: 0, allowGlide: true, landing: false,
    cruise: 3.2, glide: [1.0, 1.7], flapsR: [3, 4],
    bMid: .28, bAmp: .15, bPer: 6.5, bFrom: 0, bt: 1, fu: 0, fEnd: 0, fSpeed: 2.6 };
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  // mood (calm, easy or playful) sets the beat rate, how many beats in a burst and how long the glides last
  function startFly(mood) {
    mood = mood || { freq: 3.2, glide: [1.0, 1.7], flaps: [3, 4] };
    wing.mode = 'fly'; wing.freq = wing.cruise = mood.freq; wing.glide = mood.glide; wing.flapsR = mood.flaps;
    wing.allowGlide = true; wing.landing = false;
    wing.phase = 'flap'; wing.flaps = randInt(wing.flapsR[0], wing.flapsR[1]); wing.blend = 0;
    wing.u = uAtUp(clamp(wing.a, wing.lo, wing.hi), wing.lo, wing.hi) % 1;
  }
  function breathe(mid, amp, per) { wing.mode = 'breathe'; wing.bFrom = wing.a; wing.bt = 0; wing.bMid = mid; wing.bAmp = amp; wing.bPer = per; }
  let lastFlutter = 0;
  function flutter(speed, dur) {
    const now = performance.now() / 1000;
    if (reduce || wing.mode !== 'breathe' || now - lastFlutter < 2.5) return;
    lastFlutter = now;
    wing.mode = 'flutter'; wing.fSpeed = speed || 2.6;
    wing.fu = uAtUp(clamp(wing.a, .12, .95), .12, .95) % 1; wing.fEnd = now + (dur || 1.1);
  }

  // Flight state: the body follows the path with lag, bounces with the beats, pitches with the stroke and banks into turns.
  const fly = { active: false, curve: null, u: 0, base: new THREE.Vector3(), last: new THREE.Vector3(), bob: 0, bobV: 0, heading: 0, headV: 0, roll: 0, rollV: 0, pitch: 0, settle: 1, landBlend: 0, landHeading: null, lift: 0,
    weave: { a: .71, b: 1.37, pa: 0, pb: 1.3, amp: .18 } };
  // critically damped spring step, returns [x, v]
  function spring(x, v, target, omega, dt) {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, inv = 1 / (f + hhoo);
    return [(f * x + dt * v + hhoo * target) * inv, (v + hoo * (target - x)) * inv];
  }
  function tangentHeading(curve, u) { const tg = curve.getTangentAt(clamp(u, .001, .999)); return Math.atan2(tg.y, tg.x) - Math.PI / 2; }

  const tweens = new Set();
  function tween(dur, fn, ease) {
    ease = ease || easeInOutSine;
    if (reduce) dur = 1;
    return new Promise(res => { tweens.add({ t0: performance.now(), dur: Math.max(1, dur), fn, ease, res }); kick(); });
  }
  let running = false, last = 0, glints = false, glintAcc = 0, nextShift = 0;
  const t0 = performance.now();
  function frame(now) {
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now;
    const t = (now - t0) / 1000, secs = now / 1000;
    for (const tw of Array.from(tweens)) {
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      tw.fn(tw.ease(k), dt);
      if (k >= 1) { tweens.delete(tw); tw.res(); }
    }

    let flapping = false, strokeU = 0;
    if (wing.mode === 'fly') {
      if (wing.phase === 'flap') {
        flapping = true;
        const prevU = wing.u;
        wing.u += dt * wing.freq;
        if (wing.u >= 1) { wing.u -= 1; wing.flaps--; }
        // leave the flap at the top of the upstroke, so the wings are already near the glide pose
        const ug = uAtUp(GLIDE_A, wing.lo, wing.hi);
        if (wing.allowGlide && wing.flaps <= 0 && prevU < ug && wing.u >= ug) {
          wing.phase = 'glide'; wing.glideT = rand(wing.glide[0], wing.glide[1]); wing.blend = 0;
        }
        strokeU = wing.u;
        const target = strokeA(wing.u, wing.lo, wing.hi), targetH = strokeA((wing.u + .93) % 1, wing.lo, wing.hi);
        // blend out of the glide pose over the first part of the stroke so nothing snaps
        wing.blend = Math.min(1, wing.blend + dt * 4);
        wing.a = lerp(wing.a, target, wing.blend); wing.aH = lerp(wing.aH, targetH, wing.blend);
      } else {
        wing.glideT -= dt;
        // a soft V that breathes a little in the airflow, hindwings slightly lower than forewings
        const breathe_ = Math.sin(t * 2.1) * .035 + Math.sin(t * 3.3) * .015;
        wing.a += (GLIDE_A + breathe_ - wing.a) * Math.min(1, dt * 5);
        wing.aH += (GLIDE_A - .08 + breathe_ * .8 - wing.aH) * Math.min(1, dt * 5);
        if (wing.glideT <= 0 || !wing.allowGlide) { wing.phase = 'flap'; wing.flaps = randInt(wing.flapsR[0], wing.flapsR[1]); wing.u = uAtUp(wing.a, wing.lo, wing.hi); wing.blend = 0; }
      }
    } else if (wing.mode === 'flutter') {
      wing.fu = (wing.fu + dt * wing.fSpeed) % 1;
      wing.a = strokeA(wing.fu, .12, .95); wing.aH = strokeA((wing.fu + .93) % 1, .12, .95);
      if (secs > wing.fEnd) breathe(wing.bMid, wing.bAmp, wing.bPer);
    } else if (wing.mode === 'breathe') {
      wing.bt = Math.min(1, wing.bt + dt / 1.4);
      const w = smooth01(wing.bt), sF = Math.sin(t * Math.PI * 2 / wing.bPer), sH = Math.sin(t * Math.PI * 2 / wing.bPer - .35);
      wing.a = lerp(wing.bFrom, wing.bMid + wing.bAmp * sF, w); wing.aH = lerp(wing.bFrom, wing.bMid + wing.bAmp * sH, w);
    } else {
      wing.aH += (wing.a - wing.aH) * Math.min(1, dt * 8);
    }
    const vel = (wing.a - wing.prev) / dt; wing.prev = wing.a;
    wing.flex += (clamp(-vel * .03, -1, 1) - wing.flex) * Math.min(1, dt * 12);
    foreR.rotation.y = -wing.a; foreL.rotation.y = wing.a; hindR.rotation.y = -wing.aH; hindL.rotation.y = wing.aH;
    foreMat.uniforms.uFlex.value = hindMat.uniforms.uFlex.value = wing.flex;
    foreMat.uniforms.uTime.value = hindMat.uniforms.uTime.value = t;
    antennae.forEach(({ pivot, sd }, i) => { pivot.rotation.z = sd * .045 * Math.sin(t * (1.1 + i * .25) + i); pivot.rotation.x = .07 * Math.sin(t * .9 + i); });

    if (fly.active) {
      const c = fly.curve;
      const P = c.getPointAt(clamp(fly.u, 0, 1));
      fly.base.lerp(P, 1 - Math.exp(-dt * 6));
      // lift: each downstroke pushes the body up; in a glide it sinks gently, like a paper plane
      const push = flapping ? Math.max(0, Math.sin(Math.PI * 2 * (strokeU + .08))) : 0;
      const liftTarget = flapping ? S * (1.7 * push - .2) : -S * 1.05;
      fly.lift += (liftTarget - fly.lift) * Math.min(1, dt * 3.5);
      fly.bobV += fly.lift * dt * 1.6; fly.bobV -= fly.bobV * Math.min(1, dt * 1.1);
      fly.bob += fly.bobV * dt; fly.bob -= fly.bob * Math.min(1, dt * .9);
      fly.bob = clamp(fly.bob, -S * 1.6, S * 1.6);
      const st = fly.settle;
      // a slow weave, so it never tracks the path like a train (its rhythm changes every flight)
      const wv = fly.weave, wx = (Math.sin(t * wv.a + wv.pa) * .6 + Math.sin(t * wv.b + wv.pb) * .4) * S * wv.amp;
      bfly.position.set(fly.base.x + wx * st, fly.base.y + fly.bob * st, fly.base.z);

      // heading: look a little ahead along the path, so the turn is anticipated rather than chased
      let hT = tangentHeading(c, fly.u + .035);
      if (fly.landHeading !== null) hT = lerpAngle(hT, fly.landHeading, fly.landBlend);
      const hErr = angDiff(hT, fly.heading);
      [fly.heading, fly.headV] = (() => { const r = spring(0, fly.headV, hErr, 3.2, dt); return [fly.heading + r[0], r[1]]; })();
      // bank: roll into the turn in proportion to how fast the heading is changing, led by where the path is going
      const curv = angDiff(tangentHeading(c, fly.u + .07), tangentHeading(c, fly.u + .01));
      const rollT = clamp(fly.headV * .22 + curv * 2.2, -.5, .5) * (flapping ? 1 : 1.25);
      [fly.roll, fly.rollV] = spring(fly.roll, fly.rollV, rollT, 4.5, dt);
      // pitch: nose dips on the downstroke, lifts on the upstroke, a quarter cycle behind the wings; glides nose-down
      const pitchT = flapping ? -.1 + .13 * Math.sin(Math.PI * 2 * strokeU - Math.PI / 2) : -.22;
      fly.pitch += (pitchT - fly.pitch) * Math.min(1, dt * 6);
      bfly.rotation.set(fly.pitch * st, fly.roll * st, fly.heading);
    }

    // now and then, a slow shuffle on the perch
    if ((state === 'reading' || state === 'waiting') && wing.mode === 'breathe' && nextShift && secs > nextShift && !reduce) {
      nextShift = secs + rand(14, 22);
      const h0 = bfly.rotation.z, h1 = perchHeading(perchMode) + rand(-.12, .12);
      tween(2400, k => { bfly.rotation.z = lerp(h0, h1, k); });
      flutter(2.2, 1.0);
    }
    bfly.updateMatrixWorld(true);

    if (bfly.visible && glints && !reduce) {
      glintAcc += dt;
      while (glintAcc > .45) { glintAcc -= .45; glintFrom(Math.random() < .5 ? foreR : foreL, .86, .82); }
    }
    if (bfly.visible) {
      const z = bfly.position.z, open = .3 + .7 * Math.cos(clamp(wing.a, 0, 1.45)), grow = 1 + z / (D * .5);
      shadow.visible = true;
      shadow.position.set(bfly.position.x + S * .12 + z * .3, bfly.position.y - S * .2 - z * .35, -3);
      shadow.scale.set(S * 2 * open * grow, S * 1.9 * grow, 1);
      shadow.rotation.z = bfly.rotation.z;
      shadow.material.opacity = .16 * Math.exp(-z / (D * .06));
    } else shadow.visible = false;

    updateParticles(dt);
    renderer.render(scene, camera);
    if (state !== 'idle' || tweens.size || pAlive > 0) requestAnimationFrame(frame);
    else { running = false; renderer.render(scene, camera); }
  }
  function kick() { if (running) return; running = true; last = performance.now(); requestAnimationFrame(frame); }

  /* ---------- unhurried flight paths ---------- */
  function flyAlong(curve, dur, ease, landHeading, fromPerch, mood) {
    const p0 = curve.getPointAt(0);
    fly.weave = { a: rand(.55, .85), b: rand(1.15, 1.6), pa: rand(0, 6.28), pb: rand(0, 6.28), amp: rand(.14, .22) * ((mood && mood.weave) || 1) };
    fly.curve = curve; fly.u = 0;
    fly.base.copy(p0); fly.last.copy(p0);
    fly.bob = 0; fly.bobV = 0; fly.lift = 0; fly.rollV = 0; fly.headV = 0;
    fly.heading = fromPerch ? bfly.rotation.z : tangentHeading(curve, 0);
    fly.roll = fromPerch ? 0 : fly.roll; fly.pitch = fromPerch ? 0 : -.1;
    fly.landHeading = landHeading == null ? null : landHeading;
    fly.settle = fromPerch ? 0 : 1; fly.landBlend = 0; fly.active = true;
    bfly.position.copy(p0);
    return tween(dur, u => {
      fly.u = clamp(u, 0, 1);
      const rampIn = fromPerch ? smooth01(u / .14) : 1;
      const landS = fly.landHeading !== null ? 1 - smooth01((u - .72) / .28) : 1;
      fly.settle = Math.min(rampIn, landS); fly.landBlend = 1 - landS;
      if (fly.landHeading !== null) { wing.allowGlide = u < .92; wing.freq = lerp(wing.cruise, 2.7, smooth01((u - .85) / .15)); }
    }, ease);
  }
  async function settleOnto(P, heading, alive) {
    // the last beat or two slow down, then the wings fold up as the feet touch
    fly.settle = 0; fly.landBlend = 1;
    await wait(500);
    if (alive && !alive()) return;
    fly.active = false;
    const p0 = bfly.position.clone(), r0 = bfly.rotation.clone();
    wing.mode = 'hold'; const a0 = wing.a;
    await Promise.all([
      tween(600, k => { bfly.position.lerpVectors(p0, P, k); bfly.rotation.set(lerp(r0.x, 0, k), lerp(r0.y, 0, k), lerpAngle(r0.z, heading, k)); }),
      tween(800, k => { wing.a = lerp(a0, 1.3, k); })
    ]);
  }
  /* ---------- a different route every visit (the routes themselves are in flight-paths.js) ---------- */
  const Flight = window.TitliFlight;
  const flightLog = (() => {
    let mem = { entry: [], exit: [] };
    try { const v = JSON.parse(localStorage.getItem('titli.flights') || 'null'); if (v && Array.isArray(v.entry) && Array.isArray(v.exit)) mem = v; } catch (_) {}
    return {
      recent: (kind, n) => mem[kind].slice(-n),
      add(kind, name) { mem[kind] = mem[kind].concat(name).slice(-6); try { localStorage.setItem('titli.flights', JSON.stringify(mem)); } catch (_) {} },
    };
  })();
  function route(kind, at) {
    const r = Flight.plan(kind, {
      W, H, S, D, menubar: MENUBAR, at: { x: at.x, y: at.y, z: at.z || 0 },
      recent: flightLog.recent(kind, kind === 'entry' ? 3 : 2),   // never one of the last few
      makeCurve: pts => Flight.makeCurve(THREE, D, pts),
    });
    flightLog.add(kind, r.name);
    return r;
  }

  /* ======================================================================
     The overlay: one butterfly at a time. Main tells us what to deliver
     and when to pull away; we tell main when the note is on screen,
     what the person tapped, and when the butterfly has gone.
     ====================================================================== */
  const bridge = window.overlay;
  const bubble = $('#bubble');
  let current = null, flowGen = 0, autoTimer = null, interactive = false;
  const NOTE_STAYS_MS = 10 * 60 * 1000, VISIT_STAYS_MS = 6000;

  const tell = ev => bridge.send(ev);
  function setInteractive(on) { if (on !== interactive) { interactive = on; tell({ type: 'interactive', on }); } }

  function placeNow(P, heading) { fly.active = false; bfly.position.copy(P); bfly.rotation.set(0, 0, heading); wing.mode = 'hold'; wing.a = 1.3; }

  async function deliver(item) {
    if (current) return;
    const gen = ++flowGen, alive = () => gen === flowGen;
    current = item;
    applyStyle(item.style || 'rose');
    state = 'flying'; perchMode = 'corner';
    const P = pxToWorld(perchPx('corner')), H0 = perchHeading('corner');
    const way = reduce ? null : route('entry', P);
    bfly.visible = true; wing.a = .9; startFly(way && way.mood); glints = true; kick();
    if (reduce) placeNow(P, H0);
    else {
      await flyAlong(way.curve, way.duration, k => Math.sin(k * Math.PI / 2), H0, false, way.mood); if (!alive()) return;
      glints = false;
      await settleOnto(P, H0, alive); if (!alive()) return;
    }
    glints = false; state = 'landing';
    await wait(500); if (!alive()) return;
    await tween(2700, k => { wing.a = lerp(1.3, .1, k); }); if (!alive()) return;
    breathe(.28, .15, 6.5);
    state = 'reading';
    nextShift = performance.now() / 1000 + rand(10, 16);
    showBubble(item);
    tell({ type: 'shown', id: item.id });
    autoTimer = setTimeout(() => { if (alive() && state === 'reading') leave(null); }, item.kind === 'visit' ? VISIT_STAYS_MS : NOTE_STAYS_MS);
  }

  async function leave(kind) {
    if (state !== 'reading' || !current) return;
    const gen = ++flowGen, alive = () => gen === flowGen;
    const item = current;
    state = 'leaving'; clearTimeout(autoTimer); nextShift = 0;
    if (kind) tell({ type: 'react', id: item.id, r: kind });
    if (kind && kind !== 'butterfly') { floatEmoji(kind); lastFlutter = 0; flutter(2.6, .9); }
    await wait(kind && kind !== 'butterfly' ? 900 : 250); if (!alive()) return;
    hideBubble(); setInteractive(false);
    await wait(400); if (!alive()) return;
    wing.mode = 'hold'; const a0 = wing.a;
    await tween(600, k => { wing.a = lerp(a0, 1.0, k); }); if (!alive()) return;
    const way = reduce ? null : route('exit', bfly.position);
    startFly(way && way.mood); glints = true;
    if (!reduce) { await flyAlong(way.curve, way.duration, k => Math.pow(k, 1.5), null, true, way.mood); if (!alive()) return; }
    finish('done', item.id);
  }

  function finish(type, id) {
    glints = false; fly.active = false; state = 'idle'; bfly.visible = false; current = null; wing.mode = 'hold';
    kick();
    // give the empty frame a moment to paint before the window is hidden
    setTimeout(() => tell({ type, id }), 60);
  }

  // a meeting started, the screen locked, or similar: vanish at once
  function abort() {
    if (!current) return;
    const id = current.id;
    flowGen++; tweens.clear(); clearTimeout(autoTimer);
    nextShift = 0;
    bubble.classList.remove('show'); bubble.hidden = true; setInteractive(false);
    finish('aborted', id);
  }

  /* ---------- the note ---------- */
  function showBubble(item) {
    const visit = item.kind === 'visit';
    $('#bFrom').textContent = item.circleName ? `${item.fromName} · ${item.circleName}` : item.fromName;
    const note = $('#bNote');
    note.classList.toggle('b-heart', !visit && !item.text);
    note.classList.toggle('b-visit', visit);
    note.textContent = visit ? 'sent a butterfly back 🦋' : (item.text || '♥');
    $('#bReact').hidden = visit;
    bubble.setAttribute('aria-label', visit ? `${item.fromName} sent a butterfly back` : `Note from ${item.fromName}`);
    bubble.hidden = false; placeOverlays();
    requestAnimationFrame(() => bubble.classList.add('show'));
  }
  function hideBubble() { bubble.classList.remove('show'); setTimeout(() => { if (!bubble.classList.contains('show')) bubble.hidden = true; }, 420); }
  function placeOverlays() {
    if (bubble.hidden) return;
    const px = worldToPx(bfly.position);
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const left = clamp(px.x + S * 1.3 - bw, 10, W - bw - 10);
    bubble.style.left = left + 'px';
    bubble.style.top = clamp(px.y + S * 1.05 + 8, 10, H - bh - 10) + 'px';
    bubble.style.setProperty('--tail-x', clamp(px.x - left, 14, bw - 14) + 'px');
  }
  function floatEmoji(e) {
    const b = bubble.getBoundingClientRect();
    const cx = b.left + b.width / 2 - 9, cy = b.top + 4;
    const h = document.createElement('span'); h.className = 'float-emo'; h.textContent = e; document.body.append(h);
    h.animate([
      { transform: `translate(${cx}px, ${cy}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${cx}px, ${cy - 20}px) scale(1.2)`, opacity: 1, offset: .35 },
      { transform: `translate(${cx}px, ${cy - 44}px) scale(1)`, opacity: 0 }
    ], { duration: reduce ? 1 : 1300, easing: 'ease-out' }).onfinish = () => h.remove();
  }

  bubble.querySelectorAll('.b-emo').forEach(b => b.addEventListener('click', () => leave(b.dataset.r)));
  $('#backBtn').addEventListener('click', () => leave('butterfly'));
  $('#closeBtn').addEventListener('click', () => leave(null));

  // clicks pass straight through to your apps, except on the note and the butterfly itself
  document.addEventListener('mousemove', e => {
    if (!current) { setInteractive(false); return; }
    let over = false;
    if (!bubble.hidden) { const r = bubble.getBoundingClientRect(); over = e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 4; }
    const px = worldToPx(bfly.position);
    const nearBfly = Math.hypot(e.clientX - px.x, e.clientY - px.y) < S * 1.4;
    if (nearBfly && state === 'reading') flutter(2.6, 1);
    setInteractive(over || (nearBfly && state === 'reading'));
  });

  bridge.onGeometry(g => { if (g && typeof g.menubar === 'number') MENUBAR = g.menubar; resize(); });
  bridge.onDeliver(d => { if (d && typeof d.menubar === 'number') MENUBAR = d.menubar; resize(); if (d && d.item) deliver(d.item); });
  bridge.onAbort(() => abort());

  window.addEventListener('resize', resize);
  applyStyle('rose');
  resize();
})();
