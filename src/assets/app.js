'use strict';

// Bestellgemeinschaft – Oberfläche (ohne Framework). Daten über api.php.

const IMG = 'https://shop.landlinie.de/media/cache/listing/';
const IMG_BIG = 'https://shop.landlinie.de/media/cache/lightbox/';
const S = {
  boot: null, state: null, view: 'shop', korbUser: null,
  q: '', cat: '', articles: [], more: false, offset: 0,
  alleFilter: 'alle', adminTab: 'runde', poll: null,
};

// ---------- Hilfen ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const num = (n) => (Math.round((+n || 0) * 1000) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });
const dt = (s) => new Date(s).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const userName = (id) => (S.state?.users.find((u) => u.id === id) || {}).name || '?';
const modeLabel = { allein: 'allein', muss: 'muss teilen', kann: 'kann teilen' };
const isOpen = () => S.state?.round?.status === 'open' || S.state?.round?.status === 'offen';

async function api(action, data, params = '') {
  const opt = data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(data),
  };
  const r = await fetch(`api.php?a=${action}${params}`, { credentials: 'same-origin', ...opt });
  let j = {};
  try { j = await r.json(); } catch { j = { error: 'Antwort nicht lesbar (' + r.status + ')' }; }
  if (r.status === 401 && action !== 'login') { S.state = null; renderLogin(); throw new Error(j.error); }
  if (!r.ok || j.error) throw new Error(j.error || 'Fehler ' + r.status);
  return j;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), err ? 4500 : 2200);
}

async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); throw e; }
}

function img(a, big = false) {
  return a.image ? (big ? IMG_BIG : IMG) + a.image : '';
}

// ---------- Start ----------
async function start() {
  try {
    S.boot = await api('boot');
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }
  if (S.boot.setup) return renderSetup();
  if (!S.boot.logged_in) return renderLogin();
  await load();
  route();
  startPoll();
}

async function load(roundId) {
  const rid = roundId ?? S.state?.round?.id;
  S.state = await api('state', undefined, rid ? `&round_id=${rid}` : '');
  if (!S.korbUser || !S.state.users.some((u) => u.id === S.korbUser)) S.korbUser = S.state.me.id;
}

function startPoll() {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    if (document.hidden || $('#modal-root').children.length || !S.state) return;
    const before = JSON.stringify([S.state.items, S.state.round]);
    try { await load(); } catch { return; }
    if (JSON.stringify([S.state.items, S.state.round]) !== before) render();
  }, 15000);
}
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && S.state) { try { await load(); render(); } catch {} }
});

window.addEventListener('hashchange', route);
function route() {
  const v = (location.hash.replace('#/', '') || 'shop').split('?')[0];
  S.view = ['shop', 'korb', 'alle', 'pfand', 'admin'].includes(v) ? v : 'shop';
  if (S.view === 'admin' && !S.state?.me.is_admin) S.view = 'shop';
  render();
}

// ---------- Einrichtung und Login ----------
function renderSetup() {
  $('#app').innerHTML = `<div class="login">
    <h1>Bestellgemeinschaft</h1>
    <p class="muted" style="text-align:center">Erste Einrichtung: Lege dein Admin-Konto an.</p>
    <div class="card">
      <label class="f">Dein Name</label><input id="s-name" type="text" autocomplete="name">
      <label class="f">PIN (4 Ziffern)</label><input id="s-pin" type="password" inputmode="numeric" maxlength="4">
      <div class="err" id="s-err"></div>
      <button class="btn block" style="margin-top:14px" id="s-go">Einrichten</button>
    </div></div>`;
  $('#s-go').onclick = async () => {
    try {
      await api('setup', { name: $('#s-name').value, pin: $('#s-pin').value });
      location.reload();
    } catch (e) { $('#s-err').textContent = e.message; }
  };
}

async function renderLogin() {
  clearInterval(S.poll);
  if (!S.boot || !S.boot.users) S.boot = await api('boot');
  let sel = +localStorage.getItem('bg_user') || null;
  if (!S.boot.users.some((u) => u.id === sel)) sel = null;
  let pin = '';
  const draw = () => {
    $('#app').innerHTML = `<div class="login">
      <h1>Bestellgemeinschaft</h1>
      <p class="muted" style="text-align:center">Wer bist du?</p>
      <div class="who-grid">${S.boot.users.map((u) => `<button data-u="${u.id}" class="${u.id === sel ? 'on' : ''}">${esc(u.name)}</button>`).join('')}</div>
      ${sel ? `<div class="pin">${[0, 1, 2, 3].map((i) => `<span class="${i < pin.length ? 'f' : ''}"></span>`).join('')}</div>
      <div class="err" id="l-err" style="text-align:center"></div>
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join('')}
        <span></span><button data-n="0">0</button><button data-n="del" aria-label="Löschen">⌫</button></div>` : ''}
    </div>`;
    $('#app').querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => { sel = +b.dataset.u; pin = ''; draw(); }));
    $('#app').querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => press(b.dataset.n)));
  };
  const press = async (n) => {
    if (n === 'del') pin = pin.slice(0, -1); else if (pin.length < 4) pin += n;
    draw();
    if (pin.length === 4) {
      try {
        await api('login', { user_id: sel, pin });
        localStorage.setItem('bg_user', String(sel));
        await load(); route(); startPoll();
      } catch (e) { pin = ''; draw(); $('#l-err').textContent = e.message; }
    }
  };
  document.onkeydown = (e) => {
    if (S.state || !sel) return;
    if (/^\d$/.test(e.key)) press(e.key);
    if (e.key === 'Backspace') press('del');
  };
  draw();
}

// ---------- Grundgerüst ----------
function myItems(uid) {
  return S.state.items.filter((it) => it.people.some((p) => p.user_id === uid && (p.eff > 0 || p.owner)) || it.owner_id === uid);
}

function render() {
  if (!S.state) return;
  const st = S.state;
  const r = st.round;
  const count = r ? myItems(st.me.id).filter((i) => i.status === 'aktiv').length : 0;
  let sub = 'Keine Bestellrunde';
  if (r) {
    sub = r.status === 'offen' ? `Bestellschluss ${dt(r.deadline)}` : `Status: ${r.status}`;
  }
  $('#app').innerHTML = `
    <header class="top">
      <div class="title"><b>${esc(r ? r.title : 'Bestellgemeinschaft')}</b><span>${esc(sub)}</span></div>
      <button class="chip-user" id="me-btn">${esc(st.me.name)} ▾</button>
    </header>
    <nav class="nav">
      ${navLink('shop', '🛒', 'Shop')}
      ${navLink('korb', '🧺', 'Körbe', count)}
      ${navLink('alle', '📋', 'Alle')}
      ${navLink('pfand', '♻️', 'Leergut')}
      ${st.me.is_admin ? navLink('admin', '⚙️', 'Admin') : ''}
    </nav>
    <main id="main"></main>`;
  $('#me-btn').onclick = meMenu;
  const m = $('#main');
  ({ shop: viewShop, korb: viewKorb, alle: viewAlle, pfand: viewPfand, admin: viewAdmin })[S.view](m);
}

