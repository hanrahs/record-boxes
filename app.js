'use strict';
/*
 * Record Boxes — track which storage box each record is packed in.
 * Everything is stored on the device (IndexedDB). No server, no accounts.
 */

/* =========================================================================
 * Helpers
 * ========================================================================= */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const boxCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = t => t
  ? new Date(+t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : 'never';
const plural = (n, word) => `${n.toLocaleString()} ${n === 1 ? word : word + (/(x|ch|sh|s)$/.test(word) ? 'es' : 's')}`;

/* =========================================================================
 * Storage (IndexedDB)
 * ========================================================================= */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('record-boxes', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('records', { keyPath: 'key' });
        db.createObjectStore('boxes', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  all(store) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  write(store, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      fn(tx.objectStore(store));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  putMany(store, items) {
    const conv = store === 'records' ? toStored : x => x;
    return this.write(store, os => items.forEach(i => os.put(conv(i))));
  },
  put(store, item) { return this.putMany(store, [item]); },
  del(store, key) { return this.write(store, os => os.delete(key)); },
  clear(store) { return this.write(store, os => os.clear()); },
};

/* =========================================================================
 * State
 * ========================================================================= */
const S = {
  records: [],          // sorted array of record objects
  byKey: new Map(),     // key -> record
  boxes: new Map(),     // id -> { id, parent, created }
  tab: 'records',
  activeBox: localStorage.getItem('activeBox') || null,
  hidePacked: localStorage.getItem('hidePacked') !== '0',
  query: '',
  barcode: null,        // { label, keys:Set } when filtering by a scanned barcode
  listLimit: 200,
};

const settings = {
  get user() { return localStorage.getItem('dUser') || ''; },
  set user(v) { localStorage.setItem('dUser', v.trim()); },
  get token() { return (localStorage.getItem('dToken') || '').trim(); },
  set token(v) { localStorage.setItem('dToken', v.trim()); },
  get changes() { return +(localStorage.getItem('changes') || 0); },
  set changes(v) { localStorage.setItem('changes', v); },
};

function touched() { settings.changes = settings.changes + 1; }

// Derived fields used for search & sort (not stored).
function prep(r) {
  r.hay = norm([r.artist, r.title, r.label, r.catno, r.year, r.format].join(' '));
  r.sortKey = norm(r.artist).replace(/^the\s+/, '');
  return r;
}
function toStored(r) {
  const { hay, sortKey, ...rest } = r;
  return rest;
}
function sortRecords() {
  S.records.sort((a, b) =>
    a.sortKey.localeCompare(b.sortKey) ||
    (+a.year || 9999) - (+b.year || 9999) ||
    String(a.title).localeCompare(String(b.title)));
}
function addRecordToState(r) {
  prep(r);
  S.records.push(r);
  S.byKey.set(r.key, r);
}
function setActiveBox(id) {
  S.activeBox = id || null;
  if (id) localStorage.setItem('activeBox', id); else localStorage.removeItem('activeBox');
}

/* =========================================================================
 * Boxes
 * ========================================================================= */
const topBoxes = () => [...S.boxes.values()].filter(b => !b.parent).sort((a, b) => boxCmp(a.id, b.id));
const childBoxes = id => [...S.boxes.values()].filter(b => b.parent === id).sort((a, b) => boxCmp(a.id, b.id));
const recordsIn = id => S.records.filter(r => r.box === id);

function countByBox() {
  const c = {};
  for (const r of S.records) if (r.box) c[r.box] = (c[r.box] || 0) + 1;
  return c;
}
function boxTotal(id, counts = countByBox()) {
  return (counts[id] || 0) + childBoxes(id).reduce((n, k) => n + (counts[k.id] || 0), 0);
}
function locText(boxId) {
  if (!boxId) return '';
  const b = S.boxes.get(boxId);
  return b?.parent ? `${b.parent} › ${b.id}` : boxId;
}
function splitLoc(boxId) {
  if (!boxId) return { outer: '', inner: '' };
  const b = S.boxes.get(boxId);
  return b?.parent ? { outer: b.parent, inner: b.id } : { outer: boxId, inner: '' };
}
function nextOuterId() {
  let max = 100;
  for (const b of S.boxes.values()) if (!b.parent && /^\d+$/.test(b.id)) max = Math.max(max, +b.id);
  return String(max + 1);
}
function nextInnerId(parent) {
  for (let i = 0; i < 26; i++) {
    const id = parent + String.fromCharCode(65 + i);
    if (!S.boxes.has(id)) return id;
  }
  return parent + '-';
}
async function createBox(id, parent) {
  id = String(id || '').trim().toUpperCase();
  if (!id) return null;
  if (S.boxes.has(id)) { toast(`Box ${id} already exists`); return null; }
  const b = { id, parent: parent || null, created: Date.now() };
  S.boxes.set(id, b);
  await DB.put('boxes', b);
  touched();
  return b;
}

async function setBox(r, boxId) {
  const prev = r.box || null;
  r.box = boxId || null;
  r.packedAt = boxId ? Date.now() : null;
  await DB.put('records', r);
  touched();
  updateProgress();
  return prev;
}

/* =========================================================================
 * Discogs
 * ========================================================================= */
async function dFetch(path) {
  const token = settings.token;
  if (!token) throw new Error('Add your Discogs token first (Sync & export tab).');
  const url = 'https://api.discogs.com' + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try { res = await fetch(url); }
    catch {
      // Discogs rate-limit replies can look like network errors in a browser, so wait and retry once or twice.
      if (attempt < 2 && navigator.onLine) { await sleep(15000); continue; }
      throw new Error("Couldn't reach Discogs — check your internet connection.");
    }
    if (res.status === 429) { await sleep(15000); continue; }
    if (res.status === 401) throw new Error('Discogs did not accept the token. Check it in the Sync & export tab.');
    if (res.status === 403) throw new Error('Discogs refused access. Check the username matches the account the token belongs to.');
    if (res.status === 404) throw new Error('Not found on Discogs — check the username.');
    if (!res.ok) throw new Error('Discogs error ' + res.status);
    return res.json();
  }
  throw new Error('Discogs is busy (rate limit). Wait a minute and try again.');
}

const cleanName = n => String(n || '').replace(/\s\(\d+\)$/, '').trim();

function mapDiscogs(item) {
  const b = item.basic_information || {};
  const artists = b.artists || [];
  let artist = '';
  artists.forEach((a, i) => {
    artist += cleanName(a.name);
    if (i < artists.length - 1) {
      const j = (a.join || '').trim();
      artist += !j || j === ',' ? ', ' : ` ${j} `;
    }
  });
  const format = (b.formats || []).map(f => {
    const qty = +f.qty > 1 ? `${f.qty}×` : '';
    const desc = (f.descriptions || []).filter(d => d !== f.name).join(', ');
    return qty + (f.name || '') + (desc ? `, ${desc}` : '');
  }).join(' + ');
  const label = (b.labels || [])[0] || {};
  const img = u => (u && !/spacer\.gif/.test(u) ? u : '');
  return {
    releaseId: b.id,
    masterId: b.master_id || null,
    artist: artist || 'Unknown artist',
    title: b.title || 'Untitled',
    year: b.year ? String(b.year) : '',
    format,
    label: cleanName(label.name),
    catno: label.catno && label.catno !== 'none' ? label.catno : '',
    thumb: img(b.thumb),
    cover: img(b.cover_image),
  };
}

async function syncDiscogs(onStatus) {
  const user = settings.user;
  if (!user) throw new Error('Enter your Discogs username first.');
  const items = [];
  let page = 1, pages = 1;
  do {
    onStatus(`Downloading from Discogs… page ${page}${pages > 1 ? ' of ' + pages : ''}`);
    const data = await dFetch(`/users/${encodeURIComponent(user)}/collection/folders/0/releases?per_page=100&page=${page}`);
    pages = data.pagination?.pages || 1;
    items.push(...(data.releases || []));
    page++;
    if (page <= pages) await sleep(1100); // stay under Discogs' 60 requests/minute
  } while (page <= pages);

  onStatus('Saving…');
  const seen = new Set();
  const changed = [];
  let added = 0, gone = 0;
  for (const it of items) {
    const key = 'd' + it.instance_id;
    seen.add(key);
    const info = mapDiscogs(it);
    const existing = S.byKey.get(key);
    if (existing) {
      Object.assign(existing, info, { removed: false });
      prep(existing);
      changed.push(existing);
    } else {
      const r = { key, source: 'discogs', instanceId: it.instance_id, box: null, packedAt: null, addedAt: Date.now(), ...info };
      addRecordToState(r);
      changed.push(r);
      added++;
    }
  }
  for (const r of S.records) {
    if (r.source === 'discogs' && !seen.has(r.key) && !r.removed) {
      r.removed = true;
      changed.push(r);
      gone++;
    }
  }
  await DB.putMany('records', changed);
  sortRecords();
  localStorage.setItem('lastSync', Date.now());
  return { total: items.length, added, gone };
}

async function lookupBarcode(code) {
  code = code.replace(/\D/g, '');
  let data = await dFetch(`/database/search?type=release&per_page=100&barcode=${code}`);
  // A UPC read as EAN-13 gets a leading 0 — try without it too.
  if (!data.results?.length && code.length === 13 && code[0] === '0') {
    data = await dFetch(`/database/search?type=release&per_page=100&barcode=${code.slice(1)}`);
  }
  const results = data.results || [];
  const ids = new Set(results.map(r => r.id));
  let matches = S.records.filter(r => r.releaseId && ids.has(r.releaseId));
  let note = '';
  if (!matches.length) {
    const masters = new Set(results.map(r => r.master_id).filter(Boolean));
    matches = S.records.filter(r => r.masterId && masters.has(r.masterId));
    if (matches.length) note = 'same album, different pressing';
  }
  return { code, results, matches, note };
}

/* =========================================================================
 * Navigation — tabs + a stack of full-screen sub-views (Android back works)
 * ========================================================================= */
const stack = []; // { el, build }
let afterPop = null;

function pushView(build) {
  const el = document.createElement('section');
  el.className = 'view sub';
  $('main').appendChild(el);
  const entry = { el, build, state: {} };
  stack.push(entry);
  build(el, entry);
  showTop();
  history.pushState({ depth: stack.length }, '');
  return entry;
}
function showTop() {
  const top = stack[stack.length - 1];
  document.querySelectorAll('main > .view').forEach(v => { v.hidden = true; });
  if (top) top.el.hidden = false; else $('#v-' + S.tab).hidden = false;
  $('#tabs').hidden = !!top;
  document.body.classList.toggle('insub', !!top);
}
const goBack = () => history.back();

window.addEventListener('popstate', e => {
  // Back pressed while a pop-up is open: just close the pop-up and stay put.
  if (openModals.length) {
    closeAllModals();
    history.pushState({ depth: stack.length }, '');
    return;
  }
  stopScanner();
  const depth = e.state?.depth || 0;
  while (stack.length > depth) stack.pop().el.remove();
  showTop();
  const top = stack[stack.length - 1];
  if (top) {
    const st = top.el.scrollTop;
    top.build(top.el, top);
    top.el.scrollTop = st;
  } else {
    refreshTab();
  }
  if (afterPop) { const fn = afterPop; afterPop = null; fn(); }
});

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  showTop();
  refreshTab();
}
function refreshTab() {
  if (S.tab === 'records') { renderActiveBar(); renderList(); }
  else if (S.tab === 'boxes') renderBoxes();
  else renderMore();
  updateProgress();
}

const subhead = (title, extra = '') =>
  `<div class="subhead noprint"><button class="back" data-back>‹ Back</button><h2>${esc(title)}</h2>${extra}</div>`;

document.addEventListener('click', e => {
  if (e.target.closest('[data-back]')) goBack();
});

/* =========================================================================
 * UI bits: toast, modals
 * ========================================================================= */
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) t.querySelector('button').onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3500);
}

