'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codes = require('../src/core/codes');
const { seal, open } = require('../src/core/seal');
const { Store } = require('../src/core/store');
const { NtfyRelay } = require('../src/core/relay');
const { TitliCore } = require('../src/core/titli');
const presence = require('../src/core/presence');
const { createMockNtfy } = require('./mock-ntfy');

const until = async (fn, ms = 4000, label = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
};

function makeCore(server, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const store = new Store(path.join(dir, 'titli.json'));
  store.load();
  store.state.settings.relay = server;
  const relay = new NtfyRelay({ server, watchdogMs: 3000 });
  const core = new TitliCore({ store, relay });
  core.setName(name);
  core.start();
  return core;
}

test('codes: format, parse and derive', () => {
  const c = codes.randomCode('pair');
  assert.match(c.code, /^P[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.deepEqual(codes.parseCode(c.code.toLowerCase().replace(/-/g, ' ')).raw, c.raw);
  assert.equal(codes.parseCode('hello'), null);
  assert.equal(codes.parseCode('G' + 'U'.repeat(15)).kind, 'legacyGroup'); // U is read as V
  assert.equal(codes.parseCode('H' + 'U'.repeat(15)).kind, 'group');
  const g = codes.randomCode('group');
  assert.equal(codes.parseCode(g.code).kind, 'group');
  const t1 = codes.topicFor(codes.inviteSecret(c.raw)), t2 = codes.topicFor(codes.inviteSecret(c.raw));
  assert.equal(t1, t2);
  assert.match(t1, /^titli_[0-9a-z]{26}$/);
  assert.notEqual(codes.topicFor(codes.inviteSecret(c.raw)), codes.topicFor(codes.inviteSecret(g.raw)));
});

test('seal: round trip, wrong key and tampering', () => {
  const k1 = codes.keyFor(Buffer.from(codes.newSecret(), 'hex')), k2 = codes.keyFor(Buffer.from(codes.newSecret(), 'hex'));
  const box = seal(k1, { t: 'note', text: 'Thinking of you 💧' });
  assert.ok(box.startsWith('t1.'));
  assert.equal(open(k1, box).text, 'Thinking of you 💧');
  assert.equal(open(k2, box), null);
  const bad = box.slice(0, -4) + (box.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.equal(open(k1, bad), null);
  assert.equal(open(k1, 'hello'), null);
});

test('presence: meetings, sharing, away and settings', () => {
  assert.equal(presence.evaluate({}, {}).busy, false);
  assert.equal(presence.evaluate({ cameraInUse: true }, {}).reason, 'meeting');
  assert.equal(presence.evaluate({ screenShared: true, micInUse: true }, {}).reason, 'sharing');
  assert.equal(presence.evaluate({ micInUse: true }, { holdInMeetings: false }).busy, false);
  assert.equal(presence.evaluate({ idleSeconds: 300 }, {}).reason, 'away');
  assert.equal(presence.evaluate({ idleSeconds: 300 }, { holdWhenAway: false }).busy, false);
  assert.equal(presence.evaluate({ locked: true, idleSeconds: 999 }, {}).reason, 'locked');
});

test('pair, send, receipts, reactions and a butterfly back', async t => {
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); anu.stop(); await ntfy.close(); });

  const inv = rohit.createInvite();
  assert.ok(inv.ok && inv.code.startsWith('P'));
  assert.equal(rohit.joinCode(inv.code).ok, false); // own code
  await until(() => rohit.relayStatus === 'online', 4000, 'rohit online');
  const j = anu.joinCode(inv.code);
  assert.ok(j.ok && j.pending);
  await until(() => anu.s.circles.length === 1 && rohit.s.circles.length === 1, 5000, 'pairing');
  assert.equal(rohit.snapshot().circles[0].name, 'Anu');
  assert.equal(anu.snapshot().circles[0].name, 'Rohit');
  assert.equal(anu.s.joining.length, 0);
  assert.equal(rohit.s.circles[0].secret, anu.s.circles[0].secret);
  assert.equal(rohit.snapshot().invites.length, 0, 'invite is used up');

  // a third person reusing the code gets nowhere
  const thief = makeCore(url, 'Thief');
  t.after(() => thief.stop());
  thief.joinCode(inv.code);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(thief.s.circles.length, 0);
  assert.equal(rohit.s.circles.length, 1);

  // nothing readable crosses the relay
  const cid = rohit.s.circles[0].id;
  assert.ok(rohit.send({ circleId: cid, text: '  Miss   you already  ' }).ok);
  await until(() => anu.s.inbox.length === 1, 4000, 'note arrives');
  assert.equal(anu.s.inbox[0].text, 'Miss you already');
  assert.equal(anu.s.inbox[0].fromName, 'Rohit');
  assert.ok(ntfy.cache.every(m => !m.message.includes('Miss')), 'relay only sees ciphertext');
  await until(() => rohit.snapshot().sent[0].status.text.startsWith('Arrived'), 4000, 'arrived receipt');

  const note = anu.nextDelivery();
  anu.shown(note.id);
  assert.equal(anu.s.inbox.length, 0);
  await until(() => rohit.snapshot().sent[0].status.text === 'Seen', 4000, 'seen receipt');

  const reactions = [];
  rohit.on('reaction', r => reactions.push(r));
  assert.ok(anu.react(note.id, '🥰').ok);
  assert.equal(anu.react(note.id, '😘').ok, false, 'one reaction per note');
  await until(() => reactions.length === 1, 4000, 'reaction');
  assert.equal(reactions[0].r, '🥰');
  assert.equal(rohit.snapshot().sent[0].status.extra, '🥰');

  // a heart, answered with a butterfly back, which then visits Rohit's laptop
  rohit.send({ circleId: cid, text: null });
  await until(() => anu.s.inbox.length === 1, 4000, 'heart arrives');
  assert.equal(anu.s.inbox[0].text, null);
  anu.shown(anu.s.inbox[0].id);
  anu.react(anu.s.received[0].id, 'butterfly');
  await until(() => rohit.s.inbox.some(x => x.kind === 'visit'), 4000, 'butterfly back');
  assert.equal(rohit.s.inbox[0].fromName, 'Anu');
  rohit.shown(rohit.s.inbox[0].id);
  const back = rohit.snapshot().received[0];
  assert.equal(back.kind, 'visit', 'a butterfly back shows in Activity');
  assert.equal(back.circleId, cid);
  assert.equal(rohit.snapshot().sent[0].circleId, cid);
});

