'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Delivery } = require('../src/main/delivery');

function setup() {
  const core = new EventEmitter();
  core.s = { settings: { holdInMeetings: true, holdWhenAway: true }, inbox: [] };
  core.nextDelivery = () => core.s.inbox[0] || null;
  core.shown = id => { core.s.inbox = core.s.inbox.filter(x => x.id !== id); core.shownIds.push(id); };
  core.react = (id, r) => core.reacts.push([id, r]);
  core.shownIds = []; core.reacts = [];
  const overlay = new EventEmitter();
  overlay.played = []; overlay.aborts = 0; overlay.hidden = 0;
  overlay.play = async item => { overlay.played.push(item.id); };
  overlay.abort = () => { overlay.aborts++; };
  overlay.hide = () => { overlay.hidden++; };
  const watcher = new EventEmitter();
  watcher.signals = {};
  const d = new Delivery({ core, overlay, watcher });
  overlay.on('event', ev => d._onOverlay(ev)); // what start() wires up, without its timers
  return { core, overlay, watcher, d };
}

test('delivers one at a time, waits through calls, and lands after', () => {
  const { core, overlay, watcher, d } = setup();
  core.s.inbox.push({ id: 'a' }, { id: 'b' });
  watcher.signals = { micInUse: true };
  d.tick();
  assert.deepEqual(overlay.played, [], 'held during a call');
  watcher.signals = {};
  d.tick();
  assert.deepEqual(overlay.played, ['a']);
  d.tick();
  assert.deepEqual(overlay.played, ['a'], 'one at a time');
  overlay.emit('event', { type: 'shown', id: 'a' });
  assert.deepEqual(core.shownIds, ['a']);
  overlay.emit('event', { type: 'react', id: 'a', r: '🥰' });
  assert.deepEqual(core.reacts, [['a', '🥰']]);
});

test('a call starting mid-flight pulls the butterfly away and it comes back later', () => {
  const { core, overlay, watcher, d } = setup();
  core.s.inbox.push({ id: 'a' });
  d.tick();
  watcher.signals = { cameraInUse: true };
  d.tick();
  assert.equal(overlay.aborts, 1);
  overlay.emit('event', { type: 'aborted', id: 'a' });
  assert.equal(d.playing, null);
  assert.equal(core.s.inbox.length, 1, 'still waiting, never shown');
});

test('a note on screen stays while you step away, but hides for a screen lock', () => {
  const { core, overlay, watcher, d } = setup();
  core.s.inbox.push({ id: 'a' });
  d.tick();
  overlay.emit('event', { type: 'shown', id: 'a' });
  watcher.signals = { idleSeconds: 600 };
  d.tick();
  assert.equal(overlay.aborts, 0);
  watcher.signals = { locked: true };
  d.tick();
  assert.equal(overlay.aborts, 1);
});