const openModals = [];
function openModal(build) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="sheet"></div>';
    document.body.appendChild(ov);
    const close = v => {
      ov.remove();
      const i = openModals.indexOf(close);
      if (i >= 0) openModals.splice(i, 1);
      resolve(v);
    };
    openModals.push(close);
    ov.addEventListener('click', e => { if (e.target === ov) close(null); });
    build(ov.firstChild, close);
  });
}
function closeAllModals() { [...openModals].forEach(c => c(null)); }

function askText(title, value = '', hint = '') {
  return openModal((el, close) => {
    el.innerHTML = `<h3>${esc(title)}</h3>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
      <input class="field" value="${esc(value)}" autocapitalize="characters" autocomplete="off">
      <div class="btns"><button class="btn ghost" data-a="c">Cancel</button><button class="btn primary" data-a="ok">OK</button></div>`;
    const inp = $('input', el);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    el.onclick = e => {
      const a = e.target.dataset.a;
      if (a === 'c') close(null);
      if (a === 'ok') close(inp.value.trim());
    };
    inp.onkeydown = e => { if (e.key === 'Enter') close(inp.value.trim()); };
  });
}
function confirmDlg(title, text, okLabel = 'OK', danger = false) {
  return openModal((el, close) => {
    el.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="btns"><button class="btn ghost" data-a="c">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`;
    el.onclick = e => {
      if (e.target.dataset.a === 'c') close(false);
      if (e.target.dataset.a === 'ok') close(true);
    };
  });
}

// Choose (or create) a box. Resolves to a box id or null.
function pickBox(title, current) {
  return openModal((el, close) => {
    const counts = countByBox();
    let h = `<h3>${esc(title)}</h3>
      <button class="btn primary wide" data-a="newouter">+ New outer box (${esc(nextOuterId())})</button><div style="margin-top:8px">`;
    const tops = topBoxes();
    if (!tops.length) h += `<p class="muted">No boxes yet — create the first one above.</p>`;
    for (const t of tops) {
      h += `<div class="pickgroup"><div class="pickrow">
          <button class="pickbtn ${t.id === current ? 'cur' : ''}" data-pick="${esc(t.id)}">${esc(t.id)} <span class="muted">· ${boxTotal(t.id, counts)}</span></button>
          <button class="btn small ghost" data-newinner="${esc(t.id)}">+ inner</button></div>`;
      for (const c of childBoxes(t.id)) {
        h += `<button class="pickbtn inner ${c.id === current ? 'cur' : ''}" data-pick="${esc(c.id)}">${esc(c.id)} <span class="muted">· ${counts[c.id] || 0}</span></button>`;
      }
      h += `</div>`;
    }
    h += `</div><div class="btns"><button class="btn ghost" data-a="c">Cancel</button></div>`;
    el.innerHTML = h;
    const cur = $('.cur', el);
    if (cur) cur.scrollIntoView({ block: 'center' });
    else el.scrollTop = el.scrollHeight;

    el.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.pick) return close(b.dataset.pick);
      if (b.dataset.a === 'c') return close(null);
      if (b.dataset.a === 'newouter') {
        const id = await askText('New outer box', nextOuterId(), 'The big box. Inner boxes go inside it.');
        if (id) { const nb = await createBox(id, null); if (nb) close(nb.id); }
      }
      if (b.dataset.newinner) {
        const p = b.dataset.newinner;
        const id = await askText(`New inner box inside ${p}`, nextInnerId(p));
        if (id) { const nb = await createBox(id, p); if (nb) close(nb.id); }
      }
    };
  });
}

/* =========================================================================
 * Progress header
 * ========================================================================= */
function updateProgress() {
  const total = S.records.length;
  const packed = S.records.reduce((n, r) => n + (r.box ? 1 : 0), 0);
  const outers = topBoxes().length;
  $('#ptext').innerHTML = total
    ? `<b>${packed.toLocaleString()}</b> of ${total.toLocaleString()} packed <span class="muted">(${Math.floor(packed / total * 100)}%) · ${plural(outers, 'outer box')}</span>`
    : `<span class="muted">No records yet — go to Sync &amp; export to load from Discogs</span>`;
  $('#pfill').style.width = total ? (packed / total * 100) + '%' : '0';
}

/* =========================================================================
 * Records tab
 * ========================================================================= */
function rowHtml(r, withPut) {
  const img = r.photo || r.thumb;
  let right = '';
  if (r.box) right = `<span class="badge">${esc(locText(r.box))}</span>`;
  else if (withPut && S.activeBox) right = `<button class="put" data-put="${esc(r.key)}">+ ${esc(S.activeBox)}</button>`;
  const meta = [r.format, r.year, r.catno].filter(Boolean).join(' · ');
  return `<li class="row ${r.box ? 'packed' : ''}" data-key="${esc(r.key)}">
    ${img ? `<img class="thumb" loading="lazy" src="${esc(img)}" alt="">` : `<div class="thumb ph">♪</div>`}
    <div class="info">
      <div class="t1">${esc(r.title)}</div>
      <div class="t2">${esc(r.artist)}</div>
      <div class="t3">${esc(meta)}${r.source === 'manual' ? ' <span class="tag">manual</span>' : ''}${r.removed ? ' <span class="warn">not in Discogs</span>' : ''}</div>
    </div>${right}</li>`;
}

function filtered() {
  if (S.barcode) return S.records.filter(r => S.barcode.keys.has(r.key));
  const toks = norm(S.query).split(/\s+/).filter(Boolean);
  return S.records.filter(r => (!S.hidePacked || !r.box) && toks.every(t => r.hay.includes(t)));
}

function renderList() {
  const view = $('#v-records');
  const st = view.scrollTop;
  const items = filtered();
  const shown = items.slice(0, S.listLimit);
  $('#list').innerHTML = shown.map(r => rowHtml(r, true)).join('');
  $('#count').textContent = S.records.length ? `${items.length.toLocaleString()} shown` : '';
  $('#more-wrap').innerHTML = items.length > shown.length
    ? `<button class="btn wide" id="showmore">Show more (${(items.length - shown.length).toLocaleString()} more)</button>` : '';
  let empty = '';
  if (!S.records.length) empty = 'No records yet. Open <b>Sync &amp; export</b>, enter your Discogs token and tap <b>Sync</b>.';
  else if (!items.length) empty = S.hidePacked && S.query ? 'Nothing unpacked matches. (Packed records are hidden — turn off “Hide packed” to see them.)' : 'Nothing matches.';
  $('#empty').innerHTML = empty;
  $('#barcodechip').innerHTML = S.barcode
    ? `<div class="bcchip"><span>🔎 ${esc(S.barcode.label)}</span><button class="btn small ghost" data-a="clearbc">✕ Clear</button></div>` : '';
  view.scrollTop = st;
}

function renderActiveBar() {
  if (S.activeBox && !S.boxes.has(S.activeBox)) setActiveBox(null);
  const id = S.activeBox;
  $('#activebar').innerHTML = id
    ? `<div class="active">
         <div class="grow"><div class="muted small">Packing into</div><div class="activeid">${esc(locText(id))}</div></div>
         <div class="muted small">${plural(recordsIn(id).length, 'record')}</div>
         <button class="btn small" data-a="changebox">Change</button>
         <button class="btn small ghost" data-a="stopbox" aria-label="Stop packing">✕</button>
       </div>`
    : `<button class="btn primary wide" style="margin-top:0" data-a="changebox">📦 Choose a box to pack into</button>`;

  const n = settings.changes;
  $('#backupnag').innerHTML = n >= 100
    ? `<div class="nag"><span>${n} changes since your last backup</span><button class="btn small" data-a="backup">Back up now</button></div>` : '';
}

function refreshRow(r) {
  const li = $(`#list li[data-key="${CSS.escape(r.key)}"]`);
  if (!li) return;
  if (r.box && S.hidePacked && !S.barcode) li.remove();
  else li.outerHTML = rowHtml(r, true);
}

async function chooseActiveBox() {
  const id = await pickBox('Pack into which box?', S.activeBox);
  if (id) { setActiveBox(id); renderActiveBar(); renderList(); }
}

function wireRecordsTab() {
  const q = $('#q');
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      S.query = q.value;
      S.barcode = null;
      S.listLimit = 200;
      $('#v-records').scrollTop = 0;
      renderList();
    }, 120);
  });

  const hp = $('#hidepacked');
  hp.checked = S.hidePacked;
  hp.addEventListener('change', () => {
    S.hidePacked = hp.checked;
    localStorage.setItem('hidePacked', hp.checked ? '1' : '0');
    S.listLimit = 200;
    renderList();
  });

  $('#scanbtn').addEventListener('click', openScanner);

  $('#v-records').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (btn?.id === 'showmore') { S.listLimit += 300; renderList(); return; }
    if (btn?.dataset.a === 'changebox') return chooseActiveBox();
    if (btn?.dataset.a === 'stopbox') { setActiveBox(null); renderActiveBar(); renderList(); return; }
    if (btn?.dataset.a === 'clearbc') { S.barcode = null; renderList(); return; }
    if (btn?.dataset.a === 'backup') return doBackup();

    if (btn?.dataset.put) {
      const r = S.byKey.get(btn.dataset.put);
      const box = S.activeBox;
      if (!r || !box) return;
      const prev = await setBox(r, box);
      refreshRow(r);
      renderActiveBar();
      toast(`${r.title} → ${locText(box)}`, 'Undo', async () => {
        await setBox(r, prev);
        renderActiveBar();
        renderList();
      });
      return;
    }
    const row = e.target.closest('.row');
    if (row) openDetail(row.dataset.key);
  });
}