test('groups: create, join by code, names and fan-out', async t => {
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), appa = makeCore(url, 'Appa');
  t.after(async () => { rohit.stop(); amma.stop(); appa.stop(); await ntfy.close(); });

  const g = rohit.createGroup('Family');
  assert.ok(g.ok && g.code.startsWith('H'));
  assert.equal(rohit.send({ circleId: g.circleId }).ok, false, 'empty group');
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  const j = amma.joinCode(g.code);
  assert.ok(j.ok && j.pending);
  appa.joinCode(g.code.toLowerCase());
  await until(() => amma.s.circles.length === 1 && appa.s.circles.length === 1, 5000, 'both joined');
  assert.equal(amma.joinCode(g.code).ok, false, 'already in it');
  await until(() => rohit.snapshot().circles[0].members.length === 2, 5000, 'members known');
  assert.equal(amma.snapshot().circles[0].name, 'Family');
  await until(() => amma.snapshot().circles[0].members.length === 2 && appa.snapshot().circles[0].members.length === 2, 5000, 'everyone knows everyone');
  assert.ok(rohit.snapshot().circles[0].secure && amma.snapshot().circles[0].secure);

  rohit.send({ circleId: g.circleId, text: 'Lunch time? 🍱' });
  await until(() => amma.s.inbox.length === 1 && appa.s.inbox.length === 1, 4000, 'fan-out');
  assert.equal(amma.s.inbox[0].circleName, 'Family');
  amma.shown(amma.s.inbox[0].id);
  await until(() => /Seen by 1 of 2/.test(rohit.snapshot().sent[0].status.text), 4000, 'group status');

  appa.leave(appa.s.circles[0].id);
  await until(() => rohit.snapshot().circles[0].members.length === 1, 4000, 'leave');
});

