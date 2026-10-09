#!/usr/bin/env node
/**
 * next-batch.js — what is still left to apply to today.
 *
 * queue (applyqueue-v2.json / applyqueue.json in the run folder) minus SKIP.txt minus
 * anything already written to a ledger part of ANY run. Lets a resumed run start work
 * immediately instead of re-deriving state. Prints: company | role | apply_url
 *
 *   next-batch.js [--run YYYY-MM-DD] [--limit N] [--json] [--this-run-only] [--cs-only]
 *                 [--slices N [--slice i]]
 *
 * Config (config.json): queue.held_companies, queue.hold_top_list,
 * queue.top_list_expiry_days, queue.fuzzy_match_threshold.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as P from './pipeline-config.js';

const a = process.argv.slice(2);
const opt = (n, d) => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const limit = parseInt(opt('--limit', '0'), 10);
const RUNS = P.path('runs');
const THRESH = Number(P.cfg('queue.fuzzy_match_threshold', 0.75));
if (!fs.existsSync(RUNS)) { console.error(`next-batch: no runs folder at ${RUNS}`); process.exit(2); }
// Default to the newest run folder, not today's UTC date — a run started in the
// evening local time is "yesterday" in UTC and would otherwise look empty.
const run = opt('--run') || fs.readdirSync(RUNS)
  .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
const dir = path.join(RUNS, run);

const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
let queue = [];
for (const f of ['applyqueue-v2.json', 'applyqueue.json']) {
  const t = read(f);
  if (t) { queue = JSON.parse(t); break; }
}
if (!queue.length) { console.error(`next-batch: no queue in ${dir}`); process.exit(2); }

const skip = new Set(read('SKIP.txt').split('\n').map(s => s.trim()).filter(Boolean));

// Ledgers from EVERY run, not just this one. A run folder is per
// day, so within-run dedup alone let a posting already submitted on an earlier
// run come back and be applied to twice — nothing else in the pipeline
// remembers prior applications (the job-list email is re-read fresh each run). --this-run-only
// restores the old behaviour.
const thisRunOnly = a.includes('--this-run-only');
const readAt = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return ''; } };
// Date-PREFIXED folders too: gap/retry runs may be named "<date>b" /
// "<date>-retry"; an exact-date regex made their ledgers invisible to dedup,
// including to the run itself. Always include this run's own folder.
const ledgerDirs = thisRunOnly ? [dir] : [...new Set([...fs.readdirSync(RUNS)
  .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort().map(d => path.join(RUNS, d)), dir])];
let priorRunFiles = 0;
const ledgerFiles = [];
for (const d of ledgerDirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter(f => /^ledger/.test(f))) {
    ledgerFiles.push({ text: readAt(d, f), run: path.basename(d) });
    if (d !== dir) priorRunFiles++;
  }
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A ledger row only retires a posting if it reached a terminal outcome.
// "skipped" is NOT terminal: a skipped posting (e.g. deferred so cheaper
// postings get done first) must come back into the queue for a later pass. Without this, a
// skipped row silently removed the posting from the run forever.
const OUTCOME = /^(submitted|skipped|challenge|parked|failed|duplicate|drop-at-apply|dropped)$/i;
const cellsOf = rec => {
  const c = rec.split('|').map(x => x.trim());
  return /^\s*\|/.test(rec) ? c.slice(1) : c;    // drop the empty cell a leading pipe creates
};
const isRow = rec => (rec.match(/\|/g) || []).length >= 2;
const outcomeOf = rec => {
  if (isRow(rec)) {                               // co | role | [url] | outcome | ...
    for (const c of cellsOf(rec).slice(2, 5)) {
      const m = c.match(/^\*{0,2}([a-z-]+)/i);
      if (m && OUTCOME.test(m[1])) return m[1].toLowerCase();
    }
    return '';
  }
  const m = rec.match(/^[-*\s]*outcome:\s*\*{0,2}([a-z-]+)/im);  // "- outcome: **skipped**"
  return m && OUTCOME.test(m[1]) ? m[1].toLowerCase() : '';
};

// Block-style parts write "- **Outcome:** submitted"; outcomeOf only knows "outcome: **x**".
const keyOutcome = rec => ((rec.match(/outcome:?\**:?\s*\**([a-z-]+)/i) || [])[1] || '').toLowerCase();

// One record per posting. Ledger parts use two formats, sometimes in the same
// run: markdown "## Company - Role" blocks, and one-row-per-line tables. Parse
// each FILE separately and pull table rows OUT of the surrounding text — a
// block that swallowed a whole table would retire every posting listed in it.
const records = [];
const runOf = new Map();                          // record -> run folder it came from
for (const { text, run: ledgerRun } of ledgerFiles) {
  const prose = [];
  const push = r => { records.push(r); runOf.set(records.length - 1, ledgerRun); };
  for (const line of text.split('\n')) {
    // Ledger parts mix "| Company | Role | outcome |" with bare
    // "Company | Role | outcome |". Both are one record per line.
    if ((line.match(/\|/g) || []).length >= 2) push(line);
    else prose.push(line);
  }
  // Appliers write headings at either level: "## Company - Role" or
  // "### Company - Role". Accepting only "## " silently dropped every ###
  // entry, so finished (even SUBMITTED) postings looked unfinished and were
  // queued for re-application. Match 2+ hashes.
  for (const block of prose.join('\n').split(/\n(?=#{2,}\s)/)) {
    if (/^#{2,}\s/.test(block)) push(block);
  }
}

// Pull (company, role) out of a record. Ledger and queue spell the same posting
// differently — "Quant" vs "Quantitative", ", Cloud Services" vs " - Cloud
// Services - Summer 2027" — so compare stemmed token sets, not raw strings.
const NOISE = new Set(['inter', 'co', 'op', 'coop', 'summe', 'winte', 'sprin',
  'fall', 'job', 'the', 'and', 'or', 'of', 'for', 'a', 'at', 'multi']);  // already 5-char-stemmed
// Drop parenthetical qualifiers first: a ledger heading writes
// "Embedded Software Engineering Intern (Towson, MD)" and the queue writes
// "Embedded Software Engineering Intern", so the location tokens alone pushed
// a real match below the match threshold and re-queued a submitted posting.
const toks = s => new Set(norm(String(s).replace(/\([^)]*\)/g, ' ')).split(' ')
  .filter(t => t && !/^\d+$/.test(t))
  .map(t => t.slice(0, 5))
  .filter(t => !NOISE.has(t)));
const parse = rec => {
  if (isRow(rec)) {
    const c = cellsOf(rec);
    return { company: c[0] || '', role: c[1] || '' };
  }
  const head = rec.split('\n')[0].replace(/^#+\s*/, '');
  const parts = head.split(/\s+[—–]\s+/);          // "## Company — Role — Location"
  return parts.length > 1
    ? { company: parts[0], role: parts[1] }
    : { company: head, role: head };
};

