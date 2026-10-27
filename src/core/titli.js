'use strict';
// The heart of Titli: people and groups ("circles"), pairing, sending, receiving and receipts.
// Pure Node, no Electron, so it can be tested on its own.
//
// Every circle (a pair or a group) has a random secret. Its relay topic and its encryption key are
// derived from that secret, and only members know it.
//   Pair:  you make a single-use invite code. When the other person enters it, their app posts
//          "join" on the invite's channel, your app answers "welcome" with a fresh circle secret,
//          and the invite is used up.
//   Group: the group code is the group's secret, so anyone with the code can join, any time.

const { EventEmitter } = require('events');
const codes = require('./codes');
const { seal, open } = require('./seal');

const MAX_TEXT = 60, MAX_NAME = 24, MAX_QUICK = 12, MAX_SENT = 40, MAX_RECEIVED = 100, MAX_HANDLED = 800, MAX_INBOX = 50, MAX_INVITES = 5;
const INVITE_TTL = 24 * 3600 * 1000, USED_INVITE_TTL = 10 * 60 * 1000;
const STYLES = ['rose', 'peony', 'gold', 'midnight'];
const REACTIONS = ['❤️', '🥰', '😘', '🤗', '😊', 'butterfly'];
const RANK = { sending: 0, sent: 1, arrived: 2, seen: 3 };

const clip = (t, n) => Array.from(String(t == null ? '' : t).replace(/\s+/g, ' ').trim()).slice(0, n).join('');

class TitliCore extends EventEmitter {
  constructor({ store, relay, now = () => Date.now() }) {
    super();
    this.store = store;
    this.relay = relay;
    this.now = now;
    this.relayStatus = 'idle';
    this._keys = new Map(); // topic -> { key, kind, ref }
    this._handled = new Set(this.s.handled);
    relay.restoreState(this.s.relayCaught);
    relay.on('message', m => this._onRelay(m));
    relay.on('caught', () => this._persistRelay());
    relay.on('status', st => {
      this.relayStatus = st;
      if (st === 'online') { this.flushOutbox(); this._resendJoins(); }
      this._changed();
    });
  }

  get s() { return this.store.state; }
  get me() { return this.s.me; }

  start() {
    this._prune();
    this._syncTopics();
    this.relay.setServer(this.s.settings.relay);
    this.relay.start();
    this._timer = setInterval(() => { this.flushOutbox(); this._prune(); }, 30000);
  }

  stop() {
    clearInterval(this._timer);
    this.relay.stop();
    this._persistRelay();
    this.store.saveNow();
  }

  /* ---------------- profile & settings ---------------- */

  setName(name) {
    const n = clip(name, MAX_NAME);
    if (!n) return { ok: false, error: 'Type the name people should see.' };
    const changed = n !== this.me.name;
    this.me.name = n;
    this._save();
    if (changed) for (const c of this.s.circles) this._postCircle(c, { t: 'hi', gname: c.kind === 'group' && !c.nameUnknown ? c.name : undefined });
    return { ok: true };
  }

