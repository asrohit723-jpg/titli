'use strict';
// Decides when a waiting butterfly may land, plays one at a time, and pulls it away the moment
// a meeting, a screen share or a locked screen starts.

const presence = require('../core/presence');

class Delivery {
  constructor({ core, overlay, watcher, log = () => {} }) {
    this.core = core;
    this.overlay = overlay;
    this.watcher = watcher;
    this.log = log;
    this.playing = null;     // { id, shown }
    this._timer = null;
    this._cool = 0;
  }

  start() {
    this.core.on('inbox', () => this.tick());
    this.watcher.on('change', () => this.tick());
    this.overlay.on('event', ev => this._onOverlay(ev));
    this._timer = setInterval(() => this.tick(), 3000);
    setTimeout(() => this.tick(), 2500);
  }

  stop() { clearInterval(this._timer); }

  status() { return presence.evaluate(this.watcher.signals, this.core.s.settings); }

  tick() {
    const p = this.status();
    if (p.busy) {
      // a note already on screen can stay while you step away; anything else (a call, a share, a lock) hides it
      const keep = this.playing && this.playing.shown && p.reason === 'away';
      if (this.playing && !keep) { this.log('holding: ' + p.reason); this.overlay.abort(); }
      return;
    }
    if (this.playing || Date.now() < this._cool) return;
    const item = this.core.nextDelivery();
    if (!item) return;
    this.playing = { id: item.id, shown: false };
    this.overlay.play(item, { anywhere: this.core.s.settings.landAnywhere !== false }).catch(e => { this.log('overlay failed: ' + e.message); this.playing = null; });
  }

  _onOverlay(ev) {
    const cur = this.playing;
    switch (ev.type) {
      case 'shown':
        if (cur && ev.id === cur.id) { cur.shown = true; this.core.shown(ev.id); }
        break;
      case 'react':
        this.core.react(ev.id, ev.r);
        break;
      case 'done':
      case 'aborted':
        this.playing = null;
        this.overlay.hide();
        this._cool = Date.now() + (ev.type === 'done' ? 1500 : 4000);
        setTimeout(() => this.tick(), ev.type === 'done' ? 1600 : 4100);
        break;
      default:
    }
  }
}

module.exports = { Delivery };