test('offline: a note sent while the other laptop sleeps lands when it wakes', async t => {
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); anu.stop(); await ntfy.close(); });
  const inv = rohit.createInvite();
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  anu.joinCode(inv.code);
  await until(() => anu.s.circles.length === 1 && rohit.s.circles.length === 1, 5000, 'pairing');
  await new Promise(r => setTimeout(r, 450)); // let a keepalive mark Anu as caught up

  anu.relay.stop();                                   // Anu's laptop goes to sleep
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'Come home soon' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(anu.s.inbox.length, 0);
  anu.relay.start();                                  // and wakes up
  await until(() => anu.s.inbox.length === 1, 5000, 'delivered after wake');
  assert.equal(anu.s.inbox[0].text, 'Come home soon');
});

test('quick notes: reorder keeps the same notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const store = new Store(path.join(dir, 'q.json')); store.load();
  const core = new TitliCore({ store, relay: new NtfyRelay({ server: 'http://127.0.0.1:9' }) });
  const before = core.s.quick.slice();
  const flipped = before.slice().reverse();
  assert.ok(core.reorderQuick(flipped).ok);
  assert.deepEqual(core.s.quick, flipped);
  assert.equal(core.reorderQuick(flipped.slice(1)).ok, false, 'missing one');
  assert.equal(core.reorderQuick([...flipped.slice(1), 'Sneaky new note']).ok, false, 'swapped one');
  assert.equal(core.reorderQuick('nope').ok, false);
  assert.deepEqual(core.s.quick, flipped);
});

test('store survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const f = path.join(dir, 'titli.json');
  fs.writeFileSync(f, '{not json');
  const st = new Store(f); const s = st.load();
  assert.ok(s.me.id && Array.isArray(s.quick) && s.quick.length > 0);
});

test('store: encrypted when the system offers a key, plain file migrates, a lost key starts fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const f = path.join(dir, 'titli.json');
  const crypto = require('crypto');
  const key = crypto.randomBytes(32);
  const crypt = {
    name: 'test',
    encrypt: s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, ct, c.getAuthTag()]); },
    decrypt: b => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'); }
  };
  // an older, plain file
  const plain = new Store(f); plain.load(); plain.state.me.name = 'Rohit'; plain.state.quick.push('Secret note'); plain.saveNow();
  const st = new Store(f, { crypt }); st.load();
  assert.equal(st.state.me.name, 'Rohit');
  st.saveNow();
  const onDisk = fs.readFileSync(f, 'utf8');
  assert.ok(!onDisk.includes('Rohit') && !onDisk.includes('Secret note'), 'nothing readable on disk');
  const again = new Store(f, { crypt }); again.load();
  assert.equal(again.state.me.name, 'Rohit');
  // without the key: start fresh, keep the old file aside
  const lost = new Store(f, { crypt: { name: 'x', encrypt: crypt.encrypt, decrypt: () => { throw new Error('denied'); } } });
  lost.load();
  assert.equal(lost.unlockFailed, true);
  assert.equal(lost.state.me.name, '');
  assert.ok(fs.readdirSync(dir).some(n => n.startsWith('titli.locked-')));
});


test('quick notes: some just for one person, shown first for them only', async t => {
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); amma.stop(); anu.stop(); await ntfy.close(); });
  const inv1 = rohit.createInvite();
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  amma.joinCode(inv1.code);
  await until(() => rohit.s.circles.length === 1, 5000, 'paired with amma');
  const inv2 = rohit.createInvite();
  anu.joinCode(inv2.code);
  await until(() => rohit.s.circles.length === 2, 5000, 'paired with anu');
  const toAmma = rohit.s.circles.find(c => c.members[amma.me.id]).id, toAnu = rohit.s.circles.find(c => c.members[anu.me.id]).id;

  assert.ok(rohit.addQuick('Saaptiya?!', toAmma).ok);
  assert.ok(rohit.addQuick('Did you sleep well?', toAmma).ok);
  assert.equal(rohit.addQuick('Saaptiya?!', toAmma).ok, false, 'no duplicates');
  assert.equal(rohit.addQuick('Reached home?', toAmma).ok, false, 'already in everyone’s notes');
  assert.ok(rohit.addQuick('Movie tonight?', toAnu).ok);
  const snap = rohit.snapshot();
  assert.deepEqual(snap.quickFor[toAmma], ['Saaptiya?!', 'Did you sleep well?']);
  assert.deepEqual(snap.quickFor[toAnu], ['Movie tonight?']);
  assert.ok(snap.quick.includes('Thinking of you') && !snap.quick.includes('Movie tonight?'), 'everyone’s list unchanged');
  assert.ok(rohit.reorderQuick(['Did you sleep well?', 'Saaptiya?!'], toAmma).ok);
  assert.equal(rohit.snapshot().quickFor[toAmma][0], 'Did you sleep well?');
  rohit.removeQuick('Movie tonight?', toAnu);
  assert.equal(rohit.snapshot().quickFor[toAnu], undefined);
  for (let i = 0; i < 6; i++) rohit.addQuick(`Extra ${i}`, toAmma);
  assert.equal(rohit.addQuick('One too many', toAmma).ok, false, 'up to 8 each');
  // unpairing drops their notes
  rohit.leave(toAmma);
  rohit._prune();
  assert.equal(rohit.s.quickFor[toAmma], undefined);
});

