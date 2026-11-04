// Lectures control room: a local-only dashboard + control API for the lectures automation kit.
// Run: node ~/.lectures-automation/dashboard/server.mjs   →  http://localhost:4545
// Listens on 127.0.0.1 only, accepts requests only from its own page, and works inside ~/Desktop/محاضرات.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { load as settings, save as saveSettings, SCHEMA, GROUPS } from '../settings.mjs';

const PORT = Number(process.env.PORT || 4545);
const HOME = os.homedir();
const KIT = path.join(HOME, '.lectures-automation');
const ROOT = path.join(HOME, 'Desktop', 'محاضرات');
const UNSORTED = path.join(ROOT, 'unsorted');
const LOGS = path.join(KIT, 'logs');
const PAUSED = path.join(KIT, 'PAUSED');
const QUEUE = path.join(KIT, 'queue.json');
const REMOTE = 'gdfull:1st Physics Group (B)';
const AUTOSYNC = path.join(KIT, 'AUTOSYNC');
const ACCOUNTS = path.join(KIT, 'accounts.json');
const DOWNLOADS = path.join(HOME, 'Downloads');
// the worker (worker/worker.mjs, launchd com.morfi.lectures-worker) makes the outputs on its own; its schedule lives in its config
const WORKER = path.join(KIT, 'worker');
const WTASKS = path.join(WORKER, 'tasks.json'), WSTATUS = path.join(WORKER, 'status.json');
const jread = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const jwrite = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const schedule = () => { const h = settings()['worker.schedule']; return h.length ? h : [9, 15, 21]; };
const OUTS = ['SRC', 'AR', 'EN', 'PR']; // slides only (Morfi: no summary, no mind map)
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
    const lecture = !CATS.has(key) && last !== 'Book' && parts.length > (inUnsorted ? 2 : 1) && !rel.includes('روابط وملفات عامة');
    const main = sources.find((s) => last.trim().startsWith(path.parse(s.name).name.trim()) || path.parse(s.name).name.trim().startsWith(last.trim())) || sources[0];
    const lang = main ? (AR.test(main.name) ? 'ar' : 'en') : 'en';
    const need = ['sl', ...(lang === 'en' ? ['ar'] : [])]; // no translation / mind map since 2026-11-03
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
function rotate(f) {
  try { if (fs.statSync(f).size > settings()['safe.logMB'] * 1e6) fs.renameSync(f, path.join(HOME, '.Trash', `${path.basename(f)}.${Date.now()}`)); } catch {}
}
const logAction = (o) => rotate(path.join(LOGS, 'actions.jsonl')) || fs.appendFileSync(path.join(LOGS, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

// ---------- jobs (whitelisted commands only) ----------
const ACTIONS = {
  pull: { label: 'سحب الجديد من الدرايف وترتيبه', cmd: ['sh', [path.join(KIT, 'inbox.sh')]] },
  // same job as push.sh (copy unsorted up, then check), run directly so the speed guard can see rclone's stats
  push: { label: 'رفع الجديد على الدرايف', transfer: true, cmd: (mode) => ['sh', ['-c', 'L="$1"; R="$2"; shift 2; rclone copy "$L" "$R" "$@"; echo "— فحص —"; rclone check "$L" "$R" --one-way --size-only --exclude .DS_Store 2>&1 | grep -E "differences|ERROR"', 'sh', UNSORTED, `${REMOTE}/unsorted`, ...tune(upFlags(), mode), '--drive-chunk-size', mode === 'chunks' ? '64M' : '16M', '-v', '--stats-one-line', '--stats', '15s']] },
  check: { label: 'فحص تطابق الدرايف', cmd: ['rclone', ['check', UNSORTED, 'gdfull:1st Physics Group (B)/unsorted', '--one-way', '--exclude', '.DS_Store']] },
  checkall: { label: 'فحص تطابق كل المحاضرات', cmd: ['rclone', ['check', ROOT, 'gdfull:1st Physics Group (B)', '--one-way', '--exclude', '.DS_Store', '--exclude', '*.md']] },
  runnow: { label: 'تشغيل الخطوات دلوقتي', drive: true, cmd: ['sh', ['-c', `sh "${path.join(KIT, 'inbox.sh')}"; echo "— رفع —"; sh "${path.join(KIT, 'push.sh')}"; echo "خلص"`]] },
  pushall: { label: 'رفع كل الجديد من الماك على الدرايف', drive: true, transfer: true, cmd: (mode) => ['rclone', ['copy', ROOT, REMOTE, ...tune(upFlags(), mode), ...chunk(mode), '--low-level-retries', '30', '-v', '--stats-one-line', '--stats', '15s']] },
  pullall: { label: 'تنزيل الجديد من الدرايف على الماك', drive: true, transfer: true, cmd: (mode) => ['rclone', ['copy', REMOTE, ROOT, '--ignore-existing', ...excludes(), ...tune(['--tpslimit', String(settings()['drive.tpslimit'] * 2), '--transfers', '4'], mode), '-v', '--stats-one-line', '--stats', '15s']] },
  finish: { label: 'نقل اللي خلص من unsorted لفولدر المادة', drive: true, cmd: ['sh', [path.join(KIT, 'finish.sh')]] },
  // read only: lists files that share a name inside the same Drive folder, changes nothing
  dupes: { label: 'دوّر على ملفات مكررة على الدرايف', cmd: ['rclone', ['dedupe', '--dedupe-mode', 'list', REMOTE, '--tpslimit', '2']] }, // read only
};
// commands that write to Drive or the Mac's lecture folders; two of them at once can make duplicate files on Drive
// rclone flags from the «الدرايف والمزامنة» settings
const excludes = () => settings()['drive.exclude'].flatMap((x) => ['--exclude', x]);
const upFlags = () => { const S = settings(); return [...(S['drive.newerWins'] ? ['--update'] : []), ...excludes(), '--tpslimit', String(S['drive.tpslimit']), '--transfers', String(S['drive.transfers']), '--retries', String(S['drive.retries'])]; };
// speed-guard variants of a transfer: normal, gentle (one file at a time, slow request rate), chunks (bigger upload pieces)
function tune(args, mode) {
  const a = [...args], set = (flag, v) => { const i = a.indexOf(flag); if (i >= 0) a[i + 1] = v; else a.push(flag, v); };
  if (mode === 'gentle') { set('--transfers', '1'); set('--tpslimit', '1'); set('--checkers', '2'); }
  if (mode === 'chunks') set('--transfers', '2');
  return a;
}
const chunk = (mode) => (mode === 'chunks' ? ['--drive-chunk-size', '64M'] : []);
const WRITES = new Set(['finish', 'pull', 'push', 'runnow', 'pushall', 'pullall', 'up', 'down']);
// rclone / download watchers running outside this dashboard (Claude's terminal, an orphan from before a restart)
function procs() {
  let out = '';
  try { out = execFileSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 8e6, env: { ...ENV, LC_ALL: 'en_US.UTF-8' } }); } catch {}
  const own = job && !job.done ? job.proc.pid : -1;
  const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, pgid, cmd]) => ({ pid: +pid, pgid: +pgid, cmd }));
  const rclone = rows.filter((r) => /^(\S*\/)?rclone\s+(copy|copyto|sync|move|moveto|deletefile|delete|purge|dedupe)\b/.test(r.cmd) && !/--dedupe-mode list/.test(r.cmd) && r.pgid !== own);
  const watchers = rows.filter((r) => /\b(grab|dlmap|dl|next)\.sh\b/.test(r.cmd) && /^(\/bin\/)?sh\s/.test(r.cmd));
  return { rclone: rclone.map((r) => ({ pid: r.pid, cmd: r.cmd.replace(/^\S*rclone\s+/, '').slice(0, 160) })), watchers: watchers.map((r) => ({ pid: r.pid, cmd: r.cmd.replace(/^\S+\s+/, '').replace(HOME, '~').slice(0, 160) })) };
}
// broken downloads: empty files or half-finished browser downloads older than 10 minutes
function badDownloads() {
  const out = [];
  let ents = []; try { ents = fs.readdirSync(DOWNLOADS, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const p = path.join(DOWNLOADS, e.name); const st = fs.statSync(p);
    const partial = /\.(crdownload|download|part)$/i.test(e.name);
    if ((st.size === 0 || partial) && Date.now() - st.mtimeMs > settings()['safe.badDownloadMinutes'] * 60e3) out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}
// NotebookLM accounts and when each one hit its limit
const DEFAULT_ACCOUNTS = [
  { n: 0, email: 'sdyqs0437', note: 'صاحب الدرايف' }, { n: 1, email: 'essamsidek123' },
  { n: 2, email: 'capital.science.faculty' }, { n: 3, email: 'ahmadsidek220' },
];
function accounts() {
  let list; try { list = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch { list = DEFAULT_ACCOUNTS; fs.writeFileSync(ACCOUNTS, JSON.stringify(list, null, 2)); }
  return list.map((a) => {
    const freeAt = a.limitedAt ? new Date(Date.parse(a.limitedAt) + settings()['acc.limitHours'] * 3600e3) : null;
    return { ...a, limited: !!freeAt && freeAt > new Date(), freeAt: freeAt && freeAt > new Date() ? freeAt.toISOString() : null };
  });
}
// a daily copy of the small state files (queue, plans, accounts, rules), last 14 days
function backup() {
  const dir = path.join(LOGS, 'backups', new Date().toISOString().slice(0, 10));
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(KIT)) if (/\.(json|tsv|txt|md)$/.test(f)) fs.copyFileSync(path.join(KIT, f), path.join(dir, f));
  if (fs.existsSync(RULES.thawabit)) fs.copyFileSync(RULES.thawabit, path.join(dir, path.basename(RULES.thawabit)));
  const old = fs.readdirSync(path.dirname(dir)).sort().slice(0, -settings()['safe.backupDays']);
  for (const d of old) fs.renameSync(path.join(path.dirname(dir), d), path.join(HOME, '.Trash', `lectures-backup-${d}-${Date.now()}`));
}
try { backup(); } catch (e) { console.error('backup', e.message); }
setInterval(() => { try { backup(); } catch {} }, 3600e3);
const REMOTE_OF = (rel) => (rel ? `${REMOTE}/${rel}` : REMOTE);
let job = null; // { id, action, lines[], done, code, clients:Set }

let waiting = []; // commands asked for while another one runs; they start one after another
function startJob(action, custom) {
  if (job && !job.done) {
    if (waiting.length >= settings()['safe.queueMax']) return { error: 'الطابور مليان، استنى شوية' };
    if (!custom && (job.action === action || waiting.some((w) => w.action === action))) return { error: 'الأمر ده شغال أو مستني في الطابور بالفعل' };
    const w = { id: randomUUID(), action, custom, label: (custom || ACTIONS[action] || {}).label, at: Date.now() };
    if (!w.label) return { error: 'أمر مش معروف' };
    waiting.push(w); return { queued: true, id: w.id, position: waiting.length };
  }
  const a = custom || ACTIONS[action];
  if (!a) return { error: 'أمر مش معروف' };
  if (WRITES.has(action) && settings()['safe.guardRclone']) {
    const busy = procs().rclone;
    if (busy.length) return { error: `فيه rclone شغال برا اللوحة (${busy.length})، استنى لما يخلص عشان الملفات متتكررش على الدرايف`, busy };
  }
  job = { id: randomUUID(), action, label: a.label, lines: [], done: false, code: null, started: Date.now(), clients: new Set(), fixes: 0 };
  const j = job;
  const push = (line) => { j.lines.push(line); if (j.lines.length > 2000) j.lines.splice(0, 500); for (const c of j.clients) c.write(`data: ${JSON.stringify({ line })}\n\n`); };
  const finish = (code) => {
    clearInterval(j.guard);
    j.done = true; j.code = j.cancelled ? 'cancelled' : code;
    // the copy+check commands end with exit 0 even when the check finds files still missing on Drive
    if (j.code === 0 && j.lines.some((l) => /\b[1-9]\d* differences found|file not in Google drive/.test(l))) j.code = 'missing';
    if (a.drive || a.transfer) setTimeout(() => driveIndex(true), 1500);
    logAction({ type: 'job', action, label: a.label, code: j.code, fixes: j.fixes, secs: Math.round((Date.now() - j.started) / 1000), tail: j.lines.slice(-6) });
    for (const c of j.clients) { c.write(`event: end\ndata: ${JSON.stringify({ code: j.code })}\n\n`); c.end(); }
    // next waiting command (a cancelled job does not start the rest by surprise)
    if (!j.cancelled) setTimeout(() => {
      const w = waiting.shift(); if (!w) return;
      const out = startJob(w.action, w.custom);
      if (out.error) logAction({ type: 'job-skipped', action: w.action, label: w.label, why: out.error });
    }, 2000);
  };
  const run = (mode) => {
    const [bin, args] = typeof a.cmd === 'function' ? a.cmd(mode) : a.cmd;
    const p = spawn(bin, args, { env: ENV, detached: true });
    j.proc = p; j.mode = mode; j.slowSince = null;
    const feed = (buf) => buf.toString().split('\n').map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d (NOTICE|INFO|ERROR|DEBUG)\s*:?\s*/, '').replace(/^:\s*/, '')).filter((l) => l.trim() && !/client_id|modification time|transaction limiter|Waiting for checks/.test(l)).forEach((l) => { watchSpeed(j, l); push(l); });
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', (e) => push('خطأ: ' + e.message));
    p.on('close', (code) => {
      if (j.fixing) { j.fixing = false; const next = j.nextMode; setTimeout(async () => { if (j.cancelled) return finish('cancelled'); await j.beforeNext?.(); if (j.cancelled) return finish('cancelled'); run(next); }, 500); return; }
      finish(code);
    });
  };
  if (a.transfer) j.guard = setInterval(() => speedGuard(j, push), 15e3);
  run('normal');
  return { id: j.id };
}
// ---------- speed guard: a transfer that stays very slow gets fixed step by step ----------
// rclone's stats line looks like "12.3 MiB / 40 MiB, 30%, 45.6 KiB/s, ETA 10m"
const UNIT = { B: 1 / 1024, KiB: 1, MiB: 1024, GiB: 1048576 };
function watchSpeed(j, line) {
  const m = line.match(/,\s*(\d+)%,\s*([\d.]+)\s*(B|KiB|MiB|GiB)\/s/);
  if (m) {
    const kbs = Number(m[2]) * UNIT[m[3]], pct = Number(m[1]); j.kbs = kbs;
    if (pct >= 100 || kbs >= settings()['drive.slowKBs']) j.slowSince = null; else j.slowSince ||= Date.now();
  } else if (/Copied|Updated|— فحص —/.test(line)) j.slowSince = null; // a finished file is progress
}
// what each fix does, in order; Morfi sees every step in the console
const FIXES = [
  ['normal', 'بعيد تشغيل الرفع من مكانه (rclone بيبدأ من جديد ومبيعيدش اللي خلص)'],
  ['gentle', 'بهدّي الطلبات: ملف واحد في المرة وطلب واحد في الثانية، عشان Google ترجع تدينا سرعة'],
  ['chunks', 'بكبّر حتة الرفع لـ 64MB عشان الملفات الكبيرة تمشي أسرع'],
  ['cooldown', 'Google بتبطّأنا: هريّح شوية وأرجع أكمّل'],
  ['gentle', 'آخر محاولة: هادي وبطيء بس مستمر'],
];
async function internetOk() { try { await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(6000) }); return true; } catch { return false; } }
async function speedGuard(j, push) {
  const S = settings();
  if (!S['drive.speedGuard'] || j.done || j.fixing || !j.slowSince || Date.now() - j.slowSince < S['drive.slowMinutes'] * 60e3) return;
  j.slowSince = null;
  if (!(await internetOk())) {
    push('⚠ النت نفسه واقع أو بطيء. مش هغيّر حاجة، هستنى النت يرجع والرفع هيكمّل لوحده.');
    return;
  }
  if (j.fixes >= S['drive.maxFixes']) {
    if (!j.toldSlow) { j.toldSlow = true; push('⚠ جرّبت كل الحلول والسرعة لسه واطية. الرفع شغال وهيكمّل، وبعتلك إشعار.'); notifyPhone('slow', 'الرفع بطيء قوي', `${j.label}: جرّبت ${j.fixes} حلول والسرعة لسه ${Math.round(j.kbs || 0)} KB/s`); }
    return;
  }
  const [mode, text] = FIXES[Math.min(j.fixes, FIXES.length - 1)];
  j.fixes++;
  push(`⚡ السرعة وقعت (${Math.round(j.kbs || 0)} KB/s لمدة ${S['drive.slowMinutes']} دقايق). الحل ${j.fixes}: ${text}`);
  logAction({ type: 'speed-fix', action: j.action, label: j.label, step: j.fixes, mode, kbs: Math.round(j.kbs || 0) });
  j.nextMode = mode === 'cooldown' ? 'gentle' : mode;
  j.beforeNext = mode === 'cooldown' ? () => new Promise((r) => setTimeout(r, S['drive.cooldownMinutes'] * 60e3)) : null;
  j.fixing = true;
  try { process.kill(-j.proc.pid, 'SIGTERM'); } catch { try { j.proc.kill('SIGTERM'); } catch {} }
}
// phone notification through ntfy (same topic and events as the worker)
async function notifyPhone(event, title, body) {
  const S = settings(), topic = S['notify.ntfy'];
  if (!topic || !S['notify.events'].includes(event) || (S['notify.quiet'] || []).includes(new Date().getHours())) return;
  try { await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { 'X-Title': 'Lectures' }, body: `${title}: ${body}` }); } catch {}
}

