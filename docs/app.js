// on the Mac the page is served by the server itself; the hosted copy talks to the server on this Mac
const API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '' : 'http://localhost:4545';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEYS = [
  ['sl', 'سلايدز'], ['tr', 'ترجمة'], ['mm', 'خريطة ذهنية'], ['ar', 'سلايدز عربي'], ['pr', 'سلايدز للمقدم'], ['en', 'سلايدز English'],
];
const KEY_NAME = Object.fromEntries(KEYS);
const ACTION_NAME = { pull: 'سحب وترتيب', push: 'رفع على الدرايف', check: 'فحص unsorted', checkall: 'فحص كل المحاضرات' };
const PAGES = { home: 'الرئيسية', subjects: 'المواد', books: 'الكتب', inbox: 'الوارد', activity: 'السجل', rules: 'الثوابت', settings: 'الإعدادات' };
const ar = new Intl.NumberFormat('ar-EG');
const time = new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let S = null, BOOKS = [], route = 'home', filter = 'all', query = '', current = null, rulesKey = 'thawabit', rulesDirty = false, streaming = false;

async function api(url, opts = {}) {
  const r = await fetch(API + url, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2800);
}
// numbers roll up to their value, like a counter in an edit
function countTo(el, to) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  if (reduced || from === to) { el.textContent = ar.format(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = ar.format(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const ring = (el, frac) => { el.style.strokeDashoffset = String(113.1 * (1 - Math.max(0, Math.min(1, frac)))); };

// ---------- routing ----------
function go() {
  const next = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const r = PAGES[next] ? next : 'home';
  const swap = () => {
    route = r;
    $$('.page').forEach((p) => { p.hidden = p.dataset.page !== r; p.classList.remove('enter'); });
    const page = $(`.page[data-page="${r}"]`);
    void page.offsetWidth; page.classList.add('enter');
    $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === r));
    $('#pageTitle').textContent = PAGES[r];
    document.title = `${PAGES[r]} · غرفة تحكم المحاضرات`;
    renderPage();
  };
  if (document.startViewTransition && !reduced && S && !document.hidden) {
    const t = document.startViewTransition(swap);
    t.ready.catch(() => {}); t.finished.catch(() => {});
  } else swap();
  window.scrollTo({ top: 0 });
}
addEventListener('hashchange', go);

// ---------- state ----------
async function load() {
  try {
    [S, BOOKS] = await Promise.all([api('/api/state'), api('/api/books')]);
  } catch {
    document.body.classList.add('offline'); document.body.classList.remove('loading');
    $('#sub').textContent = 'مش متوصّل بالماك'; $('#connDot').className = 'dot bad'; $('#connText').textContent = 'مش متوصّل';
    return;
  }
  document.body.classList.remove('offline', 'loading');
  $('#connDot').className = 'dot ok'; $('#connText').textContent = 'متوصّل بالماك';
  const lects = S.items.filter((i) => i.lecture && !i.inUnsorted);
  const done = lects.filter((i) => !i.missing.length).length;
  $('#sub').textContent = `${ar.format(lects.length)} محاضرة · ${ar.format(done)} كاملة · ${ar.format(S.pdfs)} ملف PDF`;
  $('#pilot').checked = !S.paused;
  $('#pilotText').textContent = S.paused ? 'الطيار الآلي واقف' : 'الطيار الآلي شغّال';
  document.body.classList.toggle('paused', S.paused);
  const pend = S.items.filter((i) => i.inUnsorted && i.missing.length).length;
  $('#inboxBadge').hidden = !pend; $('#inboxBadge').textContent = ar.format(pend);
  if (S.job && !S.job.done && !streaming) attach(S.job.action);
  // only redraw when something changed, so bars and rings do not replay every refresh
  const sig = JSON.stringify([S.items, S.pdfs, S.paused, S.runs, S.actions, S.queue, BOOKS]);
  if (sig !== load.sig) { load.sig = sig; renderPage(); }
}
function renderPage() {
  if (!S) return;
  ({ home: renderHome, subjects: renderSubjects, books: renderBooks, inbox: renderInbox, activity: renderHistory, rules: () => {}, settings: renderSettings })[route]();
}

// ---------- home ----------
let rulerBuilt = false;
function renderHome() {
  if (!rulerBuilt) {
    let html = '';
    for (let h = 0; h <= 24; h++) {
      html += `<i class="tick ${h % 6 ? '' : 'h6'}" style="left:${(h / 24) * 100}%"></i>`;
      if (h % 3 === 0) html += `<span class="tick-label" style="left:${(h / 24) * 100}%">${ar.format(h)}</span>`;
    }
    for (const h of S.schedule) html += `<div class="run" data-h="${h}" style="left:${(h / 24) * 100}%">${time.format(new Date(2000, 0, 1, h))}</div>`;
    $('#ticks').innerHTML = html; rulerBuilt = true;
    // the playhead scrubs from midnight to now when the app opens
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }
  const last = S.runs[0];
  $('#lastRun').innerHTML = last
    ? `<strong>آخر دورة: ${dayTime.format(new Date(last.at))}</strong><br>${esc(last.summary || '')}`
    : '<strong>لسه مفيش دورة اتسجلت</strong><br>أول دورة هتظهر هنا بعد ما تشتغل.';
  const lects = S.items.filter((i) => i.lecture && !i.inUnsorted);
  const done = lects.filter((i) => !i.missing.length).length;
  const bNeed = BOOKS.reduce((n, b) => n + b.need, 0), bDone = BOOKS.reduce((n, b) => n + b.done, 0);
  const pend = S.items.filter((i) => i.inUnsorted && i.missing.length).length;
  countTo($('#kLect'), done); $('#kLectAll').textContent = ar.format(lects.length); ring($('#ringLect'), done / (lects.length || 1));
  countTo($('#kBooks'), bDone); $('#kBooksAll').textContent = ar.format(bNeed); ring($('#ringBooks'), bDone / (bNeed || 1));
  countTo($('#kInbox'), pend); ring($('#ringInbox'), pend ? 1 : 0);
  countTo($('#kPdf'), S.pdfs); ring($('#ringPdf'), 1);
}
function tick() {
  if (!S) return;
  const now = new Date();
  const frac = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  $('#playhead').style.left = `${frac * 100}%`;
  $('#nowLabel').textContent = time.format(now);
  const next = S.schedule.map((h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d; }).find((d) => d > now)
    || (() => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(S.schedule[0], 0, 0, 0); return d; })();
  const s = Math.max(0, Math.round((next - now) / 1000)), p = (n) => String(n).padStart(2, '0');
  $('#countdown').textContent = S.paused ? 'واقف' : `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  $('#nextLabel').textContent = S.paused ? 'الطيار الآلي متوقف، الدورات هتعدّي من غير شغل لحد ما تشغّله تاني.' : `الساعة ${time.format(next)}: هيسحب الجديد، يعمل كل الملفات، ويرفعها.`;
  $$('.run').forEach((el) => {
    const h = +el.dataset.h, isNext = next.getHours() === h && next.getDate() === now.getDate();
    el.classList.toggle('next', isNext); el.classList.toggle('past', h <= now.getHours() && !isNext);
  });
  if (route === 'settings') $('#sNext').textContent = S.paused ? 'واقف' : dayTime.format(next);
}
setInterval(tick, 1000);

// ---------- subjects ----------
function keysHTML(i) {
  return KEYS.map(([k, n]) => {
    const has = i.outputs[k], need = i.missing.includes(k);
    return `<i class="k ${has ? '' : need ? 'need' : 'off'}" style="--c:var(--${k})" title="${n}${has ? '' : need ? ' (ناقص)' : ''}"></i>`;
  }).join('');
}
function renderSubjects() {
  $('#legend').innerHTML = KEYS.map(([k, n]) => `<li><i class="k" style="--c:var(--${k})"></i>${n}</li>`).join('') + '<li><i class="k need" style="--c:var(--sl)"></i>ناقص ولازم يتعمل</li>';
  const q = query.trim().toLowerCase();
  const list = S.items.filter((i) => !i.inUnsorted).filter((i) => {
    if (q && !(i.name + i.subject + i.rel).toLowerCase().includes(q)) return false;
    if (filter === 'miss') return i.missing.length;
    if (filter === 'done') return i.lecture && !i.missing.length;
    return true;
  });
  const groups = new Map();
  for (const i of list) { if (!groups.has(i.subject)) groups.set(i.subject, []); groups.get(i.subject).push(i); }
  $('#trackList').innerHTML = !groups.size
    ? `<p class="empty">${filter === 'miss' ? 'مفيش أي محاضرة ناقصة. كله جاهز.' : 'مفيش نتايج للبحث ده.'}</p>`
    : [...groups].map(([g, items]) => {
      const L = items.filter((i) => i.lecture), ok = L.filter((i) => !i.missing.length).length, pct = L.length ? Math.round((ok / L.length) * 100) : 100;
      return `<div class="track">
        <div class="track-name"><b>${esc(g)}</b><small>${ar.format(L.length)} محاضرة · ${ar.format(ok)} كاملة</small><div class="bar-mini"><i data-w="${pct}"></i></div></div>
        <div class="clips">${items.map((i) => `
          <button class="clip ${!i.lecture ? 'ref' : i.missing.length ? 'miss' : ''}" data-id="${i.id}">
            <span class="t">${esc(i.name)}</span><span class="tag">${i.lecture ? (i.lang === 'ar' ? 'عربي' : 'EN') : 'مراجع'}</span>
            <span class="keys">${keysHTML(i)}</span>
          </button>`).join('')}</div></div>`;
    }).join('');
  const L = S.items.filter((i) => i.lecture && !i.inUnsorted);
  const rows = ['sl', 'tr', 'mm', 'ar'].map((k) => { const pool = L.filter((i) => i.need.includes(k)); return [k, pool.filter((i) => i.outputs[k]).length, pool.length]; });
  const subjects = [...new Set(L.map((i) => i.subject))];
  rows.push(['pr', subjects.filter((s) => L.some((i) => i.subject === s && i.outputs.pr)).length, subjects.length, 'مادة']);
  $('#meters').innerHTML = rows.map(([k, a, b, unit]) => `
    <div class="meter" style="--c:var(--${k})"><div class="meter-top"><span>${KEY_NAME[k]}</span><span>${ar.format(a)} من ${ar.format(b)} ${unit || 'محاضرة'}</span></div>
    <div class="meter-bar"><i data-w="${b ? (a / b) * 100 : 0}"></i></div></div>`).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('[data-w]').forEach((i) => (i.style.width = i.dataset.w + '%'))));
}
$('#trackList').addEventListener('click', (e) => { const b = e.target.closest('.clip'); if (b) openDrawer(S.items.find((i) => i.id === b.dataset.id)); });
$$('.filters .chip').forEach((c) => c.addEventListener('click', () => { filter = c.dataset.f; $$('.filters .chip').forEach((x) => x.classList.toggle('on', x === c)); renderSubjects(); }));
$('#q').addEventListener('input', (e) => { query = e.target.value; renderSubjects(); });

// ---------- drawer ----------
function openDrawer(i) {
  current = i;
  $('#dSubject').textContent = (i.inUnsorted ? 'unsorted · ' : '') + i.subject + (i.lecture ? (i.lang === 'ar' ? ' · مصدر عربي' : ' · مصدر إنجليزي') : ' · مراجع');
  $('#dTitle').textContent = i.name;
  $('#dKeys').innerHTML = KEYS.map(([k, n]) => {
    const has = i.outputs[k], need = i.missing.includes(k);
    return `<div class="${has ? '' : 'no'}"><i class="k ${has ? '' : need ? 'need' : 'off'}" style="--c:var(--${k})"></i>${n}${has ? '' : need ? ' · ناقص' : ''}</div>`;
  }).join('');
  const files = [...new Set([...i.sources.map((f) => f.name), ...Object.values(i.outputs).flat(), ...i.videos.map((f) => f.name)])];
  $('#dFiles').innerHTML = files.map((n) => `<li><span>${esc(n)}</span><span>${/\.pdf$/i.test(n) ? `<button data-view="${esc(n)}">اعرض</button> ` : ''}<button data-open="${esc(n)}">افتح</button></span></li>`).join('');
  $('#dNote').value = i.missing.length ? 'كمّل: ' + i.missing.map((k) => KEY_NAME[k]).join('، ') : '';
  $('#drawer').showModal();
}
$('#dFiles').addEventListener('click', async (e) => {
  const v = e.target.dataset.view, o = e.target.dataset.open;
  if (v) window.open(API + '/api/file?rel=' + encodeURIComponent(current.rel + '/' + v), '_blank');
  if (o) { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel + '/' + o }) }); toast('اتفتح على الماك'); }
});
$('#dReveal').addEventListener('click', async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel }) }); toast('الفولدر اتفتح في Finder'); });
$('#dQueue').addEventListener('click', async () => {
  await api('/api/queue', { method: 'POST', body: JSON.stringify({ rel: current.rel, note: $('#dNote').value }) });
  $('#drawer').close(); toast('اتضافت للطلبات، الدورة الجاية هتبدأ بيها'); load();
});
$('#drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- books ----------
function renderBooks() {
  let i = 0;
  $('#books').innerHTML = BOOKS.map((b) => {
    const pct = b.need ? b.done / b.need : 0;
    const parts = b.parts.map((p) => `
      <div class="part" title="${esc(p.cover)}"><span>${p.part ? `الجزء ${ar.format(p.part)}` : 'الكتاب كله'}</span>
        <div class="frames">
          <span class="frame ${p.src ? 'done' : ''}" style="--c:var(--sl);--i:${i++}">${b.lang === 'ar' ? 'عربي' : 'EN'}</span>
          ${p.ar === null ? '' : `<span class="frame ${p.ar ? 'done' : ''}" style="--c:var(--ar);--i:${i++}">عربي</span>`}
        </div></div>`).join('');
    return `<article class="book card">
      <div class="book-head">
        <div class="pct"><svg class="ring" viewBox="0 0 44 44"><circle r="18" cx="22" cy="22"/><circle class="arc" r="18" cx="22" cy="22" data-f="${pct}" style="--c:${pct === 1 ? 'var(--mm)' : 'var(--sl)'}"/></svg><b>${ar.format(Math.round(pct * 100))}٪</b></div>
        <div><h2>${esc(b.base)}</h2><small>${esc(b.subject)} · ${ar.format(b.parts.length)} ${b.parts.length > 1 ? 'أجزاء' : 'جزء'}</small></div>
      </div>
      <div class="strip">${parts}</div>
      <div class="book-foot"><span>${ar.format(b.done)} من ${ar.format(b.need)} ملف جاهز</span><button class="btn ghost small" data-folder="${esc(b.folder)}">افتح الفولدر</button></div>
    </article>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('#books .arc').forEach((a) => ring(a, +a.dataset.f))));
}
$('#books').addEventListener('click', async (e) => {
  const f = e.target.dataset.folder; if (!f) return;
  await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: f }) }); toast('فولدر الكتاب اتفتح');
});

