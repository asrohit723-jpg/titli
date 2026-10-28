'use strict';
// Butterflies that went missing in real life: a laptop clock set hours wrong, a laptop off for longer than the relay
// keeps messages, and a pair whose upgrade to the new key only one side finished.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/core/store');
const { NtfyRelay } = require('../src/core/relay');
const { TitliCore } = require('../src/core/titli');
const { createMockNtfy } = require('./mock-ntfy');

const HOUR = 3600 * 1000;
const until = async (fn, ms = 5000, label = 'condition') => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('Timed out waiting for ' + label); await new Promise(r => setTimeout(r, 25)); }
};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'titli-')), 'titli.json');
// a Titli (any version) on a laptop whose clock is `skew` ms off
function core(Core, url, file, name, skew = 0) {
  const store = new Store(file); store.load(); store.state.settings.relay = url;
  const now = () => Date.now() + skew;
  const c = new Core({ store, relay: new NtfyRelay({ server: url, watchdogMs: 3000, now }), now });
  if (name) c.setName(name);
  c.start();
  return c;
}
async function pairNew(a, b) {
  const inv = a.createInvite();
  await new Promise(r => setTimeout(r, 300));
  b.joinCode(inv.code);
  await until(() => a.s.circles.length === 1 && b.s.circles.length === 1 && a.s.circles[0].v === 2 && b.s.circles[0].v === 2, 6000, 'paired');
}

test('a laptop whose clock is 5½ hours fast still sends and receives, and knows its clock is off', async t => {
  const ntfy = createMockNtfy(); const url = await ntfy.listen();
  const rohit = core(TitliCore, url, tmpFile(), 'Rohit');
  const priya = core(TitliCore, url, tmpFile(), 'Priya', 5.5 * HOUR);
  t.after(async () => { rohit.stop(); priya.stop(); await ntfy.close(); });
  await pairNew(rohit, priya);
  await until(() => Math.abs(priya.relay.clockOffset - 5.5 * HOUR) < 5000, 4000, 'clock offset learned');
  assert.ok(Math.abs(priya.snapshot().clockOff - 5.5 * HOUR) < 5000, 'the panel can say her clock is off');
  assert.equal(rohit.snapshot().clockOff, 0);
  priya.send({ circleId: priya.s.circles[0].id, text: 'from the fast clock' });
  await until(() => rohit.s.inbox.length === 1, 4000, 'her note arrives');
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'and back' });
  await until(() => priya.s.inbox.length === 1, 4000, 'his note arrives');
  await until(() => priya.s.sent[0].rc[rohit.me.id].st === 'arrived', 4000, 'she sees it arrived');
});

test('an older Titli (0.1.53) on a laptop 5½ hours fast: its notes still get through', async t => {
  const { TitliCore: V53 } = require('./fixtures/v053/titli');
  const ntfy = createMockNtfy(); const url = await ntfy.listen();
  const rohit = core(TitliCore, url, tmpFile(), 'Rohit');
  const priya = core(V53, url, tmpFile(), 'Priya', 5.5 * HOUR);
  t.after(async () => { rohit.stop(); priya.stop(); await ntfy.close(); });
  await pairNew(rohit, priya);
  priya.send({ circleId: priya.s.circles[0].id, text: 'old app, fast clock' });
  await until(() => rohit.s.inbox.length === 1, 4000, 'her note arrives');
  assert.equal(rohit.s.inbox[0].text, 'old app, fast clock');
});

test('a note is sent again until it arrives, even when the relay forgot it while their laptop was off', async t => {
  const ntfy = createMockNtfy(); const url = await ntfy.listen();
  let shift = 0;
  const rohitFile = tmpFile(), priyaFile = tmpFile();
  const rohit = (() => {
    const store = new Store(rohitFile); store.load(); store.state.settings.relay = url;
    const c = new TitliCore({ store, relay: new NtfyRelay({ server: url, watchdogMs: 3000 }), now: () => Date.now() + shift });
    c.setName('Rohit'); c.start(); return c;
  })();
  let priya = core(TitliCore, url, priyaFile, 'Priya');
  t.after(async () => { rohit.stop(); priya.stop(); await ntfy.close(); });
  await pairNew(rohit, priya);
  priya.stop();
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'are you there?' });
  await until(() => rohit.s.sent[0].rc[priya.me.id].st === 'sent', 4000, 'on its way');
  // her laptop stays off; the relay drops what it held
  ntfy.cache.splice(0, ntfy.cache.length);
  rohit._resendNotes();
  assert.ok(!rohit.s.sent[0].tries, 'not before ten hours');
  shift = 10 * HOUR + 60 * 1000;
  rohit._resendNotes();
  assert.equal(rohit.s.sent[0].tries, 1, 'sent again');
  priya = core(TitliCore, url, priyaFile);
  await until(() => priya.s.inbox.length === 1, 5000, 'it reaches her when she opens her laptop');
  await until(() => rohit.s.sent[0].rc[priya.me.id].st === 'arrived', 4000, 'and he sees it arrived');
  // once it has arrived, it isn't sent again
  shift += 11 * HOUR; rohit._resendNotes();
  assert.equal(rohit.s.sent[0].tries, 1);
  // a copy that turns up again is not shown twice, but answered (back to real time: only his clock was moved)
  shift = 0;
  priya.shown(priya.s.inbox[0].id);
  rohit._postCircle(rohit.s.circles[0], { t: 'note', id: rohit.s.sent[0].id, text: 'are you there?', style: 'rose', again: true });
  await until(() => rohit.s.sent[0].rc[priya.me.id].st === 'seen', 4000, 'seen');
  assert.equal(priya.s.inbox.length, 0); assert.equal(priya.s.received.length, 1);
});

