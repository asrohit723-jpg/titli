'use strict';
// Each test here is one way someone could try to get in, and checks that it fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codes = require('../src/core/codes');
const { seal, open } = require('../src/core/seal');
const identity = require('../src/core/identity');
const { Store } = require('../src/core/store');
const { NtfyRelay } = require('../src/core/relay');
const { TitliCore } = require('../src/core/titli');
const { TitliCore: V1 } = require('./fixtures/v1/titli');   // Titli 0.1.32, before any of this
const { createMockNtfy } = require('./mock-ntfy');

const until = async (fn, ms = 5000, label = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-sec-'));
  const store = new Store(path.join(dir, 'titli.json'));
  store.load();
  return store;
}
function makeCore(server, name, { Core = TitliCore, store = makeStore() } = {}) {
  store.state.settings.relay = server;
  const relay = new NtfyRelay({ server, watchdogMs: 3000 });
  const core = new Core({ store, relay });
  core.setName(name);
  core.start();
  return core;
}
async function pair(a, b) {
  const inv = a.createInvite();
  await until(() => a.relayStatus === 'online', 4000, 'online');
  b.joinCode(inv.code);
  await until(() => a.s.circles.length && b.s.circles.length, 5000, 'paired');
  return inv.code;
}
async function group(owner, ...joiners) {
  const g = owner.createGroup('Family');
  await until(() => owner.relayStatus === 'online', 4000, 'online');
  for (const j of joiners) j.joinCode(g.code);
  await until(() => joiners.every(j => j.s.circles.length) && owner.snapshot().circles[0].members.length === joiners.length, 6000, 'group formed');
  await until(() => joiners.every(j => j.snapshot().circles[0].members.length === joiners.length), 6000, 'everyone knows everyone');
  return g;
}
// what an outsider can do with a code: open anything the code's channels carry
function readWithCode(ntfy, code) {
  const raw = codes.parseCode(code).raw, keys = [codes.keyFor(codes.inviteSecret(raw)), codes.keyFor(Buffer.from(codes.groupSecret(raw), 'hex'))];
  return ntfy.cache.flatMap(m => keys.map(k => open(k, m.message)).filter(Boolean));
}
// post a hand-made message into a circle, signed (or not) by whoever we say
async function inject(url, c, payload, signer) {
  const p = { v: 2, ts: Date.now(), ...payload };
  if (signer) p.sig = identity.sign(signer, c.topic, p);
  await new NtfyRelay({ server: url }).publish(c.topic, seal(codes.keyFor(Buffer.from(c.secret, 'hex')), p));
}

test('a seen invite code can’t be used to read or join a pair', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); anu.stop(); await ntfy.close(); });
  const code = await pair(rohit, anu);
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'Secret plans 🎁' });
  await until(() => anu.s.inbox.length === 1, 4000, 'note');

  // an eavesdropper who saw the code reads the invite channel: nothing in it gives away the pair's key
  const seen = readWithCode(ntfy, code);
  assert.ok(seen.some(m => m.t === 'join') && seen.some(m => m.t === 'welcome'), 'they can read the handshake');
  assert.ok(seen.every(m => !JSON.stringify(m).includes(rohit.s.circles[0].secret)), 'but the key is never in it');
  assert.ok(seen.every(m => !(m.circle && m.circle.secret)), 'no secret field');
  assert.ok(seen.every(m => m.t !== 'note'), 'and they can’t open the note');
  const tries = [codes.inviteSecret(codes.parseCode(code).raw)].map(s => codes.topicFor(s));
  assert.ok(!tries.includes(rohit.s.circles[0].topic), 'the pair’s channel isn’t derivable from the code');

  // and joining afterwards gets nowhere
  const thief = makeCore(url, 'Thief');
  t.after(() => thief.stop());
  thief.joinCode(code);
  await sleep(500);
  assert.equal(thief.s.circles.length, 0);
  assert.equal(rohit.s.circles[0].members[thief.me.id], undefined);
  // both sides see the same safety code
  assert.equal(rohit.snapshot().circles[0].safety, anu.snapshot().circles[0].safety);
  assert.ok(rohit.snapshot().circles[0].secure);
});

