// on the Mac the page is served by the server itself; the hosted copy talks to the server on this Mac
const API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '' : 'http://localhost:4545';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEYS = [
  ['sl', 'سلايدز'], ['tr', 'ترجمة'], ['mm', 'خريطة ذهنية'], ['ar', 'سلايدز عربي'], ['pr', 'سلايدز للمقدم'], ['en', 'سلايدز English'],
];
const KEY_NAME = Object.fromEntries(KEYS);
const ACTION_NAME = { pull: 'سحب وترتيب', push: 'رفع على الدرايف', check: 'فحص unsorted', checkall: 'فحص كل المحاضرات' };
const ar = new Intl.NumberFormat('ar-EG');
const time = new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null, filter = 'all', query = '', current = null, rulesKey = 'thawabit', rulesDirty = false, streaming = false;

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

// ---------- state ----------
async function load() {
  try { S = await api('/api/state'); } catch (e) {
    $('#sub').textContent = 'مش متوصّل بالماك';
    document.body.classList.add('offline'); return;
  }
  document.body.classList.remove('offline');
  render();
  if (S.job && !S.job.done && !streaming) attach(S.job.action);
}
function render() {
  const lects = S.items.filter((i) => i.lecture);
  const done = lects.filter((i) => !i.missing.length).length;
  $('#sub').textContent = `${ar.format(lects.length)} محاضرة · ${ar.format(done)} كاملة · ${ar.format(S.pdfs)} ملف PDF`;
  $('#pilot').checked = !S.paused;
  $('#pilotText').textContent = S.paused ? 'الطيار الآلي واقف' : 'الطيار الآلي شغّال';
  document.body.classList.toggle('paused', S.paused);
  renderDay(); renderTracks(); renderMeters(); renderQueue(); renderHistory(); fillDest();
}

