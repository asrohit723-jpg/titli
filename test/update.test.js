'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonical, signManifest, verifyManifest, compareVersions } = require('../src/core/update-manifest');

const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const body = () => ({
  app: 'titli', version: '0.1.12', notes: 'New panel design', published: '2026-10-26T13:00:00.000Z',
  builds: {
    arm64: { file: 'Titli-0.1.12-arm64-mac.zip', size: 95000000, sha256: 'a'.repeat(64) },
    x64: { file: 'Titli-0.1.12-x64-mac.zip', size: 98000000, sha256: 'b'.repeat(64) }
  }
});

test('update manifest: canonical form ignores key order', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } }), canonical({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test('update manifest: signed manifests verify, anything changed does not', () => {
  const k = pair();
  const text = JSON.stringify(signManifest(body(), k.priv));
  const m = verifyManifest(text, k.pub);
  assert.equal(m.version, '0.1.12');
  assert.equal(m.sig, undefined, 'signature is not part of the body');

  // pretty-printing or reordering is fine
  const reordered = JSON.parse(text);
  assert.ok(verifyManifest(JSON.stringify({ sig: reordered.sig, builds: reordered.builds, ...reordered }, null, 2), k.pub));

  // a swapped download hash is refused
  const tampered = JSON.parse(text); tampered.builds.arm64.sha256 = 'c'.repeat(64);
  assert.throws(() => verifyManifest(JSON.stringify(tampered), k.pub), /signature/);
  // a bumped version is refused
  const bumped = JSON.parse(text); bumped.version = '9.9.9';
  assert.throws(() => verifyManifest(JSON.stringify(bumped), k.pub), /signature/);
  // someone else's key is refused
  assert.throws(() => verifyManifest(text, pair().pub), /signature/);
  // unsigned or broken is refused
  assert.throws(() => verifyManifest(JSON.stringify(body()), k.pub), /signed/);
  assert.throws(() => verifyManifest('not json', k.pub), /unreadable/);
});

test('update manifest: well signed but malformed is still refused', () => {
  const k = pair();
  const bad = [
    b => { b.app = 'other'; },
    b => { b.version = '1.2'; },
    b => { b.builds.arm64.file = '../../evil.zip'; },
    b => { b.builds.x64.sha256 = 'xyz'; },
    b => { b.builds.x64.size = -1; },
    b => { delete b.builds; }
  ];
  for (const change of bad) {
    const b = body(); change(b);
    assert.throws(() => verifyManifest(JSON.stringify(signManifest(b, k.priv)), k.pub));
  }
});

test('update manifest: the shipped public key is a valid Ed25519 key', () => {
  const pem = fs.readFileSync(path.join(__dirname, '../src/main/update-key.pem'), 'utf8');
  assert.equal(crypto.createPublicKey(pem).asymmetricKeyType, 'ed25519');
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});
