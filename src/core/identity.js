'use strict';
// Each device's own keys, made on first run and kept in Titli's (encrypted) data file:
//   sign: Ed25519. Everything this device sends is signed, so no one can send as you or change what you sent.
//   box:  X25519. Lets a group's owner hand you a new group key that only you can open.
// Pairing and key changes use one-off X25519 keys as well, so a circle's key never travels over the relay:
// both sides work it out themselves. Someone who only saw the invite code can't.

const crypto = require('crypto');
const { canonical } = require('./canonical');

const SPKI = {
  ed25519: Buffer.from('302a300506032b6570032100', 'hex'),
  x25519: Buffer.from('302a300506032b656e032100', 'hex')
};
const b64 = buf => Buffer.from(buf).toString('base64url');
const unb64 = s => Buffer.from(String(s), 'base64url');
// a raw 32-byte key, base64url
const isKey = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const isPriv = s => typeof s === 'string' && /^[A-Za-z0-9+/=]{40,120}$/.test(s);

function rawPublic(keyObj) { return b64(keyObj.export({ type: 'spki', format: 'der' }).subarray(-32)); }
function keyPair(type) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type);
  return { pub: rawPublic(publicKey), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}
const newIdentity = () => ({ sign: keyPair('ed25519'), box: keyPair('x25519') });
const ephemeral = () => keyPair('x25519');
const validIdentity = k => !!(k && k.sign && k.box && isKey(k.sign.pub) && isKey(k.box.pub) && isPriv(k.sign.priv) && isPriv(k.box.priv));

const pubKey = (type, s) => crypto.createPublicKey({ key: Buffer.concat([SPKI[type], unb64(s)]), format: 'der', type: 'spki' });
const privKey = s => crypto.createPrivateKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'pkcs8' });

// a signature covers the topic too, so a message can't be replayed into another circle
const signed = (topic, payload) => Buffer.from(canonical({ topic, p: payload }));
function sign(identity, topic, payload) {
  return b64(crypto.sign(null, signed(topic, payload), privKey(identity.sign.priv)));
}
function verify(pub, topic, payload, sig) {
  if (!isKey(pub) || typeof sig !== 'string' || sig.length > 200) return false;
  try { return crypto.verify(null, signed(topic, payload), pubKey('ed25519', pub), unb64(sig)); } catch (e) { return false; }
}

// X25519 shared secret. Refuses the all-zero result a malicious "public key" could force.
function dh(priv, pub) {
  if (!isKey(pub)) throw new Error('Not a key');
  const s = crypto.diffieHellman({ privateKey: privKey(priv), publicKey: pubKey('x25519', pub) });
  if (s.every(b => b === 0)) throw new Error('Not a usable key');
  return s;
}

const kdf = (ikm, salt, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));

// Five emoji that both people see only if no one is sitting in the middle of their connection.
const EMOJI = ['🦋', '🌸', '🍀', '🌙', '⭐', '🔥', '🌈', '🍎', '🍋', '🍇', '🍓', '🍉', '🍒', '🥥', '🥕', '🌽',
  '🍄', '🌵', '🌻', '🌷', '🐝', '🐞', '🐢', '🐙', '🐳', '🐬', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸',
  '🐧', '🦉', '🐘', '🦒', '🦓', '🦄', '🐌', '🦀', '🍩', '🍪', '🎂', '🍦', '☕', '🎈', '🎁', '🎵',
  '🎨', '📚', '⚽', '🏀', '🚲', '🚀', '⛵', '🏠', '🔑', '💎', '🧲', '🔔', '☂️', '❄️', '🌊', '🪁'];
function safetyCode(secretHex, extra = '') {
  const h = kdf(Buffer.from(secretHex, 'hex'), Buffer.from('titli'), 'titli-safety|' + extra, 8);
  let bits = 0n;
  for (const b of h) bits = (bits << 8n) | BigInt(b);
  const out = [];
  for (let i = 0; i < 5; i++) out.push(EMOJI[Number((bits >> BigInt(i * 6)) & 63n)]);
  return out.join(' ');
}

module.exports = { newIdentity, ephemeral, validIdentity, sign, verify, dh, kdf, isKey, safetyCode, EMOJI };