test('a pair whose upgrade only one side finished (her clock was fast) repairs itself once both update', async t => {
  const { TitliCore: V1 } = require('./fixtures/v1/titli');
  const { TitliCore: V53 } = require('./fixtures/v053/titli');
  const ntfy = createMockNtfy(); const url = await ntfy.listen();
  const rohitFile = tmpFile(), priyaFile = tmpFile();
  const FAST = 5.5 * HOUR;
  // paired back when she had Titli 0.1.32
  let priya = core(V1, url, priyaFile, 'Priya', FAST);
  let rohit = core(V53, url, rohitFile, 'Rohit');
  t.after(async () => { rohit.stop(); priya.stop(); await ntfy.close(); });
  const inv = priya.createInvite();
  await new Promise(r => setTimeout(r, 300));
  rohit.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 1 && priya.s.circles.length === 1, 6000, 'paired on 0.1.32');
  assert.equal(rohit.s.circles[0].v, 1);
  // she updates to 0.1.53: she takes his key and switches; her answer is dropped by his 0.1.53 (her clock is fast)
  priya.stop();
  priya = core(V53, url, priyaFile, null, FAST);
  rohit._startUpgrade(rohit.s.circles[0]);   // he asks again (his 0.1.32-era ask was already used up)
  await until(() => priya.s.circles[0].v === 2, 5000, 'she switched');
  await new Promise(r => setTimeout(r, 800));
  assert.equal(rohit.s.circles[0].v, 1, 'he never did: the pair is split');
  priya.send({ circleId: priya.s.circles[0].id, text: 'lost' });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(rohit.s.inbox.length, 0, 'what she sends never reaches him');

  // both update to this version
  rohit.stop(); priya.stop();
  rohit = core(TitliCore, url, rohitFile);
  priya = core(TitliCore, url, priyaFile, null, FAST);
  await until(() => rohit.s.circles[0].v === 2 && rohit.s.circles[0].topic === priya.s.circles[0].topic, 8000, 'both on the same new key');
  priya.send({ circleId: priya.s.circles[0].id, text: 'found you' });
  await until(() => rohit.s.inbox.some(x => x.text === 'found you'), 5000, 'her notes reach him again');
  rohit.send({ circleId: rohit.s.circles[0].id, text: 'yes!' });
  await until(() => priya.s.inbox.some(x => x.text === 'yes!'), 5000, 'and his reach her');
  await until(() => !priya.s.circles[0].upDone && !rohit.s.circles[0].upDone, 4000, 'both confirmed the switch');
  // after that, an old ask played back again changes nothing
  const keyBefore = priya.s.circles[0].topic;
  priya._repairUpgrade(priya.s.circles[0], { eph: rohit.me.keys.box.pub }, priya.s.circles[0].old[0].topic);
  assert.equal(priya.s.circles[0].topic, keyBefore);
});

test('an upgrade answer that goes missing is said again, so both sides still end on the same key', async t => {
  const { TitliCore: V1 } = require('./fixtures/v1/titli');
  const ntfy = createMockNtfy(); const url = await ntfy.listen();
  const rohitFile = tmpFile(), priyaFile = tmpFile();
  let priya = core(V1, url, priyaFile, 'Priya');
  const rohit = core(TitliCore, url, rohitFile, 'Rohit');
  t.after(async () => { rohit.stop(); priya.stop(); await ntfy.close(); });
  const inv = priya.createInvite();
  await new Promise(r => setTimeout(r, 300));
  rohit.joinCode(inv.code);
  await until(() => rohit.s.circles.length === 1 && priya.s.circles.length === 1, 6000, 'paired on 0.1.32');
  // he's offline when she updates; she takes his key and switches, and the relay forgets her answer before he's back
  rohit.relay.stop();
  priya.stop();
  priya = core(TitliCore, url, priyaFile);
  rohit._startUpgrade(rohit.s.circles[0]);
  await until(() => priya.s.circles[0].v === 2, 5000, 'she switched');
  await new Promise(r => setTimeout(r, 300));
  ntfy.cache.splice(0, ntfy.cache.length);
  rohit.relay.start();
  // hours later he asks again (every few hours, or when Titli starts); she says her part again
  rohit.s.circles[0].up.askedAt = 0; priya.s.circles[0].repairedAt = 0;
  await until(() => rohit.relayStatus === 'online', 4000, 'he is back');
  rohit._askUpgrades();
  try { await until(() => rohit.s.circles[0].v === 2, 5000, 'he switched too'); } catch (e) {
    if (process.env.DBG) console.log('DBG', JSON.stringify({ pUp: priya.s.circles[0].upDone, rUp: rohit.s.circles[0].up && rohit.s.circles[0].up.eph.pub, rpeer: rohit.s.circles[0].up && rohit.s.circles[0].up.peerEph, rst: rohit.relayStatus, streams: ntfy.streamCount, cache: ntfy.cache.length, rep: priya.s.circles[0].repairedAt, pmembers: Object.values(priya.s.circles[0].members).map(m => !!m.pub), rmembers: Object.values(rohit.s.circles[0].members).map(m => !!m.pub) }));
    throw e;
  }
  assert.equal(rohit.s.circles[0].topic, priya.s.circles[0].topic);
  priya.send({ circleId: priya.s.circles[0].id, text: 'same key' });
  await until(() => rohit.s.inbox.some(x => x.text === 'same key'), 5000, 'her note arrives');
});
