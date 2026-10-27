'use strict';
// End-to-end encryption for everything that goes through the relay: AES-256-GCM with a random IV.
// The relay sees "t1." followed by base64url(iv | ciphertext | tag) and nothing else.

const crypto = require('crypto');

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return 't1.' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}

function open(key, text) {
  try {
    if (typeof text !== 'string' || !text.startsWith('t1.')) return null;
    const b = Buffer.from(text.slice(3), 'base64url');
    if (b.length < 12 + 16 + 2) return null;
    const iv = b.subarray(0, 12), tag = b.subarray(b.length - 16), ct = b.subarray(12, b.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const obj = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null; // wrong key, tampered, or not ours
  }
}

module.exports = { seal, open };
