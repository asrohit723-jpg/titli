'use strict';
// The heart of Titli: people and groups ("circles"), pairing, sending, receiving and receipts.
// Pure Node, no Electron, so it can be tested on its own.
//
// Every circle (a pair or a group) has a random secret. Its relay topic and its encryption key are
// derived from that secret, and only members know it. Every device also has its own signing key
// (see identity.js): everything it sends is signed, and once we know someone's key we only accept
// messages signed by it. Nobody can send as someone else, even from inside a group.
//
//   Pair:  you make a single-use invite code. The other person's app posts "join" with a one-off public
//          key on the invite's channel; your app answers "welcome" with its own. Both work out the
//          pair's secret from the two keys (X25519), so someone who only saw the code learns nothing.
//          Pairs made by Titli 0.1.32 and earlier upgrade the same way, over their old channel, as soon
//          as both people have updated.
//   Group: a group code (H…) is an invite that lasts 24 hours. Whoever made it answers each joiner with
//          the group's secret, sealed so only that joiner can open it. When someone leaves or the owner
//          removes them, the owner makes a new secret and hands it to everyone else, so they're out.
//          Old groups (G… codes, where the code was the secret) switch over once everyone has updated.

const { EventEmitter } = require('events');
const codes = require('./codes');
const { seal, open } = require('./seal');
const identity = require('./identity');
const Taps = require('./taps');

const MAX_TEXT = 60, MAX_NAME = 24, MAX_QUICK = 12, MAX_PERSONAL = 8, MAX_SENT = 40, MAX_RECEIVED = 100, MAX_HANDLED = 800, MAX_INBOX = 50, MAX_INVITES = 5;
const MAX_MEMBERS = 30;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const INVITE_TTL = DAY, USED_INVITE_TTL = 10 * 60 * 1000;
// after a key change, keep listening on the old channel for stragglers (the owner longer, to help anyone who missed it)
const KEEP_OLD_KEY = DAY, KEEP_OLD_KEY_OWNER = 7 * DAY;
// the relay keeps messages for 12 hours; anything claiming to be much older is a replay. The margin ahead is wide
// because some computers have their clock set hours fast (the wrong time zone, set by hand), and older versions
// stamp messages with that clock. Titli itself now stamps them with the relay's time when this computer's clock is off.
const MAX_AGE = 14 * HOUR, MAX_AHEAD = 15 * HOUR;
// a note nobody has confirmed yet is sent again before the relay forgets it (12 hours), for up to three days
const RESEND_EVERY = 10 * HOUR, RESEND_FOR = 3 * DAY;
// a pair that switched to the new key keeps the old channel until the other side is heard on the new one
const KEEP_UPGRADE_KEY = 30 * DAY, UPGRADE_ASK_EVERY = 6 * HOUR;
const STYLES = ['rose', 'peony', 'gold', 'midnight', 'sky', 'leaf', 'monarch'];
// what the reaction row offers; older versions also send 🥰 and 😘, which still count
const REACTIONS = ['❤️', '😂', '🤗', '👍', '😊', 'butterfly'];
const REACTIONS_IN = [...REACTIONS, '🥰', '😘'];
// the one-tap butterfly (no words): any emoji, picked for each person or group (a heart for some, a wave for others)
const GESTURES = Object.keys(Taps.NAMES);   // the four names Titli 0.1.51 to 0.1.53 understand
const tapOf = x => Taps.emojiOf(x) || Taps.HEART;
const RANK = { sending: 0, sent: 1, arrived: 2, seen: 3 };
const ANNOUNCE = ['hello', 'hi', 'upgrade'];   // messages that introduce the sender's keys