test('nobody can send as someone else, even from inside a group', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), mallory = makeCore(url, 'Mallory');
  t.after(async () => { rohit.stop(); amma.stop(); mallory.stop(); await ntfy.close(); });
  await group(rohit, amma, mallory);
  const c = mallory.s.circles[0];

  // 1. a note claiming to be from Amma, signed with Mallory's key
  await inject(url, c, { t: 'note', id: 'forged1aaaa', from: amma.me.id, name: 'Amma', text: 'Send me your password' }, mallory.me.keys);
  // 2. the same, unsigned, as Titli 0.1.32 would send it
  await inject(url, c, { t: 'note', id: 'forged2aaaa', from: amma.me.id, name: 'Amma', text: 'Send me your password' }, null);
  // 3. a fake "Seen" from Amma for Rohit's note, and a fake goodbye that would remove her
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'Hi all' });
  await until(() => mallory.s.inbox.length === 1 && amma.s.inbox.length === 1, 4000, 'note');
  await inject(url, c, { t: 'seen', id: rohit.s.sent[0].id, from: amma.me.id }, mallory.me.keys);
  await inject(url, c, { t: 'bye', from: amma.me.id }, mallory.me.keys);
  // 4. renaming Amma
  await inject(url, c, { t: 'hi', from: amma.me.id, name: 'Mallory is nice', pub: mallory.me.keys.sign.pub, xpub: mallory.me.keys.box.pub }, mallory.me.keys);
  await sleep(600);

  assert.ok(rohit.s.inbox.every(n => !/password/.test(n.text || '')), 'no forged note landed');
  const st = rohit.s.sent[0].rc[amma.me.id];
  assert.notEqual(st.st, 'seen', 'no forged receipt');
  assert.ok(rohit.s.circles[0].members[amma.me.id], 'Amma is still in the group');
  assert.equal(rohit.s.circles[0].members[amma.me.id].name, 'Amma', 'and still called Amma');
});

test('leaving or being removed from a group locks you out of what comes next', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), appa = makeCore(url, 'Appa'), ex = makeCore(url, 'Ex');
  t.after(async () => { for (const x of [rohit, amma, appa, ex]) x.stop(); await ntfy.close(); });
  await group(rohit, amma, appa, ex);
  const before = { ...ex.s.circles[0] };
  const removed = [];
  ex.on('removed', r => removed.push(r));

  // the owner removes Ex
  assert.equal(amma.removeMember(amma.s.circles[0].id, ex.me.id).ok, false, 'only the owner can remove');
  assert.ok(rohit.removeMember(rohit.s.circles[0].id, ex.me.id).ok);
  await until(() => removed.length === 1, 5000, 'ex told');
  assert.equal(ex.s.circles.length, 0);
  await until(() => amma.s.circles[0].epoch === 1 && appa.s.circles[0].epoch === 1, 5000, 'new key for the rest');
  assert.notEqual(amma.s.circles[0].topic, before.topic);

  rohit.send({ circleId: rohit.s.circles[0].id, text: 'After Ex left' });
  await until(() => amma.s.inbox.length === 1 && appa.s.inbox.length === 1, 4000, 'still works for everyone else');
  // Ex kept a copy of the old key: it opens nothing sent after the change
  const oldKey = codes.keyFor(Buffer.from(before.secret, 'hex'));
  const opened = ntfy.cache.filter(m => m.topic !== before.topic).map(m => open(oldKey, m.message)).filter(Boolean);
  assert.equal(opened.length, 0);

  // Ex tries to talk their way back in with the old key, and with a code made before they were removed
  await inject(url, before, { t: 'hello', from: ex.me.id, name: 'Ex', pub: ex.me.keys.sign.pub, xpub: ex.me.keys.box.pub }, ex.me.keys);
  await sleep(500);
  assert.equal(rohit.s.circles[0].members[ex.me.id], undefined, 'no way back in on the old key');
  assert.equal(amma.s.circles[0].members[ex.me.id], undefined);
  assert.equal(rohit.snapshot().circles[0].code, undefined, 'codes from before the change are cancelled');

  // Appa leaves on his own: the owner changes the key again
  appa.leave(appa.s.circles[0].id);
  await until(() => amma.s.circles[0].epoch === 2, 5000, 'key changed after leave');
  const who = Object.entries(amma.s.circles[0].members).map(([id, m]) => `${m.name}${id === appa.me.id ? '(appa)' : id === ex.me.id ? '(ex)' : ''}`);
  assert.equal(Object.keys(amma.s.circles[0].members).length, 2, who.join(', '));
});

