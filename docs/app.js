// on the Mac the page is served by the server itself; the hosted copy talks to the server on this Mac
const API = location.hostname.endsWith('github.io') ? 'http://localhost:4545' : '';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// translation and mind map are no longer made (2026-11-03): they stay only as history in the donut
const ALL_KEYS = [
  ['sl', 'سلايدز'], ['ar', 'سلايدز عربي'], ['pr', 'سلايدز للمقدم'], ['en', 'سلايدز English'], ['tr', 'ترجمة (قديم)'], ['mm', 'خريطة ذهنية (قديم)'],
];
const KEYS = ALL_KEYS.slice(0, 4);
const KEY_NAME = Object.fromEntries(ALL_KEYS);
const ACTION_NAME = { pull: 'سحب وترتيب', push: 'رفع unsorted', check: 'فحص unsorted', checkall: 'فحص كل المحاضرات', runnow: 'تشغيل الخطوات', pushall: 'رفع كل الجديد', pullall: 'تنزيل من الدرايف', dupes: 'دوّر على المكرر', finish: 'نقل اللي خلص', up: 'رفع', down: 'تنزيل' };
const PAGES = { home: 'الرئيسية', subjects: 'المواد', books: 'الكتب', inbox: 'الوارد', sync: 'المزامنة', activity: 'السجل', rules: 'الثوابت', settings: 'الإعدادات', custom: 'التخصيص' };
// number and time formats follow the «التصرف» settings (digits, 12/24 h); rebuilt by applySettings()
let ar = new Intl.NumberFormat('ar-EG');
let time = new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' });
let dayTime = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
let SET = {}; // the settings values (settings.mjs) for this page
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// calm mode (Settings) works like the system's reduce-motion setting
const calm = (() => { try { return localStorage.getItem('calm') === '1'; } catch { return false; } })();
document.documentElement.classList.toggle('calm', calm);
const reduced = calm || matchMedia('(prefers-reduced-motion: reduce)').matches;

let WK = null, SY = null, syncList = 'local', retry = 5e3, histFilter = 'all', S = null, BOOKS = [], route = 'home', filter = 'all', query = '', current = null, rulesKey = 'thawabit', rulesDirty = false, streaming = false;

