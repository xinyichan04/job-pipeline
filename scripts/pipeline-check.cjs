#!/usr/bin/env node
/**
 * pipeline-check — diff the SimplifyJobs Summer2027-Internships README against
 * local seen-state and emit genuinely-new postings for the daily apply run.
 *
 * Mechanical filters only (closed 🔒 and advanced-degree 🎓 rows are dropped;
 * sponsorship flags are passed through). Which titles are worth applying to is
 * a judgment call that stays with the agent, per the pipeline's triage rules.
 *
 * Commands:
 *   check          fetch + parse + diff; print new rows as JSON (state untouched)
 *   mark <key>...  record keys as seen (call after each posting is processed)
 *   seed           mark everything currently listed as seen (baseline)
 *   stats          print state summary
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PIPELINE_HOME = (process.env.PIPELINE_HOME || '~/.job-pipeline').replace(/^~(?=$|\/)/, require('os').homedir());
const STATE_DIR = PIPELINE_HOME;
const STATE = path.join(STATE_DIR, 'state.json');

// ---------- concurrency: serialize state.json writers (parallel appliers) ----------
// mark/seed do read-modify-write on state.json; concurrent callers would lose
// keys. Own lock file.
{
  const cmd = process.argv[2];
  if ((cmd === 'mark' || cmd === 'seed') && !process.env.PIPELINE_CHECK_LOCKED) {
    const LOCK = path.join(STATE_DIR, '.state.lock');
    // flock is Linux util-linux; macOS ships /usr/bin/lockf instead (-k keeps the lock file).
    const haveFlock = require('child_process').spawnSync('which', ['flock']).status === 0;
    const [bin, pre] = haveFlock ? ['flock', [LOCK]] : ['/usr/bin/lockf', ['-k', LOCK]];
    const r = require('child_process').spawnSync(
      bin, [...pre, process.execPath, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, PIPELINE_CHECK_LOCKED: '1' } });
    process.exit(r.status === null ? 1 : r.status);
  }
}
// Two lists, same repo and section layout: README.md = Summer 2027,
// README-Off-Season.md = Fall 2026 / Winter 2027 / Spring 2027 co-ops
// (off-season terms are wanted too — they are easy to miss otherwise).
const LISTS = [
  { list: 'summer', url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md', marker: 'Summer 2027' },
  { list: 'offseason', url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README-Off-Season.md', marker: 'Off-Season' },
];

// All five sections (sweep everything; the only filters are
// factual degree/term qualification, applied by the agent at triage time).
const SECTIONS = [
  { key: 'swe', header: 'Software Engineering Internship Roles' },
  { key: 'pm', header: 'Product Management Internship Roles' },
  { key: 'ai-ml', header: 'Data Science, AI & Machine Learning Internship Roles' },
  { key: 'quant', header: 'Quantitative Finance Internship Roles' },
  { key: 'hw', header: 'Hardware Engineering Internship Roles' },
];
const LISTINGS_URL = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';

function loadState() {
  if (!fs.existsSync(STATE)) return { seen: {} };
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}
function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1));
  fs.renameSync(tmp, STATE);
}

function fetchReadme(url) {
  return execFileSync('curl', ['-sL', '--max-time', '60', url], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function stripTags(s) {
  return s.replace(/<br\s*\/?>/gi, '; ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
}

function parseSection(md, header, sectionKey) {
  const start = md.indexOf(header);
  if (start === -1) return [];
  const end = md.indexOf('</table>', start);
  const body = md.slice(start, end === -1 ? undefined : end);
  const rows = [];
  let lastCompany = null;
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(body))) {
    const tds = [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(x => x[1]);
    if (tds.length < 5) continue; // header or malformed row
    // Summer list: Company|Role|Location|Application|Age.
    // Off-season list adds a Terms column: Company|Role|Location|Terms|Application|Age.
    const hasTerms = tds.length >= 6;
    const [cTd, roleTd, locTd] = tds;
    const termsTd = hasTerms ? tds[3] : null;
    const appTd = tds[hasTerms ? 4 : 3];
    const ageTd = tds[hasTerms ? 5 : 4];
    let company = stripTags(cTd);
    if (company === '↳') company = lastCompany; else lastCompany = company;
    const title = stripTags(roleTd);
    const whole = cTd + roleTd;
    if (whole.includes('🔒')) continue; // closed — not applicable at all
    const flags = [];
    if (whole.includes('🎓')) flags.push('advanced-degree'); // dropped at triage, but visibly
    if (whole.includes('🛂')) flags.push('no-sponsorship');
    if (whole.includes('🇺🇸')) flags.push('us-citizenship');
    if (whole.includes('🔥')) flags.push('faang+');
    const simplify = (appTd.match(/simplify\.jobs\/p\/([0-9a-f-]{36})/) || [])[1] || null;
    const apply = (appTd.match(/href="([^"]+)"/) || [])[1] || null;
    if (!apply && !simplify) continue; // no way to apply — skip
    const key = simplify ||
      crypto.createHash('sha1').update(`${company}|${title}|${apply}`).digest('hex').slice(0, 16);
    rows.push({
      key, section: sectionKey, company, title,
      location: stripTags(locTd), age: stripTags(ageTd),
      terms: termsTd ? stripTags(termsTd) : undefined,
      apply: apply ? apply.replace(/\?utm_source=Simplify&ref=Simplify$/, '') : null,
      simplify_uuid: simplify, flags,
    });
  }
  return rows;
}

function parseAll() {
  const out = [];
  const seenKeys = new Set();
  for (const { list, url, marker } of LISTS) {
    const md = fetchReadme(url);
    if (!md.includes(marker)) {
      console.error(`error: fetched ${list} README does not look right (no "${marker}" marker) — aborting.`);
      process.exit(1);
    }
    for (const s of SECTIONS) {
      for (const r of parseSection(md, s.header, s.key)) {
        if (seenKeys.has(r.key)) continue; // same posting in both lists
        seenKeys.add(r.key);
        out.push({ ...r, list });
      }
    }
  }
  return out;
}

const cmd = process.argv[2];
const st = loadState();

if (cmd === 'check') {
  const rows = parseAll();
  const fresh = rows.filter(r => !st.seen[r.key]);
  // Enrich with Simplify's parsed terms/degrees/sponsorship (listings.json,
  // joined by posting uuid) — the factual-qualification filter reads these.
  if (fresh.length) {
    try {
      const listings = JSON.parse(execFileSync('curl',
        ['-sL', '--max-time', '90', LISTINGS_URL],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      const byId = new Map(listings.map(l => [l.id, l]));
      for (const r of fresh) {
        const l = r.simplify_uuid && byId.get(r.simplify_uuid);
        if (l) {
          r.terms = l.terms || r.terms || null;
          r.degrees = l.degrees || null;
          r.sponsorship = l.sponsorship || null;
        }
      }
    } catch (e) {
      console.error('warning: listings.json enrichment failed (' + e.message.slice(0, 80) + ') — rows lack terms/degrees; check the Simplify page per row instead.');
    }
  }
  console.log(JSON.stringify({ checked: rows.length, new: fresh.length, rows: fresh }, null, 1));
} else if (cmd === 'mark') {
  const now = new Date().toISOString();
  for (const k of process.argv.slice(3)) st.seen[k] = now;
  saveState(st);
  console.log(`marked ${process.argv.length - 3} key(s); ${Object.keys(st.seen).length} total seen.`);
} else if (cmd === 'seed') {
  const rows = parseAll();
  const now = new Date().toISOString();
  let added = 0;
  for (const r of rows) if (!st.seen[r.key]) { st.seen[r.key] = now; added++; }
  saveState(st);
  console.log(`seeded: ${added} new key(s) marked seen; ${Object.keys(st.seen).length} total.`);
} else if (cmd === 'all') {
  // every parsed row regardless of seen-state (e.g. re-examining today's 0d/1d)
  const rows = parseAll().map(r => ({ ...r, seen: !!st.seen[r.key] }));
  console.log(JSON.stringify({ checked: rows.length, rows }, null, 1));
} else if (cmd === 'stats') {
  console.log(`seen: ${Object.keys(st.seen).length} postings; state: ${STATE}`);
} else {
  console.log('usage: pipeline-check.cjs check | mark <key>... | seed | stats');
}
