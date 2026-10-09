#!/usr/bin/env node
/**
 * form.js — low-context form driver for the apply pipeline.
 *
 * The expensive thing an applier does is dump a form's DOM into its context:
 * dozens of lines of GUIDs, ARIA flags and duplicate labels, almost all of it
 * used once. This wraps agent-browser so the GUIDs stay on disk and the model
 * only ever sees short human labels.
 *
 *   form.js scan [--all]        tag fields, cache to disk, print compact list
 *   form.js set <label> <val>   fill a text/textarea field by label substring
 *   form.js type <label> <val>  same, via real click + keystrokes (REQUIRED on iCIMS/hCaptcha sites)
 *   form.js pick <q> <option>   choose a radio/checkbox by question + option
 *   form.js file <label> <path> upload a file
 *   form.js combo <label> <val> type into a combobox and take the first option
 *   form.js verify              print only: filled count, and any REQUIRED gaps
 *   form.js submit [text]       click the submit button, print outcome only
 *   form.js batch <plan.json|-> apply [{op:set|type|pick|combo|file|rescan,label,value}] in ONE
 *                               call: scan once, print only failures + read-back + verify summary
 *
 * Labels are matched case-insensitively on substring, so `form.js set "legal name"`
 * works. Element ids on Ashby-class forms regenerate on reload — rescan and the
 * labels stay stable, so a fill plan written in labels survives a reload.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as pace from './pace.js';
import * as P from './pipeline-config.js';

// Human-pacing layer (see pace.js). OFF unless
// PIPELINE_PACE=1, and a true no-op when off, so the unpaced path is byte-identical.
// Aimed at PASSIVE scorers (Ashby spam score, reCAPTCHA v3, fingerprint timing) - NOT at
// explicit puzzles like hCaptcha, which pacing does not solve. See pace.js header.

// The field cache is per-FORM state, so two appliers sharing one file will
// clobber each other: applier A's scan overwrites the cache applier B is about
// to set/pick against, and B then targets stale or wrong fields. Every
// concurrent applier MUST export its own PIPELINE_FORM_CACHE. Warn loudly if not.
const CACHE = process.env.PIPELINE_FORM_CACHE ||
  P.path(process.env.AGENT_BROWSER_SESSION ? `.form-cache-${process.env.AGENT_BROWSER_SESSION}.json` : '.form-cache.json');
if (!process.env.PIPELINE_FORM_CACHE && !process.env.AGENT_BROWSER_SESSION) {
  console.error('[form.js] WARNING: PIPELINE_FORM_CACHE and AGENT_BROWSER_SESSION are unset - using the shared ' +
    'cache. If another applier is running concurrently, your field lookups can ' +
    'be silently corrupted. Export PIPELINE_FORM_CACHE=<per-session path> first.');
}

function ab(args, timeoutMs = 45000) {
  return execFileSync(P.agentBrowser(), args, {
    encoding: 'utf8', timeout: timeoutMs,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

pace.init({ enabled: process.env.PIPELINE_PACE === '1', ab });

// agent-browser prints the eval result as a JSON string literal; unwrap it.
// The whole `raw` output IS a valid JSON string literal
// (agent-browser already escapes it correctly), so JSON.parse(raw) alone
// decodes it losslessly. The old regex-based unwrap-then-reescape path
// double-escaped any quote that was already backslash-escaped inside the
// payload (e.g. a scanned textarea whose JSON-stringified value contains
// `\"`), which corrupted scan()'s JSON the moment a field held a long or
// quote-bearing string (an essay answer) -- "form: scan failed to parse".
function evalJs(js) {
  const raw = ab(['eval', js]).trim();
  try { return JSON.parse(raw); } catch { /* fall through to legacy unwrap */ }
  const m = raw.match(/"([\s\S]*)"\s*$/);
  let s = m ? m[1] : raw;
  try { s = JSON.parse('"' + s.replace(/"/g, '\\"') + '"'); } catch { /* leave as-is */ }
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
}

const SCAN_JS = `
(function(){
  var out=[],n=0;
  document.querySelectorAll('input,textarea,select').forEach(function(el){
    if(el.type==='hidden') return;
    if((el.id||'').indexOf('g-recaptcha')===0) return;
    var lab=null;
    if(el.id){ try{ lab=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); }catch(e){} }
    var t=lab?lab.innerText:(el.getAttribute('aria-label')||el.placeholder||'');
    if(!t){ var c=el.closest('div');
      for(var i=0;i<4&&c;i++){ if(c.innerText&&c.innerText.length<200){t=c.innerText;break;} c=c.parentElement; } }
    t=(t||'').replace(/\\s+/g,' ').trim().slice(0,90);
    var q='';
    if(el.type==='radio'||el.type==='checkbox'){
      var g=el.closest('fieldset')||el.parentElement&&el.parentElement.parentElement;
      if(g&&g.innerText){ q=g.innerText.replace(/\\s+/g,' ').trim().slice(0,90); }
    }
    el.setAttribute('data-zf',n);
    out.push({i:n,tag:el.tagName,type:el.type||'',label:t,group:q,
      req:!!(el.required||el.getAttribute('aria-required')==='true'),
      val:(el.type==='file')?((el.files&&el.files.length)?el.files[0].name:''):(el.value||''),
      checked:(el.type==='radio'||el.type==='checkbox')?el.checked:null});
    n++;
  });
  return JSON.stringify(out);
})()`;

function scan() {
  const json = evalJs(SCAN_JS);
  let fields;
  try { fields = JSON.parse(json); }
  catch { console.error('form: scan failed to parse; is a page loaded?'); process.exit(2); }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(fields));
  return fields;
}

function load() {
  if (!fs.existsSync(CACHE)) return scan();
  return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
}

const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Rank candidates so the most specific label wins. Without this, "Resume"
// matches Ashby's "Autofill from resume / Upload your resume here..." blob
// before it matches the actual Resume field, and the file silently lands on
// the wrong input.
function rank(want, f) {
  const l = norm(f.label), g = norm(f.group);
  if (l === want) return 0;
  if (l.startsWith(want)) return 1;
  if (l.includes(want)) return 2 + Math.min(l.length / 200, 0.9);
  if (g === want) return 4;
  if (g.includes(want)) return 5 + Math.min(g.length / 200, 0.9);
  return 99;
}

function find(fields, label, pred) {
  const want = norm(label);
  const scored = fields.filter(pred)
    .map(f => ({ f, r: rank(want, f) }))
    .filter(x => x.r < 99)
    .sort((a, b) => a.r - b.r);
  if (!scored.length) {
    console.error(`form: no field matching "${label}". Candidates:`);
    fields.filter(pred).slice(0, 12).forEach(f => console.error(`   ${(f.label || f.group).slice(0, 60)}`));
    process.exit(3);
  }
  // Ambiguity that matters: two candidates equally specific.
  if (scored.length > 1 && scored[0].r === scored[1].r && scored[0].r >= 2) {
    console.error(`form: "${label}" is ambiguous between:`);
    scored.slice(0, 4).forEach(x => console.error(`   ${(x.f.label || x.f.group).slice(0, 60)}`));
    console.error('   -> use a longer, more specific substring');
    process.exit(3);
  }
  return scored[0].f;
}

const sel = f => `[data-zf="${f.i}"]`;
const cmd = process.argv[2];
const A = process.argv.slice(3);

if (cmd === 'scan') {
  const fields = scan();
  const showAll = A.includes('--all');
  const seen = new Set();
  let shown = 0;
  for (const f of fields) {
    if (!showAll && !f.req) continue;
    const key = f.type === 'radio' || f.type === 'checkbox' ? f.group : f.label;
    if ((f.type === 'radio' || f.type === 'checkbox') && seen.has(key)) continue;
    seen.add(key);
    const opts = (f.type === 'radio' || f.type === 'checkbox')
      ? '  [' + fields.filter(x => x.group === f.group && x.type === f.type)
          .map(x => x.label).slice(0, 8).join(' | ') + ']' : '';
    console.log(`${f.req ? 'R' : ' '} ${f.type.padEnd(8)} ${(f.label || f.group).slice(0, 60)}${opts}`);
    shown++;
  }
  console.log(`-- ${fields.length} fields (${fields.filter(f => f.req).length} required); showing ${shown}${showAll ? '' : '; --all for optional'}`);

} else if (cmd === 'set') {
  const f = find(load(), A[0], x => ['text','email','tel','url','number','password',''].includes(x.type) || x.tag === 'TEXTAREA');
  ab(['fill', sel(f), A[1]]);
  console.log(`ok ${f.label.slice(0, 45)}`);

} else if (cmd === 'type') {
  // Like `set`, but with a real click and real keystrokes instead of a programmatic fill.
  // Preferred on hCaptcha-protected ATSs (iCIMS): an A/B test on one browser, profile and IP
  // showed programmatic fill/check -> visible puzzle more often than click+type.
  // Typeahead comboboxes (iCIMS State/Province) also only populate on keystrokes.
  const f = find(load(), A[0], x => ['text','email','tel','url','number','password',''].includes(x.type) || x.tag === 'TEXTAREA');
  if (pace.enabled()) {
    const r = pace.typeInto(f.i, A[1]);
    console.log(`ok typed ${f.label.slice(0, 40)}${r.out ? ' ' + r.out : ''}`);
  } else {
    ab(['click', sel(f)]);
    ab(['press', 'Meta+a']); ab(['press', 'Backspace']);
    ab(['type', sel(f), A[1]], 90000);
    console.log(`ok typed ${f.label.slice(0, 40)}`);
  }

} else if (cmd === 'pick') {
  const fields = load();
  const wantQ = norm(A[0]), wantOpt = norm(A[1]);
  const c = fields.filter(f => (f.type === 'radio' || f.type === 'checkbox') &&
    norm(f.group).includes(wantQ) && norm(f.label) === wantOpt);
  const c2 = c.length ? c : fields.filter(f => (f.type === 'radio' || f.type === 'checkbox') &&
    norm(f.group).includes(wantQ) && norm(f.label).includes(wantOpt));
  if (!c2.length) {
    console.error(`form: no option "${A[1]}" under "${A[0]}". Options:`);
    fields.filter(f => norm(f.group).includes(wantQ)).slice(0, 10).forEach(f => console.error(`   ${f.label}`));
    process.exit(3);
  }
  ab(['click', sel(c2[0])]);
  console.log(`ok ${c2[0].label.slice(0, 40)}`);

} else if (cmd === 'file') {
  const f = find(load(), A[0], x => x.type === 'file');
  ab(['upload', sel(f), A[1]], 90000);
  console.log(`ok upload ${path.basename(A[1])}`);

} else if (cmd === 'combo') {
  const f = find(load(), A[0], x => ['text',''].includes(x.type) || x.tag === 'INPUT');
  ab(['click', sel(f)]); ab(['fill', sel(f), A[1]]);
  const got = evalJs(`(function(){
    var el=document.querySelector('${sel(f)}');
    var lb=document.getElementById(el.getAttribute('aria-controls')||'');
    if(!lb) return 'NOLIST';
    var o=lb.querySelector('[role=option]')||lb.firstElementChild;
    if(!o) return 'NOOPT';
    o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o.click();
    return el.value||o.innerText;
  })()`);
  console.log(`ok ${f.label.slice(0, 35)} = ${got.slice(0, 40)}`);

} else if (cmd === 'verify') {
  const fields = scan();
  const gaps = fields.filter(f => f.req && !f.val &&
    !(f.type === 'radio' || f.type === 'checkbox'));
  const groups = [...new Set(fields.filter(f => f.type === 'radio' && f.req).map(f => f.group))];
  const ungrouped = groups.filter(g => !fields.some(f => f.group === g && f.checked));
  const filled = fields.filter(f => f.val || f.checked).length;
  console.log(`filled ${filled}/${fields.length}`);
  if (gaps.length) console.log('MISSING REQUIRED: ' + gaps.map(f => f.label.slice(0, 40)).join(' | '));
  if (ungrouped.length) console.log('UNANSWERED REQUIRED CHOICE: ' + ungrouped.map(g => g.slice(0, 40)).join(' | '));
  if (!gaps.length && !ungrouped.length) console.log('no required gaps');

} else if (cmd === 'submit') {
  const text = A[0] || 'Submit';
  const tagged = evalJs(`(function(){
    var want=${JSON.stringify(text.toLowerCase())};
    var b=[...document.querySelectorAll('button,input[type=submit]')]
      .find(function(x){return (x.innerText||x.value||'').toLowerCase().includes(want)});
    if(!b) return 'NOBUTTON';
    b.setAttribute('data-zsubmit','1'); return 'ok';
  })()`);
  if (tagged.includes('NOBUTTON')) { console.log('submit: button not found'); process.exit(4); }
  ab(['click', '[data-zsubmit="1"]'], 90000);
  execFileSync('sleep', ['8']);
  const res = evalJs(`(function(){
    var t=document.body.innerText;
    var m=t.match(/[^.\\n]{0,120}(success|thank you|received your application|submitted|flagged as possible spam|couldn't submit|error)[^.\\n]{0,160}/i);
    return m?m[0].replace(/\\s+/g,' ').trim():t.slice(-220).replace(/\\s+/g,' ');
  })()`);
  console.log(res.slice(0, 300));

} else if (cmd === 'batch') {
  // form.js batch <plan.json | ->
  // Apply a whole page in ONE call: [{op:"set"|"type"|"pick"|"combo"|"file", label, value}, ...]
  // (also accepted: {"ops":[...]}; "rescan" op with no label). Scans once, prints only failures,
  // then reads every set/type/pick back and ends with the same summary as `verify`.
  // A failing op never stops the batch. Exit 0 = every op ok and no required gaps, 4 = otherwise.
  const src = A[0];
  if (!src) { console.log('usage: form.js batch <plan.json | ->'); process.exit(1); }
  let plan;
  try { plan = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8')); }
  catch (e) { console.log(`batch: cannot read plan: ${e.message}`); process.exit(1); }
  if (!Array.isArray(plan)) plan = plan.ops || [];
  // Writing-style rule (config apply.no_em_dashes, default on): nothing typed contains an em dash
  // or spaced en dash.
  const noDash = s => typeof s !== 'string' || !P.cfg('apply.no_em_dashes', true) ? s : s
    .replace(/\s*—\s*/g, ', ').replace(/\s+–\s+/g, ', ')
    .replace(/,\s*([,.;:])/g, '$1').replace(/\(\s*,\s*/g, '(').replace(/[ \t]{2,}/g, ' ').trim();
  const TEXT = x => ['text','email','tel','url','number','password',''].includes(x.type) || x.tag === 'TEXTAREA';
  // Same ranking as find(), but returns an error string instead of exiting.
  const resolve = (fields, label, pred) => {
    const want = norm(label);
    const scored = fields.filter(pred).map(f => ({ f, r: rank(want, f) })).filter(x => x.r < 99).sort((a, b) => a.r - b.r);
    if (!scored.length) return { err: `no field matching "${label}"` };
    if (scored.length > 1 && scored[0].r === scored[1].r && scored[0].r >= 2) {
      return { err: `"${label}" is ambiguous: ${scored.slice(0, 3).map(x => (x.f.label || x.f.group).slice(0, 40)).join(' | ')}` };
    }
    return { f: scored[0].f };
  };
  const t0 = Date.now();
  let fields = scan();
  const fails = [];
  const checks = [];   // [op, label, field-resolver, expected]
  for (const [n, step] of plan.entries()) {
    if (n > 0) pace.fieldPause();
    const op = step.op, label = step.label;
    const value = ['set', 'type', 'combo'].includes(op) ? noDash(String(step.value ?? '')) : step.value;
    const tag = `#${n + 1} ${op} "${String(label || '').slice(0, 40)}"`;
    try {
      if (op === 'rescan') { fields = scan(); continue; }
      if (op === 'set' || op === 'type') {
        const r = resolve(fields, label, TEXT);
        if (r.err) { fails.push(`${tag}: ${r.err}`); continue; }
        if (pace.enabled()) pace.typeInto(r.f.i, value);   // paced path types even for `set`
        else if (op === 'set') ab(['fill', sel(r.f), value]);
        else { ab(['click', sel(r.f)]); ab(['press', 'Meta+a']); ab(['press', 'Backspace']); ab(['type', sel(r.f), value], 90000); }
        checks.push({ tag, kind: 'text', label: r.f.label, i: r.f.i, want: value });
      } else if (op === 'pick') {
        const wantQ = norm(label), wantOpt = norm(value);
        const isChoice = f => f.type === 'radio' || f.type === 'checkbox';
        let c = fields.filter(f => isChoice(f) && norm(f.group).includes(wantQ) && norm(f.label) === wantOpt);
        if (!c.length) c = fields.filter(f => isChoice(f) && norm(f.group).includes(wantQ) && norm(f.label).includes(wantOpt));
        if (!c.length) {
          fails.push(`${tag}: no option "${value}"; options: ${fields.filter(f => norm(f.group).includes(wantQ)).slice(0, 8).map(f => f.label).join(' | ')}`);
          continue;
        }
        // Real click (hCaptcha-safe). A checkbox already in the wanted state is left alone.
        const now = evalJs(`(function(){var e=document.querySelector('${sel(c[0])}');return e&&e.checked?'1':'0';})()`);
        if (!(now === '1')) { if (pace.enabled()) pace.click(c[0].i); else ab(['click', sel(c[0])]); }
        checks.push({ tag, kind: 'choice', i: c[0].i, label: c[0].label });
      } else if (op === 'file') {
        const r = resolve(fields, label, x => x.type === 'file');
        if (r.err) { fails.push(`${tag}: ${r.err}`); continue; }
        ab(['upload', sel(r.f), value], 90000);
        // iCIMS-class uploads can reload the form: rescan so later ops target live elements.
        execFileSync('sleep', ['1.5']);
        fields = scan();
      } else if (op === 'combo') {
        const r = resolve(fields, label, x => ['text', ''].includes(x.type) || x.tag === 'INPUT');
        if (r.err) { fails.push(`${tag}: ${r.err}`); continue; }
        ab(['click', sel(r.f)]); ab(['fill', sel(r.f), value]);
        const got = evalJs(`(function(){
          var el=document.querySelector('${sel(r.f)}');
          var lb=document.getElementById(el.getAttribute('aria-controls')||'');
          if(!lb) return 'NOLIST';
          var o=lb.querySelector('[role=option]')||lb.firstElementChild;
          if(!o) return 'NOOPT';
          o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o.click();
          return el.value||o.innerText;
        })()`);
        if (got === 'NOLIST' || got === 'NOOPT') fails.push(`${tag}: combobox ${got === 'NOLIST' ? 'has no listbox' : 'has no options'} after typing`);
      } else {
        fails.push(`${tag}: unknown op (use set|type|pick|combo|file|rescan)`);
      }
    } catch (e) {
      fails.push(`${tag}: ${String(e.stderr || e.message || e).split('\n').find(Boolean)?.slice(0, 160)}`);
    }
  }
  // Read-back: one rescan, compare what the page holds now.
  const after = scan();
  const byIdx = new Map(after.map(f => [f.i, f]));
  const byLabel = l => after.find(f => f.label === l);
  const digits = s => String(s).replace(/\D/g, '');
  for (const c of checks) {
    const f = byIdx.get(c.i) && byIdx.get(c.i).label === c.label ? byIdx.get(c.i) : byLabel(c.label);
    if (!f) { fails.push(`${c.tag}: field gone after the batch (page re-rendered?)`); continue; }
    if (c.kind === 'text') {
      const ok = norm(f.val) === norm(c.want) || (digits(c.want).length >= 7 && digits(f.val) === digits(c.want));
      if (!ok) fails.push(`${c.tag}: reads back "${String(f.val).slice(0, 40)}"`);
    } else if (c.kind === 'choice' && !f.checked) {
      fails.push(`${c.tag}: not checked after click`);
    }
  }
  fails.forEach(x => console.log(`FAIL ${x}`));
  const gaps = after.filter(f => f.req && !f.val && !(f.type === 'radio' || f.type === 'checkbox'));
  const groups = [...new Set(after.filter(f => f.type === 'radio' && f.req).map(f => f.group))];
  const ungrouped = groups.filter(g => !after.some(f => f.group === g && f.checked));
  console.log(`filled ${after.filter(f => f.val || f.checked).length}/${after.length}`);
  if (gaps.length) console.log('MISSING REQUIRED: ' + gaps.map(f => f.label.slice(0, 40)).join(' | '));
  if (ungrouped.length) console.log('UNANSWERED REQUIRED CHOICE: ' + ungrouped.map(g => g.slice(0, 40)).join(' | '));
  if (!gaps.length && !ungrouped.length) console.log('no required gaps');
  console.log(`-- batch: ${plan.length} ops, ${fails.length} failed, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(fails.length || gaps.length || ungrouped.length ? 4 : 0);

} else {
  console.log('usage: form.js scan|set|pick|file|combo|verify|submit');
  process.exit(1);
}
