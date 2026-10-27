'use strict';
// The update manifest (latest-mac.json) says which version is newest and what its downloads hash to.
// CI signs it with private Ed25519 keys kept in GitHub; the app only trusts a manifest that verifies
// against one of the public keys it ships with.
// Two signatures, so the signing key can be replaced without stranding anyone:
//   sig2: the new key, over everything except the signatures
//   sig:  the original key, over everything except itself (sig2 included), which is what Titli 0.1.32
//         and earlier check. Once everyone has updated, sig is dropped. Because the updater installs without Gatekeeper,
// this signature is what stands between a tampered release and someone's Mac.
// Pure Node, no Electron, so it's tested on its own.

const crypto = require('crypto');

const APP_ID = 'titli';
const MAX_SIZE = 600 * 1024 * 1024;

const { canonical } = require('./canonical');

// keys: { old, current } private keys (PEM); either may be missing, not both
function signManifest(body, keys) {
  if (typeof keys === 'string') keys = { old: keys };
  if (!keys || (!keys.old && !keys.current)) throw new Error('No signing key.');
  const out = { ...body };
  if (keys.current) out.sig2 = crypto.sign(null, Buffer.from(canonical(body)), keys.current).toString('base64');
  if (keys.old) out.sig = crypto.sign(null, Buffer.from(canonical(out)), keys.old).toString('base64');
  return out;
}

const check = (pems, data, sig) => typeof sig === 'string' && pems.some(k => { try { return crypto.verify(null, Buffer.from(data), k, Buffer.from(sig, 'base64')); } catch (e) { return false; } });

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = { mac: /^[A-Za-z0-9._-]+\.zip$/, win: /^[A-Za-z0-9._-]+\.exe$/ };

// returns the manifest if it's genuine, well formed and for this platform (mac | win); throws otherwise.
// publicKeys: one PEM or a list of them (the keys this build trusts)
function verifyManifest(text, publicKeys, { platform = 'mac' } = {}) {
  const pems = (Array.isArray(publicKeys) ? publicKeys : [publicKeys]).filter(Boolean);
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Error('The update information is unreadable.'); }
  if (!m || typeof m !== 'object' || (typeof m.sig !== 'string' && typeof m.sig2 !== 'string')) throw new Error('The update isn’t signed.');
  const { sig, ...withSig2 } = m;
  const { sig2, ...body } = withSig2;
  const ok = check(pems, canonical(body), sig2) || check(pems, canonical(withSig2), sig);
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