/* =========================================================================
 * Record detail
 * ========================================================================= */
function openDetail(key) {
  pushView(el => {
    const r = S.byKey.get(key);
    if (!r) { el.innerHTML = subhead('Record') + '<p class="pad muted">This record has been deleted.</p>'; return; }
    const img = r.photo || r.cover || r.thumb;
    const dl = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
    const canPutActive = S.activeBox && r.box !== S.activeBox;
    el.innerHTML = `${subhead(r.artist)}
      <div class="detail">
        ${img ? `<img class="cover" src="${esc(img)}" alt="">` : `<div class="cover ph">♪</div>`}
        <h2>${esc(r.title)}</h2>
        <div class="artist">${esc(r.artist)}</div>
        <dl>${dl('Format', r.format)}${dl('Year', r.year)}${dl('Label', r.label)}${dl('Cat no', r.catno)}${r.packedAt ? dl('Packed', fmtDate(r.packedAt)) : ''}</dl>
        ${r.removed ? `<p class="warn">This record is no longer in your Discogs collection.</p>` : ''}
        <div class="loc ${r.box ? '' : 'none'}">${r.box ? `📦 In box <b>${esc(locText(r.box))}</b>` : 'Not packed yet'}</div>
        ${canPutActive ? `<button class="btn primary wide" data-a="active">Put in ${esc(S.activeBox)}</button>` : ''}
        <button class="btn wide ${canPutActive ? '' : (r.box ? '' : 'primary')}" data-a="pick">${r.box ? 'Move to another box…' : 'Choose box…'}</button>
        ${r.box ? `<button class="btn wide" data-a="openbox">Look in box ${esc(r.box)}</button>
                   <button class="btn ghost wide" data-a="unbox">Take out of box (mark unpacked)</button>` : ''}
        ${r.releaseId ? `<a class="btn ghost wide" href="https://www.discogs.com/release/${encodeURIComponent(r.releaseId)}" target="_blank" rel="noopener">Open on Discogs</a>` : ''}
        ${r.source === 'manual' ? `<button class="btn ghost wide" data-a="edit">Edit details</button>` : ''}
        ${r.source === 'manual' || r.removed ? `<button class="btn danger wide" data-a="delete">Delete from this app</button>` : ''}
      </div>`;

    el.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'active' || a === 'pick') {
        const box = a === 'active' ? S.activeBox : await pickBox(`Which box is “${r.title}” in?`, r.box);
        if (!box) return;
        const prev = await setBox(r, box);
        goBack();
        toast(`${r.title} → ${locText(box)}`, 'Undo', async () => { await setBox(r, prev); refreshCurrent(); });
      }
      if (a === 'unbox') {
        await setBox(r, null);
        rebuild(el);
      }
      if (a === 'openbox') openBox(r.box);
      if (a === 'edit') openManual(r.key);
      if (a === 'delete') {
        if (!(await confirmDlg('Delete record?', `Remove “${r.title}” from this app?`, 'Delete', true))) return;
        S.records = S.records.filter(x => x !== r);
        S.byKey.delete(r.key);
        await DB.del('records', r.key);
        touched();
        goBack();
        toast('Deleted');
      }
    };
  });
}
function refreshCurrent() {
  const top = stack[stack.length - 1];
  if (top) rebuild(top.el); else refreshTab();
}

