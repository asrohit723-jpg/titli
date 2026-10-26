'use strict';
// CI: zips are built, now write dist/latest-mac.json and sign it.
//   VERSION=0.1.12 NOTES="..." UPDATE_SIGNING_KEY="-----BEGIN PRIVATE KEY-----..." node scripts/make-manifest.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_ID, signManifest, verifyManifest } = require('../src/core/update-manifest');

const dist = path.join(__dirname, '../dist');
const version = process.env.VERSION;
const key = process.env.UPDATE_SIGNING_KEY;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('VERSION is missing'); process.exit(1); }
if (!key) { console.error('UPDATE_SIGNING_KEY is missing'); process.exit(1); }

const builds = {};
for (const arch of ['arm64', 'x64']) {
  const file = `Titli-${version}-${arch}-mac.zip`;
  const data = fs.readFileSync(path.join(dist, file));
  builds[arch] = { file, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
const notes = String(process.env.NOTES || '').split('\n')[0].slice(0, 140);
const manifest = signManifest({ app: APP_ID, version, notes, published: new Date().toISOString(), builds }, key);
const text = JSON.stringify(manifest, null, 2) + '\n';

// the key in GitHub must match the public key the app ships with, or every update would be refused
const pub = fs.readFileSync(path.join(__dirname, '../src/main/update-key.pem'), 'utf8');
try { verifyManifest(text, pub); }
catch (e) { console.error('UPDATE_SIGNING_KEY does not match src/main/update-key.pem:', e.message); process.exit(1); }

fs.writeFileSync(path.join(dist, 'latest-mac.json'), text);
console.log(text);