test('one tap sends any emoji you pick for that person, and older versions still get something sensible', async t => {
  const { TitliCore: V1 } = require('./fixtures/v1/titli');      // 0.1.32: no gestures at all
  const { TitliCore: V53 } = require('./fixtures/v053/titli');   // 0.1.51 to 0.1.53: heart, hug, wave and cheer by name
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma');
  const oldCore = (V, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-')), st = new Store(path.join(dir, 'o.json')); st.load();
    st.state.settings.relay = url;
    const c = new V({ store: st, relay: new NtfyRelay({ server: url, watchdogMs: 3000 }) }); c.setName(name); c.start(); return c;
  };
  const old = oldCore(V1, 'Oldie'), mid = oldCore(V53, 'Midi');
  t.after(async () => { rohit.stop(); amma.stop(); old.stop(); mid.stop(); await ntfy.close(); });
  const inv = rohit.createInvite();
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  amma.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 1 && amma.s.circles.length === 1, 5000, 'paired');
  const c = rohit.s.circles[0];
  assert.equal(c.tap, '👋', 'new people start with a wave');
  assert.equal(rohit.snapshot().circles[0].tap, '👋');
  // any one emoji, or one of the old names
  assert.ok(rohit.setTap(c.id, 'hug').ok); assert.equal(c.tap, '🤗');
  for (const bad of ['kiss', 'hello', '😘😘', 'a😘', '', null, 42, 'constructor', '‮😘', '😘́', '😘'.repeat(20)]) assert.equal(rohit.setTap(c.id, bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  for (const ok of ['😘', '👋🏽', '🇮🇳', '👨‍👩‍👧', ' 🌸 ']) assert.ok(rohit.setTap(c.id, ok).ok, `takes ${ok}`);
  assert.equal(c.tap, '🌸');
  assert.ok(rohit.setTap(c.id, '😘').ok);
  rohit.send({ circleId: c.id, text: null });
  await until(() => amma.s.inbox.length === 1, 4000, 'kiss arrives');
  assert.equal(amma.s.inbox[0].g, '😘');
  assert.equal(rohit.snapshot().sent[0].g, '😘');
  amma.shown(amma.s.inbox[0].id);
  assert.equal(amma.snapshot().received[0].g, '😘');
  const reacted = new Promise(r => rohit.once('reaction', r));
  assert.equal(amma.react(amma.s.received[0].id, '😂').ok, true, 'the new reactions');
  assert.equal((await reacted).g, '😘', 'the reaction knows what it was for');
  // someone sending something odd as the emoji gets a heart, never their text
  rohit._postCircle(c, { t: 'note', id: 'oddone01', text: null, g: 'heart', e: 'hi there', style: 'rose', at: rohit.now() });
  await until(() => amma.s.inbox.length === 1, 4000, 'odd one arrives');
  assert.equal(amma.s.inbox[0].g, '❤️');

  // a 0.1.53 friend: hearts, hugs, waves and cheers come through as themselves, anything else as a heart
  const inv3 = rohit.createInvite();
  mid.joinCode(inv3.code);
  await until(() => rohit.s.circles.length === 2 && mid.s.circles.length === 1, 5000, 'paired with 0.1.53');
  const toMid = rohit.s.circles[1].id;
  rohit.setTap(toMid, '🙌🏾'); rohit.send({ circleId: toMid, text: null });
  await until(() => mid.s.inbox.length === 1, 4000, 'cheer reaches 0.1.53');
  assert.equal(mid.s.inbox[0].g, 'cheer');
  rohit.setTap(toMid, '😘'); rohit.send({ circleId: toMid, text: null });
  await until(() => mid.s.inbox.length === 2, 4000, 'kiss reaches 0.1.53');
  assert.equal(mid.s.inbox[1].g, 'heart');
  mid.setTap(mid.s.circles[0].id, 'hug'); mid.send({ circleId: mid.s.circles[0].id, text: null });
  await until(() => rohit.s.inbox.length === 1, 4000, 'hug from 0.1.53');
  assert.equal(rohit.s.inbox[0].g, '🤗');

  // a 0.1.32 friend: what they send is a heart, and what we send them still lands (as a heart)
  const inv2 = rohit.createInvite();
  old.joinCode(inv2.code);
  await until(() => rohit.s.circles.length === 3 && old.s.circles.length === 1, 5000, 'paired with old');
  old.send({ circleId: old.s.circles[0].id, text: null });
  await until(() => rohit.s.inbox.length === 2, 4000, 'old heart arrives');
  assert.equal(rohit.s.inbox[1].g, '❤️');
  rohit.send({ circleId: rohit.s.circles[2].id, text: null });
  await until(() => old.s.inbox.length === 1, 4000, 'our wave reaches 0.1.32');
  assert.equal(old.s.inbox[0].text, null);
});

test('people paired before gestures keep their hearts, and untouched old default notes are refreshed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const f = path.join(dir, 'titli.json');
  const st = new Store(f); st.load();
  st.state.circles.push({ id: 'abcdefgh', kind: 'pair', v: 2, name: 'Suresh', secret: 'ab'.repeat(32), topic: 'titli_x', members: {}, createdAt: 1 });
  // saved by 0.1.51 to 0.1.53, with the gesture names
  st.state.circles.push({ id: 'bcdefghi', kind: 'pair', v: 2, name: 'Anu', secret: 'cd'.repeat(32), topic: 'titli_y', members: {}, tap: 'wave', createdAt: 1 });
  st.state.inbox.push({ kind: 'note', id: 'waiting1', circleId: 'bcdefghi', from: 'someone1', fromName: 'Anu', text: null, g: 'hug', style: 'rose', at: 1 });
  st.state.sent.push({ id: 'sentone1', circleId: 'bcdefghi', text: null, g: 'cheer', style: 'rose', at: 1, rc: {} });
  st.state.quick = ['Thinking of you', 'Saaptiya?', 'Drink some water 💧', 'Miss you already', 'Proud of you', 'Come home soon'];
  st.saveNow();
  const again = new Store(f); again.load();
  assert.ok(!again.state.quick.includes('Miss you already') && again.state.quick.includes('Reached home?'));
  const core = new TitliCore({ store: again, relay: new NtfyRelay({ server: 'http://127.0.0.1:9' }) });
  assert.equal(core.s.circles[0].tap, '❤️');
  assert.equal(core.s.circles[1].tap, '👋', 'the old names become their emoji');
  assert.equal(core.nextDelivery().g, '🤗');
  assert.equal(core.snapshot().sent[0].g, '🙌');
  // someone who edited their notes keeps them exactly
  const own = new Store(path.join(dir, 'own.json')); own.load(); own.state.quick = ['Miss you already', 'Lunch?']; own.saveNow();
  const ownAgain = new Store(path.join(dir, 'own.json')); ownAgain.load();
  assert.deepEqual(ownAgain.state.quick, ['Miss you already', 'Lunch?']);
});