/* =========================================================================
 * Boxes tab & box view
 * ========================================================================= */
function renderBoxes() {
  const el = $('#v-boxes');
  const st = el.scrollTop;
  const counts = countByBox();
  const tops = topBoxes();
  const unpacked = S.records.length - Object.values(counts).reduce((a, b) => a + b, 0);
  let h = `<div class="pad">
      <button class="btn primary wide" data-a="newouter">+ New outer box (${esc(nextOuterId())})</button>
      <p class="muted small">${plural(tops.length, 'outer box')}, ${plural(S.boxes.size - tops.length, 'inner box')} · ${plural(unpacked, 'record')} not packed yet</p>
    </div>`;
  if (!tops.length) h += `<p class="pad muted">No boxes yet. Boxes are numbered from 101; inner boxes get a letter (101A, 101B…).</p>`;
  for (const t of tops) {
    const kids = childBoxes(t.id);
    h += `<div class="boxcard ${S.activeBox === t.id ? 'activebox' : ''}">
        <button class="boxhead" data-box="${esc(t.id)}"><span class="boxid">${esc(t.id)}</span>
          <span class="muted small">${plural(boxTotal(t.id, counts), 'record')}${kids.length ? ` · ${kids.length} inner` : ''}${S.activeBox === t.id ? ' · packing now' : ''}</span></button>
        ${kids.length ? `<div class="chips">${kids.map(k => `<button class="chip ${S.activeBox === k.id ? 'activebox' : ''}" data-box="${esc(k.id)}">${esc(k.id)}<span>${counts[k.id] || 0}</span></button>`).join('')}</div>` : ''}
      </div>`;
  }
  el.innerHTML = h;
  el.scrollTop = st;
}

