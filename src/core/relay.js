'use strict';
// Talks to an ntfy server (https://ntfy.sh by default, or a self-hosted one).
// One long-lived JSON stream covers every topic we listen to. ntfy keeps messages for 12 hours,
// so after sleep or a dropped connection we reconnect with since=<last time we heard from it>.

const { EventEmitter } = require('events');

const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000];
const WATCHDOG_MS = 80000; // ntfy sends a keepalive every 45s

class NtfyRelay extends EventEmitter {
  constructor({ server = 'https://ntfy.sh', fetchImpl = globalThis.fetch, now = () => Date.now(), watchdogMs = WATCHDOG_MS } = {}) {
    super();
    this.server = server.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.now = now;
    this.watchdogMs = watchdogMs;
    this.topics = new Map();   // topic -> since (unix seconds) for that topic
    this.caught = new Map();   // topic -> time up to which we were connected and listening
    this.status = 'idle';
    this.clockOffset = 0;      // this computer's clock minus the relay's, when it's off by minutes or more
    this._ctrl = null;
    this._stopped = true;
    this._attempt = 0;
    this._loop = null;
    this._wake = null;
  }

  setServer(server) {
    const s = String(server || '').replace(/\/+$/, '');
    if (!s || s === this.server) return;
    this.server = s; this.restart();
  }

  // topics: Map or object of topic -> since (unix seconds)
  setTopics(entries) {
    const next = new Map(entries instanceof Map ? entries : Object.entries(entries || {}));
    const same = next.size === this.topics.size && [...next.keys()].every(t => this.topics.has(t));
    for (const [t, since] of next) if (!this.topics.has(t) || this.topics.get(t) > since) this.topics.set(t, since);
    for (const t of [...this.topics.keys()]) if (!next.has(t)) { this.topics.delete(t); this.caught.delete(t); }
    if (!same) this.restart();
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._loop = this._run();
  }

  stop() {
    this._stopped = true;
    if (this._ctrl) this._ctrl.abort();
    if (this._wake) this._wake();
    this._setStatus('idle');
  }

  // drop the current stream and reconnect straight away (topics changed, woke from sleep, network back)
  restart() {
    this._attempt = 0;
    if (this._ctrl) this._ctrl.abort();
    if (this._wake) this._wake();
  }

  async publish(topic, body) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await this.fetch(`${this.server}/${topic}`, {
          method: 'POST', body,
          headers: { 'Content-Type': 'text/plain', 'X-Firebase': 'no', 'X-Cache': 'yes' }
        });
        if (res.status === 429) throw new Error('The relay is busy. Trying again shortly.');
        if (!res.ok) throw new Error(`Relay returned ${res.status}`);
        const j = await res.json().catch(() => ({}));
        return j;
      } catch (e) {
        lastErr = e;
        await sleep(600 * (i + 1));
      }
    }
    throw lastErr;
  }

  // each topic resumes from where we were last listening (or from when we started caring about it)
  _since() {
    let since = Infinity;
    for (const [t, s] of this.topics) since = Math.min(since, Math.max(s, (this.caught.get(t) || 0) - 5));
    if (!isFinite(since)) since = this._serverNowSec();
    // a clock set fast makes "since" land in the future, and the relay would hold back everything
    return Math.max(0, Math.floor(Math.min(since, this._serverNowSec())));
  }

  // how far back to remember for a topic we are about to add
  persistState() { return Object.fromEntries(this.caught); }
  restoreState(obj) { for (const [t, v] of Object.entries(obj || {})) if (typeof v === 'number') this.caught.set(t, v); }

  _setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }

  async _run() {
    while (!this._stopped) {
      if (!this.topics.size) { this._setStatus('idle'); await this._pause(60000); continue; }
      const ctrl = new AbortController(); this._ctrl = ctrl;
      let watchdog;
      const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs); };
      try {
        const url = `${this.server}/${[...this.topics.keys()].join(',')}/json?since=${this._since()}`;
        kick();
        const res = await this.fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/x-ndjson' } });
        if (!res.ok || !res.body) throw new Error(`Relay returned ${res.status}`);
        this._setStatus('online'); this._attempt = 0;
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line) this._line(line);
          }
        }
      } catch (e) {
        if (this._stopped) break;
        if (!ctrl.signal.aborted || e.name !== 'AbortError') this.emit('warn', e);
      } finally {
        clearTimeout(watchdog);
      }
      if (this._stopped) break;
      if (ctrl.signal.aborted && this._attempt === 0) { this._attempt = 1; continue; } // deliberate restart
      this._setStatus('offline');
      const wait = BACKOFF[Math.min(this._attempt++, BACKOFF.length - 1)];
      await this._pause(wait);
    }
  }

  _line(line) {
    let m; try { m = JSON.parse(line); } catch (e) { return; }
    // the relay says what time it is on every connect and keepalive: that's how we notice a computer clock set wrong
    if ((m.event === 'open' || m.event === 'keepalive') && Number.isFinite(m.time) && m.time > 0) this._clock(m.time);
    if (m.event === 'open') return;
    if (m.event === 'keepalive') {
      const t = m.time || Math.floor(this.now() / 1000);
      for (const topic of this.topics.keys()) if ((this.caught.get(topic) || 0) < t) this.caught.set(topic, t);
      this.emit('caught');
      return;
    }
    if (m.event !== 'message' || !m.topic || typeof m.message !== 'string') return;
    const since = this.topics.get(m.topic);
    if (since === undefined || (m.time && m.time < Math.min(since, this._serverNowSec()) - 5)) return;
    if (m.time && (this.caught.get(m.topic) || 0) < m.time) this.caught.set(m.topic, m.time);
    this.emit('message', { id: m.id, time: m.time, topic: m.topic, body: m.message });
  }

  // how far this computer's clock is from the relay's (ms; positive = ahead). Small differences don't count:
  // the relay only gives whole seconds, and the trip takes a moment.
  _clock(serverSec) {
    const off = this.now() - serverSec * 1000;
    const next = Math.abs(off) < 2 * 60 * 1000 ? 0 : Math.round(off / 1000) * 1000;
    if (Math.abs(next - this.clockOffset) >= 60 * 1000 || (next === 0) !== (this.clockOffset === 0)) {
      this.clockOffset = next;
      this.emit('clock', next);
    }
  }

  _serverNowSec() { return Math.floor((this.now() - this.clockOffset) / 1000); }

  _pause(ms) {
    return new Promise(res => {
      const t = setTimeout(() => { this._wake = null; res(); }, ms);
      this._wake = () => { clearTimeout(t); this._wake = null; res(); };
    });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { NtfyRelay };