function navLink(v, ico, label, badge) {
  return `<a href="#/${v}" class="${S.view === v ? 'active' : ''}"><span class="ico">${ico}</span>${label}${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
}

function meMenu() {
  modal(`<div class="head"><h2>${esc(S.state.me.name)}</h2><button class="x" data-close>×</button></div>
    <button class="btn secondary block" id="m-pin">PIN ändern</button>
    <div style="height:8px"></div>
    <button class="btn danger block" id="m-out">Abmelden / Person wechseln</button>`, (root, close) => {
    $('#m-out', root).onclick = async () => { await api('logout', {}); close(); S.state = null; S.boot = null; renderLogin(); };
    $('#m-pin', root).onclick = () => {
      close();
      modal(`<div class="head"><h2>Neue PIN</h2><button class="x" data-close>×</button></div>
        <input id="np" type="password" inputmode="numeric" maxlength="4" placeholder="4 Ziffern">
        <div class="actions"><button class="btn" id="np-ok">Speichern</button></div>`, (r2, c2) => {
        $('#np-ok', r2).onclick = () => run(() => api('my_pin', { pin: $('#np', r2).value }), 'PIN geändert').then(c2);
      });
    };
  });
}

// ---------- Modal ----------
function modal(html, init) {
  const root = $('#modal-root');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  init && init(bg, close);
  const f = bg.querySelector('input:not([type=hidden]), select');
  if (f && window.matchMedia('(min-width: 640px)').matches) f.focus();
  return close;
}

function stepper(id, value, step, min, max, unit) {
  return `<div class="stepper" data-step="${step}" data-min="${min}" data-max="${max}">
    <button type="button" data-d="-1" aria-label="weniger">−</button>
    <input id="${id}" type="text" inputmode="decimal" autocomplete="off" value="${String(+(+value).toFixed(3)).replace('.', ',')}">
    <span class="unit">${esc(unit)}</span>
    <button type="button" data-d="1" aria-label="mehr">+</button></div>`;
}

function wireSteppers(root, onChange) {
  root.querySelectorAll('.stepper').forEach((s) => {
    const inp = s.querySelector('input');
    s.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      const step = +s.dataset.step, min = +s.dataset.min, max = +s.dataset.max;
      let v = (parseFloat(String(inp.value).replace(',', '.')) || 0) + step * +b.dataset.d;
      v = Math.round(v / step) * step;
      inp.value = String(+Math.min(Math.max(v, min), max).toFixed(3)).replace('.', ',');
      onChange && onChange();
    }));
    inp.oninput = () => onChange && onChange();
  });
}
const val = (inp) => parseFloat(String(inp.value).replace(',', '.')) || 0;

function userSelect(id, selected) {
  return `<select id="${id}">${S.state.users.filter((u) => u.active).map((u) =>
    `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)}${u.id === S.state.me.id ? ' (ich)' : ''}</option>`).join('')}</select>`;
}

// ---------- Shop ----------
function openShares() {
  return S.state.items.filter((it) => it.status === 'aktiv' && it.mode !== 'allein' && it.free > 0.0001);
}

function viewShop(m) {
  const st = S.state;
  const cats = st.categories.filter((c) => +c.top === 1);
  const open = isOpen() ? openShares() : [];
  m.innerHTML = `
    ${!st.round ? `<div class="hint o">Noch keine Bestellrunde. ${st.me.is_admin ? 'Lege unter Admin eine an.' : 'Die Admin legt sie an.'}</div>` : ''}
    ${st.round && !isOpen() ? `<div class="hint o">Die Bestellrunde ist geschlossen (${esc(st.round.status)}). Bestellen geht erst wieder in der nächsten Runde.</div>` : ''}
    ${open.length ? `<div class="open-shares"><h3>Offene Teil-Gebinde (${open.length})</h3>${open.map(shareRow).join('')}</div>` : ''}
    <div id="search-anchor"></div>
    <div class="search">
      <input type="search" id="q" placeholder="Artikel suchen (Name, Hersteller, Art.-Nr.)" value="${esc(S.q)}" autocomplete="off">
      <div class="chips"><button class="chip ${S.cat === '' ? 'on' : ''}" data-cat="">Alle</button>
        <button class="chip ${S.cat === '_fav' ? 'on' : ''}" data-cat="_fav">★ Favoriten</button>
        <button class="chip ${S.cat === '_zuletzt' ? 'on' : ''}" data-cat="_zuletzt">Zuletzt bestellt</button>
        ${cats.map((c) => `<button class="chip ${S.cat === c.code ? 'on' : ''}" data-cat="${esc(c.code)}">${esc(c.label)}</button>`).join('')}</div>
    </div>
    ${st.artikel_anzahl === 0 ? `<div class="empty">Noch keine Artikel. ${st.me.is_admin ? 'Unter Admin → Sortiment den Abgleich starten.' : ''}</div>` : ''}
    <div class="grid" id="arts" style="min-height:100vh;align-content:start"></div>
    <div id="more" style="text-align:center;margin-top:12px"></div>`;
  m.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinDialog(+b.dataset.join)));
  m.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { S.cat = b.dataset.cat; S.offset = 0; S.jump = true; viewShop(m); }));
  const q = $('#q', m);
  q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(() => { S.q = q.value; S.offset = 0; S.jump = true; searchArticles(); }, 250); };
  searchArticles();
}

function shareRow(it) {
  const a = it.article;
  const taken = it.total - it.free;
  return `<div class="share-row">
    <div class="art-mini grow"><b>${esc(a.name)}</b> <span class="muted small">${esc(a.gebinde)}</span>
      <div class="small"><b>${num(it.free)} von ${num(it.total)} ${esc(a.einheit)} frei</b> · ${modeLabel[it.mode]} · von ${esc(userName(it.owner_id))}</div>
      <div class="bar part"><i style="width:${Math.round((taken / it.total) * 100)}%"></i></div></div>
    <button class="btn sm orange" data-join="${it.id}">Bei mir hinzufügen</button></div>`;
}

// Nach Filter/Suche: Suchfeld nach oben, die offenen Teil-Gebinde rutschen aus dem Bild
function jumpToSearch() {
  const a = $('#search-anchor');
  if (!a) return;
  const nav = $('.nav');
  const offset = $('.top').offsetHeight + (nav && getComputedStyle(nav).position === 'sticky' ? nav.offsetHeight : 0);
  window.scrollTo({ top: Math.max(0, a.getBoundingClientRect().top + window.scrollY - offset), behavior: 'smooth' });
  const on = $('.chips .chip.on');
  if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
}

async function searchArticles(append = false) {
  const box = $('#arts');
  if (!box) return;
  const p = `&q=${encodeURIComponent(S.q)}&cat=${encodeURIComponent(S.cat)}&offset=${S.offset}`;
  let r;
  try { r = await api('articles', undefined, p); } catch (e) { toast(e.message, true); return; }
  S.articles = append ? S.articles.concat(r.items) : r.items;
  S.more = r.more;
  if (!$('#arts')) return;
  $('#arts').innerHTML = S.articles.length ? S.articles.map(articleCard).join('') :
    (!S.state.artikel_anzahl ? '' : `<div class="empty">${S.cat === '_fav' && !S.q ? 'Noch keine Favoriten. Tippe bei einem Artikel auf den Stern ☆.'
      : S.cat === '_zuletzt' && !S.q ? 'Noch nichts bestellt.' : 'Nichts gefunden.'}</div>`);
  $('#more').innerHTML = S.more ? '<button class="btn secondary" id="more-btn">Weitere Artikel</button>' : '';
  if (S.more) $('#more-btn').onclick = () => { S.offset += 40; searchArticles(true); };
  if (S.jump) { S.jump = false; jumpToSearch(); }
  $('#arts').querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addDialog(S.articles.find((a) => a.artnr === b.dataset.add))));
  $('#arts').querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinDialog(+b.dataset.join)));
  $('#arts').querySelectorAll('[data-fav]').forEach((b) => (b.onclick = async () => {
    const r = await run(() => api('fav_toggle', { artnr: b.dataset.fav }), null);
    const f = S.state.favs;
    if (r.fav) f.push(b.dataset.fav); else f.splice(f.indexOf(b.dataset.fav), 1);
    b.classList.toggle('on', r.fav);
    b.textContent = r.fav ? '★' : '☆';
    toast(r.fav ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
  }));
  $('#arts').querySelectorAll('[data-img]').forEach((b) => (b.onclick = () => imageDialog(S.articles.find((a) => a.artnr === b.dataset.img))));
}

function articleTags(a) {
  const t = [];
  const herkunft = [a.land && a.land !== 'DIV' ? 'Herkunft ' + a.land : '', a.hersteller ? 'Hersteller ' + a.hersteller : ''].filter(Boolean).join(' · ');
  if (herkunft) t.push(`<span class="muted small" style="width:100%">${esc(herkunft)}</span>`);
  if (a.pfand > 0) t.push(`<span class="tag o">Pfand ${eur(a.pfand)}</span>`);
  if (a.bestand === 0) t.push('<span class="tag r">derzeit nicht lieferbar</span>');
  else if (a.bestand === 1) t.push('<span class="tag o">wenig Bestand</span>');
  (a.merkmale || []).slice(0, 4).forEach((x) => t.push(`<span class="tag">${esc(x)}</span>`));
  return `<div class="tags">${t.join('')}</div>`;
}

function netLine(a) {
  return `<div class="muted small">Netto: ${eur(a.unit_price_net)} / ${esc(a.einheit)} + ${a.mwst} % MwSt.</div>`;
}

function articleCard(a) {
  const shared = isOpen() ? S.state.items.filter((it) => it.artnr === a.artnr && it.status === 'aktiv') : [];
  const joinable = shared.filter((it) => it.mode !== 'allein' && it.free > 0.0001);
  return `<div class="card"><div class="art">
      <div class="img" data-img="${esc(a.artnr)}" style="background-image:url('${esc(img(a))}')" role="img" aria-label="Bild ${esc(a.name)}"></div>
      <div class="grow">
        <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><div class="name grow">${esc(a.name)}</div>
          <button class="fav ${S.state.favs.includes(a.artnr) ? 'on' : ''}" data-fav="${esc(a.artnr)}" aria-label="Favorit">${S.state.favs.includes(a.artnr) ? '★' : '☆'}</button></div>
        <div class="meta">${esc(a.zusatz ? a.zusatz + ' · ' : '')}${esc(a.gebinde)} · Art. ${esc(a.artnr)}</div>
        <div class="price" style="margin-top:4px">${eur(a.unit_price)} <small>/ ${esc(a.einheit)}</small>
          <small> · Gebinde ${num(a.units)} ${esc(a.einheit)} = ${eur(a.case_price)}</small></div>
        ${netLine(a)}
        ${articleTags(a)}
      </div></div>
    ${shared.length ? `<div class="hint ${joinable.length ? 'o' : ''}">${shared.map((it) =>
      `${esc(userName(it.owner_id))}: ${modeLabel[it.mode]}${it.mode !== 'allein' ? `, ${num(it.free)} von ${num(it.total)} ${esc(a.einheit)} frei` : ''}`).join('<br>')}</div>` : ''}
    ${isOpen() ? `<div class="row" style="margin-top:10px">
      ${joinable.map((it) => `<button class="btn sm orange grow" data-join="${it.id}">Bei mir hinzufügen${joinable.length > 1 ? ' (' + esc(userName(it.owner_id)) + ')' : ''}</button>`).join('')}
      <button class="btn sm ${joinable.length ? 'secondary' : ''} grow" data-add="${esc(a.artnr)}">In den Korb</button></div>` : ''}
  </div>`;
}

function imageDialog(a) {
  modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
    ${a.image ? `<img class="lightbox" src="${esc(img(a, true))}" alt="">` : '<div class="empty">Kein Bild</div>'}
    <p class="muted small">${esc(a.zusatz)} · ${esc(a.gebinde)} · Art. ${esc(a.artnr)}${a.ean && a.ean !== '0' ? ' · EAN ' + esc(a.ean) : ''}</p>
    ${articleTags(a)}
    ${a.staffel.length > 1 ? `<p class="small">Staffelpreise (netto je ${esc(a.einheit)}): ${a.staffel.map((s) => `ab ${num(s.menge)} Gebinde ${eur(s.ek)}`).join(' · ')}</p>` : ''}`);
}