function wireBoxesTab() {
  $('#v-boxes').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.box) return openBox(b.dataset.box);
    if (b.dataset.a === 'newouter') {
      const id = await askText('New outer box', nextOuterId(), 'The big box. Inner boxes go inside it.');
      if (id && await createBox(id, null)) renderBoxes();
    }
  });
}

function openBox(id) {
  pushView(el => {
    const b = S.boxes.get(id);
    if (!b) { el.innerHTML = subhead(`Box ${id}`) + '<p class="pad muted">This box has been deleted.</p>'; return; }
    const kids = childBoxes(id);
    const direct = recordsIn(id);
    const counts = countByBox();
    const total = boxTotal(id, counts);
    let h = subhead(`Box ${id}`) + `<div class="pad">
        <p style="margin-top:0">${plural(total, 'record')}${kids.length ? ` in ${plural(kids.length, 'inner box')}` : ''}${b.parent ? ` · inside outer box <button class="link" data-box="${esc(b.parent)}">${esc(b.parent)}</button>` : ''}</p>
        <div class="btnrow">
          ${S.activeBox === id
            ? `<button class="btn" data-a="stoppack">✓ Packing now — stop</button>`
            : `<button class="btn primary" data-a="pack">Pack into this box</button>`}
          ${!b.parent ? `<button class="btn" data-a="newinner">+ Inner box</button>` : ''}
          <button class="btn" data-a="print">Print list</button>
          ${!kids.length ? `<button class="btn ghost" data-a="move">${b.parent ? 'Move…' : 'Put inside another box…'}</button>` : ''}
          ${!direct.length && !kids.length ? `<button class="btn danger" data-a="del">Delete box</button>` : ''}
        </div></div>`;
    for (const k of kids) {
      const recs = recordsIn(k.id);
      h += `<div class="secthead"><span>${esc(k.id)} · ${plural(recs.length, 'record')}</span><button class="btn small ghost" data-box="${esc(k.id)}">Open</button></div>
            <ul class="list">${recs.map(r => rowHtml(r, false)).join('') || '<li class="pad muted small">Empty</li>'}</ul>`;
    }
    if (direct.length || !kids.length) {
      if (kids.length) h += `<div class="secthead"><span>Directly in ${esc(id)} · ${plural(direct.length, 'record')}</span></div>`;
      h += `<ul class="list">${direct.map(r => rowHtml(r, false)).join('') || '<li class="pad muted">This box is empty.</li>'}</ul>`;
    }
    el.innerHTML = h;

    el.onclick = async e => {
      const btn = e.target.closest('button');
      if (btn?.dataset.box) return openBox(btn.dataset.box);
      const a = btn?.dataset.a;
      if (a === 'pack') { setActiveBox(id); afterPop = () => switchTab('records'); history.go(-stack.length); return; }
      if (a === 'stoppack') { setActiveBox(null); rebuild(el); return; }
      if (a === 'newinner') {
        const nid = await askText(`New inner box inside ${id}`, nextInnerId(id));
        if (nid && await createBox(nid, id)) rebuild(el);
        return;
      }
      if (a === 'print') return openPrint(id);
      if (a === 'move') {
        const target = await pickOuter(id, b.parent);
        if (target === undefined) return;
        b.parent = target;
        await DB.put('boxes', b);
        touched();
        rebuild(el);
        toast(target ? `${id} is now inside ${target}` : `${id} is now an outer box`);
        return;
      }
      if (a === 'del') {
        if (!(await confirmDlg(`Delete box ${id}?`, 'The box is empty.', 'Delete', true))) return;
        S.boxes.delete(id);
        await DB.del('boxes', id);
        if (S.activeBox === id) setActiveBox(null);
        touched();
        goBack();
        return;
      }
      const row = e.target.closest('.row');
      if (row) openDetail(row.dataset.key);
    };
  });
}
function rebuild(el) {
  const entry = stack.find(s => s.el === el);
  if (!entry) return;
  const st = el.scrollTop;
  entry.build(el, entry);
  el.scrollTop = st;
}