test('the owner leaving hands the group on', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), appa = makeCore(url, 'Appa');
  t.after(async () => { for (const x of [rohit, amma, appa]) x.stop(); await ntfy.close(); });
  await group(rohit, amma, appa);
  rohit.leave(rohit.s.circles[0].id);
  await until(() => amma.s.circles[0].epoch === 1 && appa.s.circles[0].epoch === 1, 5000, 'handed over');
  const next = [amma.me.id, appa.me.id].sort()[0];
  assert.equal(amma.s.circles[0].owner, next);
  assert.equal(Object.keys(amma.s.circles[0].members).length, 2);
  const newOwner = next === amma.me.id ? amma : appa, other = next === amma.me.id ? appa : amma;
  assert.ok(newOwner.snapshot().circles[0].owner);
  newOwner.send({ circleId: newOwner.s.circles[0].id, text: 'Still here' });
  await until(() => other.s.inbox.length === 1, 4000, 'works after hand-over');
});

test('group codes stop working after 24 hours and can’t be used by a 0.1.32 app', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), late = makeCore(url, 'Late');
  const old = makeCore(url, 'Old', { Core: V1 });
  t.after(async () => { for (const x of [rohit, late, old]) x.stop(); await ntfy.close(); });
  const g = rohit.createGroup('Family');
  rohit.s.invites[0].createdAt -= 25 * 3600 * 1000;   // a day goes by
  rohit._prune();
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  late.joinCode(g.code);
  await sleep(700);
  assert.equal(late.s.circles.length, 0, 'an expired code gets no answer');
  assert.equal(old.joinCode(g.code).ok, false, '0.1.32 says it isn’t a Titli code instead of joining nothing');
  // and a fresh one works
  const fresh = rohit.createGroupInvite(rohit.s.circles[0].id);
  assert.notEqual(fresh.code, g.code);
  late.joinCode(fresh.code);
  await until(() => late.s.circles.length === 1, 5000, 'fresh code works');
});

test('old messages played back again are ignored', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); anu.stop(); await ntfy.close(); });
  await pair(rohit, anu);
  const c = rohit.s.circles[0];
  rohit.send({ circleId: c.id, text: 'Once' });
  await until(() => anu.s.inbox.length === 1, 4000, 'note');
  anu.shown(anu.s.inbox[0].id);
  // the relay (or anyone who knows the channel) sends the very same message again
  const original = ntfy.cache.find(m => m.topic === c.topic && open(codes.keyFor(Buffer.from(c.secret, 'hex')), m.message).t === 'note');
  await new NtfyRelay({ server: url }).publish(c.topic, original.message);
  // and a validly signed note dated 20 hours ago
  await inject(url, anu.s.circles[0], { t: 'note', id: 'stalenoteaa', from: rohit.me.id, name: 'Rohit', text: 'Stale', ts: Date.now() - 20 * 3600 * 1000 }, rohit.me.keys);
  await sleep(600);
  assert.equal(anu.s.inbox.length, 0);
  assert.equal(anu.s.received.length, 1);
});