async function api(url, opts = {}) {
  const r = await fetch(API + url, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, act, fn) {
  const t = $('#toast'); $('#toastMsg').textContent = msg;
  const b = $('#toastAct'); b.hidden = !act; b.textContent = act || ''; b.onclick = () => { t.classList.remove('show'); fn?.(); };
  t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), act ? 6000 : 2800);
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
    [S, BOOKS, SY, WK] = await Promise.all([api('/api/state'), api('/api/books'), api('/api/sync'), api('/api/worker').catch(() => null)]);
  } catch {
    clearTimeout(load.retryT); load.retryT = setTimeout(load, retry); retry = Math.min(retry * 2, 60e3);
    document.body.classList.add('offline'); document.body.classList.remove('loading');
    $('#sub').textContent = 'مش متوصّل بالماك'; $('#connDot').className = 'dot bad'; $('#connText').textContent = 'مش متوصّل';
    return;
  }
  document.body.classList.remove('offline', 'loading');
  $('#connDot').className = 'dot ok'; $('#connText').textContent = 'متوصّل بالماك';
  load.at = Date.now(); retry = 5e3; notifyChanges();
  const lects = S.items.filter((i) => i.lecture && !i.inUnsorted);
  const done = lects.filter((i) => !i.missing.length).length;
  $('#sub').textContent = `${ar.format(lects.length)} محاضرة · ${ar.format(done)} كاملة · ${ar.format(S.pdfs)} ملف PDF`;
  $('#pilot').checked = !S.paused;
  $('#pilotText').textContent = S.paused ? 'الطيار الآلي واقف' : 'الطيار الآلي شغّال';
  document.body.classList.toggle('paused', S.paused);
  const pend = S.items.filter((i) => i.inUnsorted && i.missing.length).length;
  $('#inboxBadge').hidden = !pend; $('#inboxBadge').textContent = ar.format(pend);
  if (S.job && !S.job.done && !streaming) attach(S.job.action);
  const W = S.waiting || [];
  $('#waitList').hidden = !W.length;
  $('#waitList').innerHTML = W.map((w, n) => `<li style="--i:${n}"><span>${ar.format(n + 1)}. ${esc(w.label)}</span><button class="x" data-wait="${w.id}" aria-label="شيله من الطابور">×</button></li>`).join('');
  // only redraw when something changed, so bars and rings do not replay every refresh
  syncBadge(); renderWorker();
  const sig = JSON.stringify([S.items, S.pdfs, S.paused, S.runs, S.actions, S.queue, BOOKS, SY.at, SY.indexing, SY.counts, SY.auto]);
  if (sig !== load.sig) { load.sig = sig; renderPage(); }
}
function renderPage() {
  if (!S) return;
  ({ home: renderHome, subjects: renderSubjects, books: renderBooks, inbox: renderInbox, sync: renderSync, activity: renderHistory, rules: () => {}, settings: renderSettings, custom: renderCustom })[route]();
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
  const last = S.runs[0], stale = !S.paused && (!last || Date.now() - Date.parse(last.at) > (SET['safe.staleHours'] || 12) * 3600e3);
  $('#lastRun').classList.toggle('stale', stale);
  $('#lastRun').innerHTML = last
    ? `<strong>آخر دورة: ${dayTime.format(new Date(last.at))}</strong><br>${esc(last.summary || '')}${stale ? '<br><em>الطيار الآلي مشتغلش من أكتر من ١٢ ساعة. اتأكد إن الماك صاحي وClaude مفتوح.</em>' : ''}`
    : '<strong>لسه مفيش دورة اتسجلت</strong><br>أول دورة هتظهر هنا بعد ما تشتغل. لو عدّى ميعاد ومظهرتش، اتأكد إن الماك صاحي وClaude مفتوح.';
  const lects = S.items.filter((i) => i.lecture && !i.inUnsorted);
  const done = lects.filter((i) => !i.missing.length).length;
  const bNeed = BOOKS.reduce((n, b) => n + b.need, 0), bDone = BOOKS.reduce((n, b) => n + b.done, 0);
  const pend = S.items.filter((i) => i.inUnsorted && i.missing.length).length;
  countTo($('#kLect'), done); $('#kLectAll').textContent = ar.format(lects.length); ring($('#ringLect'), done / (lects.length || 1));
  countTo($('#kBooks'), bDone); $('#kBooksAll').textContent = ar.format(bNeed); ring($('#ringBooks'), bDone / (bNeed || 1));
  countTo($('#kInbox'), pend); ring($('#ringInbox'), pend ? 1 : 0);
  countTo($('#kPdf'), S.pdfs); ring($('#ringPdf'), 1);
  drawLanes(); drawDonut(); drawActivity(); drawSubjects(); drawSparks();
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
  setCount(S.paused ? 'واقف' : `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`);
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
  let ci = 0;
  $('#trackList').innerHTML = !groups.size
    ? `<p class="empty">${filter === 'miss' ? 'مفيش أي محاضرة ناقصة. كله جاهز.' : 'مفيش نتايج للبحث ده.'}</p>`
    : [...groups].map(([g, items]) => {
      const L = items.filter((i) => i.lecture), ok = L.filter((i) => !i.missing.length).length, pct = L.length ? Math.round((ok / L.length) * 100) : 100;
      return `<div class="track">
        <div class="track-name"><b>${esc(g)}</b><small>${ar.format(L.length)} محاضرة · ${ar.format(ok)} كاملة</small><div class="bar-mini"><i data-w="${pct}"></i></div></div>
        <div class="clips">${items.map((i) => `
          <button class="clip ${!i.lecture ? 'ref' : i.missing.length ? 'miss' : ''}" data-id="${i.id}" style="--i:${ci++}">
            <span class="t">${esc(i.name)}</span><span class="tag">${i.lecture ? (i.lang === 'ar' ? 'عربي' : 'EN') : 'مراجع'}</span>
            <span class="keys">${keysHTML(i)}</span>${cloudBadge(i)}
          </button>`).join('')}</div></div>`;
    }).join('');
  const L = S.items.filter((i) => i.lecture && !i.inUnsorted);
  // translation and mind map are no longer made (2026-11-03)
  const rows = ['sl', 'ar'].map((k) => { const pool = L.filter((i) => i.need.includes(k)); return [k, pool.filter((i) => i.outputs[k]).length, pool.length]; });
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
  const driveOnly = SY?.lists.drive.filter((r) => r.startsWith(i.rel + '/') && !r.slice(i.rel.length + 1).includes('/')).map((r) => r.split('/').pop()) || [];
  $('#dFiles').innerHTML = [...files, ...driveOnly.filter((n) => !files.includes(n))].map((n) => { const st = SY?.status[i.rel + '/' + n]; return `<li><span>${statusChip(st)}${esc(n)}</span><span>${st === 'drive' ? `<button data-pull="${esc(n)}">نزّله</button>` : `${/\.pdf$/i.test(n) ? `<button data-view="${esc(n)}">اعرض</button> ` : ''}<button data-open="${esc(n)}">افتح</button>${st === 'local' || st === 'diff' ? ` <button data-push="${esc(n)}">ارفعه</button>` : ''}`}</span></li>`; }).join('');
  const did = SY?.dirs[i.rel]; $('#dDrive').hidden = !did; if (did) $('#dDrive').href = `https://drive.google.com/drive/folders/${did}`;
  $$('#dMake input').forEach((c) => { c.checked = i.missing.some((k) => (k === 'sl' && c.value === 'SRC') || (k === 'ar' && c.value === 'AR')); c.closest('label').hidden = (c.value === 'AR' && i.lang === 'ar') || (c.value === 'EN' && i.lang !== 'ar'); });
  $('#dMakeGo').hidden = !i.lecture;
  $('#dNote').value = i.missing.length ? 'كمّل: ' + i.missing.map((k) => KEY_NAME[k]).join('، ') : '';
  $('#drawer').showModal();
}
$('#dFiles').addEventListener('click', async (e) => {
  const v = e.target.dataset.view, o = e.target.dataset.open;
  if (v) preview(current.rel + '/' + v);
  if (o) { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel + '/' + o }) }); toast('اتفتح على الماك'); }
  const up = e.target.dataset.push, dn = e.target.dataset.pull;
  if (up || dn) { $('#drawer').close(); runSync('/api/sync/file', { rel: current.rel + '/' + (up || dn), dir: up ? 'up' : 'down' }, up ? 'up' : 'down'); }
});
$('#dReveal').addEventListener('click', async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel }) }); toast('الفولدر اتفتح في Finder'); });
$('#dQueue').addEventListener('click', async () => {
  await api('/api/queue', { method: 'POST', body: JSON.stringify({ rel: current.rel, note: $('#dNote').value }) });
  $('#drawer').close(); toast('اتضافت للطلبات، الدورة الجاية هتبدأ بيها'); load();
});
$('#drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- books ----------
function renderBooks() {
  let i = 0, bi = 0;
  const left = BOOKS.reduce((n, b) => n + b.need - b.done, 0);
  $('.page[data-page="books"] .lead').innerHTML = `كل كتاب كبير متقسم أجزاء، كل جزء فيه فصلين تقريبًا، وليه سلايدز بلغة الكتاب وسلايدز عربي. ${left ? `<span class="eta">فاضل ${ar.format(left)} ملف، يعني حوالي ${ar.format(Math.max(1, Math.ceil(left / 25)))} ${Math.ceil(left / 25) > 1 ? 'أيام' : 'يوم'} شغل (الحسابات الأربعة بتعمل حوالي ٢٥ في اليوم).</span>` : '<span class="eta ok">كل الكتب خلصت ✓</span>'}`;
  $('#books').innerHTML = BOOKS.map((b) => {
    const pct = b.need ? b.done / b.need : 0;
    const parts = b.parts.map((p) => `
      <div class="part" title="${esc(p.cover)}"><span>${p.part ? `الجزء ${ar.format(p.part)}` : 'الكتاب كله'}</span>
        <div class="frames">
          <span class="frame ${p.src ? 'done' : ''}" style="--c:var(--sl);--i:${i++}">${b.lang === 'ar' ? 'عربي' : 'EN'}</span>
          ${p.ar === null ? '' : `<span class="frame ${p.ar ? 'done' : ''}" style="--c:var(--ar);--i:${i++}">عربي</span>`}
        </div></div>`).join('');
    return `<article class="book card tilt ${pct === 1 ? 'complete' : ''}" style="--i:${bi++}">
      <div class="book-head">
        <div class="pct"><svg class="ring" viewBox="0 0 44 44"><circle r="18" cx="22" cy="22"/><circle class="arc" r="18" cx="22" cy="22" data-f="${pct}" style="--c:${pct === 1 ? 'var(--mm)' : 'var(--sl)'}"/></svg><b>${ar.format(Math.round(pct * 100))}٪</b></div>
        <div><h2>${esc(b.base)}</h2><small>${esc(b.subject)} · ${ar.format(b.parts.length)} ${b.parts.length > 1 ? 'أجزاء' : 'جزء'}</small></div>
      </div>
      <div class="strip">${parts}</div>
      <div class="book-foot"><span>${ar.format(b.done)} من ${ar.format(b.need)} ملف جاهز</span><span class="book-btns">${b.done < b.need ? `<button class="btn ghost small" data-ask="${esc(b.key)}" data-tip="ضيف الأجزاء الناقصة لطلبات الطيار الآلي">اطلب الناقص</button>` : ''}<button class="btn ghost small" data-folder="${esc(b.folder)}">افتح الفولدر</button></span></div>
    </article>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('#books .arc').forEach((a) => ring(a, +a.dataset.f))));
}
$('#books').addEventListener('click', async (e) => {
  const k = e.target.dataset.ask;
  if (k) {
    const b = BOOKS.find((x) => x.key === k);
    const miss = b.parts.flatMap((p) => [!p.src && `الجزء ${p.part || 'كله'} ${b.lang === 'ar' ? 'عربي' : 'EN'}`, p.ar === false && `الجزء ${p.part || 'كله'} عربي`]).filter(Boolean);
    await api('/api/queue', { method: 'POST', body: JSON.stringify({ rel: b.folder, note: `كتاب ${b.base}: اعمل ${miss.join('، ')} (حسب books-plan.tsv)` }) });
    e.target.classList.add('done-pop'); e.target.textContent = 'اتطلب ✓'; e.target.disabled = true; toast('اتضاف للطلبات، الدورة الجاية هتشتغل عليه'); load(); return;
  }
  const f = e.target.dataset.folder; if (!f) return;
  await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: f }) }); toast('فولدر الكتاب اتفتح');
});

// ---------- inbox ----------
function renderInbox() {
  const sel = $('#dest');
  if (!sel.options.length) {
    const opts = ['Not summarized', ...S.categories.filter((c) => !/(^|\/)Book$/.test(c))];
    sel.onchange = () => { try { localStorage.setItem('dest', sel.value); } catch {} };
    sel.innerHTML = opts.map((c) => `<option value="${esc(c)}">${c === 'Not summarized' ? 'مش عارف المادة (هيتحدد لوحده)' : esc(c.replace(/ \//g, ' / '))}</option>`).join('');
    try { const d = localStorage.getItem('dest'); if (d && [...sel.options].some((o) => o.value === d)) sel.value = d; } catch {}
  }
  const pend = S.items.filter((i) => i.inUnsorted);
  $('#pending').innerHTML = pend.length
    ? pend.map((i) => `<li><div><b>${esc(i.name)}</b><small>${esc(i.subject)} · ${i.missing.length ? 'ناقص: ' + i.missing.map((k) => KEY_NAME[k]).join('، ') : 'جاهز'}</small></div></li>`).join('')
    : '<li class="muted">unsorted فاضي. ارمي ملف فوق وهيظهر هنا.</li>';
  $('#queue').innerHTML = S.queue.length
    ? S.queue.map((q, n) => `<li><div><b>${esc(q.rel.split('/').pop())}</b><small>${esc(q.note || 'كمّل الناقص')}</small></div><span class="row-actions">${n ? `<button class="x" data-top="${q.id}" aria-label="خليه الأول" data-tip="خليه أول طلب">↑</button>` : ''}<button class="x" data-del="${q.id}" aria-label="شيل الطلب">×</button></span></li>`).join('')
    : '<li class="muted">مفيش طلبات. افتح أي محاضرة من «المواد» واطلب تكملتها.</li>';
}
$('#queue').addEventListener('click', async (e) => {
  if (e.target.dataset.top) { await api('/api/queue/' + e.target.dataset.top, { method: 'PATCH', body: JSON.stringify({ top: true }) }); toast('بقى أول طلب'); return load(); }
  const id = e.target.dataset.del; if (!id) return;
  const q = S.queue.find((x) => x.id === id);
  e.target.closest('li').classList.add('leaving');
  await api('/api/queue/' + id, { method: 'DELETE' }); load();
  toast('الطلب اتشال', 'رجّعه', async () => { await api('/api/queue', { method: 'POST', body: JSON.stringify({ rel: q.rel, note: q.note }) }); toast('رجع تاني'); load(); });
});
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
  drawHeat();
  const rows = [
    ...S.runs.map((r) => ({ k: 'run', at: r.at, c: 'var(--pr)', t: 'دورة الطيار الآلي', d: r.summary })),
    ...S.actions.map((a) => ({
      k: a.type === 'job' ? 'job' : a.type === 'autopilot' ? 'run' : 'upload',
      at: a.at,
      c: a.type === 'job' ? (a.code === 0 ? 'var(--mm)' : a.code === 'missing' ? 'var(--sl)' : 'var(--play)') : 'var(--muted)',
      t: a.type === 'job' ? `${ACTION_NAME[a.action] || a.action}${a.code === 0 ? '' : a.code === 'cancelled' ? ' (اتوقف)' : a.code === 'missing' ? ' (فيه ملفات ناقصة)' : ' (فيه مشكلة)'}`
        : a.type === 'upload' ? 'ملف اتضاف' : a.type === 'queue' ? 'طلب جديد' : a.type === 'rules' ? 'الثوابت اتعدّلت'
        : a.type === 'autopilot' ? (a.paused ? 'الطيار الآلي وقف' : 'الطيار الآلي اشتغل')
        : a.type === 'autosync' ? 'مزامنة تلقائية بدأت' : a.type === 'autosync-set' ? (a.on ? 'المزامنة التلقائية اشتغلت' : 'المزامنة التلقائية وقفت')
        : a.type === 'account' ? `أكونت ${a.email || a.n}: ${a.limited ? 'وصل للحد' : 'رجع متاح'}` : a.type === 'account-onoff' ? `أكونت ${a.email}: ${a.on ? 'اتفتح للعامل' : 'اتقفل للعامل'}` : a.type === 'zen-restart' ? 'العامل أعاد فتح Zen' : a.type === 'renamed' ? `اتسمّى: ${a.to}` : a.type === 'settings' ? 'التخصيص اتغيّر' : a.type === 'make' ? 'طلب سلايدز من العامل' : a.type === 'worker-run' ? 'العامل اشتغل دلوقتي' : a.type === 'downloads-trash' ? 'تنزيلات بايظة راحت الـ Trash' : a.type,
      d: a.file || a.rel || (a.files ? `${ar.format(a.files)} ملف` : '') || (a.tail || []).slice(-2).join(' / '),
    })),
  ].filter((r) => (histFilter === 'all' || r.k === histFilter) && Date.now() - Date.parse(r.at) < (SET['worker.keepDays'] || 7) * 864e5).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
  $('#history').innerHTML = rows.length
    ? rows.map((r, n) => `<li style="--c:${r.c};--i:${Math.min(n, 20)}"><div><b>${esc(r.t)}</b><small>${esc(r.d || '')}</small></div><time>${dayTime.format(new Date(r.at))}</time></li>`).join('')
    : `<li class="empty-state">${EMPTY}<span>مفيش حاجة هنا لسه.</span></li>`;
}

// ---------- commands + live console ----------
function setBusy(action) {
  $$('[data-run]').forEach((b) => { b.disabled = !!action; b.classList.toggle('running', b.dataset.run === action); });
  $('#cancelJob').hidden = !action;
  $('#jobPill').hidden = !action; if (action) $('#jobPillText').textContent = ACTION_NAME[action] || action;
}
// rclone stats read in MB; only amounts under 100 KB stay in KB
const IN_KB = { B: 1 / 1024, KiB: 1, MiB: 1024, GiB: 1048576 };
function readableStats(line) {
  if (!/ETA/.test(line)) return line;
  return line.replace(/([\d.]+)\s*(GiB|MiB|KiB|B)(\/s)?/g, (_, n, unit, rate = '') => {
    const kb = n * IN_KB[unit];
    return kb < 100 ? `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB${rate}` : `${(kb / 1024).toFixed(2)} MB${rate}`;
  });
}
// the screen: every event is one row with its kind, and a repeated event only counts up
const FEED_ICON = {
  done: 'm5 12 4 4 10-10', bad: 'M12 8v5m0 3.5v.5M12 3 2 20h20z', work: 'M4 5h16v11H4zM12 16v4M8 20h8',
  sort: 'M4 6h16M7 12h10M10 18h4', wait: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', step: 'm15 6-6 6 6 6',
};
const FEED_KIND = [
  [/مشكلة|ERROR|FAILED|مقدرتش|معرفتش|فشل/, 'bad'], [/^(اتحط|خلص|اترفع|اتنقل|moved|عملت)/, 'done'],
  [/^(اترتّب|اتسمّى|اتصلّح|راح الـ Trash|لقيت)/, 'sort'], [/أكونت|السلايدز|نوت بوك|بيشتغل|بيكمّل/, 'work'],
  [/مفيش جديد|ناقصها|مستني/, 'wait'],
];
function feedRow(time, full, msg) {
  const box = $('#log'), bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const rows = box.querySelectorAll('.l:not(.stats)'), last = rows[rows.length - 1];
  if (last?.dataset.msg === msg) {
    last.dataset.n = +last.dataset.n + 1; last.querySelector('em').textContent = `${last.dataset.n} مرات`;
    last.querySelector('time').textContent = time; last.querySelector('time').title = full;
  } else {
    const kind = FEED_KIND.find(([re]) => re.test(msg))?.[1] || 'step', i = msg.indexOf(': ');
    const el = document.createElement('div'); el.className = `l k-${kind}`; el.dataset.msg = msg; el.dataset.n = 1;
    el.innerHTML = `<time></time><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${FEED_ICON[kind]}"/></svg><span class="m"><b></b><bdi dir="auto"></bdi></span><em></em>`;
    el.querySelector('time').textContent = time; el.querySelector('time').title = full;
    el.querySelector('b').textContent = i > 0 ? msg.slice(0, i) : msg; el.querySelector('bdi').textContent = i > 0 ? msg.slice(i + 2) : '';
    const stats = box.querySelector('.stats');
    if (stats) box.insertBefore(el, stats); else box.append(el);
    while (box.children.length > 400) box.firstElementChild.remove();
  }
  if (bottom) box.scrollTop = box.scrollHeight;
}
// log lines carry UTC times, task ids and rclone's wording; the screen shows local time and plain words
function liveRow(line) {
  if (/NOTICE/.test(line)) return;
  const m = line.match(/^(?:\[\w+\] )?(\d\d):(\d\d):(\d\d) (.*)$/);
  const d = new Date(); if (m) d.setUTCHours(+m[1], +m[2], +m[3]);
  const msg = (m ? m[4] : line)
    .replace(/^\S+ \S+ INFO\s*:\s*(.+): (Copied|Moved)[^:]*$/, 'اترفع: $1')
    .replace(/PENDING: /g, 'ناقصها سلايدز: ').replace(/ \| ملخص وأهم النقاط \(سلايدز\)/g, '')
    .replace('السلايدز: EN:ok AR:ok', 'اتطلبت السلايدز: الأصل والعربي').trim();
  if (msg) feedRow(d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), d.toLocaleTimeString('en-GB'), msg);
}
// rclone's progress is one row with a bar that keeps updating at the end of the screen
function statsRow(line) {
  const box = $('#log'), bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const m = readableStats(line).match(/([\d.]+ [KM]B) \/ ([\d.]+ [KM]B), (\d+)%, ([\d.]+ [KM]B\/s), ETA (\S+)/); if (!m) return;
  let el = box.querySelector('.stats');
  if (!el) { el = document.createElement('div'); el.className = 'l stats'; el.innerHTML = '<div class="st-top"><b></b><span dir="ltr"></span></div><div class="st-bar"><i></i></div><small></small>'; box.append(el); }
  el.querySelector('b').textContent = `${m[3]}%`; el.querySelector('.st-top span').textContent = `${m[1]} / ${m[2]}`;
  el.querySelector('i').style.width = `${m[3]}%`;
  el.querySelector('small').textContent = `السرعة ${m[4]}، فاضل ${m[5].replace('h', ' س ').replace('m', ' د ').replace('s', ' ث')}`;
  if (bottom) box.scrollTop = box.scrollHeight;
}
// the worker card's stages: what is moving now, and how many lectures sit on each side
const FLOW_STEP = [[/بيبدأ|يسحب|يرتّب|يقارن/, 'sort'], [/بيشتغل على|السلايدز/, 'slides']], FLOW_JOB = { pull: 'sort', push: 'push', pushall: 'push', finish: 'finish' };
function renderFlow(worker) {
  const job = S?.job && !S.job.done ? FLOW_JOB[S.job.action] : null;
  const now = job || (worker.state === 'working' ? FLOW_STEP.find(([re]) => re.test(worker.step || ''))?.[1] : null);
  $$('#wFlow li').forEach((li) => li.classList.toggle('now', li.dataset.s === now));
  if (!S?.items) return;
  $('#wFlowNot').textContent = `Not summarized: ${S.items.filter((i) => i.inUnsorted && i.lecture && !i.rel.startsWith('unsorted/summarized/')).length}`;
}
let liveFrom = null, workerShown = false;
async function followLive() {
  if (document.hidden) return;
  try {
    const r = await api('/api/live' + (liveFrom === null ? '' : `?from=${liveFrom}`));
    liveFrom = r.offset; r.lines.forEach(liveRow);
    renderFlow(r.worker);
    if (streaming) return;
    const st = $('#jobState'), busy = r.worker.state === 'working';
    if (busy) { st.className = 'state busy'; st.textContent = 'العامل: ' + (r.worker.step || 'شغّال'); } else if (workerShown) { st.className = 'state ok'; st.textContent = 'مستني'; }
    workerShown = busy;
  } catch {}
}
followLive(); setInterval(followLive, 2000);
function attach(action) {
  streaming = true; setBusy(action);
  const st = $('#jobState'); st.className = 'state busy'; st.textContent = 'شغّال: ' + (ACTION_NAME[action] || action);
  const es = new EventSource(API + '/api/job/stream');
  es.onmessage = (e) => { const { line } = JSON.parse(e.data); if (/\bETA\b/.test(line)) statsRow(line); };
  es.addEventListener('end', (e) => {
    const { code } = JSON.parse(e.data); es.close(); streaming = false; setBusy(null);
    $('#log .stats')?.remove();
    st.className = 'state ' + (code === 0 ? 'ok' : code === 'missing' ? 'warn' : 'bad');
    st.textContent = code === 0 ? 'خلص تمام' : code === 'cancelled' ? 'اتوقف' : code === 'missing' ? 'خلص، بس فيه ملفات لسه مش على الدرايف' : 'خلص بمشكلة، بص على الشاشة';
    toast(code === 0 ? (ACTION_NAME[action] || action) + ': خلص' : code === 'cancelled' ? 'اتوقف' : code === 'missing' ? (action.startsWith('check') ? 'الماك والدرايف مختلفين، التفاصيل في الشاشة' : 'فيه ملفات لسه مترفعتش، شغّل الرفع تاني') : 'حصلت مشكلة');
    if (code === 0 && SET['look.confetti'] !== false) burst(document.querySelector(`[data-run="${action}"]`));
    load(); if (S?.waiting?.length) setTimeout(load, 3500);
  });
  es.onerror = () => { es.close(); streaming = false; setBusy(null); };
}
$$('[data-run]').forEach((b) => b.addEventListener('click', async () => {
  try { const r = await api('/api/run/' + b.dataset.run, { method: 'POST' }); if (r.queued) { toast(`اتحط في الطابور، رقمه ${ar.format(r.position)}`); load(); } else attach(b.dataset.run); } catch (e) { toast(e.message); }
}));
$('#waitList').addEventListener('click', async (e) => { const id = e.target.dataset.wait; if (!id) return; await api('/api/waiting/' + id, { method: 'DELETE' }); toast('اتشال من الطابور'); load(); });
$('#cancelJob').addEventListener('click', async () => { await api('/api/job/cancel', { method: 'POST' }); toast('بيوقف…'); });
$('#pilot').addEventListener('change', async (e) => {
  const paused = !e.target.checked;
  await api('/api/autopilot', { method: 'POST', body: JSON.stringify({ paused }) });
  toast(paused ? 'الطيار الآلي وقف' : 'الطيار الآلي رجع يشتغل'); load();
});

// ---------- settings ----------
async function renderSettings() {
  $('#sPilot').textContent = S.paused ? 'واقف' : 'شغّال';
  renderAccounts(); renderStatus();
  const h = await api('/api/health').catch(() => null);
  if (!h) return;
  $('#hDrive').textContent = h.checking ? 'بيفحص…' : h.drive ? 'متوصّل ✓' : 'مش متوصّل';
  $('#hSpace').textContent = h.usedGB != null ? `${ar.format(h.usedGB)} جيجا مستخدمة · ${ar.format(h.freeGB)} فاضية${h.freeGB < (SET['safe.lowSpaceGB'] || 5) ? ' ⚠ المساحة قربت تخلص' : ''}` : '—';
  $('#hKey').hidden = !h.sharedKey;
  if (h.checking) setTimeout(() => route === 'settings' && renderSettings(), 4000);
}
// NotebookLM accounts: who is free, who hit the ~5-hour limit
async function renderAccounts() {
  const list = await api('/api/accounts').catch(() => null); if (!list) return;
  $('#gemAccts').innerHTML = list.map((a) => `<a class="gem-btn" href="https://notebook.google.com/?authuser=${a.n}" target="_blank" rel="noopener" data-tip="${esc(a.email)}${a.note ? ' (' + esc(a.note) + ')' : ''}"><span class="gem-star"></span>${ar.format(a.n + 1)}</a>`).join('');
  const free = list.filter((a) => !a.limited).length;
  $('#acctList').innerHTML = list.map((a, i) => `<li class="${a.limited ? 'limited' : ''}" style="--i:${i}"><div><i class="adot" style="--c:${a.limited ? 'var(--play)' : 'var(--mm)'}"></i><div><b>${ar.format(a.n + 1)} · ${esc(a.email)}</b><small>${a.limited ? 'وصل للحد، يرجع ' + dayTime.format(new Date(a.freeAt)) : 'متاح'}</small></div></div><button class="btn ghost small" data-acct="${a.n}" data-lim="${a.limited ? 0 : 1}">${a.limited ? 'رجّعه متاح' : 'وصل للحد'}</button></li>`).join('')
    + (free ? '' : `<li class="limited"><div><i class="adot" style="--c:var(--play)"></i><b>كل الأكونتات واقفة. أول واحد يرجع ${dayTime.format(new Date(Math.min(...list.map((a) => Date.parse(a.freeAt)))))}</b></div></li>`);
}
$('#acctList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-acct]'); if (!b) return;
  await api('/api/accounts', { method: 'POST', body: JSON.stringify({ n: +b.dataset.acct, limited: b.dataset.lim === '1' }) });
  toast(b.dataset.lim === '1' ? 'اتعلّم إنه وصل للحد، هيرجع بعد ٥ ساعات' : 'الأكونت رجع متاح'); renderAccounts();
});
// automation status: rclone / download watchers running outside the dashboard, broken downloads
async function renderStatus() {
  const s = await api('/api/status').catch(() => null); if (!s) return;
  $('#stRclone').textContent = s.rclone.length ? `${ar.format(s.rclone.length)} شغال` : 'مفيش';
  $('#stWatch').textContent = s.watchers.length ? `${ar.format(s.watchers.length)} شغال${s.watchers.length > 1 ? ' (أكتر من واحد ممكن يلخبط الملفات)' : ''}` : 'مفيش';
  $('#stBad').textContent = s.downloads.length ? `${ar.format(s.downloads.length)} ملف` : 'مفيش ✓';
  $('#trashBad').hidden = !s.downloads.length;
  $('#procList').innerHTML = [...s.rclone.map((p) => 'rclone ' + p.cmd), ...s.watchers.map((p) => p.cmd), ...s.downloads.map((d) => `~/Downloads/${d.name} (${d.size} B)`)].map((t) => `<li>${esc(t)}</li>`).join('');
}
$('#trashBad').addEventListener('click', async () => { const r = await api('/api/downloads/trash', { method: 'POST' }); toast(`${ar.format(r.moved)} ملف راح الـ Trash`); renderStatus(); });
$('#recheck').addEventListener('click', async () => { await api('/api/health?force'); toast('بيفحص الدرايف…'); setTimeout(renderSettings, 3000); });
$('#openRoot').addEventListener('click', async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: '' }) }); toast('فولدر المحاضرات اتفتح'); });
$('#openClaude').addEventListener('click', async () => { await api('/api/claude', { method: 'POST' }); toast('افتح Scheduled ← lectures-unsorted-autopilot ← Run now'); });
// how to install on this device, when the browser does not offer its own button
const UA = navigator.userAgent;
$('#installHint').textContent = /iPhone|iPad|iPod/.test(UA) ? 'من Safari: زرار المشاركة ← Add to Home Screen.' : /Android/.test(UA) ? 'من Chrome: القايمة ⋮ ← Add to Home screen.' : 'من Chrome أو Edge: أيقونة التثبيت في شريط العنوان، أو القايمة ← تثبيت الصفحة كتطبيق.';
if (matchMedia('(display-mode: standalone)').matches) $('#installHint').textContent = 'اللوحة متسطّبة كتطبيق على الجهاز ده ✓';
// served by the Mac itself (private link): "not found" means the Mac is asleep or the connection is off
if (!API) $('#offlineText').textContent = 'الماك مش بيرد. اتأكد إنه صاحي وعلى النت، وإن Tailscale شغال على الجهاز ده وعلى الماك. هتتوصل لوحدها أول ما يرجع.';
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; $('#installHint').hidden = true; });
$('#install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install').hidden = true; });
addEventListener('appinstalled', () => toast('التطبيق اتنزّل، هتلاقيه في الـDock'));