// Choose which outer box a box sits inside. Resolves to id, null (= make outer), or undefined (= cancel).
function pickOuter(selfId, current) {
  return openModal((el, close) => {
    const opts = topBoxes().filter(t => t.id !== selfId);
    el.innerHTML = `<h3>Put ${esc(selfId)} inside…</h3>
      ${current ? `<button class="pickbtn" data-none="1">Nothing — make it an outer box</button>` : ''}
      ${opts.map(t => `<button class="pickbtn ${t.id === current ? 'cur' : ''}" data-id="${esc(t.id)}">${esc(t.id)}</button>`).join('')}
      <div class="btns"><button class="btn ghost" data-a="c">Cancel</button></div>`;
    el.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'c') close(null);
      if (b.dataset.none) close('');
      if (b.dataset.id) close(b.dataset.id);
    };
  }).then(v => (v === null ? undefined : (v || null)));
}

/* =========================================================================
 * Barcode scanner
 * ========================================================================= */
let scanStream = null, scanTimer = null;

function stopScanner() {
  clearTimeout(scanTimer);
  scanStream?.getTracks().forEach(t => t.stop());
  scanStream = null;
}

async function startScanner(video, onCode) {
  if (!('BarcodeDetector' in window)) throw new Error('nodetector');
  const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = wanted.filter(f => supported.includes(f));
  if (!formats.length) throw new Error('nodetector');
  const detector = new BarcodeDetector({ formats });
  scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  video.srcObject = scanStream;
  await video.play();
  const tick = async () => {
    if (!scanStream) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        const code = codes[0].rawValue;
        stopScanner();
        navigator.vibrate?.(60);
        onCode(code);
        return;
      }
    } catch { /* frame not ready */ }
    scanTimer = setTimeout(tick, 200);
  };
  tick();
}

function openScanner() {
  pushView((el, entry) => {
    if (entry.state.built) return;
    entry.state.built = true;
    el.innerHTML = `${subhead('Scan barcode')}
      <div class="pad">
        <div class="scanbox"><video playsinline muted></video><div class="scanline"></div></div>
        <p class="muted small" id="scanmsg">Point the camera at the barcode on the back of the sleeve. Needs internet (looks the barcode up on Discogs).</p>
        <div class="row2"><input class="field" id="manualcode" inputmode="numeric" placeholder="…or type the barcode number"><button class="btn" data-a="go">Find</button></div>
        <div id="scanresult"></div>
      </div>`;
    const video = $('video', el);
    const msg = $('#scanmsg', el);
    const result = $('#scanresult', el);

    const start = () => {
      result.innerHTML = '';
      startScanner(video, handle).catch(err => {
        $('.scanbox', el).hidden = true;
        msg.textContent = err.message === 'nodetector'
          ? 'This browser can’t scan barcodes — type the number instead.'
          : 'Couldn’t open the camera (permission?). You can type the number instead.';
      });
    };

    const handle = async code => {
      msg.textContent = `Looking up ${code} on Discogs…`;
      try {
        const { matches, results, note } = await lookupBarcode(code);
        if (matches.length) {
          S.barcode = {
            label: `Barcode ${code} · ${plural(matches.length, 'match')}${note ? ' (' + note + ')' : ''}`,
            keys: new Set(matches.map(m => m.key)),
          };
          S.query = '';
          $('#q').value = '';
          afterPop = () => switchTab('records');
          goBack();
          return;
        }
        msg.textContent = '';
        result.innerHTML = `<p><b>${esc(code)}</b> isn’t in your collection.</p>
          ${results.length ? `<p class="muted small">On Discogs it’s: ${results.slice(0, 3).map(r => esc(r.title)).join('; ')}</p>` : `<p class="muted small">Discogs doesn’t know this barcode either.</p>`}
          <button class="btn primary wide" data-a="again">Scan another</button>`;
      } catch (err) {
        msg.textContent = err.message;
        result.innerHTML = `<button class="btn primary wide" data-a="again">Try again</button>`;
      }
    };

    el.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'again') { $('.scanbox', el).hidden = false; msg.textContent = 'Point the camera at the barcode.'; start(); }
      if (a === 'go') {
        const code = $('#manualcode', el).value.replace(/\D/g, '');
        if (code) { stopScanner(); handle(code); }
      }
    };
    start();
  });
}

/* =========================================================================
 * Manual records (not on Discogs)
 * ========================================================================= */
function resizeImage(file, max = 500) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

