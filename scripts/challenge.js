#!/usr/bin/env node
/**
 * challenge.js — hand a captcha / bot wall / interactive login to the human operator
 * instead of trying to beat it.
 *
 * POLICY: the applier never solves, bypasses or farms out a challenge. No solver
 * services, no stealth tricks, no retry loops against it. It records the challenge
 * here, notifies the operator, logs the posting as `challenge` (NOT terminal —
 * next-batch.js keeps it queued), and moves on. The operator solves it in the pipeline
 * browser window; the cookies it sets live in that browser profile (and can be kept
 * with session-store.js), so the next attempt at that site gets through.
 *
 *   challenge.js park --company C --role R --url U --kind captcha|botwall|login
 *                     [--detail "what the page says"] [--session applier1]
 *                     [--tab N] [--filled "what is already filled"]
 *   challenge.js list [--all]          open challenges (or every one)
 *   challenge.js digest                ONE notification for every open challenge, grouped by host
 *   challenge.js resolve <id|all>      operator says it is done -> mark solved
 *   challenge.js sweep-list            solved rows whose tab may still hold a part-filled form
 *   challenge.js swept <id|all>        mark sweep done
 *   challenge.js open                  exit 0 if any challenge is still open
 *
 * park notifies at most once per URL. If $PIPELINE_HOME/QUIET or $PIPELINE_HOME/BATCH_DM
 * exists (or CHALLENGE_BATCH=1), the notification is deferred to the next `digest`.
 * CHALLENGE_DRY=1 prints messages instead of sending. Exit codes: 0 ok, 2 bad usage.
 */
import fs from 'node:fs';
import * as P from './pipeline-config.js';

