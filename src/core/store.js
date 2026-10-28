'use strict';
// Everything Titli knows lives in one JSON file on this laptop, readable only by this user and,
// where the system offers it, encrypted with a key the system keeps (see the crypt option).

const fs = require('fs');
const path = require('path');
const { newId } = require('./codes');

const DEFAULT_QUICK = ['Reached home?', 'Saaptiya?', 'Call me when free', 'Thinking of you', 'You got this 💪', 'Drink some water 💧'];
// the first defaults leaned romantic; anyone who never changed them gets the new ones
const OLD_DEFAULT_QUICK = ['Thinking of you', 'Saaptiya?', 'Drink some water 💧', 'Miss you already', 'Proud of you', 'Come home soon'];

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
      sendReceipts: true,   // tell people when their note arrived and when you saw it
      landAnywhere: true,   // the butterfly lands in a different spot each time (off: always top right)
      style: 'rose'
    },
    circles: [],     // people you're paired with, and groups
    invites: [],     // pair invites you created that nobody has used yet
    joining: [],     // pair codes you entered, waiting for the other side to answer
    quick: DEFAULT_QUICK.slice(),
    quickFor: {},    // circle id -> notes just for that person or group (shown first when sending to them)
    sent: [],        // what you sent, with who has seen it
    inbox: [],       // butterflies waiting to land on this laptop
    received: [],    // butterflies that have landed here (most recent first)
    outbox: [],      // relay posts that failed while offline
    handled: [],     // relay message ids already processed
    relayCaught: {}, // topic -> unix time we were last listening
    lastTo: null
  };
}

// crypt (optional): { name, encrypt(string) -> Buffer, decrypt(Buffer) -> string }, e.g. Electron's safeStorage on
// Windows (DPAPI). Then the file holds only ciphertext. Without crypt, an encrypted file is set aside, never unlocked.
class Store {
  // encrypt: true = write encrypted; false = write a plain file (an encrypted one is read with crypt, then saved
  // plain); left out = follow the file (an encrypted file stays encrypted)
  constructor(file, { crypt = null, encrypt } = {}) {
    this.file = file;
    this.crypt = crypt;
    this.mode = encrypt;
    this.encrypt = !!(crypt && (encrypt === undefined ? true : encrypt));
    this.migrated = false;
    this.state = null;
    this.unlockFailed = false;
    this._timer = null;
  }

  _read() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { return null; }
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || data.titliEncrypted !== 1) return data;
    try {
      if (!this.crypt) throw new Error('no key');
      const plain = JSON.parse(this.crypt.decrypt(Buffer.from(String(data.data), 'base64')));
      if (this.mode === undefined) this.encrypt = true; else this.migrated = !this.encrypt;
      return plain;
    } catch (e) {
      // no key here (a Mac never asks the Keychain; a new Windows computer): keep the file aside, start fresh
      this.unlockFailed = true;
      try { fs.renameSync(this.file, this.file.replace(/\.json$/, '') + `.locked-${Date.now()}.json`); } catch (err) { /* best effort */ }
      return null;
    }
  }

  load() {
    const data = this._read();
    const d = defaults();
    if (!data || typeof data !== 'object') { this.state = d; this.saveNow(); return this.state; }
    this.state = { ...d, ...data, me: { ...d.me, ...(data.me || {}) }, settings: { ...d.settings, ...(data.settings || {}) } };
    for (const k of ['circles', 'invites', 'joining', 'quick', 'sent', 'inbox', 'received', 'outbox', 'handled']) {
      if (!Array.isArray(this.state[k])) this.state[k] = d[k];
    }
    if (JSON.stringify(this.state.quick) === JSON.stringify(OLD_DEFAULT_QUICK)) this.state.quick = DEFAULT_QUICK.slice();
    if (!this.state.quickFor || typeof this.state.quickFor !== 'object' || Array.isArray(this.state.quickFor)) this.state.quickFor = {};
    // scheduling was removed; drop what earlier versions saved for it
    delete this.state.schedules; delete this.state.lastScheduleCheck;
    // read from an encrypted file but meant to be plain now: save it that way straight away, so the key is never needed again
    if (this.migrated) { this.saveNow(); this.migrated = false; }
    return this.state;
  }

  save() {
    clearTimeout(this._timer);
    // a busy disk or an antivirus holding the file: try again shortly rather than crash
    this._timer = setTimeout(() => { try { this.saveNow(); } catch (e) { this.saveError = e; this._timer = setTimeout(() => this.save(), 2000); } }, 250);
  }

  saveNow() {
    clearTimeout(this._timer);
    if (!this.state) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const plain = JSON.stringify(this.state, null, 1);
    const out = this.encrypt
      ? JSON.stringify({ titliEncrypted: 1, by: this.crypt.name, data: this.crypt.encrypt(plain).toString('base64') })
      : plain;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaults, DEFAULT_QUICK };