// ---------- inbox ----------
function renderInbox() {
  const sel = $('#dest');
  if (!sel.options.length) {
    const opts = ['Not summarized', ...S.categories.filter((c) => !/(^|\/)Book$/.test(c))];
    sel.innerHTML = opts.map((c) => `<option value="${esc(c)}">${c === 'Not summarized' ? 'مش عارف المادة (هيتحدد لوحده)' : esc(c.replace(/ \//g, ' / '))}</option>`).join('');
  }
  const pend = S.items.filter((i) => i.inUnsorted);
  $('#pending').innerHTML = pend.length
    ? pend.map((i) => `<li><div><b>${esc(i.name)}</b><small>${esc(i.subject)} · ${i.missing.length ? 'ناقص: ' + i.missing.map((k) => KEY_NAME[k]).join('، ') : 'جاهز'}</small></div></li>`).join('')
    : '<li class="muted">unsorted فاضي. ارمي ملف فوق وهيظهر هنا.</li>';
  $('#queue').innerHTML = S.queue.length
    ? S.queue.map((q) => `<li><div><b>${esc(q.rel.split('/').pop())}</b><small>${esc(q.note || 'كمّل الناقص')}</small></div><button class="x" data-del="${q.id}" aria-label="شيل الطلب">×</button></li>`).join('')
    : '<li class="muted">مفيش طلبات. افتح أي محاضرة من «المواد» واطلب تكملتها.</li>';
}
$('#queue').addEventListener('click', async (e) => { const id = e.target.dataset.del; if (!id) return; await api('/api/queue/' + id, { method: 'DELETE' }); toast('الطلب اتشال'); load(); });
function upload(file) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${esc(file.name)}</span><span class="bar-p"><i></i></span>`;
  $('#uploads').prepend(li);
  return new Promise((res) => {
    const x = new XMLHttpRequest();
    x.open('POST', API + `/api/upload?dest=${encodeURIComponent($('#dest').value)}&name=${encodeURIComponent(file.name)}`);
    x.upload.onprogress = (e) => { $('i', li).style.width = (e.loaded / e.total) * 100 + '%'; };
    x.onload = () => { li.lastElementChild.replaceWith(Object.assign(document.createElement('small'), { textContent: x.status === 200 ? 'اتحط ✓' : 'فشل' })); res(); };
    x.onerror = () => res();
    x.send(file);
  });
}
async function uploadAll(files) { for (const f of files) await upload(f); toast('الملفات اتحطت في unsorted. دوس «ارفع على الدرايف»'); load(); }
$('#files').addEventListener('change', (e) => uploadAll([...e.target.files]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadAll([...e.dataTransfer.files]));

// ---------- activity ----------
function renderHistory() {
  const rows = [
    ...S.runs.map((r) => ({ at: r.at, c: 'var(--pr)', t: 'دورة الطيار الآلي', d: r.summary })),
    ...S.actions.map((a) => ({
      at: a.at,
      c: a.type === 'job' ? (a.code === 0 ? 'var(--mm)' : 'var(--play)') : 'var(--muted)',
      t: a.type === 'job' ? `${ACTION_NAME[a.action] || a.action}${a.code === 0 ? '' : a.code === 'cancelled' ? ' (اتوقف)' : ' (فيه مشكلة)'}`
        : a.type === 'upload' ? 'ملف اتضاف' : a.type === 'queue' ? 'طلب جديد' : a.type === 'rules' ? 'الثوابت اتعدّلت'
        : a.type === 'autopilot' ? (a.paused ? 'الطيار الآلي وقف' : 'الطيار الآلي اشتغل') : a.type,
      d: a.file || a.rel || (a.tail || []).slice(-2).join(' / '),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
  $('#history').innerHTML = rows.length
    ? rows.map((r) => `<li style="--c:${r.c}"><div><b>${esc(r.t)}</b><small>${esc(r.d || '')}</small></div><time>${dayTime.format(new Date(r.at))}</time></li>`).join('')
    : '<li class="muted">لسه مفيش حاجة اتعملت من اللوحة.</li>';
}

// ---------- commands + live console ----------
function setBusy(action) {
  $$('[data-run]').forEach((b) => { b.disabled = !!action; b.classList.toggle('running', b.dataset.run === action); });
  $('#cancelJob').hidden = !action;
  $('#jobPill').hidden = !action; if (action) $('#jobPillText').textContent = ACTION_NAME[action] || action;
}
function logLine(text) {
  const el = document.createElement('span'); el.className = 'l'; el.textContent = text;
  $('#log').append(el); $('#log').scrollTop = $('#log').scrollHeight;
}
function attach(action) {
  streaming = true; setBusy(action);
  const st = $('#jobState'); st.className = 'state busy'; st.textContent = 'شغّال: ' + (ACTION_NAME[action] || action);
  $('#log').textContent = '';
  const es = new EventSource(API + '/api/job/stream');
  es.onmessage = (e) => logLine(JSON.parse(e.data).line);
  es.addEventListener('end', (e) => {
    const { code } = JSON.parse(e.data); es.close(); streaming = false; setBusy(null);
    st.className = 'state ' + (code === 0 ? 'ok' : 'bad');
    st.textContent = code === 0 ? 'خلص تمام' : code === 'cancelled' ? 'اتوقف' : 'خلص بمشكلة، بص على الشاشة';
    if (!$('#log').textContent.trim()) logLine(code === 'cancelled' ? 'اتوقف قبل ما يخلص.' : action === 'pull' ? 'مفيش جديد.' : 'كله متطابق، مفيش حاجة ناقصة.');
    toast(code === 0 ? (ACTION_NAME[action] || action) + ': خلص' : code === 'cancelled' ? 'اتوقف' : 'حصلت مشكلة');
    load();
  });
  es.onerror = () => { es.close(); streaming = false; setBusy(null); };
}
$$('[data-run]').forEach((b) => b.addEventListener('click', async () => {
  try { await api('/api/run/' + b.dataset.run, { method: 'POST' }); attach(b.dataset.run); } catch (e) { toast(e.message); }
}));
$('#cancelJob').addEventListener('click', async () => { await api('/api/job/cancel', { method: 'POST' }); toast('بيوقف…'); });
$('#pilot').addEventListener('change', async (e) => {
  const paused = !e.target.checked;
  await api('/api/autopilot', { method: 'POST', body: JSON.stringify({ paused }) });
  toast(paused ? 'الطيار الآلي وقف' : 'الطيار الآلي رجع يشتغل'); load();
});

// ---------- settings ----------
async function renderSettings() {
  $('#sPilot').textContent = S.paused ? 'واقف' : 'شغّال';
  const h = await api('/api/health').catch(() => null);
  if (!h) return;
  $('#hDrive').textContent = h.checking ? 'بيفحص…' : h.drive ? 'متوصّل ✓' : 'مش متوصّل';
  $('#hSpace').textContent = h.usedGB != null ? `${ar.format(h.usedGB)} جيجا مستخدمة · ${ar.format(h.freeGB)} فاضية` : '—';
  $('#hKey').hidden = !h.sharedKey;
  if (h.checking) setTimeout(() => route === 'settings' && renderSettings(), 4000);
}
$('#recheck').addEventListener('click', async () => { await api('/api/health?force'); toast('بيفحص الدرايف…'); setTimeout(renderSettings, 3000); });
$('#openRoot').addEventListener('click', async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: '' }) }); toast('فولدر المحاضرات اتفتح'); });
$('#openClaude').addEventListener('click', async () => { await api('/api/claude', { method: 'POST' }); toast('افتح Scheduled ← lectures-unsorted-autopilot ← Run now'); });
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; $('#installHint').hidden = true; });
$('#install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install').hidden = true; });
addEventListener('appinstalled', () => toast('التطبيق اتنزّل، هتلاقيه في الـDock'));

// ---------- rules editor ----------
async function loadRules() {
  const r = await api('/api/rules/' + rulesKey);
  $('#rulesText').value = r.text; rulesDirty = false;
  $('#rulesInfo').textContent = 'آخر تعديل ' + dayTime.format(new Date(r.mtime));
}
$$('.tabs .chip').forEach((c) => c.addEventListener('click', () => {
  if (rulesDirty && !confirm('في تعديل مش محفوظ. تسيبه؟')) return;
  rulesKey = c.dataset.r;
  $$('.tabs .chip').forEach((x) => { x.classList.toggle('on', x === c); x.setAttribute('aria-selected', x === c); });
  loadRules();
}));
$('#rulesText').addEventListener('input', () => { rulesDirty = true; $('#rulesInfo').textContent = 'فيه تعديل مش محفوظ'; });
$('#saveRules').addEventListener('click', async () => {
  await api('/api/rules/' + rulesKey, { method: 'PUT', body: JSON.stringify({ text: $('#rulesText').value }) });
  toast('اتحفظ، والنسخة القديمة اتشالت في logs'); loadRules(); load();
});

// ---------- boot ----------
document.body.classList.add('loading');
go();
load().then(() => go());
loadRules().catch(() => {});
setInterval(() => { if (!streaming && !document.hidden && !$('#drawer').open && !(route === 'rules' && rulesDirty)) load(); }, 20000);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) navigator.serviceWorker.register('sw.js').catch(() => {});