function openManual(key) {
  pushView((el, entry) => {
    if (entry.state.built) return;
    entry.state.built = true;
    const r = key ? S.byKey.get(key) : null;
    let photo = r?.photo || '';
    const f = (name, label, extra = '') =>
      `<label class="lbl">${label}<input class="field" name="${name}" value="${esc(r?.[name] || '')}" ${extra}></label>`;
    el.innerHTML = `${subhead(r ? 'Edit record' : 'Add a record')}
      <div class="pad">
        <p class="muted small" style="margin-top:0">For records that aren’t in your Discogs collection.</p>
        ${f('artist', 'Artist')}
        ${f('title', 'Title')}
        ${f('format', 'Format', 'placeholder="e.g. LP, 7\\", 2×LP Box Set"')}
        ${f('year', 'Year', 'inputmode="numeric"')}
        ${f('label', 'Label')}
        ${f('catno', 'Catalogue number')}
        <img class="photoprev" ${photo ? `src="${esc(photo)}"` : 'hidden'} alt="">
        <label class="btn wide">📷 ${photo ? 'Change' : 'Add'} cover photo<input type="file" accept="image/*" name="photo" hidden></label>
        <button class="btn primary wide" data-a="save" style="margin-top:16px">Save</button>
      </div>`;

    $('input[name=photo]', el).addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        photo = await resizeImage(file);
        const p = $('.photoprev', el);
        p.src = photo;
        p.hidden = false;
      } catch (err) { toast(err.message); }
    });

    el.onclick = async e => {
      if (e.target.closest('[data-a]')?.dataset.a !== 'save') return;
      const val = n => $(`input[name=${n}]`, el).value.trim();
      const data = {
        artist: val('artist') || 'Unknown artist',
        title: val('title'),
        format: val('format'),
        year: val('year'),
        label: val('label'),
        catno: val('catno'),
        photo,
      };
      if (!data.title) { toast('Please enter a title'); return; }
      if (r) {
        Object.assign(r, data);
        prep(r);
        sortRecords();
        await DB.put('records', r);
        touched();
        goBack();
        toast('Saved');
      } else {
        const nr = { key: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), source: 'manual', box: null, packedAt: null, addedAt: Date.now(), ...data };
        addRecordToState(nr);
        sortRecords();
        await DB.put('records', nr);
        touched();
        afterPop = () => {
          S.query = data.title;
          S.barcode = null;
          $('#q').value = data.title;
          switchTab('records');
          toast('Added');
        };
        goBack();
      }
    };
  });
}

/* =========================================================================
 * Sync & export tab
 * ========================================================================= */
function renderMore() {
  const el = $('#v-more');
  const manualCount = S.records.filter(r => r.source === 'manual').length;
  const lastBackup = localStorage.getItem('lastBackup');
  el.innerHTML = `<div class="pad">
    <h3 style="margin-top:4px">Discogs</h3>
    <label class="lbl">Username<input class="field" id="duser" value="${esc(settings.user)}" autocapitalize="off" autocomplete="off"></label>
    <label class="lbl">Personal access token<input class="field" id="dtoken" type="password" value="${esc(settings.token)}" autocomplete="off"></label>
    <p class="muted small">Get a token on discogs.com → Settings → Developers → <i>Generate new token</i>. It’s only stored on this phone.</p>
    <button class="btn primary wide" data-a="sync">Sync collection from Discogs</button>
    <p class="muted small" id="syncstatus">Last sync: ${fmtDate(localStorage.getItem('lastSync'))}. Syncing adds new records and updates details — your box numbers are never touched.</p>

    <h3>Records not on Discogs</h3>
    <button class="btn wide" data-a="addmanual">+ Add a record by hand</button>
    <p class="muted small">${plural(manualCount, 'record')} added by hand.</p>

    <h3>Backup</h3>
    <p class="small">${plural(settings.changes, 'change')} since last backup (${fmtDate(lastBackup)}).</p>
    <button class="btn primary wide" data-a="backup">Back up — save to OneDrive</button>
    <p class="muted small">Opens Android’s share menu: choose <b>OneDrive</b> and pick a folder. The file can be restored onto any phone or laptop.</p>
    <button class="btn ghost wide" data-a="restore">Restore from a backup file…</button>
    <input type="file" id="restorefile" accept=".txt,.json,text/plain,application/json" hidden>

    <h3>Export (for insurance / movers)</h3>
    <button class="btn wide" data-a="csv">Spreadsheet of all records by box (CSV)</button>
    <button class="btn wide" data-a="print">Box-by-box lists (print / save as PDF)</button>

    <h3>About</h3>
    <p class="muted small" id="storageinfo">All data is stored on this device only.</p>
  </div>`;

  navigator.storage?.persisted?.().then(p => {
    const i = $('#storageinfo');
    if (i) i.textContent = `All data is stored on this device only. ${p ? 'Storage is protected from automatic clean-up.' : 'Tip: install the app to your home screen so Android keeps the data safe.'}`;
  });

  $('#duser', el).onchange = e => { settings.user = e.target.value; };
  $('#dtoken', el).onchange = e => { settings.token = e.target.value; };
  $('#restorefile', el).onchange = e => { if (e.target.files[0]) doRestore(e.target.files[0]); e.target.value = ''; };
}

function wireMoreTab() {
  $('#v-more').addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'sync') {
      settings.user = $('#duser').value;
      settings.token = $('#dtoken').value;
      const btn = e.target.closest('button');
      const status = $('#syncstatus');
      btn.disabled = true;
      try {
        const res = await syncDiscogs(msg => { status.textContent = msg; });
        updateProgress();
        renderMore();
        toast(`Synced ${res.total.toLocaleString()} records · ${res.added} new${res.gone ? ` · ${res.gone} no longer on Discogs` : ''}`);
      } catch (err) {
        status.textContent = err.message;
        btn.disabled = false;
      }
    }
    if (a === 'addmanual') openManual(null);
    if (a === 'backup') doBackup();
    if (a === 'restore') $('#restorefile').click();
    if (a === 'csv') exportCsv();
    if (a === 'print') openPrint(null);
  });
}

/* =========================================================================
 * Files: share / backup / restore / CSV
 * ========================================================================= */
