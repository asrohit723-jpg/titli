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

test('update manifest: Mac and Windows manifests only work on their own platform', () => {
  const k = pair();
  const win = { ...body(), platform: 'win', builds: { x64: { file: 'Titli-Setup-0.1.12-x64.exe', size: 90000000, sha256: 'd'.repeat(64) } } };
  const winText = JSON.stringify(signManifest(win, k.priv));
  assert.equal(verifyManifest(winText, k.pub, { platform: 'win' }).builds.x64.file, 'Titli-Setup-0.1.12-x64.exe');
  assert.throws(() => verifyManifest(winText, k.pub, { platform: 'mac' }), /different kind/);
  // Mac manifests from before Windows (no platform field) still count as Mac ones
  assert.ok(verifyManifest(JSON.stringify(signManifest(body(), k.priv)), k.pub, { platform: 'mac' }));
  assert.throws(() => verifyManifest(JSON.stringify(signManifest(body(), k.priv)), k.pub, { platform: 'win' }), /different kind/);
  // a Windows manifest can't point at a zip, a Mac one can't point at an exe
  const wrongFile = { ...win, builds: { x64: { ...win.builds.x64, file: 'Titli.zip' } } };
  assert.throws(() => verifyManifest(JSON.stringify(signManifest(wrongFile, k.priv)), k.pub, { platform: 'win' }), /looks wrong/);
  const macExe = { ...body(), platform: 'mac', builds: { arm64: { ...body().builds.arm64, file: 'Titli.exe' } } };
  assert.throws(() => verifyManifest(JSON.stringify(signManifest(macExe, k.priv)), k.pub, { platform: 'mac' }), /looks wrong/);
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

test('manifests signed with the old key, the new key, or both: each app accepts what it should', () => {
  const v1 = require('./fixtures/v1/update-manifest');   // what Titli 0.1.32 runs
  const oldK = pair(), newK = pair(), stranger = pair();
  const both = JSON.stringify(signManifest(body(), { old: oldK.priv, current: newK.priv }));
  const newOnly = JSON.stringify(signManifest(body(), { current: newK.priv }));
  const oldOnly = JSON.stringify(signManifest(body(), { old: oldK.priv }));
  // today's apps trust both keys
  for (const t of [both, newOnly, oldOnly]) assert.equal(verifyManifest(t, [oldK.pub, newK.pub]).version, '0.1.12');
  // 0.1.32 still installs a dual-signed update (so it can reach the version that trusts the new key)
  assert.equal(v1.verifyManifest(both, oldK.pub).version, '0.1.12');
  assert.throws(() => v1.verifyManifest(newOnly, oldK.pub));
  // once the old key is dropped from the app, only the new one counts
  assert.throws(() => verifyManifest(oldOnly, [newK.pub]), /signature/);
  assert.equal(verifyManifest(both, [newK.pub]).version, '0.1.12');
  // a stranger's key is no use, and neither is moving one signature onto other content
  assert.throws(() => verifyManifest(JSON.stringify(signManifest(body(), { current: stranger.priv })), [oldK.pub, newK.pub]), /signature/);
  const swapped = { ...JSON.parse(both), version: '9.9.9' };
  assert.throws(() => verifyManifest(JSON.stringify(swapped), [oldK.pub, newK.pub]), /signature/);
  assert.equal(verifyManifest(both, [newK.pub]).sig2, undefined, 'signatures are not part of the result');
});