function addDialog(a) {
  const st = S.state;
  const step = a.step;
  const st0 = { mode: a.units > step + 0.0001 ? 'muss' : 'allein', cases: 1, owner: st.me.id };
  modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
    <div class="art"><div class="img" style="background-image:url('${esc(img(a))}')"></div>
      <div class="grow small"><div>${esc(a.zusatz)}</div><div>Gebinde: <b>${esc(a.gebinde)}</b> (${num(a.units)} ${esc(a.einheit)})</div>
      <div class="price">${eur(a.unit_price)} / ${esc(a.einheit)} · Gebinde ${eur(a.case_price)}</div>${netLine(a)}</div></div>
    <label class="f">Für wen?</label>${userSelect('a-owner', st.me.id)}
    <label class="f">Wie bestellen?</label>
    <div class="seg" id="a-mode">
      <button data-m="allein"><b>Allein</b>ganzes Gebinde</button>
      <button data-m="muss"><b>Muss teilen</b>nur wenn voll</button>
      <button data-m="kann"><b>Kann teilen</b>Rest nehme ich</button>
    </div>
    <label class="f">Anzahl Gebinde</label>${stepper('a-cases', 1, 1, 1, 99, '× ' + a.gebinde)}
    <div id="a-qty-wrap"><label class="f" id="a-qty-label"></label><div id="a-qty-box"></div></div>
    <div class="hint" id="a-info"></div>
    <div class="err" id="a-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="a-ok">In den Korb</button></div>`,
  (root, close) => {
    const upd = () => {
      const cases = Math.max(1, Math.round(val($('#a-cases', root))));
      const total = +(a.units * cases).toFixed(3);
      root.querySelectorAll('#a-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === st0.mode));
      const wrap = $('#a-qty-wrap', root);
      wrap.style.display = st0.mode === 'allein' ? 'none' : '';
      const cur = $('#a-qty', root) ? val($('#a-qty', root)) : Math.min(total, Math.max(step, Math.round(total / 2 / step) * step));
      if (st0.mode !== 'allein') {
        $('#a-qty-label', root).textContent = st0.mode === 'muss' ? 'Meine Menge' : 'Ich nehme mindestens';
        $('#a-qty-box', root).innerHTML = stepper('a-qty', Math.min(cur, total), step, st0.mode === 'muss' ? step : 0, total, a.einheit);
        wireSteppers($('#a-qty-box', root), info);
      }
      info();
    };
    const info = () => {
      const cases = Math.max(1, Math.round(val($('#a-cases', root))));
      const total = +(a.units * cases).toFixed(3);
      const q = st0.mode === 'allein' ? total : Math.min(val($('#a-qty', root)), total);
      let t = '';
      if (st0.mode === 'allein') t = `Du bekommst ${num(total)} ${esc(a.einheit)} für <b>${eur(total * a.unit_price)}</b>.`;
      if (st0.mode === 'muss') t = `Du nimmst ${num(q)} ${esc(a.einheit)} (${eur(q * a.unit_price)}). Für die restlichen <b>${num(total - q)} ${esc(a.einheit)}</b> müssen sich andere eintragen, sonst wird der Artikel nicht bestellt.`;
      if (st0.mode === 'kann') t = `Du nimmst mindestens ${num(q)} ${esc(a.einheit)}. Andere können bis zu <b>${num(total - q)} ${esc(a.einheit)}</b> nehmen, was übrig bleibt, bekommst du (höchstens ${eur(total * a.unit_price)}).`;
      $('#a-info', root).innerHTML = t;
    };
    root.querySelectorAll('#a-mode button').forEach((b) => (b.onclick = () => { st0.mode = b.dataset.m; upd(); }));
    wireSteppers($('#a-cases', root).closest('.stepper').parentElement, upd);
    $('#a-owner', root).onchange = () => {
      const pid = +$('#a-owner', root).value;
      $('#a-ok', root).textContent = pid === st.me.id ? 'In den Korb' : `In den Korb von ${userName(pid)}`;
    };
    upd();
    $('#a-ok', root).onclick = async () => {
      const cases = Math.max(1, Math.round(val($('#a-cases', root))));
      try {
        await api('item_add', { artnr: a.artnr, owner_id: +$('#a-owner', root).value, mode: st0.mode, cases, qty: st0.mode === 'allein' ? 0 : val($('#a-qty', root)) });
        close(); toast('Im Korb'); await load(); render();
      } catch (e) { $('#a-err', root).textContent = e.message; }
    };
  });
}

