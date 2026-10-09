#!/usr/bin/env node
/**
 * session-store.js — save and restore one authenticated ATS session per tenant host.
 *
 * WHY THIS EXISTS:
 *   Many captchas fire at an ATS login/email gate BEFORE the application form exists, and those
 *   gates are tenant-wide: dozens of postings can sit behind one tenant's gate. A human solves
 *   the gate once, but the solve lives only in whichever browser profile was driving — another
 *   worker's profile never sees it, and reseeding a profile overwrites it. So the same gate got
 *   re-solved per posting instead of per tenant.
 *
 *   Pair this with `next-batch.js --slices N`, which keeps every posting on a host with ONE
 *   worker. Grouping stops two workers tripping the same gate; this file makes the one solve
 *   outlive the profile, the process and the restart.
 *
 * WHAT THIS IS NOT:
 *   Not a captcha bypass. Nothing here defeats, solves or predicts a challenge — a human still
 *   solves the gate exactly once. This only stops re-presenting a gate already passed, which is
 *   ordinary session reuse (the same thing a persistent browser profile does, made portable).
 *   No fingerprint spoofing, no solving service.
 *
 * SECURITY — READ BEFORE CHANGING:
 *   The files written here contain live session cookies. A session cookie is a bearer
 *   credential: anyone holding it is logged in as the applicant on that ATS. Therefore
 *     - the directory ($PIPELINE_HOME/sessions) is created 0700 and every file is written 0600;
 *     - `sessions/` must stay out of git (PIPELINE_HOME lives outside the repo, and the repo's
 *       .gitignore excludes sessions/ as well);
 *     - `list` prints names/expiries only, NEVER cookie values;
 *     - nothing here is ever written to a ledger, a notification, or a log.
 *
 * OPERATIONAL NOTE:
 *   Connecting to a Chrome that an applier is actively driving can BLOCK — an outside
 *   `cookies get` against a busy CDP port hung past 120s. So `save` is meant to be called by
 *   the applier from inside its own flow, right after it gets past a gate, while it owns the
 *   browser. Do not poll a busy instance from outside.
 *
 * Usage:
 *   session-store.js save <host|url> --cdp <port>     # dump this host's cookies + localStorage
 *   session-store.js restore <host|url> --cdp <port>  # put them back before navigating there
 *   session-store.js has <host|url>                   # exit 0 if a usable (unexpired) session exists
 *   session-store.js list                             # what we hold, redacted
 *   session-store.js forget <host|url>                # delete one stored session
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as P from './pipeline-config.js';

const AB = P.agentBrowser();
const DIR = P.path('sessions');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const cdp = opt('--cdp');

// Accept either a bare host or a full apply_url, so callers can pass r.apply_url directly.
const hostOf = s => {
  if (!s) return null;
  try { return new URL(s).hostname.toLowerCase(); } catch { /* not a url */ }
  return String(s).replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || null;
};
const fileFor = h => path.join(DIR, `${h.replace(/[^a-z0-9.-]/g, '_')}.json`);

// A cookie belongs to this host if it names the host exactly, or is a parent-domain cookie
// (".icims.com" covers "careers-example.icims.com"). Anything else is another tenant's and must
// not be written into this file — that would leak one site's session into another's.
const covers = (domain, host) => {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  const bare = d.startsWith('.') ? d.slice(1) : d;
  return host === bare || host.endsWith('.' + bare);
};

function ab(args) {
  if (!cdp) { console.error('session-store: --cdp <port> is required for save/restore'); process.exit(2); }
  return execFileSync(AB, ['--cdp', String(cdp), ...args], {
    encoding: 'utf8', maxBuffer: 1 << 26, timeout: 60_000,
  });
}

// Tolerate the runner returning either a bare array or a {cookies:[...]} / {data:[...]} wrapper.
const unwrap = (txt, key) => {
  let j; try { j = JSON.parse(txt); } catch { return null; }
  // Peel nested wrappers, e.g. {success:true,data:{cookies:[...]}} (agent-browser's shape
  // in some versions — a single-level peel below returned {cookies:[...]}, not the array,
  // so every `save` died with "could not read cookies").
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== 'object') break;
    let next;
    for (const k of [key, 'cookies', 'data', 'result', 'value']) {
      if (j[k] !== undefined) { next = j[k]; break; }
    }
    if (next === undefined) break;
    j = next;
  }
  if (Array.isArray(j)) return j;
  return j && j.success === false ? null : j;
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch { /* already ours */ }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const liveCookies = list => (list || []).filter(c => !c.expires || c.expires < 0 || c.expires > nowSec());