// ---------- the day ruler ----------
let rulerBuilt = false;
function renderDay() {
  const ruler = $('#ticks');
  if (!rulerBuilt) {
    let html = '';
    for (let h = 0; h <= 24; h++) {
      html += `<i class="tick ${h % 6 ? '' : 'h6'}" style="left:${(h / 24) * 100}%"></i>`;
      if (h % 3 === 0) html += `<span class="tick-label" style="left:${(h / 24) * 100}%">${ar.format(h)}</span>`;
    }
    for (const h of S.schedule) html += `<div class="run" data-h="${h}" style="left:${(h / 24) * 100}%">${time.format(new Date(2000, 0, 1, h))}</div>`;
    ruler.innerHTML = html; rulerBuilt = true;
    // the one orchestrated moment: the playhead scrubs from midnight to now
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }
  const last = S.runs[0];
  $('#lastRun').innerHTML = last
    ? `<strong>آخر دورة: ${dayTime.format(new Date(last.at))}</strong><br>${esc(last.summary || '')}`
    : '<strong>لسه مفيش دورة اتسجلت</strong><br>أول دورة هتظهر هنا بعد ما تشتغل.';
}
function tick() {
  const now = new Date();
  const frac = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  $('#playhead').style.left = `${frac * 100}%`;
  $('#nowLabel').textContent = time.format(now);
  const next = S.schedule.map((h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d; }).find((d) => d > now)
    || (() => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(S.schedule[0], 0, 0, 0); return d; })();
  const s = Math.max(0, Math.round((next - now) / 1000));
  const p = (n) => String(n).padStart(2, '0');
  $('#countdown').textContent = S.paused ? 'واقف' : `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  $('#nextLabel').textContent = S.paused
    ? 'الطيار الآلي متوقف، الدورات هتعدّي من غير شغل لحد ما تشغّله تاني.'
    : `الساعة ${time.format(next)}: هيسحب الجديد، يعمل كل الملفات، ويرفعها.`;
  $$('.run').forEach((el) => {
    const h = +el.dataset.h;
    el.classList.toggle('past', h <= now.getHours() && next.getHours() !== h);
    el.classList.toggle('next', next.getHours() === h && next.getDate() === now.getDate());
  });
}
setInterval(() => S && tick(), 1000);

// ---------- tracks ----------
function keysHTML(i) {
  return KEYS.map(([k, n]) => {
    const has = i.outputs[k]; const need = i.missing.includes(k);
    return `<i class="k ${has ? '' : need ? 'need' : 'off'}" style="--c:var(--${k})" title="${n}${has ? '' : need ? ' (ناقص)' : ''}"></i>`;
  }).join('');
}
function renderTracks() {
  $('#legend').innerHTML = KEYS.map(([k, n]) => `<li><i class="k" style="--c:var(--${k})"></i>${n}</li>`).join('')
    + '<li><i class="k need" style="--c:var(--sl)"></i>ناقص ولازم يتعمل</li>';
  const q = query.trim().toLowerCase();
  const list = S.items.filter((i) => {
    if (q && !(i.name + i.subject + i.rel).toLowerCase().includes(q)) return false;
    if (filter === 'miss') return i.missing.length;
    if (filter === 'done') return i.lecture && !i.missing.length;
    if (filter === 'unsorted') return i.inUnsorted;
    return true;
  });
  const groups = new Map();
  for (const i of list) {
    const g = (i.inUnsorted ? 'unsorted · ' : '') + i.subject;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  if (!groups.size) { $('#trackList').innerHTML = `<p class="empty">${filter === 'miss' ? 'مفيش أي محاضرة ناقصة. كله جاهز.' : filter === 'unsorted' ? 'unsorted فاضي دلوقتي. ارمي ملف فوق وهيظهر هنا.' : 'مفيش نتايج للبحث ده.'}</p>`; return; }
  $('#trackList').innerHTML = [...groups].map(([g, items]) => {
    const L = items.filter((i) => i.lecture); const ok = L.filter((i) => !i.missing.length).length;
    const pct = L.length ? Math.round((ok / L.length) * 100) : 100;
    return `<div class="track">
      <div class="track-name"><b>${esc(g)}</b><small>${ar.format(L.length)} محاضرة · ${ar.format(ok)} كاملة</small><div class="bar-mini"><i style="width:${pct}%"></i></div></div>
      <div class="clips">${items.map((i) => `
        <button class="clip ${!i.lecture ? 'ref' : i.missing.length ? 'miss' : ''}" data-id="${i.id}">
          <span class="t">${esc(i.name)}</span>
          <span class="tag">${i.lecture ? (i.lang === 'ar' ? 'عربي' : 'EN') : 'مراجع'}</span>
          <span class="keys">${keysHTML(i)}</span>
        </button>`).join('')}</div>
    </div>`;
  }).join('');
}
$('#trackList').addEventListener('click', (e) => {
  const b = e.target.closest('.clip'); if (b) openDrawer(S.items.find((i) => i.id === b.dataset.id));
});
$$('.filters .chip').forEach((c) => c.addEventListener('click', () => {
  filter = c.dataset.f; $$('.filters .chip').forEach((x) => x.classList.toggle('on', x === c)); renderTracks();
}));
$('#q').addEventListener('input', (e) => { query = e.target.value; renderTracks(); });

// ---------- drawer ----------
function openDrawer(i) {
  current = i;
  $('#dSubject').textContent = (i.inUnsorted ? 'unsorted · ' : '') + i.subject + (i.lecture ? (i.lang === 'ar' ? ' · مصدر عربي' : ' · مصدر إنجليزي') : ' · مراجع');
  $('#dTitle').textContent = i.name;
  $('#dKeys').innerHTML = KEYS.map(([k, n]) => {
    const has = i.outputs[k]; const need = i.missing.includes(k);
    return `<div class="${has ? '' : 'no'}"><i class="k ${has ? '' : need ? 'need' : 'off'}" style="--c:var(--${k})"></i>${n}${has ? '' : need ? ' · ناقص' : ''}</div>`;
  }).join('');
  const files = [...i.sources.map((f) => f.name), ...Object.values(i.outputs).flat(), ...i.videos.map((f) => f.name)];
  const uniq = [...new Set(files)];
  $('#dFiles').innerHTML = uniq.map((n) => `<li><span>${esc(n)}</span><span>
      ${/\.pdf$/i.test(n) ? `<button data-view="${esc(n)}">اعرض</button>` : ''}
      <button data-open="${esc(n)}">افتح</button></span></li>`).join('');
  $('#dAsk').hidden = false;
  $('#dNote').value = i.missing.length ? 'كمّل: ' + i.missing.map((k) => KEY_NAME[k]).join('، ') : '';
  $('#drawer').showModal();
}
$('#dFiles').addEventListener('click', async (e) => {
  const v = e.target.dataset.view, o = e.target.dataset.open;
  if (v) window.open(API + '/api/file?rel=' + encodeURIComponent(current.rel + '/' + v), '_blank');
  if (o) { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel + '/' + o }) }); toast('اتفتح على الماك'); }
});
$('#dReveal').addEventListener('click', async () => {
  await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: current.rel }) }); toast('الفولدر اتفتح في Finder');
});
$('#dQueue').addEventListener('click', async () => {
  await api('/api/queue', { method: 'POST', body: JSON.stringify({ rel: current.rel, note: $('#dNote').value }) });
  $('#drawer').close(); toast('اتضافت للطلبات، الدورة الجاية هتبدأ بيها'); load();
});
$('#drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- meters ----------
function renderMeters() {
  const L = S.items.filter((i) => i.lecture);
  const rows = ['sl', 'tr', 'mm', 'ar'].map((k) => {
    const pool = L.filter((i) => i.need.includes(k)); const has = pool.filter((i) => i.outputs[k]).length;
    return [k, has, pool.length];
  });
  const subjects = [...new Set(L.map((i) => i.subject))];
  rows.push(['pr', subjects.filter((s) => L.some((i) => i.subject === s && i.outputs.pr)).length, subjects.length, 'مادة']);
  $('#meters').innerHTML = rows.map(([k, a, b, unit]) => `
    <div class="meter" style="--c:var(--${k})">
      <div class="meter-top"><span>${KEY_NAME[k]}</span><span>${ar.format(a)} من ${ar.format(b)} ${unit || 'محاضرة'}</span></div>
      <div class="meter-bar"><i data-w="${b ? (a / b) * 100 : 0}"></i></div>
    </div>`).join('');
  requestAnimationFrame(() => $$('#meters i').forEach((i) => (i.style.width = i.dataset.w + '%')));
}

// ---------- queue + history ----------
function renderQueue() {
  $('#queue').innerHTML = S.queue.length ? S.queue.map((q) => `<li><div><b>${esc(q.rel.split('/').pop())}</b><small>${esc(q.note || 'كمّل الناقص')}</small></div>
    <button class="x" data-del="${q.id}" aria-label="شيل الطلب">×</button></li>`).join('')
    : '<li class="muted">مفيش طلبات. افتح أي محاضرة واطلب تكملتها.</li>';
}
$('#queue').addEventListener('click', async (e) => {
  const id = e.target.dataset.del; if (!id) return;
  await api('/api/queue/' + id, { method: 'DELETE' }); toast('الطلب اتشال'); load();
});
function renderHistory() {
  const rows = [
    ...S.runs.map((r) => ({ at: r.at, c: 'var(--pr)', t: 'دورة الطيار الآلي', d: r.summary })),
    ...S.actions.map((a) => ({
      at: a.at,
      c: a.type === 'job' ? (a.code === 0 ? 'var(--mm)' : 'var(--play)') : 'var(--muted)',
      t: a.type === 'job' ? `${ACTION_NAME[a.action] || a.action}${a.code === 0 ? '' : ' (فيه مشكلة)'}`
        : a.type === 'upload' ? 'ملف اتضاف' : a.type === 'queue' ? 'طلب جديد' : a.type === 'rules' ? 'الثوابت اتعدّلت'
        : a.type === 'autopilot' ? (a.paused ? 'الطيار الآلي وقف' : 'الطيار الآلي اشتغل') : a.type,
      d: a.file || a.rel || (a.tail || []).slice(-2).join(' / '),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  $('#history').innerHTML = rows.length ? rows.map((r) => `<li><i class="dot" style="--c:${r.c}"></i><div><b>${esc(r.t)}</b><small>${esc(r.d || '')}</small></div><small>${dayTime.format(new Date(r.at))}</small></li>`).join('')
    : '<li class="muted">لسه مفيش حاجة اتعملت من اللوحة.</li>';
}

// ---------- commands + live console ----------
function setBusy(action) {
  $$('[data-run]').forEach((b) => { b.disabled = !!action; b.classList.toggle('running', b.dataset.run === action); });
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
    st.textContent = code === 0 ? 'خلص تمام' : 'خلص بمشكلة، بص على الشاشة';
    if (!$('#log').textContent.trim()) logLine(action === 'push' || action.startsWith('check') ? 'كله متطابق، مفيش حاجة ناقصة.' : 'مفيش جديد.');
    toast(code === 0 ? (ACTION_NAME[action] || action) + ': خلص' : 'حصلت مشكلة');
    load();
  });
  es.onerror = () => { es.close(); streaming = false; setBusy(null); };
}
$$('[data-run]').forEach((b) => b.addEventListener('click', async () => {
  try { await api('/api/run/' + b.dataset.run, { method: 'POST' }); attach(b.dataset.run); } catch (e) { toast(e.message); }
}));
$('#openRoot').addEventListener('click', async () => { await api('/api/open', { method: 'POST', body: JSON.stringify({ rel: '' }) }); toast('فولدر المحاضرات اتفتح'); });
$('#openClaude').addEventListener('click', async () => {
  await api('/api/claude', { method: 'POST' });
  toast('افتح Scheduled ← lectures-unsorted-autopilot ← Run now');
});
$('#pilot').addEventListener('change', async (e) => {
  const paused = !e.target.checked;
  await api('/api/autopilot', { method: 'POST', body: JSON.stringify({ paused }) });
  toast(paused ? 'الطيار الآلي وقف' : 'الطيار الآلي رجع يشتغل'); load();
});

// ---------- uploads ----------
function fillDest() {
  const sel = $('#dest'); if (sel.options.length) return;
  const opts = ['Not summarized', ...S.categories.filter((c) => !/(^|\/)Book$/.test(c))];
  sel.innerHTML = opts.map((c) => `<option value="${esc(c)}">${c === 'Not summarized' ? 'مش عارف المادة (هيتحدد لوحده)' : esc(c.replace(/ \//g, ' / '))}</option>`).join('');
}
function upload(file) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${esc(file.name)}</span><span class="bar-p"><i></i></span>`;
  $('#uploads').prepend(li);
  return new Promise((res) => {
    const x = new XMLHttpRequest();
    x.open('POST', API + `/api/upload?dest=${encodeURIComponent($('#dest').value)}&name=${encodeURIComponent(file.name)}`);
    x.upload.onprogress = (e) => { $('i', li).style.width = (e.loaded / e.total) * 100 + '%'; };
    x.onload = () => { $('i', li).style.width = '100%'; li.lastElementChild.replaceWith(Object.assign(document.createElement('small'), { textContent: x.status === 200 ? 'اتحط ✓' : 'فشل' })); res(); };
    x.onerror = () => res();
    x.send(file);
  });
}
async function uploadAll(files) {
  for (const f of files) await upload(f);
  toast('الملفات اتحطت في unsorted. دوس «ارفع على الدرايف»'); load();
}
$('#files').addEventListener('change', (e) => uploadAll([...e.target.files]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadAll([...e.dataTransfer.files]));

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
  toast('اتحفظ، ونسخة قديمة اتشالت في logs'); loadRules(); load();
});

load(); loadRules().catch(() => {});
setInterval(() => { if (!streaming && !document.hidden && !$('#drawer').open) load(); }, 20000);