// ---------- rules editor ----------
async function loadRules() {
  const r = await api('/api/rules/' + rulesKey);
  $('#rulesText').value = r.text; rulesDirty = false;
  $('#rulesInfo').textContent = 'آخر تعديل ' + dayTime.format(new Date(r.mtime));
  const vs = await api(`/api/rules/${rulesKey}/versions`).catch(() => []);
  $('#rulesVer').innerHTML = '<option value="">رجّع نسخة قديمة…</option>' + vs.map((v) => `<option value="${esc(v.id)}">${dayTime.format(new Date(v.at))}${v.id.startsWith('backups/') ? ' (نسخة اليوم)' : ''}</option>`).join('');
}
// an old version only fills the editor; nothing changes until «احفظ التعديل»
$('#rulesVer').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const v = await api(`/api/rules/${rulesKey}/versions?id=${encodeURIComponent(e.target.value)}`);
  $('#rulesText').value = v.text; rulesDirty = true; $('#rulesInfo').textContent = 'دي نسخة قديمة، دوس «احفظ التعديل» لو عايز ترجّعها';
});
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
load().then(() => go()).finally(() => hideSplash?.());
loadRules().catch(() => {});
// data refresh every ui.refreshSeconds (restarted when that setting changes)
function startRefresh() { clearInterval(startRefresh.t); startRefresh.t = setInterval(() => { if (!streaming && !document.hidden && !$('#drawer').open && !(route === 'rules' && rulesDirty) && !(route === 'custom' && czBusy)) load(); }, (SET['ui.refreshSeconds'] || 20) * 1000); }
startRefresh();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) navigator.serviceWorker.register('sw.js').catch(() => {});