test('names can’t hide characters, and look-alikes in a group get told apart', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), a = makeCore(url, 'Amma'), b = makeCore(url, 'Mallory');
  t.after(async () => { for (const x of [rohit, a, b]) x.stop(); await ntfy.close(); });
  assert.equal(b.setName('Am‮ma​').ok, true);
  assert.equal(b.me.name, 'Amma', 'right-to-left and invisible characters are stripped');
  await group(rohit, a, b);
  const names = rohit.snapshot().circles[0].members;
  assert.equal(new Set(names).size, 2, `two Ammas are labelled differently: ${names.join(', ')}`);
});

test('relays must use https (except one on this computer)', () => {
  const store = makeStore();
  const core = new TitliCore({ store, relay: new NtfyRelay({ server: 'https://ntfy.sh' }) });
  assert.equal(core.setSettings({ relay: 'http://example.com' }).ok, false);
  assert.equal(core.setSettings({ relay: 'https://ntfy.example.com' }).ok, true);
  assert.equal(core.setSettings({ relay: 'http://127.0.0.1:8080' }).ok, true);
  store.state.settings.relay = 'http://evil.example';
  const again = new TitliCore({ store, relay: new NtfyRelay({ server: 'https://ntfy.sh' }) });
  assert.equal(again.s.settings.relay, 'https://ntfy.sh', 'an unsafe saved relay is reset');
});

test('receipts can be switched off', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), anu = makeCore(url, 'Anu');
  t.after(async () => { rohit.stop(); anu.stop(); await ntfy.close(); });
  await pair(rohit, anu);
  anu.setSettings({ sendReceipts: false });
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'Hi' });
  await until(() => anu.s.inbox.length === 1, 4000, 'note');
  anu.shown(anu.s.inbox[0].id);
  await sleep(500);
  assert.equal(rohit.snapshot().sent[0].status.text, 'On its way');
});

test('0.1.32 and this version pair both ways, then upgrade on their own', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const oldStore = makeStore();
  const rohit = makeCore(url, 'Rohit'), friend = makeCore(url, 'Friend', { Core: V1, store: oldStore });
  const oldie = makeCore(url, 'Oldie', { Core: V1 });
  const cores = [rohit, friend, oldie];
  t.after(async () => { for (const x of cores) x.stop(); await ntfy.close(); });

  // new makes the code, old joins
  await pair(rohit, friend);
  // old makes the code, new joins
  const inv = oldie.createInvite();
  await until(() => oldie.relayStatus === 'online', 4000, 'online');
  rohit.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 2 && oldie.s.circles.length === 1, 5000, 'paired with oldie');
  const toFriend = rohit.s.circles.find(c => c.members[friend.me.id]);
  const toOldie = rohit.s.circles.find(c => c.members[oldie.me.id]);
  assert.equal(toFriend.v, 1); assert.equal(toOldie.v, 1);
  assert.equal(rohit.snapshot().circles.find(c => c.id === toFriend.id).secure, false, 'shown as not fully protected yet');

  // notes go both ways while they're on different versions
  rohit.send({ circleId: toFriend.id, text: 'From new' });
  friend.send({ circleId: friend.s.circles[0].id, text: 'From old' });
  await until(() => friend.s.inbox.length === 1 && rohit.s.inbox.length === 1, 4000, 'mixed notes');
  friend.shown(friend.s.inbox[0].id);
  await until(() => rohit.snapshot().sent[0].status.text === 'Seen', 4000, 'receipt from old');

  // the friend updates: same saved data, new Titli
  const oldTopic = toFriend.topic, oldSecret = toFriend.secret;
  friend.stop();
  const updated = makeCore(url, 'Friend', { store: oldStore });
  cores.push(updated);
  await until(() => toFriend.v === 2 && updated.s.circles[0].v === 2, 6000, 'upgraded');
  assert.notEqual(toFriend.topic, oldTopic);
  assert.equal(toFriend.secret, updated.s.circles[0].secret);
  assert.ok(rohit.snapshot().circles.find(c => c.id === toFriend.id).secure);

  rohit.send({ circleId: toFriend.id, text: 'After the upgrade' });
  await until(() => updated.s.inbox.some(n => n.text === 'After the upgrade'), 4000, 'works after upgrade');
  // someone holding the old key (from a code seen back then) reads none of it
  const oldKey = codes.keyFor(Buffer.from(oldSecret, 'hex'));
  assert.equal(ntfy.cache.filter(m => m.topic === toFriend.topic).map(m => open(oldKey, m.message)).filter(Boolean).length, 0);
  // and can't speak for the friend on the old channel any more either
  await new NtfyRelay({ server: url }).publish(oldTopic, seal(oldKey, { t: 'note', id: 'downgrade1a', from: updated.me.id, name: 'Friend', text: 'Unsigned impostor' }));
  await sleep(500);
  assert.ok(rohit.s.inbox.every(n => n.text !== 'Unsigned impostor'));
});

