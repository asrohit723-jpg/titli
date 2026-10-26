'use strict';
// Everything Titli knows lives in one JSON file on this laptop (readable only by this user).

const fs = require('fs');
const path = require('path');
const { newId } = require('./codes');

const DEFAULT_QUICK = ['Thinking of you', 'Saaptiya?', 'Drink some water 💧', 'Miss you already', 'Proud of you', 'Come home soon'];

function defaults() {
  return {
    version: 1,
    me: { id: newId(12), name: '' },
    settings: {
      relay: 'https://ntfy.sh',
      holdInMeetings: true,
      holdWhenAway: true,
      notifyReactions: true,
      openAtLogin: true,
      allowCapture: false,  // let screen recordings see butterflies (for filming)
      style: 'rose'
    },
    circles: [],     // people you're paired with, and groups
    invites: [],     // pair invites you created that nobody has used yet
    joining: [],     // pair codes you entered, waiting for the other side to answer
    quick: DEFAULT_QUICK.slice(),
    schedules: [],
    sent: [],        // what you sent, with who has seen it
    inbox: [],       // butterflies waiting to land on this laptop
    received: [],    // butterflies that have landed here (most recent first)
    outbox: [],      // relay posts that failed while offline
    handled: [],     // relay message ids already processed
    relayCaught: {}, // topic -> unix time we were last listening
    lastTo: null,
    lastScheduleCheck: 0
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = null;
    this._timer = null;
  }

  load() {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { data = null; }
    const d = defaults();
    if (!data || typeof data !== 'object') { this.state = d; this.saveNow(); return this.state; }
    this.state = { ...d, ...data, me: { ...d.me, ...(data.me || {}) }, settings: { ...d.settings, ...(data.settings || {}) } };
    for (const k of ['circles', 'invites', 'joining', 'quick', 'schedules', 'sent', 'inbox', 'received', 'outbox', 'handled']) {
      if (!Array.isArray(this.state[k])) this.state[k] = d[k];
    }
    return this.state;
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this._timer);
    if (!this.state) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaults, DEFAULT_QUICK };
