// Lectures control room: a local-only dashboard + control API for the lectures automation kit.
// Run: node ~/.lectures-automation/dashboard/server.mjs   →  http://localhost:4545
// Listens on 127.0.0.1 only, accepts requests only from its own page, and works inside ~/Desktop/محاضرات.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4545);
const HOME = os.homedir();
const KIT = path.join(HOME, '.lectures-automation');
const ROOT = path.join(HOME, 'Desktop', 'محاضرات');
const UNSORTED = path.join(ROOT, 'unsorted');
const LOGS = path.join(KIT, 'logs');
const PAUSED = path.join(KIT, 'PAUSED');
const QUEUE = path.join(KIT, 'queue.json');
const SCHEDULE = [9, 15, 21]; // hours of the 3 daily autopilot runs (set in the Claude app's scheduled task)
const RULES = {
  runbook: path.join(KIT, 'RUNBOOK.md'),
  thawabit: path.join(ROOT, 'NotebookLM - الثوابت.md'),
};
const ENV = { ...process.env, PATH: `${HOME}/.local/bin:${HOME}/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
fs.mkdirSync(LOGS, { recursive: true });

// ---------- scanning ----------
const OUT = [
  ['pr', /\(سلايدز للمقدم\) - English\.pdf$/],
  ['ar', /\(سلايدز\) - عربي( - الجزء .*)?\.pdf$/],
  ['en', /\(سلايدز\) - English\.pdf$/],
  ['sl', /\(سلايدز\)( - الجزء .*)?\.pdf$|( - ملخص| - أهم النقاط)\.pdf$/],
  ['tr', / - ترجمة\.pdf$/],
  ['mm', / - خريطة ذهنية\.pdf$/],
];
const SRC_EXT = new Set(['.pdf', '.pptx', '.ppt', '.docx', '.doc']);
const VID_EXT = new Set(['.mp4', '.mov', '.mkv']);
const AR = /[؀-ۿ]/;
const outKind = (n) => (OUT.find(([, re]) => re.test(n)) || [])[0];
const cats = () => new Set(fs.readFileSync(path.join(KIT, 'categories.txt'), 'utf8').split('\n').filter(Boolean));
const coll = new Intl.Collator('ar', { numeric: true });

function scan() {
  const CATS = cats();
  const items = [];
  let pdfs = 0, bytes = 0;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
        bytes += st.size; if (e.name.toLowerCase().endsWith('.pdf')) pdfs++;
      }
    }
    const rel = path.relative(ROOT, dir);
    if (!rel) return;
    const outputs = {}, sources = [], videos = [];
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      const k = outKind(f.name);
      if (k) (outputs[k] ||= []).push(f);
      else if (SRC_EXT.has(ext)) sources.push(f);
      else if (VID_EXT.has(ext)) videos.push(f);
    }
    if (!sources.length && !Object.keys(outputs).length) return;
    const parts = rel.split(path.sep);
    const inUnsorted = parts[0] === 'unsorted';
    const key = (inUnsorted ? parts.slice(1) : parts).join('/');
    const sub = inUnsorted ? (['Not summarized', 'summarized'].includes(parts[1]) ? parts[2] || parts[1] : parts[1] || 'unsorted') : parts[0];
    const last = parts[parts.length - 1];
    const lecture = !CATS.has(key) && last !== 'Book' && parts.length > (inUnsorted ? 2 : 1);
    const main = sources.find((s) => last.trim().startsWith(path.parse(s.name).name.trim()) || path.parse(s.name).name.trim().startsWith(last.trim())) || sources[0];
    const lang = main ? (AR.test(main.name) ? 'ar' : 'en') : 'en';
    const need = ['sl', 'tr', 'mm', ...(lang === 'en' ? ['ar'] : [])];
    const missing = lecture ? need.filter((k) => !outputs[k]) : [];
    items.push({
      id: Buffer.from(rel).toString('base64url'), rel, name: last.trim(), subject: (sub || '').trim(), inUnsorted, lecture, lang,
      sources, videos, outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.map((f) => f.name)])),
      missing, need, mtime: Math.max(0, ...files.map((f) => f.mtime)),
    });
  })(ROOT);
  items.sort((a, b) => coll.compare(a.rel, b.rel));
  return { items, pdfs, bytes };
}

function readJSONL(f, n = 40) {
  try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}
const readQueue = () => { try { return JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch { return []; } };
const writeQueue = (q) => fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
const logAction = (o) => fs.appendFileSync(path.join(LOGS, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

// ---------- jobs (whitelisted commands only) ----------
const ACTIONS = {
  pull: { label: 'سحب الجديد من الدرايف وترتيبه', cmd: ['sh', [path.join(KIT, 'inbox.sh')]] },
  push: { label: 'رفع الجديد على الدرايف', cmd: ['sh', [path.join(KIT, 'push.sh')]] },
  check: { label: 'فحص تطابق الدرايف', cmd: ['rclone', ['check', UNSORTED, 'gdfull:1st Physics Group (B)/unsorted', '--one-way', '--exclude', '.DS_Store']] },
  checkall: { label: 'فحص تطابق كل المحاضرات', cmd: ['rclone', ['check', ROOT, 'gdfull:1st Physics Group (B)', '--one-way', '--exclude', '.DS_Store', '--exclude', '*.md']] },
};
let job = null; // { id, action, lines[], done, code, clients:Set }

function startJob(action) {
  if (job && !job.done) return { error: 'في عملية شغالة دلوقتي، استنى لما تخلص' };
  const a = ACTIONS[action];
  if (!a) return { error: 'أمر مش معروف' };
  job = { id: randomUUID(), action, label: a.label, lines: [], done: false, code: null, started: Date.now(), clients: new Set() };
  const j = job;
  const push = (line) => { j.lines.push(line); for (const c of j.clients) c.write(`data: ${JSON.stringify({ line })}\n\n`); };
  const p = spawn(a.cmd[0], a.cmd[1], { env: ENV, detached: true });
  j.proc = p;
  const feed = (buf) => buf.toString().split('\n').map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d (NOTICE|INFO|ERROR) ?:? ?/, '')).filter((l) => l.trim() && !/client_id/.test(l)).forEach(push);
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  p.on('error', (e) => push('خطأ: ' + e.message));
  p.on('close', (code) => {
    j.done = true; j.code = j.cancelled ? 'cancelled' : code;
    logAction({ type: 'job', action, label: a.label, code: j.code, secs: Math.round((Date.now() - j.started) / 1000), tail: j.lines.slice(-6) });
    for (const c of j.clients) { c.write(`event: end\ndata: ${JSON.stringify({ code: j.code })}\n\n`); c.end(); }
  });
  return { id: j.id };
}
function cancelJob() {
  if (!job || job.done) return false;
  job.cancelled = true;
  try { process.kill(-job.proc.pid, 'SIGTERM'); } catch { try { job.proc.kill('SIGTERM'); } catch {} }
  return true;
}

// ---------- books: split slide parts (plan in books-plan.tsv) ----------
function books() {
  const rows = fs.readFileSync(path.join(KIT, 'books-plan.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
  const map = new Map();
  for (const [key, folder, source, base, lang, part, label, cover] of rows) {
    if (!map.has(key)) map.set(key, { key, folder, source, base, lang, parts: [] });
    const dir = path.join(ROOT, folder);
    const name = (ar) => `${base} - ملخص وأهم النقاط (سلايدز)${ar ? ' - عربي' : ''}${part !== '0' ? ` - الجزء ${part} (${label})` : ''}.pdf`;
    const has = (n) => fs.existsSync(path.join(dir, n));
    map.get(key).parts.push({ part: Number(part), label, cover, src: has(name(false)), ar: lang === 'en' ? has(name(true)) : null });
  }
  return [...map.values()].map((b) => {
    const need = b.parts.reduce((n, p) => n + 1 + (p.ar === null ? 0 : 1), 0);
    const done = b.parts.reduce((n, p) => n + (p.src ? 1 : 0) + (p.ar ? 1 : 0), 0);
    return { ...b, subject: b.folder.split('/')[0].trim(), need, done };
  });
}

// ---------- health: is Drive reachable through rclone? (cached 10 min) ----------
let health = { at: 0 };
function checkHealth(force) {
  if (!force && Date.now() - health.at < 600e3) return health;
  health = { ...health, at: Date.now(), checking: true };
  const p = spawn('rclone', ['about', 'gdfull:', '--json'], { env: ENV });
  let out = '', err = '';
  const t = setTimeout(() => p.kill('SIGTERM'), 25e3);
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => {
    clearTimeout(t);
    let about = null; try { about = JSON.parse(out); } catch {}
    health = {
      at: Date.now(), checking: false, drive: code === 0 && !!about,
      usedGB: about ? +(about.used / 2 ** 30).toFixed(1) : null, freeGB: about ? Math.round(about.free / 2 ** 30) : null,
      sharedKey: /shared Google Drive client_id/.test(err), rateLimited: /rateLimitExceeded/.test(err),
    };
  });
  return health;
}
checkHealth(true);

// ---------- helpers ----------
function safePath(rel) {
  const p = path.resolve(ROOT, rel || '');
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('المسار برا فولدر المحاضرات');
  return p;
}
function body(req, limit = 2e6) {
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { rej(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks)));
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function nextRun(now = new Date()) {
  for (const h of SCHEDULE) { const d = new Date(now); d.setHours(h, 0, 0, 0); if (d > now) return d; }
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(SCHEDULE[0], 0, 0, 0); return d;
}

// ---------- server ----------
const okHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// the hosted copy of the page (GitHub Pages) may talk to this server, but only from this Mac's own browser
const HOSTED = 'https://morfi28i.github.io';
http.createServer(async (req, res) => {
  try {
    if (!okHosts.has(req.headers.host)) return send(res, 403, { error: 'host' });
    const origin = req.headers.origin;
    if (origin === HOSTED) {
      res.setHeader('access-control-allow-origin', HOSTED);
      res.setHeader('vary', 'origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, PUT, DELETE',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-private-network': 'true',
          'access-control-max-age': '600',
        });
        return res.end();
      }
    } else if (req.method !== 'GET' && origin && !okHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'origin' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const r = u.pathname;

    if (req.method === 'GET' && (r === '/' || /^\/[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(r))) {
      const f = path.join(KIT, 'dashboard', 'docs', r === '/' ? 'index.html' : r.slice(1));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(f)], 'cache-control': 'no-cache' });
      return fs.createReadStream(f).pipe(res);
    }
    if (r === '/api/books') return send(res, 200, books());
    if (r === '/api/health') return send(res, 200, checkHealth(u.searchParams.has('force')));
    if (r === '/api/job/cancel' && req.method === 'POST') return send(res, 200, { cancelled: cancelJob() });
    if (r === '/api/state') {
      const s = scan();
      return send(res, 200, {
        ...s, paused: fs.existsSync(PAUSED), schedule: SCHEDULE, nextRun: nextRun().toISOString(), now: new Date().toISOString(),
        runs: readJSONL(path.join(LOGS, 'runs.jsonl'), 20), actions: readJSONL(path.join(LOGS, 'actions.jsonl'), 30),
        queue: readQueue(), categories: [...cats()],
        job: job && { id: job.id, action: job.action, label: job.label, done: job.done, code: job.code, lines: job.lines.slice(-200) },
      });
    }
    if (r.startsWith('/api/run/') && req.method === 'POST') {
      const out = startJob(r.split('/').pop());
      return send(res, out.error ? 409 : 200, out);
    }
    if (r === '/api/job/stream') {
      if (!job) return send(res, 404, { error: 'no job' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
      if (job.done) { res.write(`event: end\ndata: ${JSON.stringify({ code: job.code })}\n\n`); return res.end(); }
      job.clients.add(res); const j = job; req.on('close', () => j.clients.delete(res));
      return;
    }
    if (r === '/api/autopilot' && req.method === 'POST') {
      const { paused } = JSON.parse(await body(req));
      if (paused) fs.writeFileSync(PAUSED, new Date().toISOString()); else fs.rmSync(PAUSED, { force: true });
      logAction({ type: 'autopilot', paused: !!paused });
      return send(res, 200, { paused: !!paused });
    }
    if (r === '/api/open' && req.method === 'POST') {
      const { rel, reveal } = JSON.parse(await body(req));
      const p = safePath(rel);
      if (!fs.existsSync(p)) return send(res, 404, { error: 'مش موجود' });
      spawn('open', reveal ? ['-R', p] : [p], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true });
    }
    if (r === '/api/claude' && req.method === 'POST') {
      spawn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true });
    }
    if (r === '/api/file') {
      const p = safePath(u.searchParams.get('rel'));
      const ext = path.extname(p).toLowerCase();
      if (!MIME[ext] || !fs.existsSync(p)) return send(res, 404, { error: 'مش موجود' });
      res.writeHead(200, { 'content-type': MIME[ext], 'content-length': fs.statSync(p).size });
      return fs.createReadStream(p).pipe(res);
    }
    if (r.startsWith('/api/rules/')) {
      const f = RULES[r.split('/').pop()];
      if (!f) return send(res, 404, { error: 'مش معروف' });
      if (req.method === 'GET') return send(res, 200, { text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs });
      if (req.method === 'PUT') {
        const { text } = JSON.parse(await body(req));
        fs.copyFileSync(f, path.join(LOGS, path.basename(f) + '.' + Date.now() + '.bak'));
        fs.writeFileSync(f, text);
        logAction({ type: 'rules', file: path.basename(f) });
        return send(res, 200, { ok: true });
      }
    }
    if (r === '/api/upload' && req.method === 'POST') {
      const dest = u.searchParams.get('dest') || '';
      const name = path.basename(u.searchParams.get('name') || '');
      if (!name || name.startsWith('.')) return send(res, 400, { error: 'اسم ملف مش صالح' });
      const dir = safePath(path.join('unsorted', dest));
      if (!dir.startsWith(UNSORTED)) return send(res, 400, { error: 'الرفع جوه unsorted بس' });
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      if (fs.existsSync(target)) { const pp = path.parse(name); target = path.join(dir, `${pp.name} (${Date.now()})${pp.ext}`); }
      const data = await body(req, 600e6);
      fs.writeFileSync(target, data);
      logAction({ type: 'upload', file: path.relative(ROOT, target), size: data.length });
      return send(res, 200, { saved: path.relative(ROOT, target) });
    }
    if (r === '/api/queue' && req.method === 'POST') {
      const { rel, note } = JSON.parse(await body(req));
      safePath(rel);
      const q = readQueue();
      q.push({ id: randomUUID(), rel, note: String(note || '').slice(0, 500), at: new Date().toISOString(), status: 'waiting' });
      writeQueue(q); logAction({ type: 'queue', rel });
      return send(res, 200, { ok: true });
    }
    if (r.startsWith('/api/queue/') && req.method === 'DELETE') {
      const id = r.split('/').pop();
      writeQueue(readQueue().filter((x) => x.id !== id));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Lectures control room → http://localhost:${PORT}`));