test('store: with the key at hand, an encrypted file is read once and kept as a plain file after that', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const f = path.join(dir, 'titli.json');
  let calls = 0;
  const crypt = { name: 'test', encrypt: s => Buffer.from(s, 'utf8').reverse(), decrypt: b => { calls++; return Buffer.from(b).reverse().toString('utf8'); } };
  const enc = new Store(f, { crypt, encrypt: true }); enc.load(); enc.state.me.name = 'Rohit'; enc.saveNow();
  assert.match(fs.readFileSync(f, 'utf8'), /titliEncrypted/);
  const mac = new Store(f, { crypt, encrypt: false }); mac.load();
  assert.equal(mac.state.me.name, 'Rohit');
  assert.equal(calls, 1);
  assert.ok(!/titliEncrypted/.test(fs.readFileSync(f, 'utf8')), 'saved back as a plain file at once');
  const next = new Store(f, { crypt, encrypt: false }); next.load();
  assert.equal(next.state.me.name, 'Rohit');
  assert.equal(calls, 1, 'the key is not needed again');
});

test('a Mac never asks the Keychain: safeStorage is never touched, and an old encrypted file is set aside', () => {
  const { dataLock } = require('../src/main/data-lock');
  const touched = [];
  const spy = new Proxy({}, { get: (_t, k) => { touched.push(k); return () => { throw new Error('the Keychain was asked'); }; } });
  for (const platform of ['darwin', 'linux']) {
    const lock = dataLock({ platform, packaged: true, smoke: false, safeStorage: spy });
    assert.deepEqual(lock, { crypt: null, encrypt: false }, platform);
  }
  assert.deepEqual(touched, [], 'safeStorage is not even looked at');
  // a file 0.1.45 to 0.1.52 encrypted on a Mac
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const f = path.join(dir, 'titli.json');
  fs.writeFileSync(f, JSON.stringify({ titliEncrypted: 1, by: 'safeStorage', data: Buffer.from('v10secret').toString('base64') }));
  const mac = new Store(f, dataLock({ platform: 'darwin', packaged: true, smoke: false, safeStorage: spy })); mac.load();
  assert.equal(mac.unlockFailed, true);
  assert.equal(mac.state.me.name, '', 'starts fresh');
  assert.ok(!/titliEncrypted/.test(fs.readFileSync(f, 'utf8')), 'and saves a plain file');
  assert.ok(fs.readdirSync(dir).some(n => /^titli\.locked-\d+\.json$/.test(n)), 'the old file is kept aside, not deleted');
  assert.deepEqual(touched, []);
  // Windows still encrypts, with its own account key (no prompt there)
  let asked = 0;
  const win = dataLock({ platform: 'win32', packaged: true, smoke: false, safeStorage: { isEncryptionAvailable: () => { asked++; return true; }, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } });
  assert.equal(win.encrypt, true); assert.equal(asked, 1);
});