// Requeued old parked/failed postings: CARRYOVER.json rows with "requeue": "<date>". A parked/failed record from a run BEFORE that date no longer
// retires the posting. A submitted/duplicate record always does — never apply twice.
let requeued = [];
try {
  requeued = (JSON.parse(fs.readFileSync(P.path('CARRYOVER.json'), 'utf8')).rows || [])
    .filter(r => r.requeue).map(r => ({ co: toks(r.company), role: toks(r.role), date: r.requeue }));
} catch { /* no carryover file */ }

const done = [];
// A retry queue row may carry "requeue": "<YYYY-MM-DD>" (retry lane): parked /
// failed / timebox records from runs BEFORE that date then no longer retire that row.
// submitted / duplicate / drop-at-apply / dropped always do - never apply twice.
const RETRYABLE = ['parked', 'failed', 'timebox'];
records.forEach((rec, i) => {
  const oc = outcomeOf(rec);
  // challenge = waiting on a human to clear a captcha/bot wall (challenge.js) — also still owed
  if (['skipped', 'challenge'].includes(oc)) return;
  const { company, role } = parse(rec);
  const co = toks(company), rl = toks(role);
  if (!co.size || !rl.size) return;                // header/separator row, not a posting
  if (['parked', 'failed'].includes(oc) && requeued.some(q => runOf.get(i) < q.date
      && covers(co, q.co) && jaccard(rl, q.role) >= THRESH)) return;
  done.push({ co, role: rl, oc: oc || keyOutcome(rec), run: runOf.get(i) });
});