test('an old group switches to the new protection once everyone has updated', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const sOwner = makeStore(), sMember = makeStore();
  let owner = makeCore(url, 'Rohit', { Core: V1, store: sOwner }), member = makeCore(url, 'Amma', { Core: V1, store: sMember });
  const cores = [owner, member];
  t.after(async () => { for (const x of cores) x.stop(); await ntfy.close(); });
  const g = owner.createGroup('Family');
  assert.ok(g.code.startsWith('G'));
  await until(() => owner.relayStatus === 'online', 4000, 'online');
  member.joinCode(g.code);
  await until(() => Object.keys(owner.s.circles[0].members).length === 2, 5000, 'old group formed');
  const oldTopic = owner.s.circles[0].topic;

  owner.stop(); member.stop();
  owner = makeCore(url, 'Rohit', { store: sOwner }); member = makeCore(url, 'Amma', { store: sMember });
  cores.push(owner, member);
  await until(() => owner.s.circles[0].v === 2 && member.s.circles[0].v === 2, 6000, 'switched over');
  assert.notEqual(member.s.circles[0].topic, oldTopic);
  assert.equal(member.s.circles[0].owner, owner.me.id);
  assert.equal(owner.snapshot().circles[0].legacyCode, false);

  // the old code no longer gets anyone in
  const latecomer = makeCore(url, 'Late', { Core: V1 });
  cores.push(latecomer);
  latecomer.joinCode(g.code);
  owner.send({ circleId: owner.s.circles[0].id, text: 'Members only' });
  await until(() => member.s.inbox.length === 1, 4000, 'member gets it');
  await sleep(300);
  assert.equal(latecomer.s.inbox.length, 0);
});

test('ids that look like built-in names can’t sneak a removed member back in or break reactions', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), ex = makeCore(url, 'Ex');
  t.after(async () => { for (const x of [rohit, amma, ex]) x.stop(); await ntfy.close(); });
  await group(rohit, amma, ex);
  const before = { ...ex.s.circles[0] };
  assert.ok(rohit.removeMember(rohit.s.circles[0].id, ex.me.id).ok);
  await until(() => amma.s.circles[0].epoch === 1, 5000, 'new key');
  const fake = identity.newIdentity();
  for (const from of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await inject(url, before, { t: 'hello', from, name: 'Ex', pub: fake.sign.pub, xpub: fake.box.pub }, fake);
  }
  // and on the current key: a reaction "from" __proto__
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'hi' });
  await until(() => amma.s.inbox.length === 1, 4000, 'note');
  await inject(url, rohit.s.circles[0], { t: 'react', id: rohit.s.sent[0].id, r: '❤️', from: '__proto__', name: 'x', pub: fake.sign.pub }, fake);
  await sleep(600);
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(Object.prototype.hasOwnProperty.call(rohit.s.circles[0].members, k), false, `${k} is not a member`);
  assert.equal(Object.getPrototypeOf(rohit.s.circles[0].members), Object.prototype);
  assert.equal(({}).react, undefined, 'nothing leaks onto every object');
  assert.equal(Object.keys(rohit.s.circles[0].members).length, 2);
});