// control characters, invisible and right-to-left marks people could use to disguise a name or a note
const HIDDEN = /[\u0000-\u001f\u007f-\u009f­؜᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const clip = (t, n) => Array.from(String(t == null ? '' : t).replace(HIDDEN, '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');
const isHex64 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(s);
const payloadOf = msg => { const { sig, ...p } = msg; return p; };
const relayOk = url => /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);

class TitliCore extends EventEmitter {
  constructor({ store, relay, now = () => Date.now() }) {
    super();
    this.store = store;
    this.relay = relay;
    this.now = now;
    this.relayStatus = 'idle';
    this._keys = new Map(); // topic -> { key, kind, ref, old }
    this._resynced = new Map();
    if (!identity.validIdentity(this.me.keys)) { this.me.keys = identity.newIdentity(); this.store.save(); }
    if (!relayOk(this.s.settings.relay)) this.s.settings.relay = 'https://ntfy.sh';
    if (typeof this.s.settings.sendReceipts !== 'boolean') this.s.settings.sendReceipts = true;
    // people paired before gestures existed keep getting hearts; the old names become their emoji
    for (const c of this.s.circles) c.tap = tapOf(c.tap);
    for (const it of this.s.inbox) if (it.g != null) it.g = tapOf(it.g);
    if (!Array.isArray(this.s.seenNotes)) this.s.seenNotes = [];
    // pairs an older Titli switched to the new key: keep the old channel until the other side is heard on the new one,
    // so a switch only one side finished can still be repaired
    for (const c of this.s.circles) {
      if (c.kind !== 'pair' || c.v !== 2 || !(c.old || []).length || c.upDone) continue;
      c.upDone = {};
      for (const o of c.old) { if (!o.at) o.at = o.until - KEEP_OLD_KEY; o.until = Math.max(o.until, this.now() + KEEP_UPGRADE_KEY); }
    }
    // circles saved by older versions don't list our keys in our own entry
    for (const c of this.s.circles) if (c.members && c.members[this.me.id]) c.members[this.me.id] = { ...c.members[this.me.id], ...this._pub };
    this._handled = new Set(this.s.handled);
    relay.restoreState(this.s.relayCaught);
    relay.on('message', m => this._onRelay(m));
    relay.on('caught', () => this._persistRelay());
    relay.on('clock', () => this._changed());
    relay.on('status', st => {
      this.relayStatus = st;
      if (st === 'online') { this.flushOutbox(); this._resendJoins(); }
      this._changed();
    });
  }

  get s() { return this.store.state; }
  get me() { return this.s.me; }
  get _pub() { return { pub: this.me.keys.sign.pub, xpub: this.me.keys.box.pub }; }

  start() {
    this._prune();
    this._syncTopics();
    this.relay.setServer(this.s.settings.relay);
    this.relay.start();
    this._announce();
    this._timer = setInterval(() => { this.flushOutbox(); this._prune(); this._resendNotes(); this._askUpgrades(); }, 30000);
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
    for (const c of this.s.circles) if (c.members[this.me.id]) c.members[this.me.id].name = n;
    this._save();
    if (changed) for (const c of this.s.circles) this._postCircle(c, { t: 'hi', ...this._pub, gname: c.kind === 'group' && !c.nameUnknown ? c.name : undefined });
    return { ok: true };
  }

  setSettings(patch = {}) {
    const st = this.s.settings;
    for (const k of ['holdInMeetings', 'holdWhenAway', 'notifyReactions', 'openAtLogin', 'allowCapture', 'sendReceipts', 'landAnywhere']) if (typeof patch[k] === 'boolean') st[k] = patch[k];
    if (STYLES.includes(patch.style)) st.style = patch.style;
    if (typeof patch.relay === 'string') {
      const url = patch.relay.trim().replace(/\/+$/, '');
      if (!relayOk(url)) return { ok: false, error: 'The relay address should start with https://' };
      st.relay = url; this.relay.setServer(url);
    }
    this._save();
    return { ok: true };
  }

  // what one tap sends to this person or group: any one emoji
  setTap(circleId, tap) {
    const c = this._circle(circleId);
    if (!c) return { ok: false, error: 'That person or group is gone.' };
    const e = Taps.emojiOf(tap);
    if (!e) return { ok: false, error: 'Pick one emoji.' };
    c.tap = e; this._save();
    return { ok: true };
  }

  /* ---------------- quick notes ----------------
     Notes for everyone, plus notes just for one person or group (circleId), which show first when sending to them. */

  _quickList(circleId) {
    if (!circleId) return this.s.quick;
    if (!this._circle(circleId)) return null;
    const lists = this.s.quickFor || (this.s.quickFor = {});
    return lists[circleId] || (lists[circleId] = []);
  }

  addQuick(text, circleId = null) {
    const t = clip(text, MAX_TEXT);
    if (!t) return { ok: false, error: 'Write a few words to save.' };
    const list = this._quickList(circleId);
    if (!list) return { ok: false, error: 'That person or group is gone.' };
    const who = circleId ? this.snapshot().circles.find(c => c.id === circleId).name : null;
    if (list.includes(t)) return { ok: false, error: who ? `That note is already saved for ${who}.` : 'That note is already saved.' };
    if (circleId && this.s.quick.includes(t)) return { ok: false, error: 'That note is already in your notes for everyone.' };
    const max = circleId ? MAX_PERSONAL : MAX_QUICK;
    if (list.length >= max) return { ok: false, error: who ? `You can keep up to ${max} notes just for ${who}. Delete one first.` : `You can keep up to ${max} quick notes. Delete one first.` };
    list.push(t); this._save();
    return { ok: true };
  }

  removeQuick(text, circleId = null) {
    if (!circleId) this.s.quick = this.s.quick.filter(q => q !== text);
    else if (this.s.quickFor && this.s.quickFor[circleId]) this.s.quickFor[circleId] = this.s.quickFor[circleId].filter(q => q !== text);
    this._save();
    return { ok: true };
  }

  // the same notes in a new order (the first nine get number keys)
  reorderQuick(list, circleId = null) {
    const cur = this._quickList(circleId);
    const same = cur && Array.isArray(list) && list.length === cur.length && list.every(x => typeof x === 'string') &&
      [...list].sort().join('\n') === [...cur].sort().join('\n');
    if (!same) return { ok: false, error: 'Your notes changed while you were moving them. Try again.' };
    if (circleId) this.s.quickFor[circleId] = list.slice(); else this.s.quick = list.slice();
    this._save();
    return { ok: true };
  }

  /* ---------------- pairing & groups ---------------- */

  createInvite() {
    const open = this.s.invites.filter(i => i.kind !== 'group' && !i.circleId);
    if (open.length >= MAX_INVITES) return { ok: true, code: open[open.length - 1].code };
    const c = codes.randomCode('pair');
    this.s.invites.push({ kind: 'pair', code: c.code, raw: c.raw, eph: identity.ephemeral(), createdAt: this.now(), since: this._nowSec() - 5 });
    this._syncTopics(); this._save();
    return { ok: true, code: c.code };
  }

  // a 24-hour code for one of your groups; whoever enters it gets the group's key from your Titli
  createGroupInvite(circleId) {
    const c = this._circle(circleId);
    if (!c || c.kind !== 'group') return { ok: false, error: 'That group is gone.' };
    if (c.v !== 2) return { ok: true, code: c.code };   // an old group's code still works until it switches over
    const now = this.now();
    const live = this.s.invites.find(i => i.kind === 'group' && i.circleId === c.id && now - i.createdAt < INVITE_TTL - HOUR);
    if (live) return { ok: true, code: live.code };
    const code = codes.randomCode('group');
    this.s.invites.push({ kind: 'group', code: code.code, raw: code.raw, circleId: c.id, answered: {}, createdAt: now, since: this._nowSec() - 5 });
    this._syncTopics(); this._save();
    return { ok: true, code: code.code };
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
    if (this.s.invites.some(i => i.raw === p.raw)) return { ok: false, error: "That's your own code. Send it to the other person instead." };
    if (p.kind === 'legacyGroup') return this._joinLegacyGroup(p);
    const already = this.s.circles.find(c => c.joinedWith === p.raw);
    if (already) return { ok: false, error: `You're already in ${already.name}.` };
    if (!this.s.joining.some(j => j.raw === p.raw)) {
      this.s.joining.push({ kind: p.kind, code: p.code, raw: p.raw, eph: identity.ephemeral(), createdAt: this.now(), since: this._nowSec() - 5 });
      this._syncTopics(); this._save();
    }
    this._sendJoin(this.s.joining.find(j => j.raw === p.raw));
    return { ok: true, kind: p.kind, pending: true };
  }

  // G… codes come from Titli 0.1.32 and earlier: the code is the group's secret
  _joinLegacyGroup(p) {
    const secret = codes.groupSecret(p.raw);
    const topic = codes.topicFor(Buffer.from(secret, 'hex'));
    const existing = this.s.circles.find(c => c.topic === topic);
    if (existing) return { ok: false, error: `You're already in ${existing.name}.` };
    const c = { id: codes.newId(), kind: 'group', v: 1, name: 'New group', nameUnknown: true, code: p.code, secret, topic, members: { [this.me.id]: this._meMember() }, tap: '👋', createdAt: this.now(), since: this._nowSec() - 5 };
    this.s.circles.push(c);
    this._syncTopics(); this._save();
    this._postCircle(c, { t: 'hello', ...this._pub });
    return { ok: true, kind: 'group', circleId: c.id };
  }

  createGroup(name) {
    const n = clip(name, MAX_NAME);
    if (!n) return { ok: false, error: 'Give the group a name first.' };
    if (this.s.circles.some(c => c.kind === 'group' && c.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'You already have a group with that name.' };
    const secret = codes.newSecret();
    const c = { id: codes.newId(), kind: 'group', v: 2, epoch: 0, name: n, secret, topic: codes.topicFor(Buffer.from(secret, 'hex')), members: { [this.me.id]: this._meMember() }, owner: this.me.id, tap: '👋', createdAt: this.now(), since: this._nowSec() - 5 };
    this.s.circles.push(c);
    this._syncTopics(); this._save();
    const inv = this.createGroupInvite(c.id);
    return { ok: true, code: inv.code, circleId: c.id };
  }

  leave(circleId) {
    const c = this._circle(circleId);
    if (!c) return { ok: false, error: 'That person or group is already gone.' };
    const others = Object.keys(c.members).filter(id => id !== this.me.id);
    if (c.kind === 'group' && c.v === 2 && c.owner === this.me.id && others.some(id => identity.isKey(c.members[id].xpub))) {
      // hand the group over: a new key for everyone else, and the next person in line becomes its owner
      const next = others.filter(id => identity.isKey(c.members[id].xpub)).sort()[0];
      this._rekey(c, { exclude: [this.me.id], owner: next });
    } else {
      this._postCircle(c, { t: 'bye' });
      this.s.circles = this.s.circles.filter(x => x !== c);
    }
    this.s.invites = this.s.invites.filter(i => i.circleId !== c.id);
    // give the goodbye a moment to go out before we stop listening
    setTimeout(() => this._syncTopics(), 1500);
    this._save();
    return { ok: true };
  }

  // the group's owner can take someone out; everyone else gets a new key they don't
  removeMember(circleId, memberId) {
    const c = this._circle(circleId);
    if (!c || c.kind !== 'group') return { ok: false, error: 'That group is gone.' };
    if (c.owner !== this.me.id) return { ok: false, error: 'Only the person who made the group can remove people.' };
    if (memberId === this.me.id || !c.members[memberId]) return { ok: false, error: 'They’re not in the group.' };
    this._rekey(c, { exclude: [memberId] });
    this._save();
    return { ok: true };
  }

  /* ---------------- sending ---------------- */

  send({ circleId, text, style, gesture } = {}) {
    const c = this._circle(circleId);
    if (!c) return { ok: false, error: 'Pick who to send it to.' };
    const others = Object.keys(c.members).filter(id => id !== this.me.id);
    if (!others.length) return { ok: false, error: c.kind === 'group' ? `No one has joined ${c.name} yet. Share its code first.` : 'They haven’t joined yet.' };
    const t = text == null ? null : (clip(text, MAX_TEXT) || null);
    const g = t == null ? (Taps.emojiOf(gesture) || tapOf(c.tap)) : undefined;
    // e: the emoji; g: the nearest of the four names, for anyone still on 0.1.51 to 0.1.53 (older ones show a heart)
    const msg = { t: 'note', id: codes.newId(), text: t, g: g && Taps.legacyName(g), e: g, style: STYLES.includes(style) ? style : this.s.settings.style, at: this.now() };
    const rec = { id: msg.id, circleId: c.id, text: t, g, style: msg.style, at: msg.at, rc: {} };
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
    if (item.kind === 'note' && this.s.settings.sendReceipts) { const c = this._circle(item.circleId); if (c) this._postCircle(c, { t: 'seen', id: item.id }); }
    this._save(); this.emit('inbox');
  }

  react(id, r) {
    if (!REACTIONS_IN.includes(r)) return { ok: false };
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
    const me = this.me, now = this.now();
    const others = c => Object.entries(c.members).filter(([id]) => id !== me.id);
    const circleName = c => c.kind === 'pair' ? ((others(c)[0] || [null, { name: c.name }])[1].name || c.name) : c.name;
    const groupCode = c => {
      if (c.v !== 2) return c.code ? { code: c.code, expiresAt: null } : null;
      const inv = this.s.invites.filter(i => i.kind === 'group' && i.circleId === c.id && now - i.createdAt < INVITE_TTL).pop();
      return inv ? { code: inv.code, expiresAt: inv.createdAt + INVITE_TTL } : null;
    };
    const circles = this.s.circles.map(c => {
      const os = others(c), gc = c.kind === 'group' ? groupCode(c) : null;
      // two people in one group with the same name get a short tag from their key, so they can't pass as each other
      const counts = {};
      for (const [, m] of os) { const k = (m.name || '').toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
      const label = (id, m) => (m.name || 'Someone') + (counts[(m.name || '').toLowerCase()] > 1 ? ` (${(m.pub || id).slice(0, 4)})` : '');
      return {
        id: c.id, kind: c.kind, name: circleName(c),
        members: os.map(([id, m]) => label(id, m)),
        people: os.map(([id, m]) => ({ id, name: label(id, m) })),
        code: gc ? gc.code : undefined, codeExpiresAt: gc ? gc.expiresAt : undefined, legacyCode: c.kind === 'group' && c.v !== 2,
        owner: c.owner === me.id, createdAt: c.createdAt || null, tap: tapOf(c.tap),
        // fully protected: the new key exchange is done and we know everyone's signing key
        secure: c.v === 2 && os.every(([, m]) => identity.isKey(m.pub)),
        safety: identity.safetyCode(c.secret, c.kind === 'group' ? `group|${c.id}|${c.epoch || 0}` : 'pair')
      };
    });
    const nameOf = id => { const c = circles.find(x => x.id === id); return c ? c.name : 'Someone'; };
    return {
      me: { name: me.name },
      settings: { ...this.s.settings },
      relayStatus: this.relayStatus,
      clockOff: this.relay.clockOffset || 0,
      circles,
      invites: this.s.invites.filter(i => i.kind !== 'group' && !i.circleId).map(i => ({ code: i.code, createdAt: i.createdAt })),
      joining: this.s.joining.map(j => ({ code: j.code, kind: j.kind, createdAt: j.createdAt })),
      quick: this.s.quick.slice(),
      quickFor: Object.fromEntries(Object.entries(this.s.quickFor || {}).filter(([id, l]) => this._circle(id) && Array.isArray(l) && l.length).map(([id, l]) => [id, l.slice()])),
      sent: this.s.sent.slice(0, 20).map(m => ({ id: m.id, circleId: m.circleId, text: m.text, g: m.text == null ? tapOf(m.g) : undefined, at: m.at, to: nameOf(m.circleId), status: this._statusOf(m) })),
      received: this.s.received.filter(r => !r.preview).slice(0, 20).map(r => ({ id: r.id, kind: r.kind, circleId: r.circleId, text: r.text, g: r.text == null ? tapOf(r.g) : undefined, fromName: r.fromName, circleName: r.circleName, at: r.at, react: r.react || null })),
      inboxCount: this.s.inbox.length,
      lastTo: this.s.lastTo
    };
  }

  /* ---------------- internals ---------------- */

  _meMember() { return { name: this.me.name, ...this._pub }; }

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
  _nowSec() { return Math.floor(this._trueNow() / 1000); }
  // the real time: this computer's clock, corrected by the relay's when it's set wrong
  _trueNow() { return this.now() - (this.relay.clockOffset || 0); }

  _syncTopics() {
    const map = new Map(), now = this.now();
    this._keys.clear();
    const add = (topic, since, entry) => { this._keys.set(topic, entry); map.set(topic, since || 0); };
    for (const c of this.s.circles) {
      add(c.topic, c.since, { kind: 'circle', ref: c.id, key: codes.keyFor(Buffer.from(c.secret, 'hex')) });
      c.old = (c.old || []).filter(o => o.until > now);
      for (const o of c.old) add(o.topic, o.since, { kind: 'circle', ref: c.id, old: true, key: codes.keyFor(Buffer.from(o.secret, 'hex')) });
    }
    for (const i of this.s.invites) {
      const sec = codes.inviteSecret(i.raw);
      add(codes.topicFor(sec), i.since, { kind: 'invite', ref: i.raw, key: codes.keyFor(sec) });
    }
    for (const j of this.s.joining) {
      const sec = codes.inviteSecret(j.raw);
      add(codes.topicFor(sec), j.since, { kind: 'joining', ref: j.raw, key: codes.keyFor(sec) });
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
    if (!msg || typeof msg.t !== 'string' || !isId(msg.from) || msg.from === this.me.id) return;
    // too old or from the future: a replay of something the relay saw before
    if (msg.ts != null) { const ts = Number(msg.ts), now = this._trueNow(); if (!(ts > now - MAX_AGE && ts < now + MAX_AHEAD)) return; }
    try {
      if (k.kind === 'invite') this._onInvite(this.s.invites.find(i => i.raw === k.ref), msg, topic);
      else if (k.kind === 'joining') this._onJoining(this.s.joining.find(j => j.raw === k.ref), msg, time, topic);
      else this._onCircle(this._circle(k.ref), msg, time, topic, k.old);
    } catch (e) {
      this.emit('warn', e);
    }
    this._save();
  }

  // a message signed by the key it carries (used before we know someone's key)
  _selfSigned(msg, topic) {
    return identity.isKey(msg.pub) && identity.verify(msg.pub, topic, payloadOf(msg), msg.sig);
  }

  /* --- pairing: the person who made the code --- */
  _onInvite(inv, msg, topic) {
    if (!inv || msg.t !== 'join') return;
    if (inv.kind === 'group') return this._onGroupJoin(inv, msg, topic);
    const v2 = msg.v === 2;
    if (v2 && !(identity.isKey(msg.eph) && identity.isKey(msg.xpub) && this._selfSigned(msg, topic))) return;
    const sec = codes.inviteSecret(inv.raw);
    let c = inv.circleId ? this._circle(inv.circleId) : null;
    if (inv.circleId && (!c || !c.members[msg.from])) return; // already used by someone else
    if (c && c.members[msg.from].pub && c.members[msg.from].pub !== msg.pub) return;
    if (!c) {
      const name = clip(msg.name, MAX_NAME) || 'Someone';
      let secret, them;
      if (v2) {
        if (!inv.eph) inv.eph = identity.ephemeral();
        inv.joinEph = msg.eph;
        secret = identity.kdf(identity.dh(inv.eph.priv, msg.eph), sec, `titli-pair-v2|${inv.eph.pub}|${msg.eph}`).toString('hex');
        them = { name, pub: msg.pub, xpub: msg.xpub };
      } else {
        // someone on Titli 0.1.32 or earlier: the old way, and the pair upgrades once they update
        secret = codes.newSecret();
        them = { name };
      }
      c = { id: codes.newId(), kind: 'pair', v: v2 ? 2 : 1, name, secret, topic: codes.topicFor(Buffer.from(secret, 'hex')), members: { [this.me.id]: this._meMember(), [msg.from]: them }, tap: '👋', createdAt: this.now(), since: this._nowSec() - 5 };
      this.s.circles.push(c);
      inv.circleId = c.id; inv.usedAt = this.now();
      this.s.lastTo = this.s.lastTo || c.id;
      this._syncTopics();
      this.emit('paired', { name, circleId: c.id });
    }
    if (c.v === 2 && inv.joinEph === msg.eph) {
      this._postSigned(topic, codes.keyFor(sec), { t: 'welcome', v: 2, ...this._pub, to: msg.from, eph: inv.eph.pub, joinEph: msg.eph, circle: { id: c.id } });
    } else if (c.v !== 2 && !v2) {
      this._postSigned(topic, codes.keyFor(sec), { t: 'welcome', v: 1, to: msg.from, circle: { id: c.id, secret: c.secret } });
    }
  }

  /* --- pairing: the person who entered the code --- */
  _onJoining(j, msg, time, topic) {
    if (!j || msg.t !== 'welcome' || msg.to !== this.me.id) return;
    if (j.kind === 'group') return this._onGroupWelcome(j, msg, time, topic);
    const name = clip(msg.name, MAX_NAME) || 'Someone';
    const sec = codes.inviteSecret(j.raw);
    let c;
    if (msg.v === 2) {
      if (msg.joinEph !== j.eph.pub || !identity.isKey(msg.eph) || !identity.isKey(msg.xpub) || !this._selfSigned(msg, topic) || !msg.circle || !isId(msg.circle.id)) return;
      const secret = identity.kdf(identity.dh(j.eph.priv, msg.eph), sec, `titli-pair-v2|${msg.eph}|${j.eph.pub}`).toString('hex');
      c = { id: msg.circle.id, kind: 'pair', v: 2, name, secret, topic: codes.topicFor(Buffer.from(secret, 'hex')), members: { [this.me.id]: this._meMember(), [msg.from]: { name, pub: msg.pub, xpub: msg.xpub } }, tap: '👋', createdAt: this.now(), since: (time || this._nowSec()) - 10 };
    } else {
      // made on Titli 0.1.32 or earlier: take its key now and upgrade the pair when they update
      if (!msg.circle || !isId(msg.circle.id) || !isHex64(msg.circle.secret)) return;
      c = { id: msg.circle.id, kind: 'pair', v: 1, name, secret: msg.circle.secret, topic: codes.topicFor(Buffer.from(msg.circle.secret, 'hex')), members: { [this.me.id]: this._meMember(), [msg.from]: { name } }, tap: '👋', createdAt: this.now(), since: (time || this._nowSec()) - 10 };
    }
    this.s.joining = this.s.joining.filter(x => x !== j);
    if (this._circle(c.id)) { this._syncTopics(); return; }
    this.s.circles.push(c);
    this.s.lastTo = this.s.lastTo || c.id;
    this._syncTopics();
    if (c.v !== 2) this._startUpgrade(c);
    this.emit('paired', { name, circleId: c.id });
  }

  /* --- groups: answering someone who entered our group code --- */
  _onGroupJoin(inv, msg, topic) {
    if (msg.v !== 2 || !identity.isKey(msg.eph) || !identity.isKey(msg.xpub) || !this._selfSigned(msg, topic)) return;
    const c = this._circle(inv.circleId);
    if (!c || c.v !== 2 || this.now() - inv.createdAt > INVITE_TTL) return;
    const known = c.members[msg.from];
    if (known && known.pub !== msg.pub) return;
    if ((c.removed || []).includes(msg.from)) return;
    if (!known && Object.keys(c.members).length >= MAX_MEMBERS) return;
    inv.answered = inv.answered || {};
    let a = inv.answered[msg.from];
    if (!a || a.joinEph !== msg.eph) {
      if (Object.keys(inv.answered).length >= MAX_MEMBERS * 2) return;
      a = inv.answered[msg.from] = { eph: identity.ephemeral(), joinEph: msg.eph };
    }
    const sec = codes.inviteSecret(inv.raw);
    const key = identity.kdf(identity.dh(a.eph.priv, msg.eph), sec, 'titli-group-welcome-v2');
    const members = {};
    for (const [id, m] of Object.entries(c.members)) members[id] = { name: m.name, pub: m.pub, xpub: m.xpub };
    this._postSigned(topic, codes.keyFor(sec), {
      t: 'welcome', v: 2, kind: 'group', ...this._pub, to: msg.from, eph: a.eph.pub, joinEph: msg.eph,
      circle: { id: c.id, name: c.name, epoch: c.epoch || 0, owner: c.owner, members }, box: seal(key, { secret: c.secret })
    });
  }

  /* --- groups: we entered a code and someone in the group answered --- */
  _onGroupWelcome(j, msg, time, topic) {
    if (msg.v !== 2 || msg.kind !== 'group' || msg.joinEph !== j.eph.pub || !identity.isKey(msg.eph) || !this._selfSigned(msg, topic)) return;
    const g = msg.circle;
    if (!g || !isId(g.id) || !g.members || typeof g.members !== 'object' || this._circle(g.id)) return;
    const key = identity.kdf(identity.dh(j.eph.priv, msg.eph), codes.inviteSecret(j.raw), 'titli-group-welcome-v2');
    const box = open(key, msg.box);
    if (!box || !isHex64(box.secret)) return;
    const members = {};
    for (const [id, m] of Object.entries(g.members).slice(0, MAX_MEMBERS)) {
      if (!isId(id) || id === this.me.id || !m || !identity.isKey(m.pub)) continue;
      members[id] = { name: clip(m.name, MAX_NAME) || 'Someone', pub: m.pub, xpub: identity.isKey(m.xpub) ? m.xpub : undefined };
    }
    if (!members[msg.from] || members[msg.from].pub !== msg.pub) return;   // whoever answered must be in the group they describe
    members[this.me.id] = this._meMember();
    const c = { id: g.id, kind: 'group', v: 2, epoch: Number.isInteger(g.epoch) && g.epoch >= 0 ? g.epoch : 0, name: clip(g.name, MAX_NAME) || 'Group', secret: box.secret,
      topic: codes.topicFor(Buffer.from(box.secret, 'hex')), owner: isId(g.owner) ? g.owner : msg.from, members, joinedWith: j.raw, tap: '👋', createdAt: this.now(), since: (time || this._nowSec()) - 10 };
    this.s.joining = this.s.joining.filter(x => x !== j);
    this.s.circles.push(c);
    this.s.lastTo = this.s.lastTo || c.id;
    this._syncTopics();
    this._postCircle(c, { t: 'hello', ...this._pub });
    this.emit('joinedGroup', { group: c.name, circleId: c.id });
  }

  /* --- everything inside a pair or group --- */
  _onCircle(c, msg, time, topic, viaOldKey) {
    if (!c) return;
    let m = c.members[msg.from];
    const isNew = !m;
    if (m && m.pub) {
      // we know their key: it has to be them
      if (!identity.verify(m.pub, topic, payloadOf(msg), msg.sig)) return;
    } else if (typeof msg.sig === 'string' && identity.isKey(msg.pub)) {
      // first time we see their key: it must sign this very message, and only announcements introduce a key
      if (!ANNOUNCE.includes(msg.t) || !this._selfSigned(msg, topic)) return;
      // a newcomer has to know the current key: an old one (kept by someone who was removed) gets no one in
      if (!m && (c.kind === 'pair' || viaOldKey || (c.removed || []).includes(msg.from) || Object.keys(c.members).length >= MAX_MEMBERS)) return;
      m = c.members[msg.from] = { name: (m && m.name) || 'Someone', pub: msg.pub, xpub: identity.isKey(msg.xpub) ? msg.xpub : undefined };
    } else {
      // unsigned: only from someone still on Titli 0.1.32 or earlier, in a circle that hasn't switched over yet
      if (c.v === 2) return;
      if (!m && (c.kind === 'pair' || viaOldKey || Object.keys(c.members).length >= MAX_MEMBERS)) return;
    }
    const name = clip(msg.name, MAX_NAME);
    if (name || isNew) c.members[msg.from] = { ...(m || {}), name: name || (m && m.name) || 'Someone' };
    if (c.kind === 'pair' && name) c.name = name;
    m = c.members[msg.from];
    const fromName = m.name;
    // the other side of an upgraded pair is talking on the new key: the switch is done, the old channel can go soon
    if (!viaOldKey && c.kind === 'pair' && c.upDone) {
      delete c.upDone; c.upConfirmed = true;
      const soon = this.now() + KEEP_OLD_KEY;
      for (const o of c.old || []) o.until = Math.min(o.until, soon);
    }

    switch (msg.t) {
      case 'note': {
        if (msg.text != null && typeof msg.text !== 'string') return;
        if (!isId(msg.id)) return;
        const waiting = this.s.inbox.some(x => x.id === msg.id), shown = this.s.received.some(x => x.id === msg.id) || this.s.seenNotes.some(([id]) => id === msg.id);
        if (waiting || shown) {
          // sent again because they never heard back: tell them once more
          if (msg.again && this.s.settings.sendReceipts) this._postCircle(c, { t: shown ? 'seen' : 'got', id: msg.id });
          return;
        }
        this.s.seenNotes.push([msg.id, this.now()]);
        if (this.s.seenNotes.length > 600) this.s.seenNotes.splice(0, this.s.seenNotes.length - 600);
        const item = {
          kind: 'note', id: msg.id, circleId: c.id, from: msg.from, fromName,
          circleName: c.kind === 'group' ? c.name : null, text: msg.text == null ? null : clip(msg.text, 80) || null,
          g: msg.text == null ? (Taps.emojiOf(msg.e) || tapOf(msg.g)) : undefined,
          // when the relay got it, not when the sender says it was sent
          style: STYLES.includes(msg.style) ? msg.style : 'rose', at: time ? time * 1000 : this.now()
        };
        this.s.inbox.push(item);
        if (this.s.inbox.length > MAX_INBOX) this.s.inbox.splice(0, this.s.inbox.length - MAX_INBOX);
        if (this.s.settings.sendReceipts) this._postCircle(c, { t: 'got', id: item.id });
        this.emit('inbox');
        break;
      }
      case 'got': case 'seen': case 'react': {
        const rec = this.s.sent.find(x => x.id === msg.id && x.circleId === c.id);
        if (!rec) return;
        const rc = rec.rc[msg.from] || (Object.keys(rec.rc).length < MAX_MEMBERS ? (rec.rc[msg.from] = { st: 'sent', react: null }) : null);
        if (!rc) return;
        const st = msg.t === 'got' ? 'arrived' : 'seen';
        if (RANK[st] > RANK[rc.st]) rc.st = st;
        if (msg.t === 'react' && REACTIONS_IN.includes(msg.r) && !rc.react) {
          rc.react = msg.r;
          if (msg.r === 'butterfly') {
            this.s.inbox.push({ kind: 'visit', id: `v-${rec.id}-${msg.from}`.slice(0, 60), circleId: c.id, from: msg.from, fromName, circleName: c.kind === 'group' ? c.name : null, text: rec.text, g: rec.text == null ? tapOf(rec.g) : undefined, style: rec.style, at: this.now() });
            this.emit('inbox');
          } else {
            this.emit('reaction', { fromName, r: msg.r, text: rec.text, g: tapOf(rec.g) });
          }
        }
        break;
      }
      case 'hello':
        if (c.kind === 'group') {
          this._postCircle(c, { t: 'hi', ...this._pub, owner: c.owner === this.me.id || undefined, gname: c.nameUnknown ? undefined : c.name });
          if (isNew) this.emit('joined', { name: fromName, group: c.name });
          this._maybeUpgradeGroup(c);
        }
        break;
      case 'hi':
        if (c.kind === 'group') {
          if (c.nameUnknown && typeof msg.gname === 'string' && clip(msg.gname, MAX_NAME)) { c.name = clip(msg.gname, MAX_NAME); c.nameUnknown = false; }
          // old groups had no owner on record; whoever made it says so once they update
          if (c.v !== 2 && !c.owner && msg.owner === true && m.pub) c.owner = msg.from;
          this._maybeUpgradeGroup(c);
        }
        break;
      case 'bye':
        if (c.kind === 'pair') {
          this.s.circles = this.s.circles.filter(x => x !== c);
          this._syncTopics();
          this.emit('unpaired', { name: fromName });
        } else {
          delete c.members[msg.from];
          // they're out: everyone else gets a new key
          if (c.v === 2 && c.owner === this.me.id) this._rekey(c, {});
        }
        break;
      case 'upgrade':
        if (c.kind !== 'pair' || !m.pub) break;
        if (c.v !== 2) this._onUpgrade(c, msg, time);
        else if (viaOldKey && !msg.re) this._repairUpgrade(c, msg, topic);
        break;
      case 'rekey':
        this._onRekey(c, msg, time);
        break;
      default:
    }
    // someone still on an old channel: repeat the latest key change there so they catch up
    if (viaOldKey && this._circle(c.id) && c.owner === this.me.id && c.lastRekey && c.members[msg.from] && msg.t !== 'rekey') this._resync(c, topic);
    this._changed();
  }

  /* --- upgrading a pair made by an older Titli: a fresh key exchange over the old channel --- */
  _startUpgrade(c) {
    if (c.kind !== 'pair' || c.v === 2) return;
    if (!c.up) c.up = { eph: identity.ephemeral() };
    c.up.askedAt = this.now();
    this._postCircle(c, { t: 'upgrade', ...this._pub, eph: c.up.eph.pub });
  }

  // a pair still on the old key asks again every few hours, in case the other side missed it
  _askUpgrades() {
    if (this.relayStatus !== 'online') return;
    for (const c of this.s.circles) if (c.kind === 'pair' && c.v !== 2 && this.now() - ((c.up && c.up.askedAt) || 0) > UPGRADE_ASK_EVERY) this._startUpgrade(c);
  }

  // we switched to the new key, but they're still asking on the old channel: they never got our answer
  _repairUpgrade(c, msg, topic) {
    // once they've talked to us on the new key, an old ask can only be a replay
    if (c.upConfirmed || !identity.isKey(msg.eph)) return;
    const o = (c.old || []).find(x => x.topic === topic);
    if (!o) return;
    const now = this.now();
    if (c.repairedAt && now - c.repairedAt < 60 * 1000) return;   // copies of the same ask arrive together
    const key = codes.keyFor(Buffer.from(o.secret, 'hex'));
    if (c.upDone && c.upDone.peerEph === msg.eph && c.upDone.eph) {
      // say it again: with it they land on the same key we did
      c.repairedAt = now;
      this._postSigned(o.topic, key, { t: 'upgrade', re: 1, ...this._pub, eph: c.upDone.eph });
      return;
    }
    // we don't know what we answered (an older Titli switched), or they started over. Once our answer has left the
    // relay (12 hours), they can't finish with it: start the exchange again with them, on the old channel.
    if (!o.at || now - o.at < 13 * HOUR) return;
    c.repairedAt = now;
    const eph = identity.ephemeral();
    this._postSigned(o.topic, key, { t: 'upgrade', re: 1, ...this._pub, eph: eph.pub });
    const both = [eph.pub, msg.eph].sort().join('|');
    const secret = identity.kdf(identity.dh(eph.priv, msg.eph), Buffer.from(o.secret, 'hex'), `titli-upgrade-v2|${both}`).toString('hex');
    o.until = Math.max(o.until, now + KEEP_UPGRADE_KEY);
    this._switchKey(c, secret, this._nowSec() - 10, KEEP_UPGRADE_KEY);
    c.upDone = { eph: eph.pub, peerEph: msg.eph };
    this._syncTopics();
  }

  _onUpgrade(c, msg, time) {
    if (!identity.isKey(msg.eph)) return;
    if (!c.up) c.up = { eph: identity.ephemeral() };
    // answer with ours (again, if they have a new one), so they can finish even if they missed it
    if (c.up.peerEph !== msg.eph) { c.up.peerEph = msg.eph; this._postCircle(c, { t: 'upgrade', ...this._pub, eph: c.up.eph.pub }); }
    const both = [c.up.eph.pub, msg.eph].sort().join('|');
    const secret = identity.kdf(identity.dh(c.up.eph.priv, msg.eph), Buffer.from(c.secret, 'hex'), `titli-upgrade-v2|${both}`).toString('hex');
    this._switchKey(c, secret, (time || this._nowSec()) - 10, KEEP_UPGRADE_KEY);
    c.upDone = { eph: c.up.eph.pub, peerEph: msg.eph };
    c.v = 2; delete c.up;
    this._syncTopics();
    this.emit('secured', { name: c.members[msg.from].name });
  }

  /* --- groups: a new key for everyone still in it (owner only) --- */
  // gid: the owner's id for the group (groups from older versions have a different id on each device)
  _boxKey(theirXpub, gid, epoch) {
    return identity.kdf(identity.dh(this.me.keys.box.priv, theirXpub), Buffer.from('titli'), `titli-group-box|${gid}|${epoch}`);
  }

  _rekey(c, { exclude = [], owner = c.owner }) {
    const epoch = (c.epoch || 0) + 1, secret = codes.newSecret();
    const keep = Object.entries(c.members).filter(([id, m]) => !exclude.includes(id) && (id === this.me.id || identity.isKey(m.xpub)));
    const members = {}, boxes = {};
    for (const [id, m] of keep) {
      members[id] = id === this.me.id ? this._meMember() : { name: m.name, pub: m.pub, xpub: m.xpub };
      if (id !== this.me.id) boxes[id] = seal(this._boxKey(m.xpub, c.id, epoch), { secret });
    }
    if (!members[owner]) owner = keep.map(([id]) => id).sort()[0] || this.me.id;
    const removed = exclude.filter(id => id !== this.me.id);
    const change = { t: 'rekey', gid: c.id, epoch, owner, members, boxes, removed: removed.length ? removed : undefined };
    this._postCircle(c, change);
    // codes made before the change could let someone who just left straight back in
    this.s.invites = this.s.invites.filter(i => i.circleId !== c.id);
    if (exclude.includes(this.me.id)) {
      this.s.circles = this.s.circles.filter(x => x !== c);
      this._syncTopics();
      return;
    }
    c.members = members; c.epoch = epoch; c.owner = owner; c.v = 2; delete c.code;
    c.removed = [...new Set([...(c.removed || []), ...removed])].slice(-50);
    c.lastRekey = change;
    this._switchKey(c, secret, this._nowSec() - 5, KEEP_OLD_KEY_OWNER);
    this._syncTopics();
  }

  _onRekey(c, msg, time) {
    if (c.kind !== 'group') return;
    const sender = c.members[msg.from];
    // only the owner can change the key (an old group with no owner on record: any member who has updated)
    const allowed = c.owner ? msg.from === c.owner : c.v !== 2;
    if (!allowed || !sender || !sender.pub || !identity.isKey(sender.xpub)) return;
    const epoch = Number(msg.epoch);
    if (!Number.isInteger(epoch) || epoch <= (c.epoch || 0) || !msg.members || typeof msg.members !== 'object') return;
    if (!msg.members[this.me.id] || !msg.boxes || typeof msg.boxes[this.me.id] !== 'string') {
      // we're not in the new group
      this.s.circles = this.s.circles.filter(x => x !== c);
      this.s.invites = this.s.invites.filter(i => i.circleId !== c.id);
      this._syncTopics();
      this.emit('removed', { group: c.name });
      return;
    }
    const box = open(this._boxKey(sender.xpub, isId(msg.gid) ? msg.gid : c.id, epoch), msg.boxes[this.me.id]);
    if (!box || !isHex64(box.secret)) return;
    const members = {};
    for (const [id, nm] of Object.entries(msg.members).slice(0, MAX_MEMBERS)) {
      if (!isId(id) || !nm || !identity.isKey(nm.pub)) continue;
      const had = c.members[id];
      // keep the keys we already know; the owner can't swap someone's key
      members[id] = had && had.pub ? had : { name: clip(nm.name, MAX_NAME) || 'Someone', pub: nm.pub, xpub: identity.isKey(nm.xpub) ? nm.xpub : undefined };
    }
    members[this.me.id] = this._meMember();
    c.members = members; c.epoch = epoch; c.v = 2; delete c.code;
    c.owner = isId(msg.owner) && members[msg.owner] ? msg.owner : msg.from;
    if (Array.isArray(msg.removed)) c.removed = [...new Set([...(c.removed || []), ...msg.removed.filter(isId)])].slice(-50);
    this.s.invites = this.s.invites.filter(i => i.circleId !== c.id);
    this._switchKey(c, box.secret, (time || this._nowSec()) - 10, KEEP_OLD_KEY);
    this._syncTopics();
  }

  // an old group switches to the new protection once everyone in it has updated (its maker does it)
  _maybeUpgradeGroup(c) {
    if (c.kind !== 'group' || c.v === 2 || c.owner !== this.me.id) return;
    const others = Object.entries(c.members).filter(([id]) => id !== this.me.id);
    if (others.length && others.every(([, m]) => identity.isKey(m.pub) && identity.isKey(m.xpub))) this._rekey(c, {});
  }

  _resync(c, topic) {
    const last = this._resynced.get(topic) || 0;
    if (this.now() - last < 10 * 60 * 1000) return;
    const o = (c.old || []).find(x => x.topic === topic);
    if (!o) return;
    this._resynced.set(topic, this.now());
    this._postSigned(topic, codes.keyFor(Buffer.from(o.secret, 'hex')), c.lastRekey);
  }

  _switchKey(c, secret, sinceSec, keepFor) {
    const now = this.now();
    c.old = (c.old || []).filter(o => o.until > now).slice(-3);
    c.old.push({ topic: c.topic, secret: c.secret, since: c.since, until: now + keepFor, at: now });
    c.secret = secret; c.topic = codes.topicFor(Buffer.from(secret, 'hex')); c.since = sinceSec;
  }

  // once per start: tell every circle our keys (so groups can switch over and stragglers catch up), and upgrade old pairs
  _announce() {
    for (const c of this.s.circles) {
      if (c.kind === 'pair') { if (c.v !== 2) this._startUpgrade(c); }
      else this._postCircle(c, { t: 'hi', ...this._pub, owner: c.owner === this.me.id || undefined, gname: c.nameUnknown ? undefined : c.name });
    }
  }

  _sendJoin(j) {
    if (!j) return;
    if (!j.eph) j.eph = identity.ephemeral();
    const sec = codes.inviteSecret(j.raw);
    this._postSigned(codes.topicFor(sec), codes.keyFor(sec), { t: 'join', v: 2, kind: j.kind === 'group' ? 'group' : undefined, ...this._pub, eph: j.eph.pub });
  }
  _resendJoins() { for (const j of this.s.joining) this._sendJoin(j); }

  _postCircle(c, obj, sentId) {
    this._postSigned(c.topic, codes.keyFor(Buffer.from(c.secret, 'hex')), obj, sentId);
  }

  // everything we send carries who it's from, when, and our signature over all of it
  _postSigned(topic, key, obj, sentId) {
    const payload = { ...obj, v: obj.v || 2, from: this.me.id, name: this.me.name, ts: this._trueNow() };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    payload.sig = identity.sign(this.me.keys, topic, payload);
    this._post(topic, seal(key, payload), sentId);
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
      const fresh = this.s.outbox.filter(o => this.now() - o.at < 12 * HOUR);
      this.s.outbox = [];
      for (let i = 0; i < fresh.length; i++) {
        try { await this.relay.publish(fresh[i].topic, fresh[i].body); this._markSent(fresh[i].sentId); }
        catch (e) { this.s.outbox.push(...fresh.slice(i)); break; }
      }
      this._save();
    } finally { this._flushing = false; }
  }

  // notes nobody has confirmed: send them again before the relay forgets them (it keeps 12 hours), for up to 3 days.
  // Whoever already has it just answers again.
  _resendNotes() {
    if (this.relayStatus !== 'online') return;
    const now = this.now();
    for (const rec of this.s.sent) {
      if (now - rec.at > RESEND_FOR || now - (rec.lastTry || rec.at) < RESEND_EVERY) continue;
      const c = this._circle(rec.circleId);
      if (!c || !Object.entries(rec.rc).some(([id, r]) => r.st === 'sent' && c.members[id])) continue;
      rec.lastTry = now; rec.tries = (rec.tries || 0) + 1;
      const g = rec.text == null ? tapOf(rec.g) : undefined;
      this._postCircle(c, { t: 'note', id: rec.id, text: rec.text, g: g && Taps.legacyName(g), e: g, style: rec.style, at: rec.at, again: true });
      this._save();
    }
  }

  _prune() {
    const now = this.now();
    const before = this.s.invites.length + this.s.joining.length + this.s.circles.reduce((n, c) => n + (c.old || []).length, 0);
    this.s.invites = this.s.invites.filter(i => i.kind === 'group' ? now - i.createdAt < INVITE_TTL : (i.circleId ? now - i.usedAt < USED_INVITE_TTL : now - i.createdAt < INVITE_TTL));
    this.s.joining = this.s.joining.filter(j => now - j.createdAt < INVITE_TTL);
    for (const c of this.s.circles) c.old = (c.old || []).filter(o => o.until > now);
    this.s.seenNotes = (this.s.seenNotes || []).filter(([, t]) => now - t < RESEND_FOR + DAY);
    // notes kept for someone you're no longer connected to
    if (this.s.quickFor) for (const id of Object.keys(this.s.quickFor)) if (!this._circle(id)) delete this.s.quickFor[id];
    const after = this.s.invites.length + this.s.joining.length + this.s.circles.reduce((n, c) => n + c.old.length, 0);
    if (after !== before) { this._syncTopics(); this._save(); }
  }

  _persistRelay() { this.s.relayCaught = this.relay.persistState(); this.store.save(); }

  _save() { this.store.save(); this._changed(); }

  _changed() {
    if (this._pending) return;
    this._pending = true;
    setImmediate(() => { this._pending = false; this.emit('changed'); });
  }
}

module.exports = { TitliCore, STYLES, REACTIONS, GESTURES, MAX_TEXT, MAX_QUICK, MAX_MEMBERS, clip, relayOk };