test('a 0.1.32 friend who made the code: their notes and hearts still reach us, before and after we restart', async t => {
  const { TitliCore: V1 } = require('./fixtures/v1/titli');
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const oldStore = new Store(path.join(dir, 'o.json')); oldStore.load(); oldStore.state.settings.relay = url;
  const old = new V1({ store: oldStore, relay: new NtfyRelay({ server: url, watchdogMs: 3000 }) }); old.setName('Priya'); old.start();
  let rohit = makeCore(url, 'Rohit');
  t.after(async () => { rohit.stop(); old.stop(); await ntfy.close(); });
  const inv = old.createInvite();
  await new Promise(r => setTimeout(r, 300));
  rohit.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 1 && old.s.circles.length === 1, 6000, 'paired');
  assert.equal(rohit.s.circles[0].v, 1, 'stays on the old protocol while they are on 0.1.32');
  old.send({ circleId: old.s.circles[0].id, text: 'hi from windows' });
  await until(() => rohit.s.inbox.length === 1, 4000, 'note arrives');
  assert.equal(rohit.s.inbox[0].text, 'hi from windows');
  await until(() => old.snapshot().sent[0].status.text.startsWith('Arrived'), 4000, 'they see it arrived');
  // we quit (or update) and start again from the same saved file
  rohit.stop();
  const again = new Store(rohit.store.file); again.load();
  rohit = new TitliCore({ store: again, relay: new NtfyRelay({ server: url, watchdogMs: 3000 }) }); rohit.start();
  await until(() => rohit.relayStatus === 'online', 4000, 'online again');
  old.send({ circleId: old.s.circles[0].id, text: null });
  await until(() => rohit.s.inbox.length === 2, 4000, 'heart arrives after a restart');
  assert.equal(rohit.s.inbox[1].g, '❤️');
});