function joinDialog(itemId, forUser) {
  const it = S.state.items.find((i) => i.id === itemId);
  if (!it) return;
  const a = it.article;
  const uid = forUser || S.state.me.id;
  const mine = (pid) => (it.people.find((p) => p.user_id === pid && !p.owner) || {}).qty || 0;
  modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
    <p class="small">${esc(a.gebinde)} · ${eur(a.unit_price)} / ${esc(a.einheit)} · von <b>${esc(userName(it.owner_id))}</b> (${modeLabel[it.mode]})</p>
    <p><b id="j-free"></b></p>
    <label class="f">Für wen?</label>${userSelect('j-user', uid)}
    <label class="f">Menge</label><div id="j-box"></div>
    <div class="hint" id="j-info"></div><div class="err" id="j-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn orange" id="j-ok">Bei mir hinzufügen</button></div>`,
  (root, close) => {
    const draw = () => {
      const pid = +$('#j-user', root).value;
      if (pid === it.owner_id) {
        $('#j-box', root).innerHTML = '<div class="err">Das ist die eigene Position, die Menge bitte im Korb ändern.</div>';
        $('#j-ok', root).disabled = true; $('#j-info', root).textContent = ''; return;
      }
      $('#j-ok', root).disabled = false;
      $('#j-ok', root).textContent = pid === S.state.me.id ? 'Bei mir hinzufügen' : `Bei ${userName(pid)} hinzufügen`;
      const max = +(it.free + mine(pid)).toFixed(3);
      $('#j-free', root).textContent = `${num(it.free)} von ${num(it.total)} ${a.einheit} sind noch frei` + (mine(pid) ? `, ${userName(pid)} hat schon ${num(mine(pid))} ${a.einheit}` : '');
      $('#j-box', root).innerHTML = stepper('j-qty', mine(pid) || Math.min(max, a.step), a.step, 0, max, a.einheit);
      wireSteppers($('#j-box', root), info);
      info();
    };
    const info = () => {
      const q = val($('#j-qty', root));
      $('#j-info', root).innerHTML = q > 0 ? `${num(q)} ${esc(a.einheit)} = <b>${eur(q * a.unit_price)}</b>` : 'Menge 0 = austragen';
    };
    $('#j-user', root).onchange = draw;
    draw();
    $('#j-ok', root).onclick = async () => {
      try {
        await api('alloc_set', { item_id: it.id, user_id: +$('#j-user', root).value, qty: val($('#j-qty', root)) });
        close(); toast('Eingetragen'); await load(); render();
      } catch (e) { $('#j-err', root).textContent = e.message; }
    };
  });
}

// ---------- Körbe ----------
function personQty(it, uid) {
  const p = it.people.find((x) => x.user_id === uid);
  return p ? (p.actual ?? p.eff) : 0;
}

function viewKorb(m) {
  const st = S.state;
  const uid = S.korbUser;
  const items = myItems(uid);
  const active = items.filter((i) => i.status === 'aktiv');
  const sum = active.reduce((s, it) => s + personQty(it, uid) * it.article.unit_price, 0);
  m.innerHTML = `
    <div class="chips no-print" style="margin-bottom:8px">${st.users.filter((u) => u.active).map((u) =>
      `<button class="chip ${u.id === uid ? 'on' : ''}" data-ku="${u.id}">${esc(u.name)}${u.id === st.me.id ? ' (ich)' : ''} · ${myItems(u.id).filter((i) => i.status === 'aktiv').length}</button>`).join('')}</div>
    ${!st.round ? '<div class="empty">Keine Bestellrunde.</div>' : ''}
    ${st.round && !items.length ? `<div class="empty">${uid === st.me.id ? 'Dein' : esc(userName(uid)) + 's'} Korb ist leer.<br><a href="#/shop">Zum Shop</a></div>` : ''}
    ${items.map((it) => korbCard(it, uid)).join('')}
    ${items.length ? `<div class="card row"><div class="grow">Summe ${esc(userName(uid))} (brutto, Pfand wird nicht berechnet)</div><div class="price">${eur(sum)}</div></div>` : ''}`;
  m.querySelectorAll('[data-ku]').forEach((b) => (b.onclick = () => { S.korbUser = +b.dataset.ku; viewKorb(m); }));
  wireItemButtons(m, uid);
}

function itemStatus(it) {
  if (it.status === 'entfallen') return '<span class="tag r">entfallen – nicht aufgegangen</span>';
  if (!it.delivered) return '<span class="tag r">nicht geliefert</span>';
  if (it.mode === 'allein') return '<span class="tag">allein</span>';
  if (it.free > 0.0001) return it.mode === 'kann' ? `<span class="tag">kann teilen · ${num(it.free)} ${esc(it.article.einheit)} abzugeben</span>` : `<span class="tag o">muss teilen · noch ${num(it.free)} ${esc(it.article.einheit)} frei</span>`;
  return `<span class="tag">${modeLabel[it.mode]} · voll</span>`;
}

function peopleList(it) {
  const a = it.article;
  return `<div class="people">${it.people.filter((p) => p.eff > 0 || p.owner).map((p) => {
    const q = p.actual ?? p.eff;
    const note = p.owner ? (it.mode === 'kann' ? ` (mind. ${num(p.qty)}, nimmt den Rest)` : '') : ` · mitbestellt bei ${esc(userName(it.owner_id))}`;
    return `<div class="p"><span><span class="who">${esc(userName(p.user_id))}</span><span class="muted small">${p.owner ? ' · bestellt' : ''}${note}</span></span>
      <span>${num(q)} ${esc(a.einheit)}${p.actual != null ? ' <span class="tag b">gewogen</span>' : ''} · ${eur(q * a.unit_price)}</span></div>`;
  }).join('')}
  ${it.mode !== 'allein' && it.free > 0.0001 ? `<div class="p muted"><span>${it.mode === 'kann' ? 'davon abzugeben' : 'noch frei'}</span><span>${num(it.free)} ${esc(a.einheit)}</span></div>` : ''}</div>`;
}

function korbCard(it, uid) {
  const a = it.article;
  const isOwner = it.owner_id === uid;
  const q = personQty(it, uid);
  const open = isOpen() && it.status === 'aktiv';
  return `<div class="card">
    <div class="art"><div class="img" data-img2="${esc(a.artnr)}" style="background-image:url('${esc(img(a))}')"></div>
      <div class="grow"><div class="name">${esc(a.name)}</div>
        <div class="meta">${esc(a.gebinde)} · ${it.cases} Gebinde · ${eur(a.unit_price)}/${esc(a.einheit)}</div>
        ${netLine(a)}
        <div class="row" style="margin-top:4px">${itemStatus(it)}${isOwner ? '' : `<span class="tag b">mitbestellt bei ${esc(userName(it.owner_id))}</span>`}</div>
        <div class="price" style="margin-top:4px">${esc(userName(uid))}: ${num(q)} ${esc(a.einheit)} = ${eur(q * a.unit_price)}</div>
      </div></div>
    ${peopleList(it)}
    ${open ? `<div class="row no-print" style="margin-top:10px">
      ${isOwner ? `${it.mode !== 'allein' ? `<button class="btn sm secondary" data-own="${it.id}">Meine Menge</button>` : ''}
        <button class="btn sm secondary" data-edit="${it.id}">Art / Gebinde</button>
        <button class="btn sm danger" data-del="${it.id}">Löschen</button>`
      : `<button class="btn sm secondary" data-join2="${it.id}">Menge ändern</button>
        <button class="btn sm danger" data-out="${it.id}">Austragen</button>`}
      ${it.mode !== 'allein' && it.free > 0.0001 ? `<button class="btn sm orange" data-joinother="${it.id}">Andere eintragen</button>` : ''}
    </div>` : ''}
  </div>`;
}

function wireItemButtons(m, uid) {
  const find = (id) => S.state.items.find((i) => i.id === +id);
  m.querySelectorAll('[data-img2]').forEach((b) => (b.onclick = () => imageDialog(S.state.items.find((i) => i.artnr === b.dataset.img2).article)));
  m.querySelectorAll('[data-join2]').forEach((b) => (b.onclick = () => joinDialog(+b.dataset.join2, uid)));
  m.querySelectorAll('[data-joinother]').forEach((b) => (b.onclick = () => {
    const it = find(b.dataset.joinother);
    const other = S.state.users.find((u) => u.active && u.id !== it.owner_id);
    joinDialog(it.id, other ? other.id : undefined);
  }));
  m.querySelectorAll('[data-out]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Aus diesem Artikel austragen?')) return;
    await run(() => api('alloc_set', { item_id: +b.dataset.out, user_id: uid, qty: 0 }), 'Ausgetragen');
    await load(); render();
  }));
  m.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const it = find(b.dataset.del);
    const others = it.people.filter((p) => !p.owner && p.eff > 0).map((p) => userName(p.user_id));
    if (!confirm(`${it.article.name} löschen?` + (others.length ? `\nMitbestellt haben: ${others.join(', ')}. Ihre Anteile fallen dann auch weg.` : ''))) return;
    await run(() => api('item_delete', { item_id: it.id }), 'Gelöscht');
    await load(); render();
  }));
  m.querySelectorAll('[data-own]').forEach((b) => (b.onclick = () => ownQtyDialog(find(b.dataset.own))));
  m.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editItemDialog(find(b.dataset.edit))));
}

function ownQtyDialog(it) {
  const a = it.article;
  const others = it.people.filter((p) => !p.owner).reduce((s, p) => s + p.qty, 0);
  const max = +(it.total - others).toFixed(3);
  modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
    <p class="small">${it.mode === 'kann' ? 'Mindestmenge' : 'Eigene Menge'} von ${esc(userName(it.owner_id))}. Andere haben ${num(others)} ${esc(a.einheit)}, höchstens ${num(max)} ${esc(a.einheit)} möglich.</p>
    ${stepper('o-qty', it.owner_qty, a.step, it.mode === 'kann' ? 0 : a.step, max, a.einheit)}
    <div class="err" id="o-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="o-ok">Speichern</button></div>`, (root, close) => {
    wireSteppers(root);
    $('#o-ok', root).onclick = async () => {
      try { await api('alloc_set', { item_id: it.id, user_id: it.owner_id, qty: val($('#o-qty', root)) }); close(); toast('Gespeichert'); await load(); render(); } catch (e) { $('#o-err', root).textContent = e.message; }
    };
  });
}