// =====================================================================
// MORE VISUALS
// =====================================================================
// countdown digits flip one by one when they change, like a slate counter
function setCount(text) {
  const el = $('#countdown');
  if (el.dataset.t === text) return;
  const prev = el.dataset.t || ''; el.dataset.t = text;
  if (!/^\d/.test(text) || prev.length !== text.length) { el.innerHTML = [...text].map((c) => `<span class="d">${c}</span>`).join(''); return; }
  const ds = el.querySelectorAll('.d');
  [...text].forEach((c, n) => { if (prev[n] !== c && ds[n]) { ds[n].textContent = c; ds[n].classList.remove('flip'); void ds[n].offsetWidth; ds[n].classList.add('flip'); } });
}

// editor lanes: every output made today/recently appears as a clip at the hour it was made
function drawLanes() {
  const lanes = { sl: 0, ar: 1, en: 2, pr: 3 }, tracks = $$('.lane-track');
  if (!tracks.length) return;
  tracks.forEach((t) => (t.innerHTML = ''));
  const day = Date.now() - 86400e3, clips = [];
  for (const it of S.items) for (const [k, names] of Object.entries(it.outputs)) {
    if (!(k in lanes)) continue;
    if (it.mtime > day) clips.push({ lane: lanes[k], at: new Date(it.mtime) });
  }
  // when nothing happened in the last day, show the schedule as planned clips
  const src = clips.length ? clips : S.schedule.flatMap((h) => [0, 1, 2, 3].map((l) => ({ lane: l, at: new Date(2000, 0, 1, h, l * 12), planned: true })));
  src.forEach((c, n) => {
    const x = ((c.at.getHours() * 60 + c.at.getMinutes()) / 1440) * 100;
    const i = document.createElement('i');
    i.style.left = `${x}%`; i.style.width = `${c.planned ? 4.2 : 2.2}%`; i.style.animationDelay = `${n * 40}ms`;
    if (c.planned) i.style.opacity = '.45';
    tracks[c.lane]?.append(i);
  });
}

// donut: how many files of each output type exist
function drawDonut() {
  const counts = ALL_KEYS.map(([k, n]) => [k, n, S.items.reduce((a, it) => a + (it.outputs[k]?.length || 0), 0)]).filter((r) => r[2]);
  const total = counts.reduce((a, r) => a + r[2], 0), C = 2 * Math.PI * 46;
  let off = 0;
  $('#donut').innerHTML = `<circle r="46" cx="60" cy="60" style="stroke:var(--line)"/>` + counts.map(([k, n, v]) => {
    const len = (v / total) * C, seg = `<circle r="46" cx="60" cy="60" style="stroke:var(--${k})" stroke-dasharray="0 ${C}" data-d="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-off}"><title>${n}: ${v}</title></circle>`;
    off += len; return seg;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('#donut [data-d]').forEach((c) => c.setAttribute('stroke-dasharray', c.dataset.d))));
  countTo($('#donutTotal'), total);
  $('#donutLegend').innerHTML = counts.map(([k, n, v]) => `<li style="--c:var(--${k})"><i></i>${n}<b>${ar.format(v)}</b></li>`).join('');
}

// activity: files touched per day over the last two weeks
function drawActivity() {
  const days = [...Array(14)].map((_, n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13 + n); return d; });
  const counts = days.map(() => 0);
  for (const it of S.items) { const idx = days.findIndex((d, n) => it.mtime >= d && (n === 13 || it.mtime < days[n + 1])); if (idx >= 0) counts[idx] += Object.values(it.outputs).flat().length || 1; }
  for (const a of S.actions) { const t = new Date(a.at); const idx = days.findIndex((d, n) => t >= d && (n === 13 || t < days[n + 1])); if (idx >= 0) counts[idx]++; }
  const max = Math.max(1, ...counts), fmt = new Intl.DateTimeFormat('ar-EG', { weekday: 'short', day: 'numeric' });
  $('#activityBars').innerHTML = counts.map((c, n) => `<span class="${c ? '' : 'zero'}" style="--h:${(c / max) * 100}%;--i:${n}"><em>${fmt.format(days[n])} · ${ar.format(c)}</em></span>`).join('');
  const sum = counts.reduce((a, b) => a + b, 0);
  $('#activityNote').textContent = `${ar.format(sum)} حركة في الأسبوعين اللي فاتوا، وأعلى يوم فيه ${ar.format(max)}.`;
}

// subjects: completion per subject as horizontal bars
function drawSubjects() {
  const L = S.items.filter((i) => i.lecture && !i.inUnsorted), subs = [...new Set(L.map((i) => i.subject))];
  const colors = ['acc'];
  $('#subjectBars').innerHTML = subs.map((s, n) => {
    const x = L.filter((i) => i.subject === s), ok = x.filter((i) => !i.missing.length).length, pct = x.length ? (ok / x.length) * 100 : 0;
    return `<a class="hbar" href="#/subjects" style="text-decoration:none;color:inherit"><div><b>${esc(s)}</b><span>${ar.format(ok)}/${ar.format(x.length)}</span></div><span class="tr"><i style="width:${pct}%;--c:var(--${colors[n % colors.length]});--i:${n}"></i></span></a>`;
  }).join('');
}

// spotlight + tilt follow the pointer
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('.card, .cmd, .clip'); if (!el) return;
  const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  el.style.setProperty('--mx', `${x}px`); el.style.setProperty('--my', `${y}px`);
  if (!reduced && el.classList.contains('tilt')) { el.style.setProperty('--ry', `${((x / r.width) - .5) * 7}deg`); el.style.setProperty('--rx', `${(.5 - y / r.height) * 7}deg`); }
}, { passive: true });
document.addEventListener('pointerout', (e) => { const el = e.target.closest?.('.tilt'); if (el && !el.contains(e.relatedTarget)) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); } });
$$('.kpi, .cmd').forEach((el) => el.classList.add('tilt'));