// ---------- Drive mirror: what is on Drive vs on the Mac (cached, refreshed after Drive jobs) ----------
let drive = { at: 0, files: null, dirs: {}, indexing: false };
function driveIndex(force) {
  if (drive.indexing || (!force && drive.files && Date.now() - drive.at < settings()['drive.cacheMinutes'] * 60e3)) return drive;
  drive.indexing = true;
  const p = spawn('rclone', ['lsjson', '-R', REMOTE, '--fast-list', '--no-mimetype'], { env: ENV });
  let out = '';
  const t = setTimeout(() => p.kill('SIGTERM'), 180e3);
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => {
    clearTimeout(t);
    try {
      const list = JSON.parse(out), files = {}, dirs = {};
      for (const f of list) { if (f.IsDir) dirs[f.Path] = f.ID; else if (!/(^|\/)\.DS_Store$/.test(f.Path)) files[f.Path] = { size: f.Size, id: f.ID }; }
      drive = { at: Date.now(), files, dirs, indexing: false };
    } catch { drive.indexing = false; drive.error = 'تعذّر قراءة الدرايف'; }
  });
  return drive;
}
function localFiles() {
  const out = {};
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[path.relative(ROOT, p)] = fs.statSync(p).size; }
  })(ROOT);
  return out;
}
function syncState() {
  driveIndex();
  const local = localFiles(), status = {}, lists = { local: [], drive: [], diff: [] };
  let both = 0;
  if (drive.files) {
    for (const [rel, size] of Object.entries(local)) {
      const d = drive.files[rel];
      if (!d) { status[rel] = 'local'; lists.local.push(rel); }
      else if (d.size !== size && !rel.endsWith('.md')) { status[rel] = 'diff'; lists.diff.push(rel); }
      else { status[rel] = 'both'; both++; }
    }
    for (const rel of Object.keys(drive.files)) if (!(rel in local)) { status[rel] = 'drive'; lists.drive.push(rel); }
  }
  const ids = {}; if (drive.files) for (const [rel, f] of Object.entries(drive.files)) ids[rel] = f.id;
  return { at: drive.at, indexing: drive.indexing, ready: !!drive.files, error: drive.error, counts: { both, local: lists.local.length, drive: lists.drive.length, diff: lists.diff.length }, lists, status, ids, dirs: drive.dirs, auto: fs.existsSync(AUTOSYNC) };
}
// auto sync: every drive.autosyncMinutes, push anything that exists only on the Mac (when switched on)
let lastAutosync = Date.now();
setInterval(() => {
  if (Date.now() - lastAutosync < settings()['drive.autosyncMinutes'] * 60e3) return;
  lastAutosync = Date.now();
  if (!fs.existsSync(AUTOSYNC) || (job && !job.done) || !drive.files || procs().rclone.length) return;
  const s = syncState();
  if (s.counts.local || s.counts.diff) { logAction({ type: 'autosync', files: s.counts.local + s.counts.diff }); startJob('pushall'); }
}, 60e3);
driveIndex(true);

