'use strict';
// CI: the downloads are built, now write the signed update manifest for one platform.
//   VERSION=0.1.12 NOTES="..." UPDATE_SIGNING_KEY="-----BEGIN PRIVATE KEY-----..." node scripts/make-manifest.js mac|win
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
const key = process.env.UPDATE_SIGNING_KEY;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('VERSION is missing'); process.exit(1); }
if (!key) { console.error('UPDATE_SIGNING_KEY is missing'); process.exit(1); }

const builds = {};
for (const [arch, file] of Object.entries(FILES[platform](version))) {
  const data = fs.readFileSync(path.join(dist, file));
  builds[arch] = { file, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
const notes = String(process.env.NOTES || '').split('\n')[0].slice(0, 140);
const manifest = signManifest({ app: APP_ID, platform, version, notes, published: new Date().toISOString(), builds }, key);
const text = JSON.stringify(manifest, null, 2) + '\n';

// the key in GitHub must match the public key the app ships with, or every update would be refused
const pub = fs.readFileSync(path.join(__dirname, '../src/main/update-key.pem'), 'utf8');
try { verifyManifest(text, pub, { platform }); }
catch (e) { console.error('UPDATE_SIGNING_KEY does not match src/main/update-key.pem:', e.message); process.exit(1); }

fs.writeFileSync(path.join(dist, `latest-${platform}.json`), text);
console.log(text);