async function shareFile(filename, content, type) {
  const file = new File([content], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

async function doBackup() {
  const data = {
    app: 'record-boxes',
    version: 1,
    exported: new Date().toISOString(),
    records: S.records.map(toStored),
    boxes: [...S.boxes.values()],
    activeBox: S.activeBox,
  };
  // Saved as .txt because Android's share menu won't accept .json files.
  const res = await shareFile(`record-boxes-backup-${today()}.txt`, JSON.stringify(data), 'text/plain');
  if (res === 'cancelled') return;
  localStorage.setItem('lastBackup', Date.now());
  settings.changes = 0;
  toast(res === 'shared' ? 'Backup shared' : 'Backup downloaded');
  refreshTab();
}

async function doRestore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a Record Boxes backup'); return; }
  if (data?.app !== 'record-boxes' || !Array.isArray(data.records)) { toast('That file isn’t a Record Boxes backup'); return; }
  const ok = await confirmDlg('Restore backup?',
    `Backup from ${fmtDate(Date.parse(data.exported))}: ${data.records.length} records, ${data.boxes.length} boxes. This REPLACES everything currently in the app.`,
    'Replace', true);
  if (!ok) return;
  await DB.clear('records');
  await DB.clear('boxes');
  await DB.putMany('records', data.records);
  await DB.putMany('boxes', data.boxes || []);
  await loadState();
  setActiveBox(data.activeBox && S.boxes.has(data.activeBox) ? data.activeBox : null);
  settings.changes = 0;
  refreshTab();
  toast('Backup restored');
}

function recordsByLocation() {
  return [...S.records].sort((a, b) => {
    const la = splitLoc(a.box), lb = splitLoc(b.box);
    if (!a.box !== !b.box) return a.box ? -1 : 1;
    return boxCmp(la.outer, lb.outer) || boxCmp(la.inner, lb.inner) || a.sortKey.localeCompare(b.sortKey);
  });
}

function exportCsv() {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Outer box', 'Inner box', 'Artist', 'Title', 'Format', 'Year', 'Label', 'Catalogue no', 'Discogs release ID', 'Source', 'Packed on']];
  for (const r of recordsByLocation()) {
    const { outer, inner } = splitLoc(r.box);
    rows.push([outer, inner, r.artist, r.title, r.format, r.year, r.label, r.catno, r.releaseId || '',
      r.source === 'manual' ? 'Added by hand' : (r.removed ? 'Discogs (removed)' : 'Discogs'),
      r.packedAt ? new Date(r.packedAt).toISOString().slice(0, 10) : '']);
  }
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  shareFile(`records-by-box-${today()}.csv`, csv, 'text/csv');
}

/* =========================================================================
 * Printable box lists (print → Save as PDF)
 * ========================================================================= */
function openPrint(onlyBox) {
  pushView((el, entry) => {
    const o = entry.state.opts ||= { covers: false, unpacked: false };
    const counts = countByBox();
    const table = recs => recs.length
      ? `<table><tr>${o.covers ? '<th></th>' : ''}<th>Artist</th><th>Title</th><th>Format</th><th>Year</th><th>Cat no</th></tr>
         ${recs.map(r => `<tr>${o.covers ? `<td>${(r.photo || r.thumb) ? `<img src="${esc(r.photo || r.thumb)}" alt="">` : ''}</td>` : ''}
           <td>${esc(r.artist)}</td><td>${esc(r.title)}</td><td>${esc(r.format)}</td><td>${esc(r.year)}</td><td>${esc(r.catno)}</td></tr>`).join('')}</table>`
      : '<p class="pmuted">Empty</p>';

    const boxSection = b => {
      const kids = childBoxes(b.id);
      const direct = recordsIn(b.id);
      let h = `<section class="outer"><h2>Box ${esc(b.id)}${b.parent ? ` <span class="pmuted">(inside ${esc(b.parent)})</span>` : ''} — ${plural(boxTotal(b.id, counts), 'record')}</h2>`;
      if (kids.length) h += `<p class="pmuted">Contains inner boxes: ${kids.map(k => esc(k.id)).join(', ')}</p>`;
      for (const k of kids) h += `<h4>${esc(k.id)} — ${plural(counts[k.id] || 0, 'record')}</h4>${table(recordsIn(k.id))}`;
      if (direct.length || !kids.length) {
        if (kids.length) h += `<h4>Loose in ${esc(b.id)}</h4>`;
        h += table(direct);
      }
      return h + '</section>';
    };

    const boxes = onlyBox ? [S.boxes.get(onlyBox)].filter(Boolean) : topBoxes();
    const packed = S.records.filter(r => r.box).length;
    let doc = `<h1>${onlyBox ? `Box ${esc(onlyBox)}` : 'Record collection — box contents'}</h1>
      <p class="pmuted">Generated ${esc(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}${onlyBox ? '' :
        ` · ${plural(packed, 'record')} packed in ${plural(boxes.length, 'outer box')} (${plural(S.boxes.size - boxes.length, 'inner box')}) · ${S.records.length.toLocaleString()} records in total`}</p>`;
    doc += boxes.map(boxSection).join('');
    if (!onlyBox && o.unpacked) {
      const un = S.records.filter(r => !r.box);
      doc += `<section class="outer"><h2>Not packed — ${plural(un.length, 'record')}</h2>${table(un)}</section>`;
    }

    el.innerHTML = `<div class="noprint">${subhead(onlyBox ? `Print box ${onlyBox}` : 'Box lists')}
        <div class="pad printopts">
          <label><input type="checkbox" data-o="covers" ${o.covers ? 'checked' : ''}> Show cover pictures</label>
          ${onlyBox ? '' : `<label><input type="checkbox" data-o="unpacked" ${o.unpacked ? 'checked' : ''}> Include records not packed yet</label>`}
          <button class="btn primary wide" data-a="print">Print / Save as PDF</button>
          <p class="muted small">In the print screen pick <b>Save as PDF</b>, then share the PDF to OneDrive. Each outer box starts on a new page.</p>
        </div></div>
      <div class="printdoc">${doc}</div>`;

    el.onchange = e => {
      const k = e.target.dataset.o;
      if (k) { o[k] = e.target.checked; rebuild(el); }
    };
    el.onclick = e => {
      if (e.target.closest('[data-a]')?.dataset.a === 'print') window.print();
    };
  });
}

/* =========================================================================
 * Start-up
 * ========================================================================= */
async function loadState() {
  const [recs, boxes] = await Promise.all([DB.all('records'), DB.all('boxes')]);
  S.records = recs.map(prep);
  sortRecords();
  S.byKey = new Map(S.records.map(r => [r.key, r]));
  S.boxes = new Map(boxes.map(b => [b.id, b]));
}

async function init() {
  try {
    await DB.open();
    await loadState();
  } catch (err) {
    $('#ptext').textContent = 'Could not open storage: ' + err.message;
    return;
  }
  history.replaceState({ depth: 0 }, '');
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });
  wireRecordsTab();
  wireBoxesTab();
  wireMoreTab();
  switchTab(S.records.length ? 'records' : 'more');

  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
