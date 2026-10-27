'use strict';
// Invite codes, secrets and the relay topics derived from them.
//
// A code looks like P7QM-2XPA-9DRT-4HWN. The first letter says what it is (P = pair, G = group),
// the other 15 characters are random Crockford base32 (75 bits), so codes can't be guessed.
// Topics and keys are derived from secrets with HKDF, so the relay only ever sees an opaque topic
// name and ciphertext.

const crypto = require('crypto');

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

function toBase32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}

function format(raw) { return raw.match(/.{1,4}/g).join('-'); }

function normalize(input) {
  return String(input || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

function randomCode(kind) {
  const prefix = kind === 'group' ? 'G' : 'P';
  const bytes = crypto.randomBytes(15);
  let s = prefix;
  for (let i = 0; i < 15; i++) s += ALPHA[bytes[i] & 31];
  return { raw: s, code: format(s), kind: kind === 'group' ? 'group' : 'pair' };
}

function parseCode(input) {
  const raw = normalize(input);
  if (raw.length !== 16 || !/^[PG]/.test(raw)) return null;
  for (const ch of raw.slice(1)) if (!ALPHA.includes(ch)) return null;
  return { raw, code: format(raw), kind: raw[0] === 'G' ? 'group' : 'pair' };
}

function derive(secret, label) {
  const ikm = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('titli-v1'), Buffer.from(label), 32));
}

// ntfy topics: letters, digits, _ and -, at most 64 characters
const topicFor = secret => 'titli_' + toBase32(derive(secret, 'topic')).slice(0, 26).toLowerCase();
const keyFor = secret => derive(secret, 'key');

const newSecret = () => crypto.randomBytes(32).toString('hex');
const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// a pair invite gets its own short-lived channel; a group code is the group's secret itself
const inviteSecret = raw => derive(raw, 'invite');
const groupSecret = raw => derive(raw, 'group').toString('hex');

module.exports = { ALPHA, toBase32, format, normalize, randomCode, parseCode, derive, topicFor, keyFor, newSecret, newId, inviteSecret, groupSecret };