function covers(a, b) { return [...a].every(t => b.has(t)) || [...b].every(t => a.has(t)); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};
// Same company AND a role that is ~the same posting. The default 0.75 is deliberately
// strict: a near-miss re-queues a posting (wasted work) but a loose match
// would drop a real application on the floor.
const seen = (company, role, rq) => {
  const c = toks(company), r = toks(role);
  if (!c.size || !r.size) return false;
  return done.some(d => covers(c, d.co) && jaccard(r, d.role) >= THRESH
    && !(rq && RETRYABLE.includes(d.oc) && d.run < rq));
};
// Held companies: config queue.held_companies (e.g. companies you apply to yourself) are never
// handed to an applier. Optionally (queue.hold_top_list) the companies recorded in TOP10.json by
// swelist-digest.py are held too; entries expire after queue.top_list_expiry_days.
const coNorm = s => norm(s).replace(/\b(inc|llc|corp|corporation|company|co|group|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
const held = (P.cfg('queue.held_companies', []) || []).map(coNorm).filter(Boolean);
if (P.cfg('queue.hold_top_list', false)) {
  try {
    const days = Number(P.cfg('queue.top_list_expiry_days', 21));
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    held.push(...(JSON.parse(fs.readFileSync(P.path('TOP10.json'), 'utf8')).entries || [])
      .filter(e => (e.recorded || '9999') >= cutoff).map(e => coNorm(e.company)).filter(Boolean));
  } catch { /* no TOP10 file */ }
}
const isHeld = co => { const c = coNorm(co); return held.some(t => c === t || c.startsWith(t + ' ') || t.startsWith(c + ' ')); };
let heldCount = 0;
const keyDone = (key, rq) => records.some((rec, i) => {
  if (!rec.includes(key.slice(0, 8))) return false;
  const oc = outcomeOf(rec) || keyOutcome(rec);
  if (['skipped', 'challenge'].includes(oc)) return false;
  return !(rq && RETRYABLE.includes(oc) && runOf.get(i) < rq);
});

const left = queue.filter(r => {
  if (skip.has(`${r.company} :: ${r.role}`)) return false;
  if (isHeld(r.company)) { heldCount++; return false; }
  // Appliers quote the posting key (uuid) in their ledger rows; titles drift (jd-list adds
  // disambiguating suffixes), so a key hit in a non-skipped/challenge row retires it outright.
  if (r.key && keyDone(r.key, r.requeue)) return false;
  return !seen(r.company, r.role, r.requeue);
});

// Role-fit priority: software engineering first, then other CS/technical
// roles, then data/analytics, then engineering/product, and business/finance/HR-type roles last.
// A stable sort, so jd-list's existing order is kept within a tier.
const roleTier = role => {
  const t = norm(role);
  if (/\b(hardware|electrical|mechanical|manufacturing|layout)\b/.test(t) && !/\b(software|firmware)\b/.test(t)) return 2;
  // "Member of Technical Staff" is an industry-standard SWE title; it was falling to tier 3 and would have been dropped by --cs-only.
  if (/\b(software|swe|backend|back end|infrastructure|platform|systems|compiler|developer|full stack|fullstack|devops|site reliability|sre|security engineer|embedded software|firmware|mobile|ios|android|web)\b/.test(t)
      || /\bmember of technical staff\b/.test(t)) return 0;
  // Bare "embedded" (without "software") is CS-adjacent enough to keep — it was landing in
  // tier 3 alongside genuinely non-CS roles.
  if (/\b(computer science|machine learning|ml|ai|artificial intelligence|data engineer|cloud|quant developer|technology|it application|information technology|computer engineering|cyber|automation|robotics|autonomy)\b/.test(t)
      || /\bembedded\b/.test(t)) return 1;
  if (/\b(data|analytics|analyst|quantitative|quant|research|electrical|electronics|controls|hardware)\b/.test(t)) return 2;
  if (/\b(human resources|hr|recruit|talent|marketing|sales|business|finance|accounting|operations|supply chain|product management|project management|pmo|process improvement|communications|legal|audit|tax)\b/.test(t)) return 4;
  return 3;
};
// --- CS-only gate ----------------------------------------------------------------------
// --cs-only
// keeps tiers 0-1 (software + CS/technical) and drops the rest. Kept as an OPT-IN FLAG rather
// than a hard filter: dropping is invisible to the human, so the default stays "order, don't drop",
// matching the rule that rows are dropped only on factual disqualification.
const csOnly = a.includes('--cs-only');
let csDropped = [];
if (csOnly) {
  csDropped = left.filter(r => roleTier(r.role) > 1);
  for (let i = left.length - 1; i >= 0; i--) if (roleTier(left[i].role) > 1) left.splice(i, 1);
}

left.sort((x, y) => roleTier(x.role) - roleTier(y.role));

// --- Tenant grouping --------------------------------------------------------------------
// Most captchas fire at an ATS login/email gate BEFORE the form exists, and the gates are
// tenant-wide: dozens of postings can sit behind one tenant's gate.
// Sorting by role tier alone let BOTH appliers walk into the same tenant independently and
// trip the same gate twice, producing two parked postings where one login would have covered
// all of them. --slices keeps every posting on a host together and gives that host to exactly
// ONE worker, so a single hand-solve (plus session-store.js restoring the cookies) covers the
// whole tenant. Greedy largest-group-first bin-packing; role-tier order is preserved inside
// each group, and groups are emitted best-tier-first so SWE still leads each slice.
const hostOf = r => {
  try { return new URL(r.apply_url).hostname.toLowerCase(); }
  catch { return `no-url:${norm(r.company)}`; }
};
// A readable name for a host in the slice summary. The session cookie lives on the HOSTNAME,
// so shared boards (jobs.ashbyhq.com, jobs.lever.co) are correctly one group even though the
// company sits in the URL path — label them by the board, not by any one tenant.
const label = h => {
  if (h.startsWith('no-url:')) return h.slice(7).split(' ')[0] || 'no-url';
  const p = h.split('.');
  const board = p.length >= 2 ? p[p.length - 2] : h;               // ashbyhq, lever, icims…
  const sub = p[0].replace(/^(careers?|jobs|external|www)-?/, ''); // tenant name
  return sub && sub !== board ? sub : board;
};
const sliceCount = parseInt(opt('--slices', '0'), 10);
const sliceIdx = opt('--slice') === undefined ? null : parseInt(opt('--slice'), 10);

let out;
if (sliceCount > 1) {
  const groups = new Map();
  for (const r of left) {
    const h = hostOf(r);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(r);
  }
  // Biggest tenant first: a big gated tenant must land before the singletons fill the bins.
  const ordered = [...groups.entries()].sort((a1, b1) => b1[1].length - a1[1].length);
  const bins = Array.from({ length: sliceCount }, () => []);
  for (const [, rows] of ordered) {
    let t = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i].length < bins[t].length) t = i;
    bins[t].push(...rows);
  }
  // Within a slice, lead with the best role tier (stable, so tenant runs stay contiguous).
  for (const b of bins) b.sort((x, y) => roleTier(x.role) - roleTier(y.role));
  if (sliceIdx !== null) {
    if (!(sliceIdx >= 0 && sliceIdx < sliceCount)) {
      console.error(`next-batch: --slice must be 0..${sliceCount - 1}`); process.exit(2);
    }
    out = limit ? bins[sliceIdx].slice(0, limit) : bins[sliceIdx];
  } else {
    if (!a.includes('--json')) {
      console.log(`${left.length} remaining, split into ${sliceCount} tenant-grouped slices:`);
      bins.forEach((b, i) => {
        const hs = [...new Set(b.map(hostOf))];
        const top = hs.map(h => [h, b.filter(r => hostOf(r) === h).length])
          .sort((p, q) => q[1] - p[1]).slice(0, 3)
          .map(([h, n]) => `${label(h)}:${n}`).join(' ');
        console.log(`  slice ${i}: ${b.length} postings across ${hs.length} hosts  (${top})`);
      });
      console.log(`\nRun one worker per slice:  next-batch.js --slices ${sliceCount} --slice <i> --json`);
    }
    out = bins.flat();
  }
} else {
  out = limit ? left.slice(0, limit) : left;
}
// no process.exit() here: it can drop unflushed stdout when piped
if (a.includes('--json')) {
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
} else {
  if (csOnly && csDropped.length) {
    console.log(`--cs-only dropped ${csDropped.length} non-CS role(s):`);
    for (const r of csDropped) console.log(`  - ${r.company} | ${r.role}`);
    console.log('');
  }
  console.log(`${left.length} remaining of ${queue.length} (held companies ${heldCount}, skiplist ${skip.size}`
    + `${thisRunOnly ? ', this run only' : `, +${priorRunFiles} prior-run ledger file(s)`})`);
  for (const r of out) console.log(`${r.company} | ${r.role} | ${r.apply_url || 'NO-URL'}`);
}
