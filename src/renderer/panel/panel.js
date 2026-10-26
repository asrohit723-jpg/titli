(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const api = window.titli;

  let S = null;                       // latest state from the main process
  let toKey = null, listMode = 'sent', repeat = 'daily', confirming = null;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const timeStr = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayTime = ms => {
    const d = new Date(ms), today = new Date();
    return d.toDateString() === today.toDateString() ? timeStr(ms) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' · ' + timeStr(ms);
  };
  const fmtHM = hm => { const [h, m] = hm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return timeStr(d.getTime()); };
  const COLORS = ['#D9577A', '#B8863A', '#5E7CC9', '#8E6CC9', '#3F9A7A', '#C9657E', '#4F86B8', '#B05FA0'];
  const colorFor = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#xSym"/></svg>';

  /* ---------- feedback ---------- */
  let toastTimer;
  function toast(msg) { $('#toastText').textContent = msg; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
  const showErr = (id, msg) => { const e = $(id); e.textContent = msg; e.hidden = false; };
  const clearErr = id => { $(id).hidden = true; };
  async function call(method, ...args) { try { return (await api.call(method, ...args)) || { ok: false }; } catch (e) { return { ok: false, error: 'Something went wrong. Please try again.' }; } }
  const copy = (text, what) => { api.ui('copy', text); toast(`${what} copied. Paste it in WhatsApp or anywhere you like.`); };

  /* ---------- tabs ---------- */
  const tabs = $$('.tab');
  function selectTab(id, focus) {
    tabs.forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    $$('.tabpanel').forEach(p => { p.hidden = p.id !== 'tab-' + id; });
    $('.scroll').scrollTop = 0;
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; selectTab(n.dataset.tab, true);
    });
  });
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.goto)));
  selectTab('send');

  /* ---------- rendering ---------- */
  function sendable() { return S.circles.filter(c => c.members.length); }

  function render() {
    if (!S) return;
    const named = !!S.me.name;
    $('#onboard').hidden = named;
    $('#main').hidden = !named;
    renderStatus();
    if (!named) return;
    renderTo(); renderQuick(); renderRecent(); renderSchedule(); renderPeople(); renderSettings();
  }

  function renderStatus() {
    const st = $('#status');
    st.className = 'status';
    if (S.relayStatus === 'offline') { st.classList.add('off'); st.textContent = 'Offline · butterflies go out when you reconnect'; }
    else if (S.presence && S.presence.busy) { st.classList.add('hold'); st.textContent = `Holding butterflies · ${S.presence.text}`; }
    else st.textContent = S.inboxCount ? `${S.inboxCount} on the way to you` : (S.shortcut ? `Ready · ${S.shortcut} opens this anywhere` : 'Ready');
  }

  function avatarFor(c) {
    const a = el('span', 'av' + (c.kind === 'group' ? ' grp' : ''), c.kind === 'group' ? String(c.members.length + 1) : (c.name || '?')[0].toUpperCase());
    if (c.kind !== 'group') a.style.background = colorFor(c.name);
    return a;
  }

  function renderTo() {
    const list = sendable();
    $('#noPeople').hidden = list.length > 0;
    $('#sendArea').hidden = list.length === 0;
    if (!list.some(c => c.id === toKey)) toKey = (list.find(c => c.id === S.lastTo) || list[0] || {}).id || null;
    const box = $('#toChips'); box.textContent = '';
    for (const c of list) {
      const b = el('button', 'to'); b.type = 'button'; b.setAttribute('aria-pressed', String(c.id === toKey));
      b.append(avatarFor(c), el('span', '', c.name));
      b.addEventListener('click', () => { toKey = c.id; renderTo(); });
      box.append(b);
    }
    $$('.sw').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === S.settings.style)));
  }

  function renderQuick() {
    const box = $('#qnGrid'); box.textContent = '';
    if (!S.quick.length) box.append(el('p', 'helper', 'Save a short note below and it will live here.'));
    S.quick.forEach((q, i) => {
      const w = el('div', 'qn-item');
      const s = el('button', 'qn-send'); s.type = 'button';
      if (i < 9) s.append(el('span', 'qn-num', String(i + 1)));
      s.append(document.createTextNode(q));
      s.addEventListener('click', async () => { if (await sendNote(q)) { s.classList.add('sent'); setTimeout(() => s.classList.remove('sent'), 1200); } });
      const d = el('button', 'qn-del'); d.type = 'button'; d.setAttribute('aria-label', `Delete quick note: ${q}`); d.innerHTML = X_ICON;
      d.addEventListener('click', () => call('removeQuick', q));
      w.append(s, d); box.append(w);
    });
  }

  function renderRecent() {
    $$('.mini-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.list === listMode)));
    const ul = $('#recent'); ul.textContent = '';
    if (listMode === 'sent') {
      if (!S.sent.length) { ul.append(el('li', 'empty', 'Nothing sent yet. Tap a quick note or send a heart.')); return; }
      for (const m of S.sent.slice(0, 8)) {
        const li = el('li', 'rc');
        li.append(el('span', 'rc-note', m.text || '♥ A heart'));
        const meta = el('span', 'rc-meta');
        meta.append(el('span', '', `${m.scheduled ? 'Scheduled · ' : ''}to ${m.to} · ${dayTime(m.at)} ·`), el('b', 'st ' + m.status.cls, m.status.text));
        if (m.status.extra) meta.append(el('span', 'rc-react', m.status.extra));
        li.append(meta); ul.append(li);
      }
    } else {
      if (!S.received.length) { ul.append(el('li', 'empty', 'Butterflies that land on your screen are kept here.')); return; }
      for (const r of S.received.slice(0, 8)) {
        const li = el('li', 'rc');
        li.append(el('span', 'rc-note', r.text || '♥ A heart'));
        const meta = el('span', 'rc-meta', `from ${r.fromName}${r.circleName ? ' · ' + r.circleName : ''} · ${dayTime(r.at)}`);
        if (r.react) meta.append(el('span', 'rc-react', '· you sent ' + (r.react === 'butterfly' ? '🦋' : r.react)));
        li.append(meta); ul.append(li);
      }
    }
  }

  function renderSchedule() {
    // note picker
    const noteSel = $('#schedNote'), prevNote = noteSel.value;
    noteSel.textContent = '';
    const opt = (sel, v, label) => { const o = el('option', '', label); o.value = v; sel.append(o); };
    opt(noteSel, '__heart', '♥ A heart');
    S.quick.forEach(q => opt(noteSel, 'q:' + q, q));
    opt(noteSel, '__new', 'Write a new note…');
    noteSel.value = [...noteSel.options].some(o => o.value === prevNote) ? prevNote : (S.quick[0] ? 'q:' + S.quick[0] : '__heart');
    $('#schedCustom').hidden = noteSel.value !== '__new';
    // recipient picker
    const toSel = $('#schedTo'), prevTo = toSel.value;
    toSel.textContent = '';
    for (const c of S.circles) opt(toSel, c.id, c.kind === 'group' ? `${c.name} (group)` : c.name);
    if ([...toSel.options].some(o => o.value === prevTo)) toSel.value = prevTo; else if (toKey) toSel.value = toKey;
    $$('.seg3 button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === repeat)));
    // next up
    const nu = $('#nextUp'); nu.textContent = '';
    if (S.next) nu.append('Next: ', el('b', '', `${dayTime(S.next.when)} · ${S.next.text || '♥ A heart'}`), ` to ${S.next.to}`);
    else nu.append('Schedule a butterfly for a time of day. It works well as a gentle reminder, like "Drink some water".');
    // list
    const ul = $('#schedList'); ul.textContent = '';
    const list = S.schedules.slice().sort((a, b) => a.time.localeCompare(b.time));
    if (!list.length) ul.append(el('li', 'empty', 'Nothing scheduled yet.'));
    const REP = { once: 'Once', daily: 'Every day', weekdays: 'Weekdays' };
    for (const s of list) {
      const li = el('li', 'sch' + (s.on ? '' : ' off'));
      li.append(el('span', 'sch-time', fmtHM(s.time)));
      const body = el('div', 'sch-body');
      body.append(el('span', 'sch-note', s.text || '♥ A heart'), el('span', 'sch-meta', `${REP[s.repeat]} · to ${s.to}`));
      const act = el('div', 'sch-actions');
      const now = el('button', 'btn small', 'Send now'); now.type = 'button';
      now.addEventListener('click', async () => { const r = await call('sendScheduleNow', s.id); toast(r.ok ? `Sent to ${s.to}.` : r.error); });
      const sw = el('label', 'switch');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.on; cb.setAttribute('aria-label', `${fmtHM(s.time)} schedule on`);
      cb.addEventListener('change', () => call('updateSchedule', s.id, { on: cb.checked }));
      sw.append(cb, el('span', 'track'));
      const del = el('button', 'icon-x'); del.type = 'button'; del.setAttribute('aria-label', `Delete ${fmtHM(s.time)} schedule`); del.innerHTML = X_ICON;
      del.addEventListener('click', () => call('removeSchedule', s.id));
      act.append(now, sw, del);
      li.append(body, act); ul.append(li);
    }
  }

  function renderPeople() {
    // invite codes waiting to be used
    const inv = $('#inviteList'); inv.textContent = '';
    for (const i of S.invites) {
      const li = el('li', 'code-item');
      li.append(el('span', 'code', i.code));
      const c = el('button', 'btn small', 'Copy'); c.type = 'button'; c.addEventListener('click', () => copy(i.code, 'Invite code'));
      const x = el('button', 'icon-x'); x.type = 'button'; x.setAttribute('aria-label', `Cancel invite ${i.code}`); x.innerHTML = X_ICON;
      x.addEventListener('click', () => call('cancelInvite', i.code));
      li.append(c, x); inv.append(li);
    }
    $('#newInvite').textContent = S.invites.length ? 'Make another code' : 'Make an invite code';
    // codes we entered, waiting for the other person's Titli to answer
    const jl = $('#joiningList'); jl.textContent = '';
    for (const j of S.joining) jl.append(el('li', 'empty', `Waiting for ${j.code} to answer. It connects as soon as their Titli is online.`));
    // people and groups
    const ul = $('#conns'); ul.textContent = '';
    if (!S.circles.length) ul.append(el('li', 'empty', 'No one yet.'));
    for (const c of S.circles) {
      const li = el('li', 'conn');
      const body = el('div', 'conn-body');
      body.append(el('span', 'conn-name', c.name));
      body.append(el('span', 'conn-meta', c.kind === 'group' ? (c.members.length ? `Group · you, ${c.members.join(', ')}` : 'Group · no one has joined yet') : 'One-to-one'));
      li.append(avatarFor(c), body);
      if (confirming === c.id) {
        const box = el('span', 'confirm');
        const yes = el('button', 'btn small danger', c.kind === 'group' ? 'Leave' : 'Unpair'); yes.type = 'button';
        yes.addEventListener('click', async () => { confirming = null; const r = await call('leave', c.id); if (r.ok) toast(c.kind === 'group' ? `You left ${c.name}.` : `You and ${c.name} are unpaired.`); });
        const no = el('button', 'btn small', 'Keep'); no.type = 'button'; no.addEventListener('click', () => { confirming = null; renderPeople(); });
        box.append(yes, no); li.append(box);
      } else {
        if (c.code) { const cc = el('button', 'conn-code', c.code); cc.type = 'button'; cc.title = 'Copy the group code'; cc.addEventListener('click', () => copy(c.code, 'Group code')); li.append(cc); }
        const x = el('button', 'icon-x'); x.type = 'button'; x.setAttribute('aria-label', c.kind === 'group' ? `Leave ${c.name}` : `Unpair ${c.name}`); x.innerHTML = X_ICON;
        x.addEventListener('click', () => { confirming = c.id; renderPeople(); });
        li.append(x);
      }
      ul.append(li);
    }
  }

  function renderSettings() {
    const st = S.settings;
    if (document.activeElement !== $('#myName')) $('#myName').value = S.me.name;
    if (document.activeElement !== $('#relayUrl')) $('#relayUrl').value = st.relay;
    $('#setMeetings').checked = st.holdInMeetings;
    $('#setAway').checked = st.holdWhenAway;
    $('#setNotify').checked = st.notifyReactions;
    $('#setLogin').checked = st.openAtLogin;
    $('#setCapture').checked = st.allowCapture;
    $('#helperNote').textContent = S.presence && S.presence.helper ? 'Camera or mic in use, or something full screen' : 'Call detection is starting, or needs the full app installed';
    $('#version').textContent = `Titli ${S.version}`;
  }

  /* ---------- actions ---------- */
  async function sendNote(text) {
    clearErr('#sendErr');
    if (!toKey) { selectTab('people'); toast('Pair with someone first.'); return false; }
    const c = S.circles.find(x => x.id === toKey);
    const r = await call('send', { circleId: toKey, text, style: S.settings.style });
    if (!r.ok) { showErr('#sendErr', r.error || 'That didn’t send. Please try again.'); return false; }
    toast(`On its way to ${c ? c.name : 'them'}.`);
    return true;
  }

  $('#heartBtn').addEventListener('click', () => sendNote(null));
  const newNote = $('#newNote');
  newNote.addEventListener('input', () => { $('#count').textContent = `${Array.from(newNote.value).length}/60`; clearErr('#sendErr'); });
  newNote.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#sendNew').click(); } });
  $('#sendNew').addEventListener('click', async () => {
    const v = newNote.value.trim();
    if (!v) return showErr('#sendErr', 'Write a few words first, or send a heart.');
    if (await sendNote(v)) { newNote.value = ''; newNote.dispatchEvent(new Event('input')); }
  });
  $('#saveNew').addEventListener('click', async () => {
    const r = await call('addQuick', newNote.value);
    if (!r.ok) return showErr('#sendErr', r.error);
    newNote.value = ''; newNote.dispatchEvent(new Event('input'));
    toast('Saved. Tap it any time to send.');
  });
  $$('.sw').forEach(b => b.addEventListener('click', () => call('setSettings', { style: b.dataset.style })));
  $$('.mini-seg button').forEach(b => b.addEventListener('click', () => { listMode = b.dataset.list; renderRecent(); }));

  // schedule
  $('#schedNote').addEventListener('change', () => { $('#schedCustom').hidden = $('#schedNote').value !== '__new'; if (!$('#schedCustom').hidden) $('#schedCustom').focus(); clearErr('#schedErr'); });
  $$('.seg3 button').forEach(b => b.addEventListener('click', () => { repeat = b.dataset.r; $$('.seg3 button').forEach(o => o.setAttribute('aria-pressed', String(o === b))); }));
  $('#addSched').addEventListener('click', async () => {
    clearErr('#schedErr');
    const v = $('#schedNote').value;
    let text = null;
    if (v === '__new') { text = $('#schedCustom').value.trim(); if (!text) return showErr('#schedErr', 'Write the note you want to schedule.'); }
    else if (v.startsWith('q:')) text = v.slice(2);
    if (!S.circles.length) return showErr('#schedErr', 'Pair with someone first.');
    const r = await call('addSchedule', { text, circleId: $('#schedTo').value, time: $('#schedTime').value, repeat });
    if (!r.ok) return showErr('#schedErr', r.error);
    $('#schedCustom').value = '';
    toast(`Scheduled for ${fmtHM($('#schedTime').value)}.`);
  });

  // people
  $('#newInvite').addEventListener('click', async () => {
    const r = await call('createInvite');
    if (r.ok) { copy(r.code, 'Invite code'); }
  });
  const joinInput = $('#joinCode');
  joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#joinBtn').addEventListener('click', async () => {
    clearErr('#peopleErr');
    const r = await call('joinCode', joinInput.value);
    if (!r.ok) return showErr('#peopleErr', r.error);
    joinInput.value = '';
    toast(r.kind === 'group' ? 'You joined the group. Its name appears as soon as someone in it is online.' : 'Code sent. You’ll be paired as soon as their Titli answers.');
  });
  const groupName = $('#groupName');
  groupName.addEventListener('keydown', e => { if (e.key === 'Enter') $('#groupBtn').click(); });
  $('#groupBtn').addEventListener('click', async () => {
    clearErr('#peopleErr');
    const r = await call('createGroup', groupName.value);
    if (!r.ok) return showErr('#peopleErr', r.error);
    groupName.value = '';
    copy(r.code, 'Group code');
  });

  // settings
  $('#saveName').addEventListener('click', async () => { const r = await call('setName', $('#myName').value); toast(r.ok ? 'Name saved.' : r.error); });
  const bindSwitch = (id, key) => $(id).addEventListener('change', e => call('setSettings', { [key]: e.target.checked }));
  bindSwitch('#setMeetings', 'holdInMeetings'); bindSwitch('#setAway', 'holdWhenAway'); bindSwitch('#setNotify', 'notifyReactions'); bindSwitch('#setLogin', 'openAtLogin'); bindSwitch('#setCapture', 'allowCapture');
  $('#saveRelay').addEventListener('click', async () => { clearErr('#settingsErr'); const r = await call('setSettings', { relay: $('#relayUrl').value }); if (!r.ok) showErr('#settingsErr', r.error); else toast('Relay saved.'); });
  $('#previewBtn').addEventListener('click', () => api.ui('preview', S.quick[0] || 'Thinking of you'));
  $('#quitBtn').addEventListener('click', () => api.ui('quit'));
  $('#closePanel').addEventListener('click', () => api.ui('hide'));

  // first run
  $('#obSave').addEventListener('click', async () => {
    clearErr('#obErr');
    const r = await call('setName', $('#obName').value);
    if (!r.ok) return showErr('#obErr', r.error);
    selectTab('people');
  });
  $('#obName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#obSave').click(); });

  // quick send from the keyboard: open with the shortcut, then 1–9 for a quick note or H for a heart
  document.addEventListener('keydown', async e => {
    if (e.key === 'Escape') { api.ui('hide'); return; }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey || !S || !S.me.name) return;
    let ok = false;
    if (/^[1-9]$/.test(e.key) && S.quick[+e.key - 1]) ok = await sendNote(S.quick[+e.key - 1]);
    else if (e.key === 'h' || e.key === 'H') ok = await sendNote(null);
    else return;
    e.preventDefault();
    if (ok) setTimeout(() => api.ui('hide'), 700);
  });

  /* ---------- state ---------- */
  api.onState(s => { S = s; render(); });
  api.onOpened(() => { if (S && !S.me.name) setTimeout(() => $('#obName').focus(), 50); });
  api.state().then(s => { S = s; render(); if (S && !S.me.name) $('#obName').focus(); });
})();