  setSettings(patch = {}) {
    const st = this.s.settings;
    for (const k of ['holdInMeetings', 'holdWhenAway', 'notifyReactions', 'openAtLogin', 'allowCapture']) if (typeof patch[k] === 'boolean') st[k] = patch[k];
    if (STYLES.includes(patch.style)) st.style = patch.style;
    if (typeof patch.relay === 'string') {
      const url = patch.relay.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/.test(url)) return { ok: false, error: 'The relay address should start with https://' };
      st.relay = url; this.relay.setServer(url);
    }
    this._save();
    return { ok: true };
  }

  /* ---------------- quick notes ---------------- */

  addQuick(text) {
    const t = clip(text, MAX_TEXT);
    if (!t) return { ok: false, error: 'Write a few words to save.' };
    if (this.s.quick.includes(t)) return { ok: false, error: 'That note is already saved.' };
    if (this.s.quick.length >= MAX_QUICK) return { ok: false, error: `You can keep up to ${MAX_QUICK} quick notes. Delete one first.` };
    this.s.quick.push(t); this._save();
    return { ok: true };
  }

  removeQuick(text) {
    this.s.quick = this.s.quick.filter(q => q !== text); this._save();
    return { ok: true };
  }

  // the same notes in a new order (the first nine get number keys)
  reorderQuick(list) {
    const same = Array.isArray(list) && list.length === this.s.quick.length && list.every(x => typeof x === 'string') &&
      [...list].sort().join('\n') === [...this.s.quick].sort().join('\n');
    if (!same) return { ok: false, error: 'Your notes changed while you were moving them. Try again.' };
    this.s.quick = list.slice(); this._save();
    return { ok: true };
  }

  /* ---------------- pairing & groups ---------------- */

  createInvite() {
    const open = this.s.invites.filter(i => !i.circleId);
    if (open.length >= MAX_INVITES) return { ok: true, code: open[open.length - 1].code };
    const c = codes.randomCode('pair');
    this.s.invites.push({ code: c.code, raw: c.raw, createdAt: this.now(), since: this._nowSec() - 5 });
    this._syncTopics(); this._save();
    return { ok: true, code: c.code };
  }

  cancelInvite(code) {
    this.s.invites = this.s.invites.filter(i => i.code !== code);
    this._syncTopics(); this._save();
    return { ok: true };
  }

  joinCode(input) {
    const p = codes.parseCode(input);
    if (!p) return { ok: false, error: "That doesn't look like a Titli code. Codes look like P7QM-2XPA-9DRT-4HWN." };
    if (!this.me.name) return { ok: false, error: 'Add your name first, so they know who you are.' };
    if (p.kind === 'pair') {
      if (this.s.invites.some(i => i.raw === p.raw)) return { ok: false, error: "That's your own invite code. Send it to the other person instead." };
      if (!this.s.joining.some(j => j.raw === p.raw)) {
        this.s.joining.push({ code: p.code, raw: p.raw, createdAt: this.now(), since: this._nowSec() - 5 });
        this._syncTopics(); this._save();
      }
      this._sendJoin(this.s.joining.find(j => j.raw === p.raw));
      return { ok: true, kind: 'pair', pending: true };
    }
    const secret = codes.groupSecret(p.raw);
    const topic = codes.topicFor(Buffer.from(secret, 'hex'));
    const existing = this.s.circles.find(c => c.topic === topic);
    if (existing) return { ok: false, error: `You're already in ${existing.name}.` };
    const c = { id: codes.newId(), kind: 'group', name: 'New group', nameUnknown: true, code: p.code, secret, topic, members: { [this.me.id]: { name: this.me.name } }, createdAt: this.now(), since: this._nowSec() - 5 };
    this.s.circles.push(c);
    this._syncTopics(); this._save();
    this._postCircle(c, { t: 'hello' });
    return { ok: true, kind: 'group', circleId: c.id };
  }

  createGroup(name) {
    const n = clip(name, MAX_NAME);
    if (!n) return { ok: false, error: 'Give the group a name first.' };
    if (this.s.circles.some(c => c.kind === 'group' && c.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'You already have a group with that name.' };
    const code = codes.randomCode('group');
    const secret = codes.groupSecret(code.raw);
    const c = { id: codes.newId(), kind: 'group', name: n, code: code.code, secret, topic: codes.topicFor(Buffer.from(secret, 'hex')), members: { [this.me.id]: { name: this.me.name } }, owner: this.me.id, createdAt: this.now(), since: this._nowSec() - 5 };
    this.s.circles.push(c);
    this._syncTopics(); this._save();
    return { ok: true, code: code.code, circleId: c.id };
  }

  leave(circleId) {
    const c = this._circle(circleId);
    if (!c) return { ok: false, error: 'That person or group is already gone.' };
    this._postCircle(c, { t: 'bye' });
    this.s.circles = this.s.circles.filter(x => x !== c);
    // give the goodbye a moment to go out before we stop listening
    setTimeout(() => this._syncTopics(), 1500);
    this._save();
    return { ok: true };
  }

  /* ---------------- sending ---------------- */

  send({ circleId, text, style } = {}) {
    const c = this._circle(circleId);
    if (!c) return { ok: false, error: 'Pick who to send it to.' };
    const others = Object.keys(c.members).filter(id => id !== this.me.id);
    if (!others.length) return { ok: false, error: c.kind === 'group' ? `No one has joined ${c.name} yet. Share its code first.` : 'They haven’t joined yet.' };
    const t = text == null ? null : (clip(text, MAX_TEXT) || null);
    const msg = { t: 'note', id: codes.newId(), text: t, style: STYLES.includes(style) ? style : this.s.settings.style, at: this.now() };
    const rec = { id: msg.id, circleId: c.id, text: t, style: msg.style, at: msg.at, rc: {} };
    for (const id of others) rec.rc[id] = { st: 'sending', react: null };
    this.s.sent.unshift(rec);
    this.s.sent.length = Math.min(this.s.sent.length, MAX_SENT);
    this.s.lastTo = c.id;
    this._save();
    this._postCircle(c, msg, rec.id);
    return { ok: true, id: msg.id };
  }

  /* ---------------- landing on this laptop ---------------- */

  nextDelivery() { return this.s.inbox[0] || null; }

  // the butterfly has opened its wings and the note is on screen
  shown(id) {
    const i = this.s.inbox.findIndex(x => x.id === id);
    if (i < 0) return;
    const [item] = this.s.inbox.splice(i, 1);
    item.shownAt = this.now();
    this.s.received.unshift(item);
    this.s.received.length = Math.min(this.s.received.length, MAX_RECEIVED);
    if (item.kind === 'note') { const c = this._circle(item.circleId); if (c) this._postCircle(c, { t: 'seen', id: item.id }); }
    this._save(); this.emit('inbox');
  }

  react(id, r) {
    if (!REACTIONS.includes(r)) return { ok: false };
    const item = this.s.received.find(x => x.id === id && x.kind === 'note');
    if (!item || item.react) return { ok: false };
    item.react = r;
    const c = this._circle(item.circleId);
    if (c) this._postCircle(c, { t: 'react', id, r, to: item.from });
    this._save();
    return { ok: true };
  }

  /* ---------------- what the panel sees (no secrets) ---------------- */

  snapshot() {
    const me = this.me;
    const circleName = c => c.kind === 'pair' ? (Object.entries(c.members).find(([id]) => id !== me.id) || [null, { name: c.name }])[1].name || c.name : c.name;
    const circles = this.s.circles.map(c => ({
      id: c.id, kind: c.kind, name: circleName(c),
      members: Object.entries(c.members).filter(([id]) => id !== me.id).map(([, m]) => m.name || 'Someone'),
      code: c.kind === 'group' ? c.code : undefined, owner: c.owner === me.id, createdAt: c.createdAt || null
    }));
    const nameOf = id => { const c = circles.find(x => x.id === id); return c ? c.name : 'Someone'; };
    return {
      me: { name: me.name },
      settings: { ...this.s.settings },
      relayStatus: this.relayStatus,
      circles,
      invites: this.s.invites.filter(i => !i.circleId).map(i => ({ code: i.code, createdAt: i.createdAt })),
      joining: this.s.joining.map(j => ({ code: j.code, createdAt: j.createdAt })),
      quick: this.s.quick.slice(),
      sent: this.s.sent.slice(0, 20).map(m => ({ id: m.id, circleId: m.circleId, text: m.text, at: m.at, to: nameOf(m.circleId), status: this._statusOf(m) })),
      received: this.s.received.filter(r => !r.preview).slice(0, 20).map(r => ({ id: r.id, kind: r.kind, circleId: r.circleId, text: r.text, fromName: r.fromName, circleName: r.circleName, at: r.at, react: r.react || null })),
      inboxCount: this.s.inbox.length,
      lastTo: this.s.lastTo
    };
  }

  /* ---------------- internals ---------------- */

  _statusOf(m) {
    const c = this._circle(m.circleId);
    const ids = Object.keys(m.rc), rs = ids.map(i => m.rc[i]);
    const emoji = r => r === 'butterfly' ? '🦋' : r;
    const reacts = rs.map(r => r.react).filter(Boolean).map(emoji).join(' ');
    if (!c || c.kind === 'pair' || ids.length === 1) {
      const r = rs[0] || { st: 'sent' };
      if (r.st === 'sending') return { cls: 'go', text: this.relayStatus === 'online' ? 'Sending' : 'Waiting for internet' };
      if (r.st === 'sent') return { cls: 'go', text: 'On its way' };
      if (r.st === 'arrived') return { cls: 'wait', text: 'Arrived · lands when they’re free' };
      return { cls: 'seen', text: r.react === 'butterfly' ? 'Seen · sent one back' : 'Seen', extra: r.react && r.react !== 'butterfly' ? reacts : '' };
    }
    const seen = rs.filter(r => r.st === 'seen').length;
    const arrived = rs.filter(r => r.st === 'arrived').length;
    const sending = rs.some(r => r.st === 'sending');
    if (sending) return { cls: 'go', text: this.relayStatus === 'online' ? 'Sending' : 'Waiting for internet' };
    const text = seen === ids.length ? 'Seen by everyone' : `Seen by ${seen} of ${ids.length}` + (arrived ? ` · ${arrived} waiting` : '');
    return { cls: seen === ids.length ? 'seen' : 'wait', text, extra: reacts };
  }

  _circle(id) { return this.s.circles.find(c => c.id === id) || null; }
  _nowSec() { return Math.floor(this.now() / 1000); }

  _syncTopics() {
    const map = new Map();
    this._keys.clear();
    for (const c of this.s.circles) {
      this._keys.set(c.topic, { kind: 'circle', ref: c.id, key: codes.keyFor(Buffer.from(c.secret, 'hex')) });
      map.set(c.topic, c.since || 0);
    }
    for (const i of this.s.invites) {
      const sec = codes.inviteSecret(i.raw), topic = codes.topicFor(sec);
      this._keys.set(topic, { kind: 'invite', ref: i.raw, key: codes.keyFor(sec) });
      map.set(topic, i.since || 0);
    }
    for (const j of this.s.joining) {
      const sec = codes.inviteSecret(j.raw), topic = codes.topicFor(sec);
      this._keys.set(topic, { kind: 'joining', ref: j.raw, key: codes.keyFor(sec) });
      map.set(topic, j.since || 0);
    }
    this.relay.setTopics(map);
  }

  _onRelay({ id, time, topic, body }) {
    if (id) {
      if (this._handled.has(id)) return;
      this._handled.add(id);
      this.s.handled.push(id);
      if (this.s.handled.length > MAX_HANDLED) { const drop = this.s.handled.splice(0, this.s.handled.length - MAX_HANDLED); drop.forEach(d => this._handled.delete(d)); }
    }
    const k = this._keys.get(topic);
    if (!k) return;
    const msg = open(k.key, body);
    if (!msg || typeof msg.t !== 'string' || !msg.from || msg.from === this.me.id) return;
    try {
      if (k.kind === 'invite') this._onInvite(this.s.invites.find(i => i.raw === k.ref), msg);
      else if (k.kind === 'joining') this._onJoining(this.s.joining.find(j => j.raw === k.ref), msg, time);
      else this._onCircle(this._circle(k.ref), msg, time);
    } catch (e) {
      this.emit('warn', e);
    }
    this._save();
  }

  _onInvite(inv, msg) {
    if (!inv || msg.t !== 'join') return;
    const sec = codes.inviteSecret(inv.raw), key = codes.keyFor(sec), topic = codes.topicFor(sec);
    let c = inv.circleId ? this._circle(inv.circleId) : null;
    if (inv.circleId && (!c || !c.members[msg.from])) return; // already used by someone else
    if (!c) {
      const name = clip(msg.name, MAX_NAME) || 'Someone';
      const secret = codes.newSecret();
      c = { id: codes.newId(), kind: 'pair', name, secret, topic: codes.topicFor(Buffer.from(secret, 'hex')), members: { [this.me.id]: { name: this.me.name }, [msg.from]: { name } }, createdAt: this.now(), since: this._nowSec() - 5 };
      this.s.circles.push(c);
      inv.circleId = c.id; inv.usedAt = this.now();
      this.s.lastTo = this.s.lastTo || c.id;
      this._syncTopics();
      this.emit('paired', { name, circleId: c.id });
    }
    this._post(topic, seal(key, { t: 'welcome', from: this.me.id, name: this.me.name, to: msg.from, circle: { id: c.id, secret: c.secret } }));
  }

  _onJoining(j, msg, time) {
    if (!j || msg.t !== 'welcome' || msg.to !== this.me.id || !msg.circle || typeof msg.circle.secret !== 'string' || !/^[0-9a-f]{64}$/.test(msg.circle.secret)) return;
    this.s.joining = this.s.joining.filter(x => x !== j);
    if (this._circle(msg.circle.id)) { this._syncTopics(); return; }
    const name = clip(msg.name, MAX_NAME) || 'Someone';
    const c = { id: String(msg.circle.id).slice(0, 32), kind: 'pair', name, secret: msg.circle.secret, topic: codes.topicFor(Buffer.from(msg.circle.secret, 'hex')), members: { [this.me.id]: { name: this.me.name }, [msg.from]: { name } }, createdAt: this.now(), since: (time || this._nowSec()) - 10 };
    this.s.circles.push(c);
    this.s.lastTo = this.s.lastTo || c.id;
    this._syncTopics();
    this.emit('paired', { name, circleId: c.id });
  }

  _onCircle(c, msg, time) {
    if (!c) return;
    const name = clip(msg.name, MAX_NAME);
    const isNew = !c.members[msg.from];
    if (name || isNew) c.members[msg.from] = { name: name || (c.members[msg.from] && c.members[msg.from].name) || 'Someone' };
    if (c.kind === 'pair' && name) c.name = name;
    const fromName = c.members[msg.from].name;

    switch (msg.t) {
      case 'note': {
        if (msg.text != null && typeof msg.text !== 'string') return;
        if (!msg.id || this.s.inbox.some(x => x.id === msg.id) || this.s.received.some(x => x.id === msg.id)) return;
        const item = {
          kind: 'note', id: String(msg.id).slice(0, 40), circleId: c.id, from: msg.from, fromName,
          circleName: c.kind === 'group' ? c.name : null, text: msg.text == null ? null : clip(msg.text, 80) || null,
          style: STYLES.includes(msg.style) ? msg.style : 'rose', at: Number(msg.at) || (time || this._nowSec()) * 1000
        };
        this.s.inbox.push(item);
        if (this.s.inbox.length > MAX_INBOX) this.s.inbox.splice(0, this.s.inbox.length - MAX_INBOX);
        this._postCircle(c, { t: 'got', id: item.id });
        this.emit('inbox');
        break;
      }
      case 'got': case 'seen': case 'react': {
        const rec = this.s.sent.find(m => m.id === msg.id);
        if (!rec) return;
        const rc = rec.rc[msg.from] || (rec.rc[msg.from] = { st: 'sent', react: null });
        const st = msg.t === 'got' ? 'arrived' : 'seen';
        if (RANK[st] > RANK[rc.st]) rc.st = st;
        if (msg.t === 'react' && REACTIONS.includes(msg.r) && !rc.react) {
          rc.react = msg.r;
          if (msg.r === 'butterfly') {
            this.s.inbox.push({ kind: 'visit', id: `v-${rec.id}-${msg.from}`.slice(0, 60), circleId: c.id, from: msg.from, fromName, circleName: c.kind === 'group' ? c.name : null, text: rec.text, style: rec.style, at: this.now() });
            this.emit('inbox');
          } else {
            this.emit('reaction', { fromName, r: msg.r, text: rec.text });
          }
        }
        break;
      }
      case 'hello':
        if (c.kind === 'group') {
          this._postCircle(c, { t: 'hi', gname: c.nameUnknown ? undefined : c.name });
          if (isNew) this.emit('joined', { name: fromName, group: c.name });
        }
        break;
      case 'hi':
        if (c.kind === 'group' && c.nameUnknown && typeof msg.gname === 'string' && clip(msg.gname, MAX_NAME)) {
          c.name = clip(msg.gname, MAX_NAME); c.nameUnknown = false;
        }
        break;
      case 'bye':
        if (c.kind === 'pair') {
          this.s.circles = this.s.circles.filter(x => x !== c);
          this._syncTopics();
          this.emit('unpaired', { name: fromName });
        } else {
          delete c.members[msg.from];
        }
        break;
      default:
    }
    this._changed();
  }

  _sendJoin(j) {
    if (!j) return;
    const sec = codes.inviteSecret(j.raw);
    this._post(codes.topicFor(sec), seal(codes.keyFor(sec), { t: 'join', from: this.me.id, name: this.me.name }));
  }
  _resendJoins() { for (const j of this.s.joining) this._sendJoin(j); }

  _postCircle(c, obj, sentId) {
    const payload = { ...obj, from: this.me.id, name: this.me.name };
    this._post(c.topic, seal(codes.keyFor(Buffer.from(c.secret, 'hex')), payload), sentId);
  }

  _post(topic, body, sentId) {
    this.relay.publish(topic, body).then(() => this._markSent(sentId), () => {
      this.s.outbox.push({ topic, body, sentId: sentId || null, at: this.now() });
      if (this.s.outbox.length > 100) this.s.outbox.splice(0, this.s.outbox.length - 100);
      this._save();
    });
  }

  _markSent(sentId) {
    if (!sentId) return;
    const rec = this.s.sent.find(m => m.id === sentId);
    if (rec) for (const rc of Object.values(rec.rc)) if (rc.st === 'sending') rc.st = 'sent';
    this._save();
  }

  async flushOutbox() {
    if (this._flushing || !this.s.outbox.length) return;
    this._flushing = true;
    try {
      // the relay keeps things for 12 hours, so anything older than that has missed its chance
      const fresh = this.s.outbox.filter(o => this.now() - o.at < 12 * 3600 * 1000);
      this.s.outbox = [];
      for (let i = 0; i < fresh.length; i++) {
        try { await this.relay.publish(fresh[i].topic, fresh[i].body); this._markSent(fresh[i].sentId); }
        catch (e) { this.s.outbox.push(...fresh.slice(i)); break; }
      }
      this._save();
    } finally { this._flushing = false; }
  }

  _prune() {
    const now = this.now();
    const before = this.s.invites.length + this.s.joining.length;
    this.s.invites = this.s.invites.filter(i => i.circleId ? now - i.usedAt < USED_INVITE_TTL : now - i.createdAt < INVITE_TTL);
    this.s.joining = this.s.joining.filter(j => now - j.createdAt < INVITE_TTL);
    if (this.s.invites.length + this.s.joining.length !== before) { this._syncTopics(); this._save(); }
  }

  _persistRelay() { this.s.relayCaught = this.relay.persistState(); this.store.save(); }

  _save() { this.store.save(); this._changed(); }

  _changed() {
    if (this._pending) return;
    this._pending = true;
    setImmediate(() => { this._pending = false; this.emit('changed'); });
  }
}

module.exports = { TitliCore, STYLES, REACTIONS, MAX_TEXT, MAX_QUICK };
