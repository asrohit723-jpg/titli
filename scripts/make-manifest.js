'use strict';
// CI: the downloads are built, now write the signed update manifest for one platform.
//   VERSION=0.1.12 NOTES="..." UPDATE_SIGNING_KEY=<original key> RELEASE_KEYS=<blob> node scripts/make-manifest.js mac|win
// Signed with the original key (what Titli 0.1.32 checks) and/or the new one from RELEASE_KEYS (only in the
// approved "release" environment). At least one is needed.
//   mac -> dist/latest-mac.json (Titli-<v>-arm64-mac.zip, Titli-<v>-x64-mac.zip)
//   win -> dist/latest-win.json (Titli-Setup-<v>-x64.exe)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_ID, signManifest, verifyManifest } = require('../src/core/update-manifest');

const dist = path.join(__dirname, '../dist');
const platform = process.argv[2] || 'mac';
const FILES = {
  mac: v => ({ arm64: `Titli-${v}-arm64-mac.zip`, x64: `Titli-${v}-x64-mac.zip` }),
  win: v => ({ x64: `Titli-Setup-${v}-x64.exe` })
};
if (!FILES[platform]) { console.error('Say which platform: mac or win'); process.exit(1); }
const version = process.env.VERSION;
const oldKey = process.env.UPDATE_SIGNING_KEY || null;
let currentKey = null;
try { if (process.env.RELEASE_KEYS) currentKey = JSON.parse(Buffer.from(process.env.RELEASE_KEYS, 'base64').toString('utf8')).updateKey || null; }
catch (e) { console.error('RELEASE_KEYS is not readable'); process.exit(1); }
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('VERSION is missing'); process.exit(1); }
if (!oldKey && !currentKey) { console.error('No signing key: set UPDATE_SIGNING_KEY and/or RELEASE_KEYS'); process.exit(1); }

const builds = {};
for (const [arch, file] of Object.entries(FILES[platform](version))) {
  const data = fs.readFileSync(path.join(dist, file));
  builds[arch] = { file, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
const notes = String(process.env.NOTES || '').split('\n')[0].slice(0, 140);
const manifest = signManifest({ app: APP_ID, platform, version, notes, published: new Date().toISOString(), builds }, { old: oldKey, current: currentKey });
const text = JSON.stringify(manifest, null, 2) + '\n';

// each key in GitHub must match a public key the app ships with, or updates would be refused
const pubOf = f => fs.readFileSync(path.join(__dirname, '../src/main', f), 'utf8');
const { sig, sig2 } = manifest;
const only = which => JSON.stringify(which === 'old' ? { ...manifest, sig2: manifest.sig2 } : (({ sig: _, ...rest }) => rest)(manifest));
try {
  if (oldKey) verifyManifest(only('old'), pubOf('update-key.pem'), { platform });
  if (currentKey) verifyManifest(only('current'), pubOf('update-key-2.pem'), { platform });
} catch (e) { console.error('A signing key does not match the public keys in src/main:', e.message); process.exit(1); }
console.error(`signed with: ${[sig && 'original key', sig2 && 'release key'].filter(Boolean).join(' + ')}`);

fs.writeFileSync(path.join(dist, `latest-${platform}.json`), text);
console.log(text);
