// What one tap sends (a note with no words): any single emoji, picked per person or group.
// Shared by the core, the main process and the panel, so it's written to load in all three.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Taps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const HEART = '❤️';
  // Titli 0.1.51 to 0.1.53 send and understand these four names, not emoji
  const NAMES = { heart: '❤️', hug: '🤗', wave: '👋', cheer: '🙌' };
  // the ones offered first; any other emoji works too
  const SUGGESTED = ['❤️', '👋', '🤗', '😘', '🙌', '😊'];
  // how the app talks about the common ones
  const WORDS = {
    '❤️': 'heart', '❤': 'heart', '♥️': 'heart', '♥': 'heart', '💖': 'heart', '💕': 'heart',
    '🤗': 'hug', '🫂': 'hug', '👋': 'wave', '🙌': 'cheer', '😘': 'kiss', '💋': 'kiss', '😚': 'kiss',
    '👍': 'thumbs up', '😊': 'smile', '🙂': 'smile', '🌸': 'flower', '🌷': 'flower', '🌹': 'rose',
    '🫶': 'heart hands', '☕': 'coffee', '🍫': 'chocolate', '🎉': 'party', '🙏': 'thank you', '💪': 'flex', '⭐': 'star'
  };
  const PLURAL = new Set(['heart hands']);
  // control characters and invisible or right-to-left marks; the joiner and variation selectors that build emoji are fine
  const HIDDEN = /[\u0000-\u001f\u007f-\u009f­؜᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/;
  const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|⃣/u;
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const plain = e => e.replace(/[\u{1f3fb}-\u{1f3ff}]/gu, '');   // 👋🏽 is still a wave

  // exactly one emoji (a flag, a skin tone or a family counts as one), or one of the old names; otherwise null
  function emojiOf(x) {
    if (typeof x !== 'string') return null;
    if (own(NAMES, x)) return NAMES[x];
    const s = x.trim();
    if (!s || s.length > 32 || HIDDEN.test(s) || !PICTURE.test(s)) return null;
    if (/[\p{L}\p{Z}]/u.test(s)) return null;                        // no words or spaces
    if (/\p{M}/u.test(s.replace(/[︎️⃣]/g, ''))) return null;   // no stacked accents
    if (segmenter) { let n = 0; for (const _ of segmenter.segment(s)) if (++n > 1) return null; }
    return s;
  }
  // the first emoji someone typed or pasted
  function firstEmoji(text) {
    if (typeof text !== 'string' || !segmenter) return emojiOf(text);
    for (const { segment } of segmenter.segment(text)) { const e = emojiOf(segment); if (e) return e; }
    return null;
  }
  const isHeart = e => WORDS[emojiOf(e) || HEART] === 'heart';
  // the name an older Titli understands: the same gesture when there is one, otherwise a heart
  function legacyName(e) {
    e = plain(emojiOf(e) || HEART);
    for (const [k, v] of Object.entries(NAMES)) if (v === e) return k;
    return 'heart';
  }
  const word = e => { e = emojiOf(e); return e && own(WORDS, plain(e)) ? WORDS[plain(e)] : null; };
  // "A heart", "A kiss", "Heart hands"; null when there's no word for it
  function label(e) {
    const w = word(e);
    if (!w) return null;
    return PLURAL.has(w) ? w[0].toUpperCase() + w.slice(1) : `A ${w}`;
  }
  // the big button on the Send tab
  function button(e, name) {
    const w = word(e);
    if (w === 'wave') return `Wave at ${name}`;
    if (w === 'cheer') return `Cheer ${name} on`;
    if (w) return `Send ${PLURAL.has(w) ? w : 'a ' + w} to ${name}`;
    return `Send to ${name}`;
  }
  return { HEART, NAMES, SUGGESTED, emojiOf, firstEmoji, isHeart, legacyName, word, label, button };
});
