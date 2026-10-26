(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const api = window.titli;

  let S = null;            // latest state from the main process
  let view = null;         // welcome1 | welcome2 | main | settings | quick | sched
  let tab = 'send';
  let toKey = null;        // who the Send tab sends to
  let pairStep = false;    // first run, step 2
  let menuFor = null, confirming = null;   // People row options
  let sf = null;           // the schedule form: { id, circleId, repeat, confirmDelete }
  let flash = null;        // { key, until }: the quick note that was just sent
  let actSeenBefore = 0;   // newest received item when Activity was last opened
  let relayOpen = false;
  let askedInvite = false;

  /* ---------- small helpers ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  function icon(id, cls) {
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    if (id === 'bfly') s.setAttribute('viewBox', '0 0 40 34');
    const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#' + id); s.append(u);
    return s;
  }
  const timeStr = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtHM = hm => { const [h, m] = String(hm).split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return timeStr(d.getTime()); };
  const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const daysFromToday = ms => Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86400000);
  function dayLabel(ms) {
    const n = daysFromToday(ms);
    if (n === 0) return 'Today';
    if (n === -1) return 'Yesterday';
    return new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  }
  function whenLabel(ms) {
    const n = daysFromToday(ms);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    return new Date(ms).toLocaleDateString([], { weekday: 'long' });
  }
  const shortDate = ms => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  // deep enough for white initials to read clearly
  const COLORS = ['#4F6DBF', '#B5405F', '#2F7F63', '#7655B8', '#8F6420', '#3A73A6', '#94428A', '#A84A63'];
  const colorFor = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const initial = name => (Array.from(String(name || '?').trim())[0] || '?').toUpperCase();

  function avatar({ name, group, count }, size) {
    const a = el('span', 'av' + (size ? ' ' + size : '') + (group ? ' grp' : ''));
    if (group) {
      a.textContent = String(count);
      if (!size) { const b = el('span', 'grp-badge'); b.append(icon('i-users')); a.append(b); }
    } else {
      a.textContent = initial(name);
      a.style.background = colorFor(name);
    }
    return a;
  }
  const circleAv = (c, size) => avatar({ name: c.name, group: c.kind === 'group', count: c.members.length + 1 }, size);
  const sendable = () => S.circles.filter(c => c.members.length);

  /* ---------- feedback ---------- */
  let toastTimer;
  function toast(text, sub = '') {
    const t = $('#toast');
    $('#toastText').textContent = text;
    $('#toastSub').textContent = sub;
    t.hidden = false;
    t.style.animation = 'none'; void t.offsetHeight; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const showErr = (id, msg) => { const e = $(id); e.textContent = msg; e.hidden = false; };
  const clearErr = id => { $(id).hidden = true; };
  async function call(method, ...args) {
    try { return (await api.call(method, ...args)) || { ok: false }; }
    catch (e) { return { ok: false, error: 'Something went wrong. Please try again.' }; }
  }
  const copy = (text, what) => { api.ui('copy', text); toast(`${what} copied`, 'Paste it in WhatsApp'); };

  const STORE_KEY = 'titli.activitySeen';
  const readSeen = () => { try { return Number(localStorage.getItem(STORE_KEY)) || 0; } catch (e) { return 0; } };
  const writeSeen = v => { try { localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* not kept */ } };
  const newestReceived = () => S.received.reduce((m, r) => Math.max(m, r.at || 0), 0);

  /* ---------- views and tabs ---------- */
  const VIEWS = { welcome1: '#welcome1', welcome2: '#welcome2', main: '#main', settings: '#page-settings', quick: '#page-quick', sched: '#page-sched' };
  function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
  function show(v) {
    if (v !== view) hideToast();
    view = v;
    for (const [k, sel] of Object.entries(VIEWS)) $(sel).hidden = k !== v;
  }

  const tabs = $$('.tab');
  function selectTab(id, focus) {
    if (id !== tab) hideToast();
    tab = id;
    tabs.forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    $$('.tabpanel').forEach(p => { p.hidden = p.id !== 'tab-' + id; });
    $('#mainScroll').scrollTop = 0;
    if (id === 'activity' && S) { actSeenBefore = readSeen(); writeSeen(newestReceived()); renderActivity(); }
    if (S) renderTabDot();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(n.dataset.tab, true);
    });
  });

  function openPage(v) { show(v); render(); const s = $(VIEWS[v] + ' .scroll'); if (s) s.scrollTop = 0; }
  function goBack() {
    const from = view;
    sf = null;
    show('main');
    if (from === 'quick') selectTab('send');
    else if (from === 'sched') selectTab('schedule');
    render();
  }
  $$('[data-back]').forEach(b => b.addEventListener('click', goBack));
  $('#openSettings').addEventListener('click', () => openPage('settings'));

  /* ---------- rendering ---------- */
  function render() {
    if (!S) return;
    if (!S.me.name) { show('welcome1'); return; }
    if (pairStep && sendable().length) {
      pairStep = false;
      view = 'main'; selectTab('send');
      toast(`You and ${sendable()[0].name} are paired`);
    }
    if (pairStep) { show('welcome2'); renderWelcome2(); return; }
    if (!view || view === 'welcome1' || view === 'welcome2') view = 'main';
    show(view);
    renderStatus(); renderUpdate(); renderSend(); renderActivity(); renderSchedule(); renderPeople(); renderSettings(); renderQuickEdit();
    if (view === 'sched' && sf) renderSf();
    if (view === 'main' && tab === 'activity') writeSeen(newestReceived());
    renderTabDot();
  }

  function renderStatus() {
    const st = $('#status');
    st.className = 'status';
    let t = 'Ready';
    if (S.relayStatus === 'offline') { st.classList.add('off'); t = 'Offline · butterflies go when you’re back online'; }
    else if (S.presence && S.presence.busy) { st.classList.add('hold'); t = `Holding butterflies · ${S.presence.text || 'you’re busy'}`; }
    else if (S.inboxCount) t = S.inboxCount === 1 ? 'A butterfly is on its way to you' : `${S.inboxCount} butterflies on the way to you`;
    $('#statusText').textContent = t;
  }

  function renderTabDot() {
    const on = !(view === 'main' && tab === 'activity') && newestReceived() > readSeen();
    $('#actDot').hidden = !on;
    $('#t-activity').setAttribute('aria-label', on ? 'Activity, something new' : 'Activity');
  }

  function renderToRow(box, list, selected, onPick) {
    box.textContent = '';
    for (const c of list) {
      const b = btn('to');
      b.setAttribute('aria-pressed', String(c.id === selected));
      b.title = c.kind === 'group' ? `${c.name}, a group of ${c.members.length + 1}` : c.name;
      b.append(circleAv(c), el('span', 'to-name', c.name));
      b.addEventListener('click', () => onPick(c.id));
      box.append(b);
    }
  }

  /* Updates */
  let lastUpdateErr = null;
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const mb = n => `${Math.max(1, Math.round(n / 1048576))} MB`;
  function renderUpdate() {
    const u = S.update || { status: 'dev', current: S.version };
    const pct = Math.round((u.progress || 0) * 100);
    // header pill: one click updates
    const pill = $('#updatePill');
    pill.hidden = !['available', 'downloading', 'installing'].includes(u.status);
    pill.disabled = u.status !== 'available';
    $('#updatePillText').textContent = u.status === 'downloading' ? `Updating ${pct}%` : u.status === 'installing' ? 'Restarting…' : 'Update';
    pill.setAttribute('aria-label', u.status === 'available' ? `Update Titli to ${u.latest}` : $('#updatePillText').textContent);
    pill.title = u.status === 'available' ? `Titli ${u.latest} is ready` : '';
    // Settings row
    const b = $('#upBtn');
    let title = `Titli ${u.current || S.version || ''}`, text = '', label = 'Check now', primary = false, disabled = false;
    switch (u.status) {
      case 'dev': text = 'Updates work in the installed app.'; break;
      case 'idle': text = 'Titli checks for updates on its own.'; break;
      case 'checking': text = 'Checking…'; label = 'Checking…'; disabled = true; break;
      case 'uptodate': text = `Up to date · checked ${ago(u.checkedAt)}`; break;
      case 'available': title = `Titli ${u.latest} is ready`; text = (u.notes ? u.notes + ' · ' : '') + mb(u.size); label = 'Update'; primary = true; break;
      case 'downloading': title = `Getting Titli ${u.latest}`; text = `Downloading… ${pct}%`; label = 'Updating'; primary = true; disabled = true; break;
      case 'installing': title = `Installing Titli ${u.latest}`; text = 'Titli will close and open again by itself.'; label = 'Restarting…'; primary = true; disabled = true; break;
      case 'error': text = 'Couldn’t check for updates.'; label = 'Try again'; break;
      default:
    }
    $('#upTitle').textContent = title;
    $('#upText').textContent = text;
    b.textContent = label;
    b.className = primary ? 'btn primary pill' : 'btn chip';
    b.disabled = disabled;
    b.hidden = u.status === 'dev';
    $('#upProgress').hidden = !(u.status === 'downloading' || u.status === 'installing');
    $('#upBar').style.width = `${pct}%`;
    const err = $('#upErr');
    err.hidden = !u.error;
    err.textContent = u.error || '';
    if (u.error && u.error !== lastUpdateErr && view === 'main') toast(u.error);
    lastUpdateErr = u.error || null;
  }
  const startUpdate = () => { if (S && S.update && S.update.status === 'available') api.ui('installUpdate'); };
  $('#updatePill').addEventListener('click', startUpdate);
  $('#upBtn').addEventListener('click', () => {
    const st = S && S.update && S.update.status;
    if (st === 'available') startUpdate(); else api.ui('checkUpdate');
  });

  /* Send */
  function renderSend() {
    const list = sendable();
    $('#sendEmpty').hidden = list.length > 0;
    $('#sendArea').hidden = list.length === 0;
    if (!list.some(c => c.id === toKey)) toKey = (list.find(c => c.id === S.lastTo) || list[0] || {}).id || null;
    renderToRow($('#toRow'), list, toKey, id => { toKey = id; renderSend(); });
    const c = list.find(x => x.id === toKey);
    $('#heartLabel').textContent = c ? `Send a heart to ${c.name}` : 'Send a heart';
    renderQuick();
    renderCompose();
  }

  function renderQuick() {
    const box = $('#qnGrid');
    box.textContent = '';
    if (!S.quick.length) {
      box.append(el('p', 'qn-empty', 'Notes you send often live here. Write one below and tap “Keep as a quick note”.'));
      return;
    }
    S.quick.forEach((q, i) => {
      const b = btn('qn');
      b.setAttribute('aria-label', `Send “${q}”` + (i < 9 ? `. Key ${i + 1}` : ''));
      b.append(el('span', 'qn-text', q));
      if (i < 9) b.append(el('kbd', '', String(i + 1)));
      const tick = el('span', 'qn-tick'); tick.append(icon('i-check')); b.append(tick);
      if (flash && flash.key === 'q:' + q && Date.now() < flash.until) b.classList.add('sent');
      b.addEventListener('click', () => sendNote(q));
      box.append(b);
    });
  }

  const newNote = $('#newNote');
  function renderCompose() {
    const n = Array.from(newNote.value).length, has = newNote.value.trim().length > 0;
    $('#count').hidden = n === 0;
    $('#count').textContent = `${n}/60`;
    $('#sendNew').disabled = !has;
    $('#keepNote').hidden = !has;
  }

  async function sendNote(text, { viaKey = false } = {}) {
    clearErr('#sendErr');
    if (!toKey) { selectTab('people'); return false; }
    const c = S.circles.find(x => x.id === toKey);
    const r = await call('send', { circleId: toKey, text, style: S.settings.style });
    if (!r.ok) { showErr('#sendErr', r.error || 'That didn’t send. Please try again.'); return false; }
    flash = { key: text == null ? 'heart' : 'q:' + text, until: Date.now() + 1400 };
    renderQuick();
    setTimeout(() => { if (S) renderQuick(); }, 1450);
    if (text == null) { const h = $('#heartBtn'); h.classList.remove('sent'); void h.offsetWidth; h.classList.add('sent'); }
    toast(`On its way to ${c ? c.name : 'them'}`, viaKey ? 'Closes in a moment' : '');
    return true;
  }

  $('#heartBtn').addEventListener('click', () => sendNote(null));
  newNote.addEventListener('input', () => { renderCompose(); clearErr('#sendErr'); });
  newNote.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#sendNew').click(); } });
  $('#sendNew').addEventListener('click', async () => {
    const v = newNote.value.trim();
    if (!v) return;
    if (await sendNote(v)) { newNote.value = ''; renderCompose(); }
  });
  $('#keepNote').addEventListener('click', async () => {
    const r = await call('addQuick', newNote.value);
    if (!r.ok) return showErr('#sendErr', r.error);
    newNote.value = ''; renderCompose();
    toast('Kept as a quick note', 'Tap it any time');
  });
  $('#editQuick').addEventListener('click', () => openPage('quick'));
  $('#emptyInvite').addEventListener('click', async () => {
    selectTab('people');
    if (!S.invites.length) await call('createInvite');
  });
  $('#emptyHaveCode').addEventListener('click', () => { selectTab('people'); setTimeout(() => $('#joinCode').focus(), 30); });

  /* Activity */
  function renderActivity() {
    const box = $('#actList');
    box.textContent = '';
    const items = [
      ...S.sent.map(m => ({ out: true, at: m.at, m })),
      ...S.received.map(r => ({ out: false, at: r.at, r }))
    ].sort((a, b) => b.at - a.at).slice(0, 30);
    $('#actLegend').hidden = !items.length;
    if (!items.length) { box.append(el('p', 'empty-note', 'Butterflies you send and receive will show up here.')); return; }

    let group = null, ul = null;
    for (const it of items) {
      const label = dayLabel(it.at);
      if (label !== group) {
        group = label;
        const sec = el('section', 'act-group');
        sec.append(el('h2', 'lbl', label));
        ul = el('ul', 'list');
        sec.append(ul); box.append(sec);
      }
      ul.append(it.out ? sentItem(it.m) : receivedItem(it.r));
    }
  }

  function noteLine(text, kind) {
    const n = el('span', 'act-note');
    if (kind === 'visit') n.append(icon('bfly', 'bf'), document.createTextNode('A butterfly back'));
    else if (text == null) n.append(icon('i-heart', 'heart'), document.createTextNode('A heart'));
    else n.textContent = text;
    return n;
  }
  function badge(out) { const b = el('span', 'badge ' + (out ? 'out' : 'in')); b.append(icon(out ? 'i-up' : 'i-down')); return b; }

  function sentItem(m) {
    const li = el('li', 'act');
    const c = S.circles.find(x => x.id === m.circleId);
    const wrap = el('span', 'act-av');
    wrap.append(c ? circleAv(c, 'sm') : avatar({ name: m.to }, 'sm'), badge(true));
    const body = el('div', 'act-body');
    body.append(noteLine(m.text));
    const meta = el('span', 'act-meta');
    if (m.scheduled) { const ic = icon('i-clock', 'clock'); meta.append(ic); }
    meta.append(document.createTextNode(`To ${m.to} · ${timeStr(m.at)}${m.scheduled ? ' · scheduled' : ''} ·`));
    const st = el('span', 'stat ' + m.status.cls);
    if (m.status.cls === 'seen') st.append(icon('i-check'));
    st.append(document.createTextNode(m.status.text));
    meta.append(st);
    body.append(meta);
    li.append(wrap, body);
    if (m.status.extra) { const p = el('span', 'react-pill', m.status.extra); p.title = 'Their reaction'; li.append(p); }
    return li;
  }

  function receivedItem(r) {
    const li = el('li', 'act');
    const wrap = el('span', 'act-av');
    wrap.append(avatar({ name: r.fromName }, 'sm'), badge(false));
    const body = el('div', 'act-body');
    body.append(noteLine(r.text, r.kind));
    let meta = `From ${r.fromName}${r.circleName ? ' in ' + r.circleName : ''} · ${timeStr(r.at)}`;
    if (r.kind === 'visit' && r.text) meta += ` · for “${r.text}”`;
    if (r.react) meta += ` · you sent ${r.react === 'butterfly' ? 'a butterfly back' : r.react}`;
    body.append(el('span', 'act-meta', meta));
    li.append(wrap, body);
    if (actSeenBefore && r.at > actSeenBefore) { const d = el('span', 'new-dot'); d.title = 'New'; li.append(d); }
    return li;
  }

  /* Schedule */
  const REP = { once: 'Once', daily: 'Every day', weekdays: 'Weekdays' };
  function renderSchedule() {
    const ul = $('#schedList');
    ul.textContent = '';
    const list = S.schedules.slice().sort((a, b) => a.time.localeCompare(b.time));
    $('#schedHint').hidden = !list.length;
    if (!list.length) ul.append(el('li', 'empty-note', 'Nothing scheduled yet. “Drink some water” every day at 11 is a nice start.'));
    for (const s of list) {
      const isNext = S.next && S.next.id === s.id;
      const li = el('li', 'sch' + (isNext ? ' next' : '') + (s.on ? '' : ' off'));
      const b = btn('sch-btn');
      b.setAttribute('aria-label', `${fmtHM(s.time)}, ${s.text || 'a heart'}, ${REP[s.repeat]} to ${s.to}. Change it`);
      const body = el('span', 'sch-body');
      const note = el('span', 'sch-note');
      if (s.text == null) note.append(icon('i-heart'), document.createTextNode('A heart')); else note.textContent = s.text;
      body.append(note, el('span', 'sch-meta', `${REP[s.repeat]} · to ${s.to}${s.on ? '' : ' · Paused'}`));
      if (isNext) body.append(el('span', 'next-tag', `Next · ${whenLabel(S.next.when)}`));
      b.append(el('span', 'sch-time', fmtHM(s.time)), body);
      b.addEventListener('click', () => openSchedForm(s));
      const sw = el('label', 'switch');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.on;
      cb.setAttribute('aria-label', `${fmtHM(s.time)} ${s.text || 'heart'}, ${s.on ? 'on' : 'paused'}`);
      cb.addEventListener('change', () => call('updateSchedule', s.id, { on: cb.checked }));
      sw.append(cb, el('span', 'track'));
      li.append(b, sw);
      ul.append(li);
    }
  }

  function nextHour() { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return `${String(d.getHours()).padStart(2, '0')}:00`; }

  function openSchedForm(s) {
    clearErr('#schedListErr');
    const list = sendable();
    if (!s && !list.length) { showErr('#schedListErr', 'Pair with someone first, then you can schedule butterflies to them.'); return; }
    sf = s ? { id: s.id, circleId: s.circleId, repeat: s.repeat, confirmDelete: false }
           : { id: null, circleId: toKey || list[0].id, repeat: 'daily', confirmDelete: false };
    $('#schedTitle').textContent = s ? 'Edit scheduled butterfly' : 'New scheduled butterfly';
    $('#sfSave').textContent = s ? 'Save changes' : 'Schedule it';
    $('#sfEditBtns').hidden = !s;
    $('#sfDelete').textContent = 'Delete';
    const sel = $('#sfNote');
    sel.textContent = '';
    const opt = (v, label) => { const o = el('option', '', label); o.value = v; sel.append(o); };
    opt('__heart', '♥  A heart');
    S.quick.forEach(q => opt('q:' + q, q));
    if (s && s.text != null && !S.quick.includes(s.text)) opt('q:' + s.text, s.text);
    opt('__new', 'Write a new note…');
    sel.value = s ? (s.text == null ? '__heart' : 'q:' + s.text) : (S.quick.includes('Drink some water') ? 'q:Drink some water' : (S.quick[0] ? 'q:' + S.quick[0] : '__heart'));
    $('#sfCustom').value = '';
    $('#sfCustom').hidden = true;
    $('#sfTime').value = s ? s.time : nextHour();
    clearErr('#sfErr');
    openPage('sched');
  }

  function renderSf() {
    let list = sendable();
    const cur = S.circles.find(c => c.id === sf.circleId);
    if (cur && !list.includes(cur)) list = [cur, ...list];
    if (!cur && list[0]) sf.circleId = list[0].id;
    renderToRow($('#sfTo'), list, sf.circleId, id => { sf.circleId = id; renderSf(); });
    $$('#sfRepeat button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === sf.repeat)));
    const c = S.circles.find(x => x.id === sf.circleId);
    const t = $('#sfTime').value ? fmtHM($('#sfTime').value) : 'that time';
    $('#sfHelp').textContent = !c ? '' : c.kind === 'group'
      ? `Anyone in ${c.name} who’s on a call at ${t} gets it when they’re free.`
      : `If ${c.name} is on a call at ${t}, it waits until they’re free.`;
  }

  $('#newSched').addEventListener('click', () => openSchedForm(null));
  $('#sfNote').addEventListener('change', () => {
    const custom = $('#sfNote').value === '__new';
    $('#sfCustom').hidden = !custom;
    if (custom) $('#sfCustom').focus();
    clearErr('#sfErr');
  });
  $('#sfTime').addEventListener('input', () => { if (sf) renderSf(); });
  $$('#sfRepeat button').forEach(b => b.addEventListener('click', () => { if (!sf) return; sf.repeat = b.dataset.r; renderSf(); }));
  $('#sfSave').addEventListener('click', async () => {
    if (!sf) return;
    clearErr('#sfErr');
    const v = $('#sfNote').value;
    let text = null;
    if (v === '__new') { text = $('#sfCustom').value.trim(); if (!text) return showErr('#sfErr', 'Write the note you want to schedule.'); }
    else if (v.startsWith('q:')) text = v.slice(2);
    const time = $('#sfTime').value;
    if (!time) return showErr('#sfErr', 'Pick a time.');
    const payload = { text, circleId: sf.circleId, time, repeat: sf.repeat };
    const editing = !!sf.id;
    const r = editing ? await call('updateSchedule', sf.id, payload) : await call('addSchedule', payload);
    if (!r.ok) return showErr('#sfErr', r.error || 'That didn’t save. Please try again.');
    goBack();
    toast(editing ? 'Schedule saved' : `Scheduled for ${fmtHM(time)}`, REP[payload.repeat]);
  });
  $('#sfNow').addEventListener('click', async () => {
    if (!sf || !sf.id) return;
    const r = await call('sendScheduleNow', sf.id);
    if (!r.ok) return showErr('#sfErr', r.error || 'That didn’t send.');
    const c = S.circles.find(x => x.id === sf.circleId);
    toast(`On its way to ${c ? c.name : 'them'}`);
  });
  $('#sfDelete').addEventListener('click', async () => {
    if (!sf || !sf.id) return;
    if (!sf.confirmDelete) { sf.confirmDelete = true; $('#sfDelete').textContent = 'Tap again to delete'; return; }
    await call('removeSchedule', sf.id);
    goBack();
    toast('Schedule deleted');
  });

  /* People */
  function renderPeople() {
    const ul = $('#conns');
    ul.textContent = '';
    $('#peopleSect').hidden = !S.circles.length;
    for (const c of S.circles) {
      const li = el('li', 'conn');
      const body = el('span', 'conn-body');
      body.append(el('span', 'conn-name', c.name));
      let meta;
      if (c.kind === 'group') meta = c.members.length ? `Group · you, ${c.members.join(', ')}` : 'Group · no one has joined yet';
      else meta = c.createdAt ? `Just you two · paired ${shortDate(c.createdAt)}` : 'Just you two';
      body.append(el('span', 'conn-meta', meta));
      const more = btn('icon-btn');
      more.append(icon('i-more'));
      more.setAttribute('aria-label', `Options for ${c.name}`);
      more.setAttribute('aria-expanded', String(menuFor === c.id));
      more.title = 'Options';
      more.addEventListener('click', () => { menuFor = menuFor === c.id ? null : c.id; confirming = null; renderPeople(); });
      li.append(circleAv(c, 'md'), body, more);
      if (menuFor === c.id) li.append(connActions(c));
      ul.append(li);
    }

    const card = $('#inviteCard');
    card.textContent = '';
    const inv = S.invites[S.invites.length - 1];
    if (inv) {
      card.append(el('span', 'card-title', 'Share this code with them'));
      const row = el('div', 'code-row');
      const cp = btn('btn primary pill'); cp.append(icon('i-copy'), document.createTextNode('Copy'));
      cp.addEventListener('click', () => copy(inv.code, 'Invite code'));
      row.append(el('span', 'code', inv.code), cp);
      card.append(row);
      const foot = el('div', 'row-head');
      foot.append(el('span', 'hint', 'They enter it in their Titli. Works once, for 24 hours.'));
      const cancel = btn('link', 'Cancel');
      cancel.setAttribute('aria-label', `Cancel invite code ${inv.code}`);
      cancel.addEventListener('click', () => call('cancelInvite', inv.code));
      foot.append(cancel);
      card.append(foot);
    } else {
      card.append(el('span', 'card-title', 'Invite someone'), el('span', 'hint', 'Make a one-time code and send it to them on WhatsApp.'));
      const mk = btn('btn primary pill', 'Make a code');
      mk.style.alignSelf = 'flex-start';
      mk.addEventListener('click', () => call('createInvite'));
      card.append(mk);
    }

    const jl = $('#joiningList');
    jl.textContent = '';
    for (const j of S.joining) {
      const li = el('li');
      li.append(el('span', 'dot warn'), document.createTextNode(`Waiting for ${j.code.slice(0, 9)}… to answer. It connects once their Titli is online.`));
      jl.append(li);
    }
  }

  function connActions(c) {
    const box = el('div', 'conn-actions');
    const isGroup = c.kind === 'group';
    if (confirming === c.id) {
      box.append(el('p', 'ask', isGroup ? `Leave ${c.name}? You’ll stop getting its butterflies.` : `Unpair from ${c.name}? You won’t be able to send each other butterflies.`));
      const yes = btn('btn outline danger', isGroup ? 'Leave' : 'Unpair');
      yes.addEventListener('click', async () => {
        menuFor = null; confirming = null;
        const r = await call('leave', c.id);
        if (r.ok) toast(isGroup ? `You left ${c.name}` : `You and ${c.name} are unpaired`);
      });
      const no = btn('btn outline', 'Keep');
      no.addEventListener('click', () => { confirming = null; renderPeople(); });
      box.append(yes, no);
      return box;
    }
    if (isGroup && c.code) {
      const cp = btn('btn outline'); cp.append(icon('i-copy'), document.createTextNode('Copy group code'));
      cp.addEventListener('click', () => copy(c.code, 'Group code'));
      box.append(cp);
    }
    const leave = btn('btn outline danger', isGroup ? 'Leave group' : 'Unpair');
    leave.addEventListener('click', () => { confirming = c.id; renderPeople(); });
    box.append(leave);
    return box;
  }

  const joinInput = $('#joinCode');
  async function join(input, errId) {
    clearErr(errId);
    const r = await call('joinCode', input.value);
    if (!r.ok) return showErr(errId, r.error);
    input.value = '';
    toast(r.kind === 'group' ? 'You joined the group' : 'Code sent', r.kind === 'group' ? 'Its name shows once someone in it is online' : 'Pairing as soon as their Titli answers');
  }
  joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#joinBtn').addEventListener('click', () => join(joinInput, '#peopleErr'));
  $('#groupOpen').addEventListener('click', () => {
    $('#groupOpen').hidden = true; $('#groupFields').hidden = false; $('#groupHint').hidden = false;
    $('#groupName').focus();
  });
  $('#groupName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#groupBtn').click(); });
  $('#groupBtn').addEventListener('click', async () => {
    clearErr('#peopleErr');
    const r = await call('createGroup', $('#groupName').value);
    if (!r.ok) return showErr('#peopleErr', r.error);
    const name = $('#groupName').value.trim();
    $('#groupName').value = '';
    $('#groupOpen').hidden = false; $('#groupFields').hidden = true; $('#groupHint').hidden = true;
    api.ui('copy', r.code);
    toast(`${name} is ready`, 'Code copied');
  });

  /* Settings */
  function renderSettings() {
    const st = S.settings;
    if (document.activeElement !== $('#myName')) $('#myName').value = S.me.name;
    if (document.activeElement !== $('#relayUrl')) $('#relayUrl').value = st.relay;
    $('#relayVal').textContent = String(st.relay || '').replace(/^https?:\/\//, '');
    $('#relayFields').hidden = !relayOpen;
    $('#relayToggle').setAttribute('aria-expanded', String(relayOpen));
    $('#setMeetings').checked = st.holdInMeetings;
    $('#setAway').checked = st.holdWhenAway;
    $('#setNotify').checked = st.notifyReactions;
    $('#setLogin').checked = st.openAtLogin;
    $('#setCapture').checked = st.allowCapture;
    $$('.wing').forEach(w => w.setAttribute('aria-pressed', String(w.dataset.style === st.style)));
    $('#helperNote').textContent = S.presence && S.presence.helper === false
      ? 'Call detection starts with the installed app'
      : 'Camera or mic in use, or an app is full screen';
    $('#version').textContent = `Titli ${S.version || ''}${S.shortcut ? ` · ${S.shortcut} opens Titli` : ''}`;
  }

  async function saveName() {
    const v = $('#myName').value.trim();
    if (!v || v === S.me.name) { $('#myName').value = S.me.name; return; }
    const r = await call('setName', v);
    toast(r.ok ? 'Name saved' : (r.error || 'That didn’t save'));
  }
  $('#myName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#myName').blur(); } });
  $('#myName').addEventListener('change', saveName);
  $$('.wing').forEach(w => w.addEventListener('click', () => call('setSettings', { style: w.dataset.style })));
  const bindSwitch = (id, key) => $(id).addEventListener('change', e => call('setSettings', { [key]: e.target.checked }));
  bindSwitch('#setMeetings', 'holdInMeetings'); bindSwitch('#setAway', 'holdWhenAway'); bindSwitch('#setNotify', 'notifyReactions');
  bindSwitch('#setLogin', 'openAtLogin'); bindSwitch('#setCapture', 'allowCapture');
  $('#relayToggle').addEventListener('click', () => { relayOpen = !relayOpen; renderSettings(); if (relayOpen) $('#relayUrl').focus(); });
  $('#saveRelay').addEventListener('click', async () => {
    clearErr('#settingsErr');
    const r = await call('setSettings', { relay: $('#relayUrl').value });
    if (!r.ok) return showErr('#settingsErr', r.error);
    relayOpen = false; renderSettings();
    toast('Relay saved');
  });
  $('#previewBtn').addEventListener('click', () => api.ui('preview', S.quick[0] || 'Thinking of you'));
  $('#quitBtn').addEventListener('click', () => api.ui('quit'));

  /* Quick notes editor */
  let dragFrom = null;
  function renderQuickEdit() {
    const ul = $('#qeList');
    ul.textContent = '';
    $('#quickCount').textContent = `${S.quick.length} of 12`;
    if (!S.quick.length) ul.append(el('li', 'empty-note', 'No quick notes yet. Add one below.'));
    S.quick.forEach((q, i) => {
      const li = el('li', 'qe-item');
      li.draggable = true;
      const grip = btn('grip');
      grip.append(icon('i-grip'));
      grip.setAttribute('aria-label', `Move “${q}”, number ${i + 1}. Use the up and down arrow keys`);
      grip.addEventListener('keydown', e => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        moveQuick(i, i + (e.key === 'ArrowUp' ? -1 : 1), true);
      });
      const num = el('kbd', '', i < 9 ? String(i + 1) : '');
      if (i >= 9) num.style.visibility = 'hidden';
      const del = btn('qe-del');
      del.append(icon('i-trash'));
      del.setAttribute('aria-label', `Delete “${q}”`);
      del.title = 'Delete';
      del.addEventListener('click', () => call('removeQuick', q));
      li.append(grip, num, el('span', 'qe-text', q), del);
      li.addEventListener('dragstart', e => { dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      li.addEventListener('dragend', () => { dragFrom = null; $$('.qe-item').forEach(x => x.classList.remove('dragging', 'over')); });
      li.addEventListener('dragover', e => { if (dragFrom === null) return; e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', e => { e.preventDefault(); if (dragFrom !== null) moveQuick(dragFrom, i); });
      ul.append(li);
    });
  }

  async function moveQuick(from, to, refocus) {
    if (to < 0 || to >= S.quick.length || from === to) return;
    const list = S.quick.slice();
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    S.quick = list;
    renderQuickEdit(); renderQuick();
    if (refocus) { const g = $$('#qeList .grip')[to]; if (g) g.focus(); }
    await call('reorderQuick', list);
  }

  async function addFromEditor() {
    clearErr('#qeErr');
    const r = await call('addQuick', $('#qeNew').value);
    if (!r.ok) return showErr('#qeErr', r.error);
    $('#qeNew').value = '';
  }
  $('#qeAdd').addEventListener('click', addFromEditor);
  $('#qeNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFromEditor(); } });

  /* First run */
  $('#obSave').addEventListener('click', async () => {
    clearErr('#obErr');
    const r = await call('setName', $('#obName').value);
    if (!r.ok) return showErr('#obErr', r.error);
    pairStep = !(S && sendable().length);
    if (pairStep && !(S && S.invites.length)) { askedInvite = true; await call('createInvite'); }
  });
  $('#obName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#obSave').click(); });

  function renderWelcome2() {
    const inv = S.invites[S.invites.length - 1];
    if (!inv && !askedInvite) { askedInvite = true; call('createInvite'); }
    $('#w2Code').textContent = inv ? inv.code : '····-····-····-····';
    $('#w2Copy').disabled = !inv;
    $('#w2Status').lastChild.textContent = S.joining.length ? 'Waiting for their Titli to answer…' : 'Waiting for them to enter it…';
  }
  $('#w2Copy').addEventListener('click', () => { const inv = S.invites[S.invites.length - 1]; if (inv) copy(inv.code, 'Code'); });
  $('#w2Join').addEventListener('keydown', e => { if (e.key === 'Enter') $('#w2JoinBtn').click(); });
  $('#w2JoinBtn').addEventListener('click', () => join($('#w2Join'), '#w2Err'));
  $('#w2Later').addEventListener('click', () => { pairStep = false; view = 'main'; selectTab('send'); render(); });

  /* ---------- keyboard ---------- */
  // open with the shortcut, then 1–9 for a quick note or H for a heart; Esc goes back, then closes
  document.addEventListener('keydown', async e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (view === 'settings' || view === 'quick' || view === 'sched') goBack(); else api.ui('hide');
      return;
    }
    if (!S || view !== 'main' || tab !== 'send') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey || !sendable().length) return;
    let ok = false;
    if (/^[1-9]$/.test(e.key) && S.quick[+e.key - 1]) { e.preventDefault(); ok = await sendNote(S.quick[+e.key - 1], { viaKey: true }); }
    else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); ok = await sendNote(null, { viaKey: true }); }
    else return;
    if (ok) setTimeout(() => api.ui('hide'), 900);
  });

  /* ---------- state ---------- */
  selectTab('send');
  api.onState(s => { S = s; render(); });
  api.onOpened(() => {
    if (!S) return;
    if (view === 'main' && tab !== 'send') selectTab('send');
    if (!S.me.name) setTimeout(() => $('#obName').focus(), 50);
    else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  api.state().then(s => { S = s; render(); if (S && !S.me.name) $('#obName').focus(); });
})();
