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
const schedule = require('../src/core/schedule');
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
  assert.equal(codes.parseCode('G' + 'U'.repeat(15)).kind, 'group'); // U is read as V
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

test('schedule: due today, weekdays, catch-up window, once', () => {
  const s = { id: 'a', time: '11:00', repeat: 'daily', on: true, last: '' };
  const mon = new Date(2026, 9, 26, 11, 0, 20).getTime(); // Monday 11:00:20
  assert.equal(schedule.due([s], mon, mon - 20000).length, 1);
  assert.equal(schedule.due([{ ...s, last: schedule.dayKey(new Date(mon)) }], mon, mon - 20000).length, 0);
  assert.equal(schedule.due([s], mon - 3600 * 1000, mon - 3600 * 1000 - 20000).length, 0); // 10:00, not yet
  const sat = new Date(2026, 9, 24, 11, 0, 10).getTime();
  assert.equal(schedule.due([{ ...s, repeat: 'weekdays' }], sat, sat - 20000).length, 0);
  // laptop slept from 10:50 to 11:40: still fires
  const wake = new Date(2026, 9, 26, 11, 40).getTime();
  assert.equal(schedule.due([s], wake, new Date(2026, 9, 26, 10, 50).getTime()).length, 1);
  // slept until 14:00: too late, skipped
  const late = new Date(2026, 9, 26, 14, 0).getTime();
  assert.equal(schedule.due([s], late, new Date(2026, 9, 26, 10, 50).getTime()).length, 0);
  const n = schedule.nextRun([s], new Date(2026, 9, 26, 12, 0).getTime());
  assert.equal(new Date(n.when).getDate(), 27);
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
  assert.ok(g.ok && g.code.startsWith('G'));
  assert.equal(rohit.send({ circleId: g.circleId }).ok, false, 'empty group');
  await until(() => rohit.relayStatus === 'online', 4000, 'online');
  assert.ok(amma.joinCode(g.code).ok);
  assert.equal(amma.joinCode(g.code).ok, false, 'already in it');
  appa.joinCode(g.code.toLowerCase());
  await until(() => rohit.snapshot().circles[0].members.length === 2, 5000, 'members known');
  await until(() => amma.snapshot().circles[0].name === 'Family' && appa.snapshot().circles[0].name === 'Family', 5000, 'group name learned');
  await until(() => amma.snapshot().circles[0].members.length === 2, 5000, 'amma knows everyone');

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

test('schedules fire through the core', async t => {
  const ntfy = createMockNtfy();
  const url = await ntfy.listen();
  let clock = new Date(2026, 9, 26, 10, 59, 30).getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titli-'));
  const store = new Store(path.join(dir, 's.json')); store.load();
  const core = new TitliCore({ store, relay: new NtfyRelay({ server: url }), now: () => clock });
  core.setName('Rohit');
  t.after(async () => { core.stop(); await ntfy.close(); });
  core.start();
  const g = core.createGroup('Us');
  core.s.circles[0].members.x = { name: 'Anu' };
  assert.ok(core.addSchedule({ text: 'Drink some water 💧', circleId: g.circleId, time: '11:00', repeat: 'once' }).ok);
  assert.equal(core.addSchedule({ circleId: g.circleId, time: '25:00' }).ok, false);
  core.s.lastScheduleCheck = clock;
  assert.equal(core.checkSchedules().length, 0);
  clock += 45000;
  assert.equal(core.checkSchedules().length, 1);
  assert.equal(core.s.schedules[0].on, false, 'once turns itself off');
  assert.equal(core.s.sent[0].scheduled, true);
  clock += 45000;
  assert.equal(core.checkSchedules().length, 0);

  // editing: switch it back on, move it later today, change the note and repeat
  const id = core.s.schedules[0].id;
  assert.ok(core.updateSchedule(id, { on: true, time: '11:05', text: 'Stretch', repeat: 'weekdays' }).ok);
  assert.deepEqual([core.s.schedules[0].time, core.s.schedules[0].text, core.s.schedules[0].repeat], ['11:05', 'Stretch', 'weekdays']);
  assert.equal(core.updateSchedule(id, { text: '   ' }).ok, false, 'empty note refused');
  assert.equal(core.updateSchedule(id, { circleId: 'nope' }).ok, false);
  assert.ok(core.updateSchedule(id, { text: null }).ok, 'a heart');
  assert.equal(core.s.schedules[0].text, null);
  clock = new Date(2026, 9, 26, 11, 5, 20).getTime();
  assert.equal(core.checkSchedules().length, 1, 'fires at the new time');
  // moving it to a time already past today waits for tomorrow
  assert.ok(core.updateSchedule(id, { time: '09:00' }).ok);
  clock += 60000;
  assert.equal(core.checkSchedules().length, 0);
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