const FILE = process.env.CHALLENGE_FILE || P.path('challenges.json');
const KINDS = new Set(['captcha', 'botwall', 'login']);

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = list => { fs.mkdirSync(P.home(), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n'); };

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = name => { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : undefined; };
const die = msg => { console.error('challenge.js: ' + msg); process.exit(2); };

const LABEL = { captcha: 'a captcha', botwall: 'a "verify you are human" wall', login: 'an interactive sign-in' };

function dm(c) {
  const host = (() => { try { return new URL(c.url).hostname; } catch { return c.url; } })();
  const text = [
    `Need a quick hand: ${c.company} (${c.role}) is stuck on ${LABEL[c.kind]}.`,
    c.detail ? `Page says: "${c.detail}"` : '',
    '',
    `Open the pipeline browser window, find the ${host} tab (or paste the link below into that window), and complete it.`,
    c.url,
    '',
    `Then run \`challenge.js resolve ${c.id}\` (or tell the orchestrator "done"). It stays queued until then.`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  if (process.env.CHALLENGE_DRY) { console.log('--- notification (dry run) ---\n' + text + '\n---'); return; }
  P.notify(text);
}

const list = load();

if (cmd === 'park') {
  const c = { company: opt('company'), role: opt('role'), url: opt('url'), kind: opt('kind'),
    detail: opt('detail') || '', session: opt('session') || process.env.AGENT_BROWSER_SESSION || '',
    // captcha-assist: record the tab and what is ALREADY filled, so a sweep can finish this
    // same attempt instead of redoing the form.
    tab: opt('tab') || '', filled: opt('filled') || '', assist: 'pending' };
  if (!c.company || !c.role || !c.url) die('park needs --company --role --url');
  if (!KINDS.has(c.kind)) die('--kind must be captcha, botwall or login');
  const existing = list.find(x => x.url === c.url && x.status === 'open');
  if (existing) {
    console.log(`already open as #${existing.id} — operator was notified ${existing.parked_at}; log the posting as "challenge" and move on`);
    process.exit(0);
  }
  const rec = { id: list.reduce((m, x) => Math.max(m, x.id), 0) + 1, ...c,
    status: 'open', parked_at: new Date().toISOString() };
  list.push(rec); save(list);
  // Quiet hours: the flag file suppresses the notification; `digest` later lists every record
  // with dm === 'deferred'. Remove the file when the operator is available again.
  const QUIET = P.path('QUIET');
  const BATCH = P.path('BATCH_DM');
  if (fs.existsSync(QUIET) || fs.existsSync(BATCH) || process.env.CHALLENGE_BATCH === '1') rec.dm = 'deferred';
  else try { dm(rec); rec.dm = 'sent'; } catch (e) { rec.dm = 'FAILED: ' + e.message.split('\n')[0]; }
  save(list);
  console.log(`parked #${rec.id} (${rec.kind}); notification ${rec.dm}. Close the tab unless the form is already filled, ` +
    'log the ledger outcome as "challenge", open a NEW tab for your next posting.');
} else if (cmd === 'list') {
  const rows = argv.includes('--all') ? list : list.filter(x => x.status === 'open');
  if (!rows.length) console.log('no open challenges');
  for (const x of rows) console.log(`#${x.id} [${x.status}] ${x.kind} ${x.company} — ${x.role} ${x.url} (${x.parked_at})`);
} else if (cmd === 'resolve') {
  const target = argv[1] || die('resolve <id|all>');
  let n = 0;
  for (const x of list) if (x.status === 'open' && (target === 'all' || String(x.id) === target)) {
    x.status = 'solved'; x.solved_at = new Date().toISOString(); x.assist = 'solved'; n++;
  }
  save(list);
  console.log(`marked ${n} solved. Run \`challenge.js sweep-list\` and hand that JSON to a sweep ` +
    'applier: it finishes the SAME attempt in the still-open tab (form state and session intact) ' +
    'rather than refilling the form from scratch.');
} else if (cmd === 'digest') {
  // ONE notification for every challenge still waiting, grouped by host. Replaces a per-URL
  // message storm: tenant-wide login gates mean dozens of postings can sit behind one gate,
  // and grouping shows which single solve unlocks many.
  const waiting = list.filter(x => x.status === 'open');
  if (!waiting.length) { console.log('nothing waiting'); process.exit(0); }
  const hostOf = u => { try { return new URL(u).hostname; } catch { return u; } };
  const groups = new Map();
  for (const x of waiting) {
    const h = hostOf(x.url);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(x);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines = [`${waiting.length} challenges waiting across ${ordered.length} sites.`,
    'Solve them in the pipeline browser window, then run `challenge.js resolve all` (or `resolve <id>`).', ''];
  for (const [h, xs] of ordered) {
    const one = xs.length > 1
      ? `  -> one solve here likely unlocks all ${xs.length} (shared login gate)` : '';
    lines.push(`${xs[0].company} — ${h} — ${xs.length} posting${xs.length > 1 ? 's' : ''}`);
    lines.push(`  #${xs.map(x => x.id).join(', #')}`);
    lines.push(`  ${xs[0].url}`);
    if (one) lines.push(one);
  }
  const text = lines.join('\n');
  if (process.env.CHALLENGE_DRY) { console.log('--- digest (dry run) ---\n' + text + '\n---'); process.exit(0); }
  P.notify(text);
  for (const x of waiting) x.dm = 'sent';
  save(list);
  console.log(`digest sent for ${waiting.length} challenges in ${ordered.length} groups`);

} else if (cmd === 'sweep-list') {
  // Worklist for a DEDICATED sweep applier: rows the operator has solved whose tab should still hold a
  // part-filled form. Match the tab by URL, never by index - indices shift as other tabs close.
  const rows = list.filter(x => x.assist === 'solved' && !x.swept_at)
    .map(x => ({ id: x.id, company: x.company, role: x.role, url: x.url, tab_hint: x.tab || null,
      already_filled: x.filled || null, session: x.session || null, solved_at: x.solved_at }));
  console.log(JSON.stringify(rows, null, 1));

} else if (cmd === 'swept') {
  const target = argv[1] || die('swept <id|all>');
  let n = 0;
  for (const x of list) if (x.assist === 'solved' && !x.swept_at && (target === 'all' || String(x.id) === target)) {
    x.swept_at = new Date().toISOString(); n++;
  }
  save(list);
  console.log(`marked ${n} swept`);

} else if (cmd === 'open') {
  process.exit(list.some(x => x.status === 'open') ? 0 : 1);
} else {
  die('usage: park | list [--all] | digest | resolve <id|all> | sweep-list | swept <id|all> | open');
}