function cancelJob() {
  if (!job || job.done) return false;
  job.cancelled = true; job.fixing = false;
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
  for (const h of schedule()) { const d = new Date(now); d.setHours(h, 0, 0, 0); if (d > now) return d; }
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(schedule()[0], 0, 0, 0); return d;
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
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
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
    if (r === '/api/sync') { if (u.searchParams.has('rescan')) driveIndex(true); return send(res, 200, syncState()); }
    if (r === '/api/sync/folder' && req.method === 'POST') {
      const { rel, dir } = JSON.parse(await body(req));
      const p = safePath(rel); const relN = path.relative(ROOT, p);
      const name = relN.split(path.sep).pop() || 'كل الفولدرات';
      const STATS = ['-v', '--stats-one-line', '--stats', '15s'];
      const cmd = (mode) => dir === 'down'
        ? ['rclone', ['copy', REMOTE_OF(relN), p, '--ignore-existing', ...excludes(), ...tune([], mode), ...STATS]]
        : ['rclone', ['copy', p, REMOTE_OF(relN), ...tune(upFlags(), mode), ...chunk(mode), ...STATS]];
      const out = startJob(dir === 'down' ? 'down' : 'up', { label: (dir === 'down' ? 'تنزيل ' : 'رفع ') + name, drive: true, transfer: true, cmd });
      return send(res, out.error ? 409 : 200, out);
    }
    if (r === '/api/sync/file' && req.method === 'POST') {
      const { rel, dir } = JSON.parse(await body(req));
      const p = safePath(rel); const relN = path.relative(ROOT, p);
      const STATS = ['-v', '--stats-one-line', '--stats', '15s'];
      const cmd = (mode) => dir === 'down' ? ['rclone', ['copyto', REMOTE_OF(relN), p, ...tune([], mode), ...STATS]] : ['rclone', ['copyto', p, REMOTE_OF(relN), ...tune(upFlags(), mode), ...chunk(mode), ...STATS]];
      const out = startJob(dir === 'down' ? 'down' : 'up', { label: (dir === 'down' ? 'تنزيل ' : 'رفع ') + path.basename(relN), drive: true, transfer: true, cmd });
      return send(res, out.error ? 409 : 200, out);
    }
    if (r === '/api/autosync' && req.method === 'POST') {
      const { on } = JSON.parse(await body(req));
      if (on) fs.writeFileSync(AUTOSYNC, new Date().toISOString()); else fs.rmSync(AUTOSYNC, { force: true });
      logAction({ type: 'autosync-set', on: !!on }); return send(res, 200, { on: !!on });
    }
    if (r === '/api/health') return send(res, 200, checkHealth(u.searchParams.has('force')));
    if (r === '/api/status') return send(res, 200, { ...procs(), downloads: badDownloads() });
    if (r === '/api/downloads/trash' && req.method === 'POST') {
      // only the broken downloads found above, moved to the Trash (never deleted)
      const bad = badDownloads(); if (!bad.length) return send(res, 200, { moved: 0 });
      const dir = path.join(HOME, '.Trash', `bad-downloads-${new Date().toISOString().slice(0, 10)}`); fs.mkdirSync(dir, { recursive: true });
      for (const f of bad) fs.renameSync(path.join(DOWNLOADS, f.name), path.join(dir, fs.existsSync(path.join(dir, f.name)) ? `${Date.now()}-${f.name}` : f.name));
      logAction({ type: 'downloads-trash', files: bad.length }); return send(res, 200, { moved: bad.length });
    }
    if (r === '/api/worker' && req.method === 'GET') {
      const st = jread(WSTATUS, {}); const alive = Date.now() - Date.parse(st.at || 0) < 120e3 || st.state === 'working';
      return send(res, 200, { status: st, alive, tasks: jread(WTASKS, []).slice(-30).reverse() });
    }
    if (r === '/api/worker/make' && req.method === 'POST') {
      const { rel, outs } = JSON.parse(await body(req)); safePath(rel);
      const list = (outs || []).filter((o) => OUTS.includes(o)); if (!list.length) return send(res, 400, { error: 'اختار حاجة واحدة على الأقل' });
      const all = jread(WTASKS, []);
      if (all.some((t) => t.rel === rel && ['waiting', 'working'].includes(t.status))) return send(res, 409, { error: 'المحاضرة دي في الطابور بالفعل' });
      all.push({ id: randomUUID(), rel, outs: list, from: 'dashboard', status: 'waiting', at: new Date().toISOString() }); jwrite(WTASKS, all);
      logAction({ type: 'make', rel, outs: list }); return send(res, 200, { ok: true });
    }
    if (r.startsWith('/api/worker/task/') && req.method === 'POST') {
      const [, , , , id, act] = r.split('/'); const all = jread(WTASKS, []); const t = all.find((x) => x.id === id);
      if (!t) return send(res, 404, { error: 'مش موجود' });
      if (act === 'retry' && ['failed', 'later', 'done'].includes(t.status)) { t.status = 'waiting'; t.error = null; }
      else if (act === 'cancel' && ['waiting', 'later'].includes(t.status)) t.status = 'cancelled';
      else return send(res, 409, { error: 'مينفعش دلوقتي' });
      jwrite(WTASKS, all); return send(res, 200, { ok: true });
    }
    if (r === '/api/worker/run' && req.method === 'POST') { fs.writeFileSync(path.join(WORKER, 'RUN'), new Date().toISOString()); logAction({ type: 'worker-run' }); return send(res, 200, { ok: true }); }
    if (r === '/api/worker/zen' && req.method === 'POST') {
      // restarts Morfi's Zen with the worker's port; Zen brings its tabs back
      spawn('node', [path.join(WORKER, 'worker.mjs'), 'zen'], { env: ENV, detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true });
    }
    if (r === '/api/settings' && req.method === 'GET') return send(res, 200, { groups: GROUPS, schema: SCHEMA, values: settings() });
    if (r === '/api/settings' && req.method === 'POST') {
      // {values:{key:value}} saves, {reset:[keys]} goes back to defaults, {replace:true, values} is an import
      const inp = JSON.parse(await body(req));
      try { const v = saveSettings(inp); logAction({ type: 'settings', keys: [...Object.keys(inp.values || {}), ...(inp.reset || [])].slice(0, 20) }); return send(res, 200, { values: v }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (r === '/api/accounts' && req.method === 'GET') return send(res, 200, accounts());
    if (r === '/api/accounts' && req.method === 'POST') {
      const inp = JSON.parse(await body(req)), { n, limited, disabled } = inp;
      const list = accounts().map(({ limited: _l, freeAt: _f, ...a }) => a);
      const a = list.find((x) => x.n === Number(n)); if (!a) return send(res, 404, { error: 'أكونت مش معروف' });
      if ('limited' in inp) a.limitedAt = limited ? new Date().toISOString() : null;
      if ('disabled' in inp) { if (disabled) a.disabled = true; else delete a.disabled; }
      fs.writeFileSync(ACCOUNTS, JSON.stringify(list, null, 2));
      logAction('disabled' in inp ? { type: 'account-onoff', n: a.n, email: a.email, on: !disabled } : { type: 'account', n: a.n, email: a.email, limited: !!limited }); return send(res, 200, accounts());
    }
    if (r === '/api/job/cancel' && req.method === 'POST') return send(res, 200, { cancelled: cancelJob() });
    if (r.startsWith('/api/waiting/') && req.method === 'DELETE') { const id = r.split('/').pop(); waiting = waiting.filter((w) => w.id !== id); return send(res, 200, { ok: true }); }
    if (r === '/api/state') {
      const s = scan();
      return send(res, 200, {
        ...s, paused: fs.existsSync(PAUSED), schedule: schedule(), nextRun: nextRun().toISOString(), now: new Date().toISOString(),
        runs: readJSONL(path.join(LOGS, 'runs.jsonl'), 20), actions: readJSONL(path.join(LOGS, 'actions.jsonl'), 30),
        queue: readQueue(), categories: [...cats()],
        waiting: waiting.map(({ id, action, label, at }) => ({ id, action, label, at })),
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
    if (r.startsWith('/api/rules/') && r.endsWith('/versions')) {
      // older copies of a rules file: the .bak made before every save + the daily backups
      const f = RULES[r.split('/')[3]]; if (!f) return send(res, 404, { error: 'مش معروف' });
      const name = path.basename(f), out = [];
      for (const b of fs.readdirSync(LOGS)) if (b.startsWith(name + '.') && b.endsWith('.bak')) out.push({ id: b, at: Number(b.slice(name.length + 1, -4)) });
      const BK = path.join(LOGS, 'backups'); if (fs.existsSync(BK)) for (const d of fs.readdirSync(BK)) if (fs.existsSync(path.join(BK, d, name))) out.push({ id: `backups/${d}/${name}`, at: Date.parse(d) });
      if (u.searchParams.get('id')) { const v = out.find((x) => x.id === u.searchParams.get('id')); if (!v) return send(res, 404, { error: 'مش موجود' }); return send(res, 200, { text: fs.readFileSync(path.join(LOGS, v.id), 'utf8') }); }
      return send(res, 200, out.sort((a, b) => b.at - a.at).slice(0, 30));
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
    if (r.startsWith('/api/queue/') && req.method === 'PATCH') {
      const id = r.split('/').pop(); const { top, note } = JSON.parse(await body(req));
      const q = readQueue(); const i = q.findIndex((x) => x.id === id); if (i < 0) return send(res, 404, { error: 'مش موجود' });
      if (note !== undefined) q[i].note = String(note).slice(0, 500);
      if (top) q.unshift(...q.splice(i, 1));
      writeQueue(q); return send(res, 200, { ok: true });
    }
    if (r.startsWith('/api/queue/') && req.method === 'DELETE') {
      const id = r.split('/').pop();
      writeQueue(readQueue().filter((x) => x.id !== id));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, /برا فولدر/.test(e.message) ? 400 : 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Lectures control room → http://localhost:${PORT}`));