function editItemDialog(it) {
  const a = it.article;
  let mode = it.mode;
  modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
    <label class="f">Wie bestellen?</label>
    <div class="seg" id="e-mode">
      <button data-m="allein"><b>Allein</b>ganzes Gebinde</button>
      <button data-m="muss"><b>Muss teilen</b>nur wenn voll</button>
      <button data-m="kann"><b>Kann teilen</b>Rest nehme ich</button></div>
    <label class="f">Anzahl Gebinde</label>${stepper('e-cases', it.cases, 1, 1, 99, '× ' + a.gebinde)}
    <div class="err" id="e-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="e-ok">Speichern</button></div>`, (root, close) => {
    const upd = () => root.querySelectorAll('#e-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    root.querySelectorAll('#e-mode button').forEach((b) => (b.onclick = () => { mode = b.dataset.m; upd(); }));
    upd(); wireSteppers(root);
    $('#e-ok', root).onclick = async () => {
      try { await api('item_update', { item_id: it.id, mode, cases: Math.round(val($('#e-cases', root))) }); close(); toast('Gespeichert'); await load(); render(); } catch (e) { $('#e-err', root).textContent = e.message; }
    };
  });
}

// ---------- Alle ----------
function viewAlle(m) {
  const st = S.state;
  const f = S.alleFilter;
  let items = st.items;
  if (f === 'offen') items = items.filter((i) => i.status === 'aktiv' && i.mode !== 'allein' && i.free > 0.0001);
  if (f === 'entfallen') items = items.filter((i) => i.status === 'entfallen' || !i.delivered);
  const total = st.items.filter((i) => i.status === 'aktiv').reduce((s, it) => s + it.cases * it.article.case_price, 0);
  const openN = st.items.filter((i) => i.status === 'aktiv' && i.mode === 'muss' && i.free > 0.0001).length;
  m.innerHTML = `
    <div class="tabs no-print">
      <button class="chip ${f === 'alle' ? 'on' : ''}" data-f="alle">Alle (${st.items.length})</button>
      <button class="chip ${f === 'offen' ? 'on' : ''}" data-f="offen">Offen (${openN})</button>
      <button class="chip ${f === 'entfallen' ? 'on' : ''}" data-f="entfallen">Entfallen</button>
      <button class="chip" id="log-btn">Protokoll</button>
    </div>
    ${openN && isOpen() ? `<div class="hint o">${openN} Teil-Gebinde sind noch nicht voll. Was bei Bestellschluss bei "muss teilen" nicht voll ist, wird nicht bestellt.</div>` : ''}
    <div class="card row"><div class="grow">Bestellwert gesamt (brutto)</div><div class="price">${eur(total)}</div></div>
    ${items.length ? items.map((it) => `<div class="card">
      <div class="row"><div class="grow"><b>${esc(it.article.name)}</b> <span class="muted small">${esc(it.article.gebinde)} · ${it.cases}× · Art. ${esc(it.artnr)}</span></div>
      <div class="price small">${eur(it.cases * it.article.case_price)}</div></div>
      <div class="row" style="margin-top:4px">${itemStatus(it)}<span class="muted small">bestellt von ${esc(userName(it.owner_id))}</span></div>
      ${peopleList(it)}
      ${isOpen() && it.status === 'aktiv' && it.mode !== 'allein' && it.free > 0.0001 ? `<div class="row no-print" style="margin-top:8px"><button class="btn sm orange" data-join="${it.id}">Bei mir hinzufügen</button></div>` : ''}
    </div>`).join('') : '<div class="empty">Keine Positionen.</div>'}`;
  m.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.alleFilter = b.dataset.f; viewAlle(m); }));
  m.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinDialog(+b.dataset.join)));
  $('#log-btn', m).onclick = showLog;
}