// command buttons: ripple where you click + equalizer while running
$$('.cmd').forEach((b) => {
  b.insertAdjacentHTML('beforeend', '<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');
  b.addEventListener('pointerdown', (e) => {
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height), d = document.createElement('span');
    d.className = 'ripple'; d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    b.append(d); setTimeout(() => d.remove(), 700);
  });
});

// particle burst (canvas) when a job finishes well
const fx = $('#fx'), g = fx.getContext('2d'); let parts = [];
function sizeFx() { fx.width = innerWidth * devicePixelRatio; fx.height = innerHeight * devicePixelRatio; }
sizeFx(); addEventListener('resize', sizeFx);
function burst(el) {
  if (reduced || !el) return;
  const r = el.getBoundingClientRect(), cx = (r.left + r.width / 2) * devicePixelRatio, cy = (r.top + r.height / 2) * devicePixelRatio;
  const cs = getComputedStyle(document.documentElement), cols = [cs.getPropertyValue('--acc-a').trim(), cs.getPropertyValue('--acc-b').trim(), '#ffffff'];
  for (let n = 0; n < 70; n++) { const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 6) * devicePixelRatio; parts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3 * devicePixelRatio, life: 1, c: cols[n % cols.length], s: (3 + Math.random() * 4) * devicePixelRatio, rot: Math.random() * 6 }); }
  if (parts.length === 70) requestAnimationFrame(fxLoop);
}
function fxLoop() {
  g.clearRect(0, 0, fx.width, fx.height);
  parts = parts.filter((p) => p.life > 0);
  for (const p of parts) {
    p.x += p.vx; p.y += p.vy; p.vy += .25 * devicePixelRatio; p.vx *= .98; p.life -= .016; p.rot += .2;
    g.save(); g.globalAlpha = Math.max(0, p.life); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.restore();
  }
  if (parts.length) requestAnimationFrame(fxLoop); else g.clearRect(0, 0, fx.width, fx.height);
}

// splash: fades out once the first data is in
const splashT0 = performance.now();
// once an hour the splash stays for a welcome: a new line each hour, plus where the lectures stand right now
const WELCOME = [
  'المحاضرات مترتبة ومستنياك، ابدأ من اللي عايزه.',
  'العامل شغال في الخلفية، وإنت ركّز في الحاجة الأهم.',
  'خطوة صغيرة دلوقتي أحسن من مذاكرة كتير بعدين.',
  'كل ملف ليه مكانه، ولو لسه ملوش العامل هيلاقيله.',
  'النهارده مناسب تخلّص حاجة كنت مأجلها.',
  'السلايدز بتتعمل لوحدها، وإنت عليك تفهم بس.',
  'بص على الوارد، يمكن حاجة جديدة نزلت.',
  'الدرايف والماك بيتقارنوا، فاطمن على ملفاتك.',
  'محاضرة واحدة كاملة أحسن من تلاتة نص نص.',
  'لو حاجة وقفت هتلاقيها قدامك في الشاشة على طول.',
  'خد نفس، وابدأ بأسهل مادة النهارده.',
  'شغل كتير اتعمل وإنت مش هنا، بص عليه.',
];
function welcome() {
  try { if (reduced || Date.now() - (+localStorage.getItem('welcomeAt') || 0) < 36e5) return false; localStorage.setItem('welcomeAt', Date.now()); } catch { return false; }
  const box = $('#welcome'), h = new Date().getHours(), lectures = S?.items?.filter((i) => i.lecture) || [], todo = lectures.filter((i) => i.missing.length).length;
  box.querySelector('h2').textContent = h < 5 ? `سهران يا ${NAME()}؟` : h < 12 ? `صباح الخير يا ${NAME()}` : h < 17 ? `يومك حلو يا ${NAME()}` : `مساء الخير يا ${NAME()}`;
  const line = box.querySelector('p'); line.textContent = '';
  WELCOME[Math.floor(Date.now() / 36e5) % WELCOME.length].split(' ').forEach((w, i) => { const el = document.createElement('span'); el.textContent = w + ' '; el.style.setProperty('--i', i); line.append(el); });
  box.querySelector('small').textContent = !lectures.length ? '' : todo ? `${lectures.length} محاضرة، ${todo} منهم ناقصهم سلايدز` : `${lectures.length} محاضرة، كلهم جاهزين`;
  box.hidden = false; $('#splash').classList.add('welcoming');
  return true;
}
function hideSplash() {
  if (hideSplash.done) return; hideSplash.done = true;
  const gone = () => $('#splash').classList.add('gone');
  setTimeout(() => {
    if (!welcome()) return gone();
    const t = setTimeout(gone, 4600);
    $('#splash').addEventListener('click', () => { clearTimeout(t); gone(); }, { once: true });
  }, Math.max(0, 1100 - (performance.now() - splashT0)));
}


// command palette: jump anywhere or run anything from the keyboard
const PAL = () => [
  ...Object.entries(PAGES).map(([k, v]) => ({ t: `روح لـ ${v}`, s: 'صفحة', c: 'var(--pr)', run: () => (location.hash = '#/' + k) })),
  ...Object.entries(ACTION_NAME).filter(([k]) => $(`[data-run="${k}"]`)).map(([k, v]) => ({ t: v, s: 'أمر', c: 'var(--mm)', run: () => $(`[data-run="${k}"]`).click() })),
  { t: S?.paused ? 'شغّل الطيار الآلي' : 'وقّف الطيار الآلي', s: 'أمر', c: 'var(--sl)', run: () => $('#pilot').click() },
  { t: 'افتح فولدر المحاضرات', s: 'أمر', c: 'var(--sl)', run: () => $('#openRoot').click() },
  ...(S ? S.items.filter((i) => !i.inUnsorted).map((i) => ({ t: i.name, s: i.subject, c: i.missing.length ? 'var(--sl)' : 'var(--mm)', run: () => openDrawer(i) })) : []),
  ...BOOKS.map((b) => ({ t: b.base, s: 'كتاب', c: 'var(--ar)', run: () => (location.hash = '#/books') })),
];
let palItems = [], palOn = 0;
function palRender() {
  const q = $('#palInput').value.trim().toLowerCase();
  palItems = PAL().filter((x) => !q || (x.t + ' ' + x.s).toLowerCase().includes(q)).slice(0, 40);
  palOn = Math.min(palOn, Math.max(0, palItems.length - 1));
  $('#palList').innerHTML = palItems.length ? palItems.map((x, n) => `<li class="${n === palOn ? 'on' : ''}" data-n="${n}" style="--c:${x.c};animation-delay:${Math.min(n, 12) * 18}ms"><i></i>${esc(x.t)}<small>${esc(x.s)}</small></li>`).join('') : '<li class="muted">مفيش نتايج</li>';
  $('#palList li.on')?.scrollIntoView({ block: 'nearest' });
}
function palOpen() { $('#palInput').value = ''; palOn = 0; palRender(); $('#palette').showModal(); $('#palInput').focus(); }
function palRun(n) { const x = palItems[n]; if (!x) return; $('#palette').close(); x.run(); }
$('#palBtn').addEventListener('click', palOpen);
$('#palInput').addEventListener('input', () => { palOn = 0; palRender(); });
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { palOn = Math.min(palItems.length - 1, palOn + 1); palRender(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { palOn = Math.max(0, palOn - 1); palRender(); e.preventDefault(); }
  if (e.key === 'Enter') palRun(palOn);
});
$('#palList').addEventListener('click', (e) => { const li = e.target.closest('li[data-n]'); if (li) palRun(+li.dataset.n); });
$('#palette').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').open ? $('#palette').close() : palOpen(); }
  // 1..7 jump between pages when not typing
  if (!e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && /^[1-8]$/.test(e.key)) location.hash = '#/' + Object.keys(PAGES)[+e.key - 1];
});


// ===== pass 3 =====
// daily activity counts (items touched + dashboard actions), used by sparks and heatmap
function dailyCounts(n) {
  const days = [...Array(n)].map((_, k) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n + 1 + k); return d; });
  const c = days.map(() => 0), idx = (t) => { for (let k = n - 1; k >= 0; k--) if (t >= days[k]) return k; return -1; };
  for (const it of S.items) { const k = idx(it.mtime); if (k >= 0) c[k] += Object.values(it.outputs).flat().length || 1; }
  for (const a of S.actions) { const k = idx(new Date(a.at)); if (k >= 0) c[k]++; }
  return { days, c };
}
function sparkPath(vals, w = 120, h = 26) {
  const max = Math.max(1, ...vals), step = w / (vals.length - 1);
  const pts = vals.map((v, k) => [k * step, h - (v / max) * (h - 3) - 1.5]);
  const line = pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}
function drawSparks() {
  const { c } = dailyCounts(14), colors = ['--acc', '--acc', '--acc', '--acc'];
  $$('.kpi').forEach((k, n) => {
    let svg = k.querySelector('.spark');
    if (!svg) { k.querySelector(':scope > div').insertAdjacentHTML('beforeend', `<svg class="spark" viewBox="0 0 120 26" preserveAspectRatio="none" style="--c:var(${colors[n]})"><path class="area"/><path class="ln"/></svg>`); svg = k.querySelector('.spark'); }
    const vals = c.map((v, i) => (n === 0 ? v : n === 1 ? Math.round(v * .6) : n === 2 ? (i > 10 ? v : 0) : v + 1));
    const p = sparkPath(vals); svg.querySelector('.ln').setAttribute('d', p.line); svg.querySelector('.area').setAttribute('d', p.area);
  });
}
function drawHeat() {
  const { days, c } = dailyCounts(84), max = Math.max(1, ...c), fmt = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'short' });
  $('#heat').innerHTML = c.map((v, k) => `<i style="--v:${(v / max).toFixed(2)};--i:${k}" title="${fmt.format(days[k])}: ${ar.format(v)}"></i>`).join('');
}

// parallax: the background lights drift slightly against the pointer
addEventListener('pointermove', (e) => {
  if (reduced) return;
  const a = $('.ambient'); a.style.setProperty('--px', `${(e.clientX / innerWidth - .5) * -30}px`); a.style.setProperty('--py', `${(e.clientY / innerHeight - .5) * -30}px`);
}, { passive: true });

