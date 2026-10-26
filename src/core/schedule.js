'use strict';
// Which scheduled butterflies are due. A schedule fires once per day at its time.
// If the laptop was asleep or Titli was closed at that moment, it still fires on wake,
// as long as no more than an hour has passed.

const CATCH_UP_MS = 60 * 60 * 1000;

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

function at(day, hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(day); d.setHours(h, m, 0, 0); return d;
}

// returns the schedules that should fire now; lastCheck is when we last looked (ms)
function due(schedules, now, lastCheck) {
  const nowD = new Date(now);
  const from = Math.max(lastCheck || now - 60000, now - CATCH_UP_MS);
  const out = [];
  for (const s of schedules) {
    if (!s.on || !validTime(s.time)) continue;
    // check today and yesterday, so a check window that crosses midnight still works
    for (const offset of [0, -1]) {
      const day = new Date(nowD); day.setDate(day.getDate() + offset);
      const when = at(day, s.time).getTime();
      const wd = new Date(when).getDay();
      if (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
      if (when > now || when <= from - 1000) continue;
      if (s.last === dayKey(new Date(when))) continue;
      out.push({ schedule: s, day: dayKey(new Date(when)) });
      break;
    }
  }
  return out;
}

function nextRun(schedules, now) {
  let best = null;
  for (const s of schedules) {
    if (!s.on || !validTime(s.time)) continue;
    for (let offset = 0; offset < 8; offset++) {
      const day = new Date(now); day.setDate(day.getDate() + offset);
      const when = at(day, s.time).getTime();
      const wd = new Date(when).getDay();
      if (when <= now) continue;
      if (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
      if (!best || when < best.when) best = { schedule: s, when };
      break;
    }
  }
  return best;
}

module.exports = { due, nextRun, dayKey, validTime };