async function showLog() {
  const r = await run(() => api('log', undefined, `&round_id=${S.state.round?.id || 0}`));
  modal(`<div class="head"><h2>Protokoll</h2><button class="x" data-close>×</button></div>
    ${r.log.length ? r.log.map((l) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="muted">${dt(l.ts)}</span><br>${esc(l.text)}</div>`).join('') : '<div class="empty">Noch nichts.</div>'}`);
}

// ---------- Pfand ----------
async function viewPfand(m) {
  m.innerHTML = '<div class="empty">Lädt …</div>';
  let r;
  try { r = await api('pfand'); } catch (e) { m.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const st = S.state;
  const open = r.entries.filter((e) => !e.returned_at);
  const done = r.entries.filter((e) => e.returned_at);
  const totalOpen = open.reduce((s, e) => s + +e.betrag, 0);
  const row = (e) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
    <div class="grow"><b>${num(e.qty)}× ${esc(e.text)}</b><div class="small muted">bei ${esc(e.name)} · ${new Date(e.created_at + 'Z').toLocaleDateString('de-DE')} · Wert ${eur(e.betrag)}${e.returned_at ? ' · zurück am ' + new Date(e.returned_at + 'Z').toLocaleDateString('de-DE') : ''}</div></div>
    ${e.returned_at ? `<button class="btn sm secondary" data-pret="${e.id}" data-v="0">Doch nicht zurück</button>` : `<button class="btn sm" data-pret="${e.id}" data-v="1">Zurückgegeben</button>`}
    ${st.me.is_admin && !e.item_id ? `<button class="btn ghost sm" data-pdel="${e.id}" aria-label="Löschen">✕</button>` : ''}</div>`;
  m.innerHTML = `
    <div class="section-title"><h2>Leergut</h2><button class="btn sm secondary" id="pf-add">Von Hand eintragen</button></div>
    <p class="small muted">Pfand wird niemandem berechnet. Hier steht nur, welches Leergut noch draußen ist, damit alles an Landlinie zurückgeht.
      Pfand-Artikel werden bei "geliefert" automatisch bei der Bestellerin eingetragen.</p>
    <div class="card row"><div class="grow">Noch nicht zurückgegeben</div><div class="price">${eur(totalOpen)}</div></div>
    <div class="card"><table><tbody>${r.balances.filter((b) => +b.stueck > 0).map((b) => `<tr><td>${esc(b.name)}</td><td class="n">${num(b.stueck)} Stück</td><td class="n price">${eur(b.saldo)}</td></tr>`).join('') || '<tr><td class="muted">Alles zurück.</td></tr>'}</tbody></table></div>
    <h3 style="margin-top:16px">Offen (${open.length})</h3>
    <div class="card">${open.map(row).join('') || '<p class="muted small">Nichts offen.</p>'}</div>
    ${done.length ? `<h3 style="margin-top:16px">Zurückgegeben</h3><div class="card">${done.slice(0, 50).map(row).join('')}</div>` : ''}`;
  $('#pf-add', m).onclick = () => modal(`<div class="head"><h2>Leergut eintragen</h2><button class="x" data-close>×</button></div>
    <label class="f">Bei wem?</label>${userSelect('p-user', st.me.id)}
    <label class="f">Was?</label><input id="p-text" type="text" placeholder="z. B. Mopro-Kiste">
    <div class="row"><div class="grow"><label class="f">Anzahl</label><input id="p-qty" type="text" inputmode="numeric" value="1"></div>
      <div class="grow"><label class="f">Wert gesamt in €</label><input id="p-betrag" type="text" inputmode="decimal"></div></div>
    <div class="err" id="p-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="p-ok">Eintragen</button></div>`, (root, close) => {
    $('#p-ok', root).onclick = async () => {
      try {
        await api('pfand_add', { user_id: +$('#p-user', root).value, text: $('#p-text', root).value, qty: parseFloat($('#p-qty', root).value) || 1, betrag: parseFloat($('#p-betrag', root).value.replace(',', '.')) });
        close(); toast('Eingetragen'); viewPfand(m);
      } catch (e) { $('#p-err', root).textContent = e.message; }
    };
  });
  m.querySelectorAll('[data-pret]').forEach((b) => (b.onclick = async () => {
    await run(() => api('pfand_return', { id: +b.dataset.pret, returned: +b.dataset.v }), +b.dataset.v ? 'Als zurückgegeben markiert' : 'Wieder offen');
    viewPfand(m);
  }));
  m.querySelectorAll('[data-pdel]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Buchung löschen?')) return;
    await run(() => api('pfand_delete', { id: +b.dataset.pdel }), 'Gelöscht'); viewPfand(m);
  }));
}

// ---------- Admin ----------
function viewAdmin(m) {
  const tabs = { runde: 'Runde', bestellung: 'Bestellliste', verteilen: 'Verteilen / Wiegen', lieferung: 'Lieferung', abrechnung: 'Abrechnung', leute: 'Bestellerinnen', sortiment: 'Sortiment & Pfand' };
  m.innerHTML = `<div class="tabs no-print">${Object.entries(tabs).map(([k, v]) => `<button class="chip ${S.adminTab === k ? 'on' : ''}" data-t="${k}">${v}</button>`).join('')}</div><div id="adm"></div>`;
  m.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { S.adminTab = b.dataset.t; viewAdmin(m); }));
  const box = $('#adm', m);
  ({ runde: admRunde, bestellung: admBestellung, verteilen: admVerteilen, lieferung: admLieferung, abrechnung: admAbrechnung, leute: admLeute, sortiment: admSortiment })[S.adminTab](box);
}

function nextMonday17() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(17, 0, 0, 0);
  return d;
}
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function admRunde(box) {
  const st = S.state;
  const r = st.round;
  const statusFlow = ['offen', 'geschlossen', 'bestellt', 'geliefert', 'abgerechnet'];
  box.innerHTML = `
    ${r ? `<div class="card">
      <h2>${esc(r.title)}</h2>
      <p class="small">Status: <b>${esc(r.status)}</b> · Bestellschluss ${dt(r.deadline)}</p>
      <label class="f">Titel</label><input id="r-title" type="text" value="${esc(r.title)}">
      <label class="f">Bestellschluss</label><input id="r-dl" type="datetime-local" value="${esc(r.deadline.slice(0, 16))}">
      <div class="row" style="margin-top:12px"><button class="btn" id="r-save">Speichern</button>
        ${r.status === 'offen' ? '<button class="btn orange" id="r-close">Bestellschluss jetzt</button>' : ''}
        ${r.status === 'geschlossen' ? '<button class="btn secondary" id="r-reopen">Wieder öffnen</button>' : ''}</div>
      ${r.status !== 'offen' ? `<label class="f">Status weiter setzen</label><div class="row">${statusFlow.slice(1).map((s) =>
        `<button class="btn sm ${r.status === s ? '' : 'secondary'}" data-status="${s}">${s}</button>`).join('')}</div>
        <p class="small muted">"geliefert" trägt das Leergut der Pfand-Artikel bei der jeweiligen Bestellerin ein (wird nicht berechnet).</p>` : ''}
    </div>` : ''}
    <div class="card"><h2>Neue Bestellrunde</h2>
      <label class="f">Titel</label><input id="n-title" type="text" value="Bestellung ${nextMonday17().toLocaleDateString('de-DE')}">
      <label class="f">Bestellschluss</label><input id="n-dl" type="datetime-local" value="${localInput(nextMonday17())}">
      <button class="btn" style="margin-top:12px" id="n-go">Runde anlegen</button>
      ${r && r.status !== 'abgerechnet' ? '<p class="small muted">Die neue Runde wird zur aktuellen. Die alte bleibt unter "Frühere Runden" erreichbar.</p>' : ''}
    </div>
    ${st.rounds.length > 1 ? `<div class="card"><h2>Frühere Runden</h2>${st.rounds.map((x) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <div class="grow">${esc(x.title)} <span class="muted small">${esc(x.status)}</span></div>
      <button class="btn sm secondary" data-open-round="${x.id}">Öffnen</button></div>`).join('')}</div>` : ''}
    <div class="card"><h2>Export</h2>
      <label class="f">Menge in der CSV für den Shop</label>
      <select id="x-mode"><option value="gebinde" ${st.export_menge === 'gebinde' ? 'selected' : ''}>Anzahl Gebinde (Bestelleinheiten)</option>
        <option value="einheiten" ${st.export_menge === 'einheiten' ? 'selected' : ''}>Ladeneinheiten (kg / Stück)</option></select>
      <p class="small muted">Beim ersten Import im Shop prüfen, ob die Mengen im Warenkorb stimmen.</p></div>`;
  const num2 = (s) => parseFloat(String(s).replace(',', '.')) || 0;
  if (r) {
    $('#r-save', box).onclick = async () => { await run(() => api('round_update', { id: r.id, title: $('#r-title', box).value, deadline: $('#r-dl', box).value }), 'Gespeichert'); await load(); render(); };
    const c = $('#r-close', box);
    if (c) c.onclick = async () => {
      if (!confirm('Bestellschluss jetzt? Nicht volle "muss teilen"-Artikel entfallen.')) return;
      const res = await run(() => api('round_close', { id: r.id }));
      await load(); render();
      modal(`<div class="head"><h2>Bestellschluss</h2><button class="x" data-close>×</button></div>${res.dropped.length ? `<p>Entfallen:</p><ul>${res.dropped.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '<p>Alles ist aufgegangen.</p>'}`);
    };
    const ro = $('#r-reopen', box);
    if (ro) ro.onclick = async () => { await run(() => api('round_reopen', { id: r.id }), 'Wieder offen'); await load(); render(); };
    box.querySelectorAll('[data-status]').forEach((b) => (b.onclick = async () => { await run(() => api('round_status', { id: r.id, status: b.dataset.status }), 'Status gesetzt'); await load(); render(); }));
  }
  $('#n-go', box).onclick = async () => {
    const res = await run(() => api('round_create', { title: $('#n-title', box).value, deadline: $('#n-dl', box).value }), 'Runde angelegt');
    await load(res.id); render();
  };
  box.querySelectorAll('[data-open-round]').forEach((b) => (b.onclick = async () => { await load(+b.dataset.openRound); render(); }));
  $('#x-mode', box).onchange = async (e) => { await run(() => api('settings', { export_menge: e.target.value }), 'Gespeichert'); await load(); };
}

