'use strict';
// The update manifest (latest-mac.json) says which version is newest and what its downloads hash to.
// CI signs it with a private Ed25519 key kept in GitHub secrets; the app only trusts a manifest that
// verifies against the public key it ships with. Because the updater installs without Gatekeeper,
// this signature is what stands between a tampered release and someone's Mac.
// Pure Node, no Electron, so it's tested on its own.

const crypto = require('crypto');

const APP_ID = 'titli';
const MAX_SIZE = 600 * 1024 * 1024;

// JSON with keys sorted at every level, so signer and checker hash exactly the same bytes
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function signManifest(body, privateKeyPem) {
  const sig = crypto.sign(null, Buffer.from(canonical(body)), privateKeyPem).toString('base64');
  return { ...body, sig };
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = { mac: /^[A-Za-z0-9._-]+\.zip$/, win: /^[A-Za-z0-9._-]+\.exe$/ };

// returns the manifest if it's genuine, well formed and for this platform (mac | win); throws otherwise
function verifyManifest(text, publicKeyPem, { platform = 'mac' } = {}) {
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Error('The update information is unreadable.'); }
  if (!m || typeof m !== 'object' || typeof m.sig !== 'string') throw new Error('The update isn’t signed.');
  const { sig, ...body } = m;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonical(body)), publicKeyPem, Buffer.from(sig, 'base64')); } catch (e) { ok = false; }
  if (!ok) throw new Error('The update’s signature doesn’t match, so it wasn’t installed.');
  if (body.app !== APP_ID) throw new Error('That update is for a different app.');
  // manifests from before Windows existed have no platform and are Mac ones
  if ((body.platform || 'mac') !== platform) throw new Error('That update is for a different kind of computer.');
  if (!VERSION_RE.test(body.version || '')) throw new Error('The update has a strange version number.');
  if (!body.builds || typeof body.builds !== 'object') throw new Error('The update lists no downloads.');
  for (const [arch, b] of Object.entries(body.builds)) {
    if (!b || !(FILE_RE[platform] || FILE_RE.mac).test(b.file || '') || !/^[0-9a-f]{64}$/.test(b.sha256 || '') || !Number.isInteger(b.size) || b.size <= 0 || b.size > MAX_SIZE) {
      throw new Error(`The ${arch} download in the update looks wrong.`);
    }
  }
  return body;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

module.exports = { APP_ID, canonical, signManifest, verifyManifest, compareVersions };
