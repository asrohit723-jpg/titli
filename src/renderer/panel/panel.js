(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const api = window.titli;

  let S = null;            // latest state from the main process
  let view = null;         // welcome1 | welcome2 | main | settings | quick
  let tab = 'send';
  let toKey = null;        // who the Send tab sends to
  // the one-tap butterfly, per person: any emoji (shared with the main process: core/taps.js)
  const Taps = window.Taps;
  const tapOf = g => Taps.emojiOf(g) || Taps.HEART;
  let pickingFor = null;   // whose "any emoji" box is open
  let qeFor = null;        // whose notes the editor shows (null: everyone)
  // their own notes first, then the ones for everyone
  const notesFor = id => {
    const mine = (S && S.quickFor && S.quickFor[id]) || [];
    return [...mine.map(t => ({ t, mine: true })), ...S.quick.filter(q => !mine.includes(q)).map(t => ({ t, mine: false }))];
  };
  let pairStep = false;    // first run, step 2
  let menuFor = null, confirming = null, removing = null;   // People row options
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
  const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const daysFromToday = ms => Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86400000);
  function dayLabel(ms) {
    const n = daysFromToday(ms);
    if (n === 0) return 'Today';
    if (n === -1) return 'Yesterday';
    return new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
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
  // invite codes: wiped from the clipboard again after two minutes
  const copyCode = (code, what) => { api.ui('copySecret', code); toast(`${what} copied`, 'Paste it in WhatsApp. It clears from your clipboard in 2 minutes.'); };

  const STORE_KEY = 'titli.activitySeen';
  const readSeen = () => { try { return Number(localStorage.getItem(STORE_KEY)) || 0; } catch (e) { return 0; } };
  const writeSeen = v => { try { localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* not kept */ } };
  const newestReceived = () => S.received.reduce((m, r) => Math.max(m, r.at || 0), 0);

  /* ---------- views and tabs ---------- */
  const VIEWS = { welcome1: '#welcome1', welcome2: '#welcome2', main: '#main', settings: '#page-settings', quick: '#page-quick' };
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
    show('main');
    if (from === 'quick') selectTab('send');
    render();
  }
  $$('[data-back]').forEach(b => b.addEventListener('click', goBack));
  $('#openSettings').addEventListener('click', () => openPage('settings'));

  /* ---------- rendering ---------- */
  function render() {
    if (!S) return;
    if (!S.me.name) {
      show('welcome1');
      // Windows tucks new tray icons under the ^ arrow, so say where Titli lives
      if (S.platform === 'win32') $('#w1Hint').textContent = `Titli lives by the clock (under the ^ arrow). ${S.shortcut || 'Ctrl+Alt+Space'} opens it any time.`;
      return;
    }
    if (pairStep && sendable().length) {
      pairStep = false;
      view = 'main'; selectTab('send');
      toast(`You and ${sendable()[0].name} are paired`);
    }
    if (pairStep) { show('welcome2'); renderWelcome2(); return; }
    if (!view || view === 'welcome1' || view === 'welcome2') view = 'main';
    show(view);
    renderStatus(); renderUpdate(); renderSend(); renderActivity(); renderPeople(); renderSettings(); renderQuickEdit();
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
    $('#upErrBox').hidden = !u.error;
    $('#upErr').textContent = u.error || '';
    $('#upCopy').hidden = !u.errorDetail;
    if (u.error && u.error !== lastUpdateErr && view === 'main') toast(u.error);
    lastUpdateErr = u.error || null;
  }
  const startUpdate = () => { if (S && S.update && S.update.status === 'available') api.ui('installUpdate'); };
  $('#updatePill').addEventListener('click', startUpdate);
  $('#upCopy').addEventListener('click', () => {
    const u = S && S.update;
    if (!u || !u.errorDetail) return;
    api.ui('copy', `Titli ${u.current} → ${u.latest || '?'} (${S.platform || ''})\n${u.error}\n${u.errorDetail}`);
    toast('Details copied');
  });
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
    const tap = tapOf(c && c.tap), heart = Taps.isHeart(tap);
    $('#heartLabel').textContent = c ? Taps.button(tap, c.name) : 'Send a heart';
    $('#tapHeart').classList.toggle('gone', !heart);
    $('#tapEmoji').hidden = heart;
    $('#tapEmoji').textContent = heart ? '' : tap;
    $('#heartBtn').title = c ? `Change what one tap sends in People → ${c.name}` : '';
    renderQuick();
    renderCompose();
  }

  function renderQuick() {
    const box = $('#qnGrid');
    box.textContent = '';
    const notes = notesFor(toKey), c = S.circles.find(x => x.id === toKey);
    if (!notes.length) {
      box.append(el('p', 'qn-empty', 'Notes you send often live here. Write one below and tap “Keep”.'));
      return;
    }
    notes.forEach(({ t: q, mine }, i) => {
      const b = btn('qn' + (mine ? ' mine' : ''));
      if (mine && c) b.title = `Just for ${c.name}`;
      b.setAttribute('aria-label', `Send “${q}”` + (mine && c ? `, just for ${c.name}` : '') + (i < 9 ? `. Key ${i + 1}` : ''));
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
    $('#keepRow').hidden = !has;
    const c = S.circles.find(x => x.id === toKey);
    $('#keepForLabel').textContent = c ? `Keep for ${c.name}` : 'Keep';
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
  async function keep(forThem) {
    const c = forThem ? S.circles.find(x => x.id === toKey) : null;
    const r = await call('addQuick', newNote.value, c ? c.id : null);
    if (!r.ok) return showErr('#sendErr', r.error);
    newNote.value = ''; renderCompose();
    toast(c ? `Kept for ${c.name}` : 'Kept for everyone', c ? `It shows first when you send to ${c.name}` : 'Tap it any time');
  }
  $('#keepFor').addEventListener('click', () => keep(true));
  $('#keepAll').addEventListener('click', () => keep(false));
  $('#editQuick').addEventListener('click', () => { qeFor = toKey; openPage('quick'); });
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

  function tapPicker(c) {
    const tap = tapOf(c.tap);
    const wrap = el('div', 'tap-row');
    wrap.append(el('span', 'tap-lbl', 'One tap sends'));
    const chips = el('div', 'tap-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', `What one tap sends ${c.name}`);
    const choices = Taps.SUGGESTED.includes(tap) ? Taps.SUGGESTED : [...Taps.SUGGESTED, tap];
    for (const e of choices) {
      const b = btn('tap-chip');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(e === tap));
      b.setAttribute('aria-label', Taps.label(e) || e);
      b.title = Taps.label(e) || e;
      b.textContent = e;
      b.addEventListener('click', async () => { pickingFor = null; await call('setTap', c.id, e); });
      chips.append(b);
    }
    const more = btn('tap-chip more');
    more.setAttribute('aria-label', 'Pick any emoji');
    more.setAttribute('aria-expanded', String(pickingFor === c.id));
    more.title = 'Pick any emoji';
    more.append(icon('i-plus'));
    more.addEventListener('click', () => {
      pickingFor = pickingFor === c.id ? null : c.id;
      if (!pickingFor) api.ui('emojiPicked');
      renderPeople();
      if (pickingFor) { const inp = $('.tap-input'); if (inp) { inp.focus(); api.ui('emojiPicker'); } }
    });
    chips.append(more);
    wrap.append(chips);
    if (pickingFor !== c.id) return wrap;

    // type, paste or pick one from the system's emoji picker
    const row = el('div', 'tap-any');
    const inp = el('input', 'tap-input');
    inp.type = 'text'; inp.maxLength = 40; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.placeholder = 'Type or paste any emoji';
    inp.setAttribute('aria-label', `Any emoji for ${c.name}`);
    const hint = el('span', 'hint', '');
    const done = () => { pickingFor = null; api.ui('emojiPicked'); renderPeople(); };
    inp.addEventListener('input', async () => {
      const e = Taps.firstEmoji(inp.value);
      if (!e) { hint.textContent = inp.value.trim() ? 'Just one emoji, no words.' : ''; return; }
      pickingFor = null; api.ui('emojiPicked');
      const r = await call('setTap', c.id, e);
      if (!r.ok) toast(r.error || 'That didn’t work');
    });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); done(); } });
    row.append(inp, hint);
    const all = el('div', 'tap-wrap');
    all.append(wrap, row);
    return all;
  }

  function noteLine(text, kind, g) {
    const n = el('span', 'act-note');
    if (kind === 'visit') n.append(icon('bfly', 'bf'), document.createTextNode('A butterfly back'));
    else if (text == null && Taps.isHeart(g)) n.append(icon('i-heart', 'heart'), document.createTextNode('A heart'));
    else if (text == null) n.append(el('span', 'act-emoji' + (Taps.label(g) ? '' : ' alone'), tapOf(g)), document.createTextNode(Taps.label(g) || ''));
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
    body.append(noteLine(m.text, null, m.g));
    const meta = el('span', 'act-meta');
    meta.append(document.createTextNode(`To ${m.to} · ${timeStr(m.at)} ·`));
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
    body.append(noteLine(r.text, r.kind, r.g));
    let meta = `From ${r.fromName}${r.circleName ? ' in ' + r.circleName : ''} · ${timeStr(r.at)}`;
    if (r.kind === 'visit' && r.text) meta += ` · for “${r.text}”`;
    if (r.react) meta += ` · you sent ${r.react === 'butterfly' ? 'a butterfly back' : r.react}`;
    body.append(el('span', 'act-meta', meta));
    li.append(wrap, body);
    if (actSeenBefore && r.at > actSeenBefore) { const d = el('span', 'new-dot'); d.title = 'New'; li.append(d); }
    return li;
  }

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
      else meta = c.createdAt ? `One-to-one · since ${shortDate(c.createdAt)}` : 'One-to-one';
      body.append(el('span', 'conn-meta', meta));
      const more = btn('icon-btn');
      more.append(icon('i-more'));
      more.setAttribute('aria-label', `Options for ${c.name}`);
      more.setAttribute('aria-expanded', String(menuFor === c.id));
      more.title = 'Options';
      more.addEventListener('click', () => { menuFor = menuFor === c.id ? null : c.id; confirming = null; removing = null; renderPeople(); });
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
      cp.addEventListener('click', () => copyCode(inv.code, 'Invite code'));
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
      box.append(el('p', 'ask', isGroup ? `Leave ${c.name}? You’ll stop getting its butterflies.` : `Remove ${c.name}? You won’t be able to send each other butterflies.`));
      const yes = btn('btn outline danger', isGroup ? 'Leave' : 'Remove');
      yes.addEventListener('click', async () => {
        menuFor = null; confirming = null;
        const r = await call('leave', c.id);
        if (r.ok) toast(isGroup ? `You left ${c.name}` : `${c.name} is removed`);
      });
      const no = btn('btn outline', 'Keep');
      no.addEventListener('click', () => { confirming = null; renderPeople(); });
      box.append(yes, no);
      return box;
    }
    const who = removing && removing.circleId === c.id && c.people.find(p => p.id === removing.id);
    if (who) {
      box.append(el('p', 'ask', `Remove ${who.name} from ${c.name}? Everyone else gets a new key, so they won’t see anything sent after this.`));
      const yes = btn('btn outline danger', 'Remove');
      yes.addEventListener('click', async () => {
        removing = null;
        const r = await call('removeMember', c.id, who.id);
        toast(r.ok ? `${who.name} is out of ${c.name}` : (r.error || 'That didn’t work'));
      });
      const no = btn('btn outline', 'Keep');
      no.addEventListener('click', () => { removing = null; renderPeople(); });
      box.append(yes, no);
      return box;
    }

    // what one tap sends them: a heart for some, a wave or a kiss for others, or any emoji at all
    box.append(tapPicker(c));

    // the same five emoji on both screens means no one is sitting in the middle
    const safe = el('div', 'safety');
    const head = el('div', 'safety-head');
    head.append(el('span', 'safety-lbl', 'Safety code'), el('span', 'safety-code', c.safety));
    safe.append(head, el('span', 'hint', !c.secure
      ? (isGroup ? 'Full protection starts once everyone in it has updated Titli.' : `Full protection starts once ${c.name} updates Titli.`)
      : (isGroup ? 'Everyone in the group sees these same five.' : `Ask ${c.name} what theirs shows. The same five means no one is listening in.`)));
    box.append(safe);

    if (isGroup) {
      if (c.code) {
        const cp = btn('btn outline'); cp.append(icon('i-copy'), document.createTextNode('Copy invite code'));
        cp.addEventListener('click', () => copyCode(c.code, 'Invite code'));
        box.append(cp);
      } else {
        const mk = btn('btn outline', 'Make an invite code');
        mk.addEventListener('click', async () => {
          const r = await call('createGroupInvite', c.id);
          if (r.ok && r.code) copyCode(r.code, 'Invite code'); else toast(r.error || 'That didn’t work');
        });
        box.append(mk);
      }
      if (c.code && c.codeExpiresAt) {
        const day = new Date(c.codeExpiresAt).toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
        box.append(el('span', 'hint full', `Anyone you send it to can join until ${timeStr(c.codeExpiresAt)} ${day}.`));
      } else if (c.code && c.legacyCode) box.append(el('span', 'hint full', 'An old-style code that never expires. It stops working once everyone in the group has updated.'));
      if (c.owner && c.people.length) {
        const list = el('ul', 'members');
        for (const p of c.people) {
          const li = el('li');
          const rm = btn('link danger', 'Remove');
          rm.setAttribute('aria-label', `Remove ${p.name} from ${c.name}`);
          rm.addEventListener('click', () => { removing = { circleId: c.id, id: p.id }; renderPeople(); });
          li.append(el('span', 'mem-name', p.name), rm);
          list.append(li);
        }
        box.append(list);
      }
    }
    const leave = btn('btn outline danger', isGroup ? 'Leave group' : 'Remove');
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
    if (r.kind === 'group' && !r.pending) toast('You joined the group', 'Its name shows once someone in it is online');
    else toast('Code sent', r.kind === 'group' ? 'You’re in as soon as someone in the group is online' : 'Pairing as soon as their Titli answers');
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
    api.ui('copySecret', r.code);
    toast(`${name} is ready`, 'Invite code copied. It works for 24 hours.');
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
    $('#setReceipts').checked = st.sendReceipts !== false;
    $('#setAnywhere').checked = st.landAnywhere !== false;
    $('#dataNote').textContent = S.dataProtected ? 'Encrypted with a key your computer keeps' : 'In a file only your account can open';
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
  bindSwitch('#setMeetings', 'holdInMeetings'); bindSwitch('#setAway', 'holdWhenAway'); bindSwitch('#setNotify', 'notifyReactions'); bindSwitch('#setReceipts', 'sendReceipts'); bindSwitch('#setAnywhere', 'landAnywhere');
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
  const editing = () => (qeFor ? ((S.quickFor && S.quickFor[qeFor]) || []) : S.quick);
  function renderQuickEdit() {
    if (qeFor && !sendable().some(c => c.id === qeFor)) qeFor = null;
    const who = qeFor ? S.circles.find(x => x.id === qeFor) : null;
    // whose notes: everyone, or one person or group
    const chips = $('#qeFor');
    chips.textContent = '';
    for (const c of [{ id: null, name: 'Everyone' }, ...sendable()]) {
      const b = btn('chip-for', c.name);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === qeFor));
      b.addEventListener('click', () => { qeFor = c.id; clearErr('#qeErr'); renderQuickEdit(); });
      chips.append(b);
    }
    const list = editing();
    const ul = $('#qeList');
    ul.textContent = '';
    $('#quickCount').textContent = `${list.length} of ${qeFor ? 8 : 12}`;
    $('#qeHint').textContent = who
      ? `These show first when you send to ${who.name}, before your notes for everyone. Drag to reorder.`
      : 'These show for everyone. Drag to reorder, or use the arrow keys on the handle. The first nine on the Send tab get number keys.';
    $('#qeNew').placeholder = who ? `Add a note just for ${who.name}…` : 'Add a note for everyone…';
    if (!list.length) ul.append(el('li', 'empty-note', who ? `No notes just for ${who.name} yet. Add one below.` : 'No quick notes yet. Add one below.'));
    list.forEach((q, i) => {
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
      const del = btn('qe-del');
      del.append(icon('i-trash'));
      del.setAttribute('aria-label', `Delete “${q}”`);
      del.title = 'Delete';
      del.addEventListener('click', () => call('removeQuick', q, qeFor));
      li.append(grip, el('span', 'qe-text', q), del);
      li.addEventListener('dragstart', e => { dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      li.addEventListener('dragend', () => { dragFrom = null; $$('.qe-item').forEach(x => x.classList.remove('dragging', 'over')); });
      li.addEventListener('dragover', e => { if (dragFrom === null) return; e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', e => { e.preventDefault(); if (dragFrom !== null) moveQuick(dragFrom, i); });
      ul.append(li);
    });
  }

  async function moveQuick(from, to, refocus) {
    const cur = editing();
    if (to < 0 || to >= cur.length || from === to) return;
    const list = cur.slice();
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    if (qeFor) S.quickFor[qeFor] = list; else S.quick = list;
    renderQuickEdit(); renderQuick();
    if (refocus) { const g = $$('#qeList .grip')[to]; if (g) g.focus(); }
    await call('reorderQuick', list, qeFor);
  }

  async function addFromEditor() {
    clearErr('#qeErr');
    const r = await call('addQuick', $('#qeNew').value, qeFor);
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
  $('#w2Copy').addEventListener('click', () => { const inv = S.invites[S.invites.length - 1]; if (inv) copyCode(inv.code, 'Code'); });
  $('#w2Join').addEventListener('keydown', e => { if (e.key === 'Enter') $('#w2JoinBtn').click(); });
  $('#w2JoinBtn').addEventListener('click', () => join($('#w2Join'), '#w2Err'));
  $('#w2Later').addEventListener('click', () => { pairStep = false; view = 'main'; selectTab('send'); render(); });

  /* ---------- keyboard ---------- */
  // open with the shortcut, then 1–9 for a quick note or H for a heart; Esc goes back, then closes
  document.addEventListener('keydown', async e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (view === 'settings' || view === 'quick') goBack(); else api.ui('hide');
      return;
    }
    if (!S || view !== 'main' || tab !== 'send') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey || !sendable().length) return;
    let ok = false;
    const keyed = notesFor(toKey).map(x => x.t);
    if (/^[1-9]$/.test(e.key) && keyed[+e.key - 1]) { e.preventDefault(); ok = await sendNote(keyed[+e.key - 1], { viaKey: true }); }
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