async function admBestellung(box) {
  const r = S.state.round;
  if (!r) { box.innerHTML = '<div class="empty">Keine Runde.</div>'; return; }
  const res = await run(() => api('order_lines', undefined, `&round_id=${r.id}`));
  const sum = res.lines.reduce((s, l) => s + l.betrag, 0);
  const sumNet = res.lines.reduce((s, l) => s + l.netto, 0);
  const openN = S.state.items.filter((i) => i.status === 'aktiv' && i.mode === 'muss' && i.free > 0.0001).length;
  box.innerHTML = `
    ${r.status === 'offen' ? `<div class="hint o">Die Runde ist noch offen${openN ? `, ${openN} "muss teilen" sind nicht voll und würden entfallen` : ''}. Erst Bestellschluss machen, dann exportieren.</div>` : ''}
    <div class="card"><div class="row"><div class="grow"><b>${res.lines.length} Artikel</b> · <b>${eur(sumNet)} netto</b> · ${eur(sum)} brutto</div>
      <a class="btn" href="api.php?a=export&round_id=${r.id}">CSV herunterladen</a></div>
      <p class="small muted">Im Shop unter Produkte → Datenerfassung → "Bestellen per CSV" hochladen. Menge = ${res.mode === 'einheiten' ? 'Ladeneinheiten' : 'Anzahl Gebinde'}.
        Netto wie im Landlinie-Warenkorb (ohne Pfand), zum Abgleichen.</p></div>
    <div class="card table-wrap"><table><thead><tr><th>Art.-Nr.</th><th>Artikel</th><th class="n">Menge</th><th class="n">Netto</th><th class="n">Brutto</th></tr></thead>
      <tbody>${res.lines.map((l) => `<tr><td>${esc(l.artnr)}</td><td>${esc(l.name)}<div class="small muted">${esc(l.gebinde)} · ${eur(l.unit_price_net)}/${esc(l.einheit)} netto</div></td>
        <td class="n">${num(l.menge)}</td><td class="n">${eur(l.netto)}</td><td class="n muted">${eur(l.betrag)}</td></tr>`).join('')}
      <tr><td></td><td class="sum">Summe</td><td></td><td class="n sum">${eur(sumNet)}</td><td class="n muted">${eur(sum)}</td></tr></tbody></table></div>`;
}