test('only the group’s owner can invite, and a key swapped for someone shows up in the safety code', async t => {
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const rohit = makeCore(url, 'Rohit'), amma = makeCore(url, 'Amma'), appa = makeCore(url, 'Appa');
  t.after(async () => { for (const x of [rohit, amma, appa]) x.stop(); await ntfy.close(); });
  await group(rohit, amma, appa);
  const r = amma.createGroupInvite(amma.s.circles[0].id);
  assert.equal(r.ok, false, 'a member who isn’t the owner can’t make a code');
  assert.match(r.error, /Only Rohit/);
  assert.equal(amma.snapshot().circles[0].ownerName, 'Rohit');
  await until(() => {
    const codes = [rohit, amma, appa].map(x => x.snapshot().circles[0].safety);
    return codes[0] === codes[1] && codes[1] === codes[2];
  }, 5000, 'everyone sees the same five');
  // Appa was handed a fake key for Amma: his five emoji no longer match
  const before = appa.snapshot().circles[0].safety;
  appa.s.circles[0].members[amma.me.id] = { ...appa.s.circles[0].members[amma.me.id], pub: identity.newIdentity().sign.pub };
  assert.notEqual(appa.snapshot().circles[0].safety, before);
  assert.notEqual(appa.snapshot().circles[0].safety, rohit.snapshot().circles[0].safety);
});

test('a late or replayed upgrade ask doesn’t move a healthy pair off its key', async t => {
  const { TitliCore: V1 } = require('./fixtures/v1/titli');
  const ntfy = createMockNtfy(), url = await ntfy.listen();
  const old = makeCore(url, 'Priya', { Core: V1 });
  const rohit = makeCore(url, 'Rohit');
  t.after(async () => { rohit.stop(); old.stop(); await ntfy.close(); });
  const inv = old.createInvite(); await sleep(300); rohit.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 1 && old.s.circles.length === 1, 6000, 'paired on 0.1.32');
  const store = old.store; old.stop();
  const priya = makeCore(url, 'Priya', { store });
  t.after(() => priya.stop());
  await until(() => priya.s.circles[0].v === 2 && rohit.s.circles[0].v === 2 && priya.s.circles[0].topic === rohit.s.circles[0].topic, 6000, 'both upgraded');
  const keyNow = rohit.s.circles[0].topic;
  // as if an older Titli had switched it: nothing on record about the switch being confirmed
  delete rohit.s.circles[0].upConfirmed; rohit.s.circles[0].upDone = {}; rohit.s.circles[0].repairedAt = 0;
  // an old ask from Priya shows up again on the old channel
  const oldEntry = rohit.s.circles[0].old[0];
  await inject(url, { topic: oldEntry.topic, secret: oldEntry.secret }, { t: 'upgrade', from: priya.me.id, name: 'Priya', pub: priya.me.keys.sign.pub, xpub: priya.me.keys.box.pub, eph: identity.ephemeral().pub }, priya.me.keys);
  await until(() => !!rohit.s.circles[0].pending, 4000, 'he offers a fresh key, without switching');
  await sleep(600);
  assert.equal(rohit.s.circles[0].topic, keyNow, 'still on the same key');
  priya.send({ circleId: priya.s.circles[0].id, text: 'still here' });
  await until(() => rohit.s.inbox.some(x => x.text === 'still here'), 4000, 'notes still arrive');
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'me too' });
  await until(() => priya.s.inbox.some(x => x.text === 'me too'), 4000, 'both ways');
});
