'use strict';
// Decides whether a butterfly may land right now. Anything that looks like a meeting,
// a presentation or an empty desk holds it until the person is free.

const AWAY_SECONDS = 120;

function evaluate(sig = {}, settings = {}) {
  if (sig.suspended) return { busy: true, reason: 'asleep' };
  if (sig.locked) return { busy: true, reason: 'locked' };
  if (settings.holdInMeetings !== false) {
    if (sig.screenShared) return { busy: true, reason: 'sharing' };
    if (sig.cameraInUse) return { busy: true, reason: 'meeting' };
    if (sig.micInUse) return { busy: true, reason: 'call' };
    if (sig.fullscreen) return { busy: true, reason: 'fullscreen' };
  }
  if (settings.holdWhenAway !== false && (sig.idleSeconds || 0) >= AWAY_SECONDS) return { busy: true, reason: 'away' };
  return { busy: false, reason: null };
}

const REASON_TEXT = {
  asleep: 'Your laptop is asleep',
  locked: 'Your screen is locked',
  sharing: "You're sharing your screen",
  meeting: 'Your camera is on',
  call: "You're on a call",
  fullscreen: 'Something is full screen',
  away: "You're away from the laptop"
};

module.exports = { evaluate, REASON_TEXT, AWAY_SECONDS };