function admVerteilen(box) {
  const items = S.state.items.filter((i) => i.status === 'aktiv');
  const kg = items.filter((i) => ['kg', 'l'].includes(i.article.einheit.toLowerCase()));
  const people = S.state.users.filter((u) => items.some((it) => personQty(it, u.id) > 0));
  box.innerHTML = `<div class="row no-print" style="margin-bottom:10px"><button class="btn" onclick="window.print()">Drucken</button></div>
    <h2>Verteilliste ${esc(S.state.round?.title || '')}</h2>
    ${people.map((u) => `<div class="card"><h3>${esc(u.name)}</h3><table><tbody>
      ${items.filter((it) => personQty(it, u.id) > 0).map((it) => `<tr><td style="width:28px">☐</td><td>${esc(it.article.name)} <span class="muted small">${esc(it.article.gebinde)}</span></td>
        <td class="n">${num(personQty(it, u.id))} ${esc(it.article.einheit)}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<div class="empty">Keine Positionen.</div>'}
    <h2 style="margin-top:20px">Wiegeliste</h2>
    ${kg.length ? kg.map((it) => `<div class="card"><b>${esc(it.article.name)}</b> <span class="muted small">${esc(it.article.gebinde)} · ${it.cases}×</span>
      <table><tbody>${it.people.filter((p) => p.eff > 0).map((p) => `<tr><td>${esc(userName(p.user_id))}</td><td class="n">${num(p.eff)} ${esc(it.article.einheit)}</td><td style="width:120px">gewogen: ______</td></tr>`).join('')}</tbody></table></div>`).join('') : '<div class="empty">Nichts zu wiegen.</div>'}`;
}

function admLieferung(box) {
  const r = S.state.round;
  if (!r || r.status === 'offen') { box.innerHTML = '<div class="empty">Erst nach Bestellschluss.</div>'; return; }
  const items = S.state.items.filter((i) => i.status === 'aktiv');
  box.innerHTML = `<p class="small muted">Nicht gelieferte Artikel abhaken. Bei Gewichtsware die gelieferte Gesamtmenge eintragen (wird anteilig verteilt) oder je Person die gewogene Menge. Leer = wie bestellt.</p>
    ${items.map((it) => `<div class="card">
      <div class="row"><div class="grow"><b>${esc(it.article.name)}</b> <span class="muted small">${esc(it.article.gebinde)} · ${it.cases}× · bestellt ${num(it.total)} ${esc(it.article.einheit)}</span></div>
        <label class="row small"><input type="checkbox" data-deliv="${it.id}" ${it.delivered ? 'checked' : ''}> geliefert</label></div>
      ${it.delivered ? `<div class="row" style="margin-top:6px"><div class="grow small">Geliefert gesamt</div>
        <input style="max-width:130px" type="text" inputmode="decimal" placeholder="${num(it.total)}" data-total="${it.id}" value="${it.people.every((p) => p.actual != null) && it.people.length ? num(it.people.reduce((s, p) => s + (p.actual || 0), 0)) : ''}"> <span class="small">${esc(it.article.einheit)}</span></div>
        <div class="people">${it.people.filter((p) => p.eff > 0).map((p) => `<div class="p"><span class="who">${esc(userName(p.user_id))}</span>
          <span class="row"><span class="muted small">bestellt ${num(p.eff)}</span><input style="max-width:110px" type="text" inputmode="decimal" placeholder="${num(p.eff)}" data-act="${it.id}:${p.user_id}" value="${p.actual != null ? num(p.actual) : ''}"></span></div>`).join('')}</div>` : ''}
    </div>`).join('') || '<div class="empty">Keine Positionen.</div>'}`;
  const pnum = (s) => (s.trim() === '' ? '' : parseFloat(s.replace(',', '.')));
  box.querySelectorAll('[data-deliv]').forEach((c) => (c.onchange = async () => { await run(() => api('delivery', { item_id: +c.dataset.deliv, delivered: c.checked ? 1 : 0 })); await load(); admLieferung(box); }));
  box.querySelectorAll('[data-total]').forEach((i) => (i.onchange = async () => { await run(() => api('delivery', { item_id: +i.dataset.total, actual_total: pnum(i.value) }), 'Gespeichert'); await load(); admLieferung(box); }));
  box.querySelectorAll('[data-act]').forEach((i) => (i.onchange = async () => {
    const [item, user] = i.dataset.act.split(':').map(Number);
    await run(() => api('delivery', { item_id: item, user_id: user, actual: pnum(i.value) }), 'Gespeichert'); await load();
  }));
}

async function admAbrechnung(box) {
  const r = S.state.round;
  if (!r) { box.innerHTML = '<div class="empty">Keine Runde.</div>'; return; }
  const res = await run(() => api('settlement', undefined, `&round_id=${r.id}`));
  const total = res.rows.reduce((s, x) => s + x.summe, 0);
  box.innerHTML = `<div class="row no-print" style="margin-bottom:10px"><button class="btn" onclick="window.print()">Drucken</button></div>
    <div class="card table-wrap"><h2>Abrechnung ${esc(r.title)}</h2><table><thead><tr><th>Wer</th><th class="n">Ware</th><th class="n">Summe</th><th>bezahlt</th></tr></thead>
      <tbody>${res.rows.map((x) => `<tr><td><a href="#" data-detail="${x.user_id}">${esc(x.name)}</a></td><td class="n">${eur(x.ware)}</td>
        <td class="n sum">${eur(x.summe)}</td><td><input type="checkbox" data-paid="${x.user_id}" ${x.paid ? 'checked' : ''}></td></tr>`).join('')}
      <tr><td class="sum">Gesamt</td><td></td><td class="n sum">${eur(total)}</td><td></td></tr></tbody></table>
      <p class="small muted">Preise brutto inkl. MwSt. Gewogene Mengen sind berücksichtigt, nicht gelieferte Artikel nicht.</p></div>
    ${res.rows.map((x) => `<div class="card" id="det-${x.user_id}"><h3>${esc(x.name)} – ${eur(x.summe)}</h3><table><tbody>
      ${x.zeilen.map((z) => `<tr><td>${esc(z.name)}</td><td class="n">${num(z.qty)} ${esc(z.einheit)}${z.gewogen ? ' ⚖' : ''}</td><td class="n">${eur(z.unit_price)}</td><td class="n">${eur(z.betrag)}</td></tr>`).join('')}
      ${x.extra ? `<tr><td>${esc(r.extra_text)}</td><td></td><td></td><td class="n">${eur(x.extra)}</td></tr>` : ''}</tbody></table></div>`).join('')}`;
  box.querySelectorAll('[data-paid]').forEach((c) => (c.onchange = () => run(() => api('payment', { round_id: r.id, user_id: +c.dataset.paid, paid: c.checked ? 1 : 0 }), 'Gespeichert')));
  box.querySelectorAll('[data-detail]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); $('#det-' + a.dataset.detail).scrollIntoView({ behavior: 'smooth' }); }));
}

function admLeute(box) {
  const st = S.state;
  box.innerHTML = `<div class="card"><div class="section-title" style="margin-top:0"><h2>Bestellerinnen</h2><button class="btn sm" id="u-new">Neu</button></div>
    ${st.users.map((u) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow"><b>${esc(u.name)}</b>
      ${u.is_admin ? '<span class="tag">Admin</span>' : ''}${u.active ? '' : '<span class="tag r">inaktiv</span>'}</div>
      <button class="btn sm secondary" data-u="${u.id}">Bearbeiten</button></div>`).join('')}</div>`;
  const dlg = (u) => modal(`<div class="head"><h2>${u ? 'Bearbeiten' : 'Neue Bestellerin'}</h2><button class="x" data-close>×</button></div>
    <label class="f">Name</label><input id="u-name" type="text" value="${esc(u?.name || '')}">
    <label class="f">PIN (4 Ziffern)${u ? ' – leer lassen = unverändert' : ''}</label><input id="u-pin" type="text" inputmode="numeric" maxlength="4">
    <label class="row" style="margin-top:12px"><input type="checkbox" id="u-admin" ${u?.is_admin ? 'checked' : ''}> Admin</label>
    ${u ? `<label class="row" style="margin-top:8px"><input type="checkbox" id="u-active" ${u.active ? 'checked' : ''}> aktiv</label>` : ''}
    <div class="err" id="u-err"></div>
    <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="u-ok">Speichern</button></div>`, (root, close) => {
    $('#u-ok', root).onclick = async () => {
      try {
        await api('user_save', { id: u?.id || 0, name: $('#u-name', root).value, pin: $('#u-pin', root).value, is_admin: $('#u-admin', root).checked ? 1 : 0, active: u ? ($('#u-active', root).checked ? 1 : 0) : 1 });
        close(); toast('Gespeichert'); await load(); render();
      } catch (e) { $('#u-err', root).textContent = e.message; }
    };
  });
  $('#u-new', box).onclick = () => dlg(null);
  box.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => dlg(st.users.find((u) => u.id === +b.dataset.u))));
}

function admSortiment(box) {
  const st = S.state;
  const locked = st.sortiment_naechster && new Date(st.sortiment_naechster) > new Date();
  box.innerHTML = `<div class="card"><h2>Sortiment aus dem Landlinie-Shop</h2>
      <p class="small">${st.artikel_anzahl} Artikel · Stand ${esc(st.sortiment_stand || 'noch nie')}</p>
      <button class="btn" id="sy-go" ${locked ? 'disabled' : ''}>Sortiment aktualisieren</button>
      ${locked ? `<p class="small muted">Wieder möglich ab ${dt(st.sortiment_naechster)} (höchstens alle 6 Stunden).</p>` : ''}
      <div id="sy-log" class="small" style="margin-top:10px"></div></div>
    <div class="card"><h2>Pfand-Artikel</h2>
      <p class="small muted">Ob ein Artikel Pfand hat, steht nicht in den Shop-Daten. Hier einmal festlegen (Betrag je Gebinde).</p>
      <input type="search" id="pf-q" placeholder="Artikel suchen"><div id="pf-res"></div>
      <h3 style="margin-top:14px">Artikel mit Pfand</h3><div id="pf-list"></div></div>`;
  const go = $('#sy-go', box);
  go.onclick = async () => {
    go.disabled = true;
    const log = $('#sy-log', box);
    try {
      log.textContent = 'Anmeldung im Shop …';
      const s = await api('sync_start', {});
      let n = 0;
      for (const [i, c] of s.categories.entries()) {
        log.textContent = `Warengruppe ${i + 1} von ${s.categories.length}: ${c.label} …`;
        n += (await api('sync_cat', { code: c.code })).count;
      }
      const f = await api('sync_finish', { started: s.started });
      log.textContent = `Fertig: ${f.count} Artikel, ${f.hidden} nicht mehr im Sortiment.`;
      await load();
    } catch (e) { log.textContent = 'Fehler: ' + e.message; }
  };
  const pfRow = (a) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow small"><b>${esc(a.name)}</b> ${esc(a.gebinde)}<br>
    ${a.pfand > 0 ? `Pfand ${eur(a.pfand)} (${esc(a.pfand_text)})` : 'kein Pfand'}</div><button class="btn sm secondary" data-pf="${esc(a.artnr)}">Pfand</button></div>`;
  let found = [];
  const wire = (root, list) => root.querySelectorAll('[data-pf]').forEach((b) => (b.onclick = () => {
    const a = list.find((x) => x.artnr === b.dataset.pf);
    modal(`<div class="head"><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></div>
      <label class="f">Pfand je Gebinde in € (0 = kein Pfand)</label><input id="pf-b" type="text" inputmode="decimal" value="${String(a.pfand).replace('.', ',')}">
      <label class="f">Bezeichnung</label><input id="pf-t" type="text" value="${esc(a.pfand_text || 'Mopro-Kiste')}">
      <div class="actions"><button class="btn secondary" data-close>Abbrechen</button><button class="btn" id="pf-ok">Speichern</button></div>`, (root2, close) => {
      $('#pf-ok', root2).onclick = async () => {
        await run(() => api('article_pfand', { artnr: a.artnr, pfand: parseFloat($('#pf-b', root2).value.replace(',', '.')) || 0, pfand_text: $('#pf-t', root2).value }), 'Gespeichert');
        close(); loadPf();
      };
    });
  }));
  const loadPf = async () => {
    const r = await api('articles', undefined, '&pfand=1');
    $('#pf-list', box).innerHTML = r.items.map(pfRow).join('') || '<p class="small muted">Noch keine.</p>';
    wire($('#pf-list', box), r.items);
  };
  const q = $('#pf-q', box);
  q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(async () => {
    if (q.value.trim().length < 2) { $('#pf-res', box).innerHTML = ''; return; }
    found = (await api('articles', undefined, '&q=' + encodeURIComponent(q.value))).items.slice(0, 10);
    $('#pf-res', box).innerHTML = found.map(pfRow).join('');
    wire($('#pf-res', box), found);
  }, 250); };
  loadPf();
}

start();