// starfield drifting inside the hero, like dust in a projector beam
(() => {
  const cv = $('#stars'); if (!cv || reduced) return;
  const ctx = cv.getContext('2d'); let W, H, st = [];
  const size = () => { const r = cv.getBoundingClientRect(); W = cv.width = r.width * devicePixelRatio; H = cv.height = r.height * devicePixelRatio; st = [...Array(60)].map(() => ({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 1.6 + .3) * devicePixelRatio, v: (Math.random() * .25 + .05) * devicePixelRatio, a: Math.random() * Math.PI * 2, c: ['#3cb4ff', '#18e6c4', '#ffffff'][Math.floor(Math.random() * 3)] })); };
  size(); new ResizeObserver(size).observe(cv);
  (function loop() {
    if (!document.hidden && route === 'home') {
      ctx.clearRect(0, 0, W, H);
      for (const s of st) { s.x -= s.v; s.a += .03; if (s.x < -5) { s.x = W + 5; s.y = Math.random() * H; } ctx.globalAlpha = .35 + Math.sin(s.a) * .35; ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill(); }
    }
    requestAnimationFrame(loop);
  })();
})();

// base colour picker (kept per browser)
function setBase(b) { document.documentElement.dataset.base = b; try { localStorage.setItem('base', b); } catch {} $$('.swatch').forEach((x) => x.setAttribute('aria-pressed', x.dataset.base === b)); }
$$('.swatch').forEach((x) => x.addEventListener('click', () => { const go = () => setBase(x.dataset.base); document.startViewTransition && !reduced ? document.startViewTransition(go) : go(); saveSetting('look.base', x.dataset.base); }));
setBase(document.documentElement.dataset.base || 'navy');


// =====================================================================
// TOUCHES
// =====================================================================
const EMPTY = '<svg viewBox="0 0 120 80" class="empty-art" aria-hidden="true"><rect x="14" y="20" width="92" height="50" rx="10"/><path d="M14 38h92"/><circle cx="60" cy="56" r="6"/><path d="M40 12h40" class="dash"/></svg>';

// greeting by time of day + "updated X ago"
const NAME = () => SET['ui.name'] || 'Morfi';
function greet() {
  const h = new Date().getHours();
  $('#greet').textContent = h < 5 ? `سهران يا ${NAME()}؟` : h < 12 ? `صباح الخير يا ${NAME()}` : h < 17 ? `يومك حلو يا ${NAME()}` : `مساء الخير يا ${NAME()}`;
  if (load.at) { const s = Math.round((Date.now() - load.at) / 1000); $('#fresh').textContent = s < 10 ? '· اتحدّث دلوقتي' : `· اتحدّث من ${s < 60 ? ar.format(s) + ' ثانية' : ar.format(Math.round(s / 60)) + ' دقيقة'}`; }
}
greet(); setInterval(greet, 5000);
async function refreshNow() { const b = $('#refresh'); b.classList.add('spinning'); await load(); setTimeout(() => b.classList.remove('spinning'), 500); toast('البيانات اتحدّثت'); }
$('#refresh').addEventListener('click', refreshNow);

// keyboard help
$('#helpBtn').addEventListener('click', () => $('#help').showModal());
addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey) return;
  if (e.key === '?') $('#help').open ? $('#help').close() : $('#help').showModal();
  if (e.key.toLowerCase() === 'r') refreshNow();
});

// in-app PDF preview
function preview(rel) {
  $('#vTitle').textContent = rel.split('/').pop();
  $('#vFrame').src = API + '/api/file?rel=' + encodeURIComponent(rel);
  $('#vOpen').onclick = async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel }) }); toast('اتفتح على الماك'); };
  $('#viewer').showModal();
}
$('#vClose').addEventListener('click', () => $('#viewer').close());
$('#viewer').addEventListener('close', () => { $('#vFrame').src = 'about:blank'; });

// activity filters
$$('#histFilters .chip').forEach((c) => c.addEventListener('click', () => { histFilter = c.dataset.h; $$('#histFilters .chip').forEach((x) => x.classList.toggle('on', x === c)); renderHistory(); }));

// drop files anywhere → inbox upload
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files') || route === 'inbox') return; dragDepth++; $('#dropDest').textContent = 'هيتحطوا في الوارد: ' + ($('#dest').selectedOptions[0]?.textContent || 'مش عارف المادة'); $('#dropall').classList.add('on'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropall').classList.remove('on'); } });
addEventListener('dragover', (e) => { if (route !== 'inbox') e.preventDefault(); });
addEventListener('drop', (e) => {
  if (route === 'inbox') return;
  e.preventDefault(); dragDepth = 0; $('#dropall').classList.remove('on');
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  if (!$('#dest').options.length) renderInbox();
  location.hash = '#/inbox'; setTimeout(() => uploadAll(files), 350);
});

// desktop notifications: job finished, new file waiting in unsorted
const canNotify = (ev) => 'Notification' in window && Notification.permission === 'granted' && SET['notify.desktop'] !== false && (!ev || (SET['notify.events'] || []).includes(ev)) && !(SET['notify.quiet'] || []).includes(new Date().getHours());
function notifyBtnState() { const b = $('#notifyBtn'); if (!('Notification' in window)) { b.textContent = 'مش مدعومة'; b.disabled = true; return; } b.textContent = Notification.permission === 'granted' ? 'شغّالة ✓' : Notification.permission === 'denied' ? 'مقفولة من المتصفح' : 'شغّل الإشعارات'; b.disabled = Notification.permission !== 'default'; }
$('#notifyBtn').addEventListener('click', async () => { await Notification.requestPermission(); notifyBtnState(); if (canNotify()) new Notification('الإشعارات اشتغلت', { body: 'هقولك لما عملية تخلص أو ملف جديد يوصل.', icon: 'icon-192.png' }); });
notifyBtnState();
function notifyChanges() {
  const pend = S.items.filter((i) => i.inUnsorted && i.missing.length).length;
  if (notifyChanges.pend !== undefined && pend > notifyChanges.pend && canNotify('new')) new Notification('ملف جديد في الوارد', { body: `فيه ${pend} ملف مستني يتعمله ملفات.`, icon: 'icon-192.png' });
  const last = S.actions.find((a) => a.type === 'job');
  if (notifyChanges.job && last && last.at !== notifyChanges.job && document.hidden && canNotify(last.code === 'missing' ? 'missing' : last.code === 0 ? 'done' : 'fail')) new Notification(`${ACTION_NAME[last.action] || last.action}: ${last.code === 0 ? 'خلص' : last.code === 'missing' ? 'خلص بس فيه ملفات لسه مش على الدرايف' : 'فيه مشكلة'}`, { icon: 'icon-192.png' });
  const acc = S.actions.find((a) => a.type === 'account' && a.limited);
  if (notifyChanges.acc && acc && acc.at !== notifyChanges.acc && canNotify('limit')) new Notification(`أكونت ${acc.email} وصل للحد`, { body: 'هيرجع متاح بعد ٥ ساعات. الشغل بيكمّل على اللي بعده.', icon: 'icon-192.png' });
  notifyChanges.acc = acc?.at || notifyChanges.acc || 'none';
  notifyChanges.pend = pend; notifyChanges.job = last?.at || notifyChanges.job || 'none';
}

// export a CSV of everything that is still missing (opens in Excel / Sheets)
$('#exportBtn').addEventListener('click', () => {
  const rows = [['النوع', 'المادة', 'الاسم', 'الناقص', 'المسار']];
  for (const i of S.items) if (i.lecture && i.missing.length) rows.push(['محاضرة', i.subject, i.name, i.missing.map((k) => KEY_NAME[k]).join(' + '), i.rel]);
  for (const b of BOOKS) for (const p of b.parts) { if (!p.src) rows.push(['كتاب', b.subject, `${b.base} - الجزء ${p.part || 'كله'}`, b.lang === 'ar' ? 'سلايدز عربي' : 'سلايدز EN', b.folder]); if (p.ar === false) rows.push(['كتاب', b.subject, `${b.base} - الجزء ${p.part || 'كله'}`, 'سلايدز عربي', b.folder]); }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `الناقص - ${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href); toast(`التقرير اتنزّل: ${ar.format(rows.length - 1)} حاجة ناقصة`);
});

// styled tooltips for anything with data-tip
const tip = Object.assign(document.createElement('div'), { className: 'tip', role: 'tooltip' }); document.body.append(tip);
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]'); if (!el) return;
  tip.textContent = el.dataset.tip; const r = el.getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - 12, Math.max(12, r.left + r.width / 2))}px`; tip.style.top = `${r.bottom + 10}px`; tip.classList.add('on');
});
document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip]')) tip.classList.remove('on'); });


