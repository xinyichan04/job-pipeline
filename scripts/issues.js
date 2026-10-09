#!/usr/bin/env node
/**
 * issues.js — the application-issue log for the job pipeline.
 *
 * Appliers log every problem they hit; the improvement loop works the log
 * from the top. Storage: one JSON object per line (append-only log of events)
 * in $PIPELINE_HOME/issues.jsonl — safe for two parallel
 * appliers appending at once (O_APPEND, one small write per event).
 *
 *   issues.js log --kind K --ats A --company C --detail "..." [--role R] [--url U]
 *                 [--step "page/field"] [--outcome submitted|parked|challenge|failed]
 *                 [--minutes N] [--session applier1]
 *   issues.js top [--n 5]            open problems grouped, most frequent first
 *   issues.js show <sig>             every occurrence of one problem
 *   issues.js claim <sig> --by W     mark in progress (stops two fixers colliding)
 *   issues.js fix <sig> --note "what changed + how it was verified"
 *   issues.js wontfix <sig> --note "why"     (needs a human / out of scope / by design)
 *   issues.js reopen <sig>
 *
 * A problem's signature is kind + ATS + a normalised key (--key, else the first
 * words of --detail), so "Corning upload" and "L3Harris upload" on
 * SuccessFactors group together. Status is derived from the latest event.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as P from './pipeline-config.js';

const FILE = process.env.ISSUES_FILE || P.path('issues.jsonl');
const KINDS = ['upload', 'login', 'account', 'email-code', 'captcha', 'botwall', 'dropdown',
  'field', 'question', 'eligibility', 'timebox', 'crash', 'tooling', 'other'];

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = n => { const i = argv.indexOf('--' + n); return i > 0 ? argv[i + 1] : undefined; };
const die = m => { console.error('issues.js: ' + m); process.exit(2); };

const norm = s => String(s || '').toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ').replace(/[0-9]+/g, ' ').replace(/[^a-z ]+/g, ' ')
  .split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
const sigOf = (kind, ats, key) =>
  crypto.createHash('sha1').update(`${kind}|${norm(ats)}|${norm(key)}`).digest('hex').slice(0, 8);

const read = () => {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
const append = ev => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
};

function problems() {
  const by = new Map();
  for (const e of read()) {
    if (!by.has(e.sig)) by.set(e.sig, { sig: e.sig, hits: [], status: 'open', notes: [] });
    const p = by.get(e.sig);
    if (e.type === 'hit') { p.hits.push(e); if (p.status === 'fixed') p.status = 'open'; }  // came back
    else { p.status = e.type === 'reopen' ? 'open' : e.type; if (e.note || e.by) p.notes.push(e); }
  }
  return [...by.values()];
}
const need = sig => {
  const p = problems().find(x => x.sig === sig || x.sig.startsWith(sig || '-'));
  return p || die(`no problem with signature ${sig}`);
};

switch (cmd) {
  case 'log': {
    const kind = opt('kind'), ats = opt('ats') || 'unknown', detail = opt('detail');
    if (!KINDS.includes(kind)) die(`--kind must be one of: ${KINDS.join(', ')}`);
    if (!detail || !opt('company')) die('log needs --company and --detail');
    const sig = sigOf(kind, ats, opt('key') || detail);
    append({ type: 'hit', sig, kind, ats, company: opt('company'), role: opt('role'),
      url: opt('url'), step: opt('step'), detail, outcome: opt('outcome'),
      minutes: opt('minutes') ? Number(opt('minutes')) : undefined,
      session: opt('session') || process.env.AGENT_BROWSER_SESSION });
    const p = problems().find(x => x.sig === sig);
    console.log(`logged ${sig} (${kind}/${ats}) — seen ${p.hits.length}x, status ${p.status}`);
    break;
  }
  case 'top': {
    const n = Number(opt('n') || 10);
    const rows = problems().filter(p => p.status === 'open' || p.status === 'claimed')
      .map(p => ({ ...p, lost: p.hits.filter(h => h.outcome && h.outcome !== 'submitted').length }))
      .sort((a, b) => b.lost - a.lost || b.hits.length - a.hits.length);
    if (!rows.length) { console.log('no open problems'); break; }
    for (const p of rows.slice(0, n)) {
      const last = p.hits.at(-1);
      const cos = [...new Set(p.hits.map(h => h.company))];
      console.log(`${p.sig}  ${p.status === 'claimed' ? '[claimed] ' : ''}${last.kind}/${last.ats}  ` +
        `${p.hits.length} hit(s), ${p.lost} lost application(s)  — ${cos.slice(0, 4).join(', ')}` +
        `${cos.length > 4 ? ` +${cos.length - 4}` : ''}\n          ${last.detail.slice(0, 160)}`);
    }
    break;
  }
  case 'show': {
    const p = need(argv[1]);
    console.log(`${p.sig} status=${p.status}`);
    for (const h of p.hits) console.log(`  ${h.at.slice(0, 16)} ${h.company}${h.role ? ' — ' + h.role : ''} ` +
      `[${h.outcome || '-'}${h.minutes ? `, ${h.minutes}m` : ''}] step=${h.step || '-'}\n    ${h.detail}${h.url ? '\n    ' + h.url : ''}`);
    for (const e of p.notes) console.log(`  ${e.at.slice(0, 16)} ${e.type}${e.by ? ' by ' + e.by : ''}: ${e.note || ''}`);
    break;
  }
  case 'claim': case 'fix': case 'wontfix': case 'reopen': {
    const p = need(argv[1]);
    const type = cmd === 'fix' ? 'fixed' : cmd === 'claim' ? 'claimed' : cmd;
    if ((type === 'fixed' || type === 'wontfix') && !opt('note')) die(`${cmd} needs --note`);
    append({ type, sig: p.sig, by: opt('by'), note: opt('note') });
    console.log(`${p.sig} → ${type}`);
    break;
  }
  default:
    die('usage: log | top [--n N] | show <sig> | claim <sig> --by W | fix <sig> --note | wontfix <sig> --note | reopen <sig>');
}