function save(host) {
  ensureDir();
  const all = unwrap(ab(['cookies', 'get', '--json']), 'cookies');
  if (!Array.isArray(all)) { console.error('session-store: could not read cookies'); process.exit(1); }
  const mine = all.filter(c => covers(c.domain, host));
  if (!mine.length) { console.error(`session-store: no cookies for ${host} — nothing saved`); process.exit(1); }

  let local = {};
  try { const l = unwrap(ab(['storage', 'local', 'get']), 'local'); if (l && typeof l === 'object') local = l; }
  catch { /* localStorage is per-origin and often empty; cookies are what matter */ }

  const rec = { host, saved_at: new Date().toISOString(), cookies: mine, local };
  const f = fileFor(host);
  fs.writeFileSync(f, JSON.stringify(rec, null, 1), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  const sess = mine.filter(c => !c.expires || c.expires < 0).length;
  console.log(`saved ${mine.length} cookies for ${host} (${sess} session-scoped), localStorage keys: ${Object.keys(local).length}`);
}

function restore(host) {
  const f = fileFor(host);
  if (!fs.existsSync(f)) { console.error(`session-store: nothing stored for ${host}`); process.exit(1); }
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const usable = liveCookies(rec.cookies);
  const dropped = rec.cookies.length - usable.length;
  if (!usable.length) { console.error(`session-store: all ${rec.cookies.length} cookies for ${host} have expired — log in again`); process.exit(1); }

  let ok = 0;
  for (const c of usable) {
    const a = ['cookies', 'set', c.name, String(c.value ?? ''), '--domain', c.domain, '--path', c.path || '/'];
    if (c.httpOnly) a.push('--httpOnly');
    if (c.secure) a.push('--secure');
    if (c.sameSite && /^(Strict|Lax|None)$/i.test(c.sameSite)) a.push('--sameSite', c.sameSite);
    if (c.expires && c.expires > 0) a.push('--expires', String(Math.floor(c.expires)));
    // One bad cookie must not abort the restore — a partial session still skips the gate.
    try { ab(a); ok++; } catch { /* keep going */ }
  }
  for (const [k, v] of Object.entries(rec.local || {})) {
    try { ab(['storage', 'local', 'set', k, String(v)]); } catch { /* non-fatal */ }
  }
  console.log(`restored ${ok}/${usable.length} cookies for ${host}`
    + `${dropped ? ` (${dropped} expired, skipped)` : ''}, saved ${rec.saved_at}`);
  if (ok === 0) process.exit(1);
}

function has(host) {
  const f = fileFor(host);
  if (!fs.existsSync(f)) process.exit(1);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  process.exit(liveCookies(rec.cookies).length ? 0 : 1);
}

function list() {
  if (!fs.existsSync(DIR)) { console.log('no sessions stored'); return; }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('no sessions stored'); return; }
  console.log(`${files.length} stored session(s) — values redacted:`);
  for (const f of files.sort()) {
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const live = liveCookies(rec.cookies).length;
    const age = Math.round((Date.now() - Date.parse(rec.saved_at)) / 6e4);
    console.log(`  ${rec.host}  ${live}/${rec.cookies.length} live  saved ${age}m ago`
      + `${live ? '' : '  [EXPIRED — re-login needed]'}`);
  }
}

function forget(host) {
  const f = fileFor(host);
  if (!fs.existsSync(f)) { console.error(`nothing stored for ${host}`); process.exit(1); }
  fs.unlinkSync(f);
  console.log(`forgot ${host}`);
}

const target = hostOf(argv[1]);
switch (cmd) {
  case 'save':    if (!target) { console.error('usage: save <host|url> --cdp <port>'); process.exit(2); } save(target); break;
  case 'restore': if (!target) { console.error('usage: restore <host|url> --cdp <port>'); process.exit(2); } restore(target); break;
  case 'has':     if (!target) process.exit(2); has(target); break;
  case 'forget':  if (!target) { console.error('usage: forget <host|url>'); process.exit(2); } forget(target); break;
  case 'list':    list(); break;
  default:
    console.error('usage: session-store.js save|restore|has|forget <host|url> [--cdp <port>] | list');
    process.exit(2);
}