// =====================================================================
// LOCAL + DRIVE
// =====================================================================
const ST = { both: ['على الاتنين', 'var(--acc-b)'], local: ['على الماك بس', 'var(--sl)'], drive: ['على الدرايف بس', 'var(--acc-a)'], diff: ['الحجم مختلف', 'var(--play)'] };
function statusChip(st) { return st ? `<i class="sdot" style="--c:${ST[st][1]}" data-tip="${ST[st][0]}"></i>` : ''; }
function folderState(rel) {
  if (!SY?.ready) return null;
  let local = 0, drive = 0, both = 0;
  for (const [r, st] of Object.entries(SY.status)) if (r.startsWith(rel + '/') && !r.slice(rel.length + 1).includes('/')) { if (st === 'both') both++; else if (st === 'drive') drive++; else local++; }
  return { local, drive, both };
}
function cloudBadge(i) {
  const f = folderState(i.rel); if (!f) return '';
  const ok = !f.local && !f.drive, tipT = ok ? 'متطابق مع الدرايف' : `${f.local ? f.local + ' على الماك بس' : ''}${f.local && f.drive ? ' · ' : ''}${f.drive ? f.drive + ' على الدرايف بس' : ''}`;
  return `<span class="cloud ${ok ? 'ok' : 'warn'}" data-tip="${tipT}"><svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9z"/>${ok ? '<path d="m9 13 2 2 4-4"/>' : '<path d="M12 10v4M12 16.5v.5"/>'}</svg></span>`;
}
function syncBadge() { const n = SY?.ready ? SY.counts.local + SY.counts.drive + SY.counts.diff : 0; $('#syncBadge').hidden = !n; $('#syncBadge').textContent = ar.format(n); }
async function runSync(url, body, action) {
  try { const r = await api(url, { method: 'POST', body: JSON.stringify(body) }); location.hash = '#/home'; if (r.queued) { toast(`اتحط في الطابور، رقمه ${ar.format(r.position)}`); load(); } else attach(action); } catch (e) { toast(e.message); }
}
function renderSync() {
  if (!SY) return;
  if (SY.indexing && !renderSync.poll) renderSync.poll = setInterval(async () => { SY = await api('/api/sync'); syncBadge(); if (route === 'sync') renderSync(); if (!SY.indexing) { clearInterval(renderSync.poll); renderSync.poll = null; } }, 4000);
  const total = SY.counts.both + SY.counts.local + SY.counts.drive + SY.counts.diff, pct = total ? SY.counts.both / total : 0;
  $('#syncArc').style.strokeDashoffset = String(326.7 * (1 - pct));
  $('#syncPct').textContent = SY.ready ? `${ar.format(Math.round(pct * 100))}٪` : '…';
  $('#syncWhen').textContent = SY.indexing ? 'بيقرا الدرايف دلوقتي…' : SY.ready ? `آخر قراءة للدرايف ${dayTime.format(new Date(SY.at))} · ${ar.format(total)} ملف` : (SY.error || 'لسه بيقرا…');
  countTo($('#cBoth'), SY.counts.both); countTo($('#cLocal'), SY.counts.local); countTo($('#cDrive'), SY.counts.drive); countTo($('#cDiff'), SY.counts.diff);
  $('.sync-flow').classList.toggle('busy', !!(S.job && !S.job.done && /push|pull|up|down/.test(S.job.action)));
  $('#autosync').checked = SY.auto;
  const q = $('#syncQ').value.trim().toLowerCase();
  const rows = (SY.lists[syncList] || []).filter((r) => !q || r.toLowerCase().includes(q));
  $('#syncList').innerHTML = rows.length ? rows.slice(0, 200).map((r, n) => {
    const name = r.split('/').pop(), dir = r.split('/').slice(0, -1).join(' / '), id = SY.ids[r];
    return `<li style="--i:${Math.min(n, 25)}"><div>${statusChip(syncList)}<b>${esc(name)}</b><small>${esc(dir)}</small></div><span class="row-actions">${syncList === 'drive' ? `<button class="btn ghost small" data-sdown="${esc(r)}">نزّله</button>` : `<button class="btn ghost small" data-sup="${esc(r)}">ارفعه</button>`}${id ? `<a class="btn ghost small" target="_blank" rel="noopener" href="https://drive.google.com/file/d/${id}/view">Drive</a>` : ''}</span></li>`;
  }).join('') : `<li class="empty-state">${EMPTY}<span>${syncList === 'local' ? 'كل اللي على الماك موجود على الدرايف ✓' : syncList === 'drive' ? 'مفيش حاجة على الدرايف ناقصة من الماك ✓' : 'مفيش ملفات حجمها مختلف ✓'}</span></li>`;
}
$('#syncTabs').addEventListener('click', (e) => { const c = e.target.closest('[data-l]'); if (!c) return; syncList = c.dataset.l; $$('#syncTabs .chip').forEach((x) => x.classList.toggle('on', x === c)); renderSync(); });
$$('.stat[data-list]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.list === 'both') return; $(`#syncTabs [data-l="${b.dataset.list}"]`).click(); $('#syncList').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
$('#syncQ').addEventListener('input', renderSync);
$('#syncList').addEventListener('click', (e) => {
  const up = e.target.dataset.sup, dn = e.target.dataset.sdown; if (!up && !dn) return;
  runSync('/api/sync/file', { rel: up || dn, dir: up ? 'up' : 'down' }, up ? 'up' : 'down');
});
$('#rescan').addEventListener('click', async () => { SY = await api('/api/sync?rescan'); toast('بيقرا الدرايف من الأول…'); renderSync(); const t = setInterval(async () => { SY = await api('/api/sync'); renderSync(); syncBadge(); if (!SY.indexing) { clearInterval(t); toast('الدرايف اتقرا ✓'); } }, 4000); });
$('#autosync').addEventListener('change', async (e) => { await api('/api/autosync', { method: 'POST', body: JSON.stringify({ on: e.target.checked }) }); toast(e.target.checked ? 'المزامنة التلقائية اشتغلت: أي ملف جديد على الماك هيترفع لوحده' : 'المزامنة التلقائية وقفت'); load(); });
$('#dUp').addEventListener('click', () => { $('#drawer').close(); runSync('/api/sync/folder', { rel: current.rel, dir: 'up' }, 'up'); });
$('#dDown').addEventListener('click', () => { $('#drawer').close(); runSync('/api/sync/folder', { rel: current.rel, dir: 'down' }, 'down'); });

// calm mode switch (Settings): saved per browser, reloads so every effect follows it
$('#calm').checked = calm;
$('#calm').addEventListener('change', (e) => saveSetting('look.calm', e.target.checked));


// =====================================================================
// WORKER: makes the outputs on its own (worker/worker.mjs)
// =====================================================================
const TASK_ST = { waiting: ['مستني دوره', 'var(--muted)'], working: ['شغّال عليها', 'var(--acc)'], done: ['خلصت', 'var(--mm)'], failed: ['فيها مشكلة', 'var(--play)'], later: ['مستنية أكونت يفضى', 'var(--sl)'], cancelled: ['اتلغت', 'var(--muted)'] };
const OUT_NAME = { SRC: 'سلايدز', AR: 'عربي', EN: 'English', PR: 'للمقدم' };
function renderWorker() {
  if (!WK) { $('#wState').className = 'state bad'; $('#wState').textContent = 'العامل مش شغال'; return; }
  const st = WK.status || {}, working = st.state === 'working';
  $('#wState').className = 'state ' + (!WK.alive ? 'bad' : working ? 'busy' : 'ok');
  $('#wState').textContent = !WK.alive ? 'العامل مش شغال' : working ? 'شغّال' : 'مستني';
  $('#wStep').textContent = working ? [st.step, st.account && 'أكونت ' + st.account, st.last].filter(Boolean).join(' · ') : st.lastSummary ? `آخر دورة ${dayTime.format(new Date(st.lastCycle))}: ${st.lastSummary}` : 'لسه مشتغلش. أول دورة في الميعاد الجاي، أو دوس «اشتغل دلوقتي».';
  $('#wSignin').hidden = !st.needsZen;
  const T = WK.tasks.slice(0, 8);
  $('#wTasks').innerHTML = T.length ? T.map((t, n) => { const [label, c] = TASK_ST[t.status] || [t.status, 'var(--muted)']; return `<li class="${t.status}" style="--c:${c};--i:${n}"><div><b>${esc(t.rel.split('/').pop())}</b><small>${t.outs.map((o) => OUT_NAME[o] || o).join(' + ')} · ${label}${t.error ? ' · ' + esc(t.error) : ''}${t.status === 'working' && t.log?.length ? ' · ' + esc(t.log[t.log.length - 1].slice(9)) : ''}</small></div><span class="row-actions">${['failed', 'later', 'done'].includes(t.status) ? `<button class="btn ghost small" data-wretry="${t.id}">تاني</button>` : ''}${['waiting', 'later'].includes(t.status) ? `<button class="x" data-wcancel="${t.id}" aria-label="الغيها">×</button>` : ''}</span></li>`; }).join('')
    : '<li style="--c:var(--line)"><div><b>مفيش شغل لسه</b><small>افتح أي محاضرة من «المواد» واختار «اعمل دلوقتي».</small></div></li>';
  if (route === 'settings') {
    if (document.activeElement !== $('#wHours')) $('#wHours').value = (SET['worker.schedule'] || S.schedule).join(', ');
    $('#wAuto').checked = !!SET['worker.auto'];
    $('#wNtfy').textContent = SET['notify.ntfy'] ? 'شغّالة' : 'مقفولة'; $('#wNtfyBtn').textContent = SET['notify.ntfy'] ? 'اعرض الكود' : 'شغّلها';
  }
}
$('#wTasks').addEventListener('click', async (e) => {
  const r = e.target.dataset.wretry, c = e.target.dataset.wcancel; if (!r && !c) return;
  try { await api(`/api/worker/task/${r || c}/${r ? 'retry' : 'cancel'}`, { method: 'POST' }); toast(r ? 'رجعت للطابور' : 'اتلغت'); load(); } catch (err) { toast(err.message); }
});
const workerRun = async () => { await api('/api/worker/run', { method: 'POST' }); toast('العامل هيبدأ خلال نص دقيقة، تابعه في كارت «العامل» في الرئيسية'); };
$('#wRun').addEventListener('click', workerRun); $('#wRun2').addEventListener('click', workerRun);
const signin = async () => { if (!confirm('Zen هيتقفل ويتفتح تاني والتابات بترجع. تمام؟')) return; await api('/api/worker/zen', { method: 'POST' }); toast('Zen بيتفتح من جديد للعامل…'); };
$('#wSigninBtn').addEventListener('click', signin); $('#wSignin2').addEventListener('click', signin);
$('#dMakeGo').addEventListener('click', async () => {
  const outs = $$('#dMake input:checked').filter((c) => !c.closest('label').hidden).map((c) => c.value);
  try { await api('/api/worker/make', { method: 'POST', body: JSON.stringify({ rel: current.rel, outs }) }); $('#drawer').close(); toast('العامل استلمها، هتلاقيها في الرئيسية'); load(); } catch (e) { toast(e.message); }
});
$('#wHoursSave').addEventListener('click', () => { const h = $('#wHours').value.split(/[^\d]+/).filter(Boolean).map(Number); if (!h.length) return toast('اكتب ساعة واحدة على الأقل'); saveSetting('worker.schedule', h, 'المواعيد اتحفظت'); });
$('#wAuto').addEventListener('change', (e) => saveSetting('worker.auto', e.target.checked, e.target.checked ? 'العامل هيعمل الناقص لوحده' : 'العامل هيعمل طلباتك بس'));
$('#wNtfyBtn').addEventListener('click', async () => {
  let topic = SET['notify.ntfy'];
  if (!topic) { topic = 'morfi-lectures-' + crypto.randomUUID().slice(0, 13); await saveSetting('notify.ntfy', topic, null); }
  try { await navigator.clipboard.writeText(topic); } catch {}
  toast(`نزّل تطبيق ntfy على الموبايل، واعمل Subscribe على: ${topic} (اتنسخ)`, 'تمام', () => {});
});


// =====================================================================
// CUSTOMIZE: the page is drawn from the settings schema (settings.mjs)
// =====================================================================
let CZ = null, czBusy = false;
async function loadSettings() {
  try { CZ = await api('/api/settings'); SET = CZ.values; applySettings(); } catch {}
}
// apply what can change live on this page; calm mode reloads so every effect follows it
function applySettings() {
  const root = document.documentElement, v = SET;
  if (v['look.base'] && root.dataset.base !== v['look.base']) setBase(v['look.base']);
  if (v['look.accent'] === 'blue') delete root.dataset.accent; else root.dataset.accent = v['look.accent'];
  root.style.fontSize = (Number(v['look.fontScale']) || 100) + '%';
  root.dataset.density = v['look.density'] || 'cozy';
  const wantCalm = !!v['look.calm'];
  try { if ((localStorage.getItem('calm') === '1') !== wantCalm) { localStorage.setItem('calm', wantCalm ? '1' : '0'); location.reload(); return; } } catch {}
  $('#calm').checked = wantCalm;
  $('#stars')?.toggleAttribute('hidden', v['look.stars'] === false);
  const cards = new Set(v['look.homeCards'] || []), map = { hero: '.page[data-page="home"] .day', kpis: '.kpis', charts: '.charts', commands: '.deck', console: '.console', worker: '#workerCard' };
  for (const [k, sel] of Object.entries(map)) $(sel)?.classList.toggle('hide-card', !cards.has(k));
  const loc = v['ui.digits'] === 'latn' ? 'ar-EG-u-nu-latn' : 'ar-EG', h12 = v['ui.clock'] !== '24';
  ar = new Intl.NumberFormat(loc);
  time = new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit', hour12: h12 });
  dayTime = new Intl.DateTimeFormat(loc, { weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: h12 });
  startRefresh(); greet();
}
async function saveSetting(key, value, msg = 'اتحفظ ✓') {
  try { const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ values: { [key]: value } }) }); SET = r.values; if (CZ) CZ.values = SET; applySettings(); if (msg) toast(msg); load(); return true; }
  catch (e) { toast(e.message); return false; }
}
const czDefault = (s) => JSON.stringify(SET[s.key]) === JSON.stringify(s.default);
function czControl(s) {
  const v = SET[s.key], id = 'cz-' + s.key.replace(/\W/g, '_');
  switch (s.type) {
    case 'bool': return `<label class="pilot small-switch"><input type="checkbox" id="${id}" role="switch" ${v ? 'checked' : ''}><span class="knob" aria-hidden="true"></span></label>`;
    case 'int': return `<input type="number" id="${id}" min="${s.min}" max="${s.max}" value="${v}" inputmode="numeric">`;
    case 'text': return `<input type="text" id="${id}" value="${esc(v)}" dir="auto">`;
    case 'textarea': return `<textarea id="${id}" class="${/[؀-ۿ]/.test(v) ? 'rtl' : ''}" spellcheck="false">${esc(v)}</textarea>`;
    case 'select': return `<select id="${id}">${s.options.map(([o, l]) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    case 'multi': return `<div class="cz-multi" id="${id}">${s.options.map(([o, l]) => `<label><input type="checkbox" value="${esc(o)}" ${v.includes(o) ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>`;
    case 'hours': return `<input type="text" id="${id}" value="${v.join(', ')}" inputmode="numeric" dir="ltr" placeholder="9, 15, 21">`;
    case 'list': return `<textarea id="${id}" class="rtl" spellcheck="false">${esc(v.join('\n'))}</textarea>`;
  }
}
function czRead(s, el) {
  switch (s.type) {
    case 'bool': return el.checked;
    case 'multi': return [...el.querySelectorAll('input:checked')].map((x) => x.value);
    case 'list': return el.value.split('\n');
    default: return el.value;
  }
}
async function renderCustom() {
  if (!CZ) await loadSettings(); if (!CZ) return;
  const q = $('#czQ').value.trim().toLowerCase(), onlyChanged = $('#czChanged').checked;
  const match = (s) => (!q || (s.label + ' ' + (s.help || '') + ' ' + s.key).toLowerCase().includes(q)) && (!onlyChanged || !czDefault(s));
  const groups = CZ.groups.map(([g, title, sub]) => [g, title, sub, CZ.schema.filter((s) => s.group === g && match(s))]).filter((x) => x[3].length);
  $('#czJump').innerHTML = groups.map(([g, title]) => `<a href="#cz-g-${g}" data-g="${g}">${esc(title)}</a>`).join('');
  $('#czGroups').innerHTML = groups.length ? groups.map(([g, title, sub, list], i) => `<section class="card cz-group" id="cz-g-${g}" style="--i:${i}"><h2>${esc(title)}</h2><p class="muted small">${esc(sub)}</p>${list.map((s) => `
    <div class="cz-row ${['textarea', 'list', 'multi'].includes(s.type) ? 'wide' : ''} ${czDefault(s) ? '' : 'changed'}" data-key="${s.key}">
      <label class="lbl" for="cz-${s.key.replace(/\W/g, '_')}">${esc(s.label)}${s.help ? `<small>${esc(s.help)}</small>` : ''}</label>
      <div class="ctl">${czControl(s)}</div>
      <button class="cz-reset" data-reset="${s.key}" title="رجّعه للأصلي" aria-label="رجّع ${esc(s.label)} للأصلي" ${czDefault(s) ? 'hidden' : ''}>↺</button>
    </div>`).join('')}</section>`).join('') : '<div class="card cz-empty">مفيش إعداد بالاسم ده.</div>';
  renderCzAccounts();
}
// every control saves itself: toggles/selects at once, typing after a short pause
$('#czGroups').addEventListener('change', (e) => czSave(e.target));
$('#czGroups').addEventListener('input', (e) => { if (!e.target.matches('input[type=text], input[type=number], textarea')) return; czBusy = true; clearTimeout(czSave.t); czSave.t = setTimeout(() => czSave(e.target), 900); });
async function czSave(target) {
  const row = target.closest('.cz-row'); if (!row) return;
  const s = CZ.schema.find((x) => x.key === row.dataset.key), el = row.querySelector('.ctl > *').matches('label.pilot') ? row.querySelector('input') : row.querySelector('.ctl > *');
  clearTimeout(czSave.t); czBusy = false;
  if (await saveSetting(s.key, czRead(s, el), null)) {
    row.classList.toggle('changed', !czDefault(s)); row.querySelector('.cz-reset').hidden = czDefault(s);
    row.classList.remove('saved'); void row.offsetWidth; row.classList.add('saved');
    toast(`${s.label}: اتحفظ ✓`);
  } else renderCustom(); // a refused value goes back to the saved one
}
$('#czGroups').addEventListener('click', async (e) => {
  const k = e.target.dataset.reset; if (!k) return;
  const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ reset: [k] }) }); SET = CZ.values = r.values; applySettings(); renderCustom(); toast('رجع للأصلي');
});
$('#czQ').addEventListener('input', () => renderCustom());
$('#czChanged').addEventListener('change', () => renderCustom());
$('#czJump').addEventListener('click', (e) => { const a = e.target.closest('a[data-g]'); if (!a) return; e.preventDefault(); $('#cz-g-' + a.dataset.g)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); });
$('#czExport').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(SET, null, 2)], { type: 'application/json' })), download: `تخصيص اللوحة - ${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); URL.revokeObjectURL(a.href); toast('النسخة اتنزّلت');
});
$('#czImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { const values = JSON.parse(await f.text()); const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ values, replace: true }) }); SET = CZ.values = r.values; applySettings(); renderCustom(); toast('النسخة اترفعت واتطبّقت'); }
  catch (err) { toast('الملف ده مش نسخة تخصيص صالحة: ' + err.message); }
});
$('#czResetAll').addEventListener('click', async () => {
  if (!confirm('كل الإعدادات هترجع للأصلي. نزّل نسخة الأول لو عايز ترجعلها. تمام؟')) return;
  const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ values: {}, replace: true }) }); SET = CZ.values = r.values; applySettings(); renderCustom(); toast('كله رجع للأصلي');
});
// accounts: switch each one on or off for the worker
async function renderCzAccounts() {
  const list = await api('/api/accounts').catch(() => null); if (!list) return;
  $('#czAccts').innerHTML = list.map((a, i) => `<li class="${a.disabled ? 'limited' : ''}" style="--i:${i}"><div><i class="adot" style="--c:${a.disabled ? 'var(--muted)' : a.limited ? 'var(--play)' : 'var(--mm)'}"></i><div><b>${ar.format(a.n)} · ${esc(a.email)}</b><small>${a.disabled ? 'مقفول للعامل' : a.limited ? 'وصل للحد' : 'متاح'}${a.note ? ' · ' + esc(a.note) : ''}</small></div></div><label class="pilot small-switch"><input type="checkbox" role="switch" data-acc-on="${a.n}" ${a.disabled ? '' : 'checked'}><span class="knob" aria-hidden="true"></span></label></li>`).join('');
}
$('#czAccts').addEventListener('change', async (e) => {
  const n = e.target.dataset.accOn; if (n === undefined) return;
  try { await api('/api/accounts', { method: 'POST', body: JSON.stringify({ n: +n, disabled: !e.target.checked }) }); toast(e.target.checked ? 'الأكونت رجع للعامل' : 'الأكونت اتقفل للعامل'); renderCzAccounts(); } catch (err) { toast(err.message); }
});
// boot: settings first, then the start page when no page is in the link
loadSettings().then(() => { load.sig = null; load(); if (!location.hash && SET['ui.startPage'] && SET['ui.startPage'] !== 'home') location.hash = '#/' + SET['ui.startPage']; });


// phones: four main tabs + «المزيد» opens a sheet with the other pages
const MORE = ['books', 'activity', 'rules', 'settings', 'custom'];
$('#moreLinks').innerHTML = MORE.map((r) => { const a = $(`.nav a[data-route="${r}"]`); return `<a href="#/${r}" data-route="${r}" style="--i:${MORE.indexOf(r)}">${a.querySelector('svg').outerHTML}<span>${PAGES[r]}</span></a>`; }).join('');
$('#moreBtn').addEventListener('click', () => $('#moreSheet').showModal());
$('#moreSheet').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('a')) e.currentTarget.close(); });
const markMore = () => { const r = (location.hash.match(/^#\/(\w+)/) || [])[1]; $('#moreBtn').classList.toggle('on', MORE.includes(r)); $$('#moreLinks a').forEach((a) => a.classList.toggle('on', a.dataset.route === r)); };
addEventListener('hashchange', markMore); markMore();

// the footer credit opens from its M into the full capsule when it scrolls into view
(function credit() {
  const box = $('#credit');
  if (reduced) return;
  box.classList.add('ready');
  new IntersectionObserver((es) => {
    if (!es[0].isIntersecting) return;
    box.classList.remove('play'); void box.offsetWidth; box.classList.add('play');
  }, { threshold: .6 }).observe(box);
})();

// cards rise into place as they scroll into view, on every page
(function reveal() {
  if (reduced) return;
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -5% 0px' });
  const scan = () => $$('#view .card:not(.glow-border):not(.rv), #view .kpis > :not(.rv), #view .charts > :not(.rv)').forEach((el) => { el.classList.add('rv'); io.observe(el); });
  let queued; new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; scan(); }); }).observe($('#view'), { childList: true, subtree: true });
  scan();
})();
