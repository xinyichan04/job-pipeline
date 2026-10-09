#!/usr/bin/env node
/**
 * greenhouse.js — label-addressed driver for Greenhouse application forms
 * (job-boards.greenhouse.io, boards.greenhouse.io, job-boards.eu.greenhouse.io and
 * company sites embedding them). Built after several tenants cost 15-20 min each on
 * react-select comboboxes.
 *
 *   greenhouse.js fields [--all]          every field: kind, label, value; ! = required & empty
 *   greenhouse.js set <label> <text>      text / textarea / email / tel
 *   greenhouse.js select <label> <option> react-select combobox (static or async search)
 *   greenhouse.js options <label>         list a select's options WITHOUT typing anything (never probe with junk
 *                                         text like "zzz" — it types into the field and waits ~6 s)
 *   greenhouse.js check <label> <option>  checkbox group ("select all that apply")
 *   greenhouse.js file <label> <path>     résumé / cover letter upload
 *   greenhouse.js verify [--fix]          required gaps; --fix re-applies any select that
 *                                         reverted since this session set it
 *
 * What debugging found:
 *  - A react-select's chosen value lives in `.select__single-value`, NOT input.value
 *    (the input is cleared on select). form.js verify therefore reports a correctly
 *    filled combobox as MISSING, which is where "the form keeps resetting" came from
 *    at least in part — appliers refilled fields that were fine.
 *  - Options are `#react-select-<inputId>-option-<n>`. A real CDP click on the option
 *    commits it; a JS mousedown+click also works on most tenants, but Veeam's Country
 *    only validated with a native el.click(). We click for real, verify, then fall back.
 *  - Country's list also contains hidden intl-tel-input `iti-*` items — ignored.
 *  - With its own browser (bin/pipeline-chrome --instance N) no field reset was reproduced
 *    across Country, Location, School, Degree, Discipline and a text fill.
 *
 * Every select is recorded in $GH_STATE (per session) so `verify --fix` can put back
 * anything that did revert before submit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as P from './pipeline-config.js';

if (!process.env.AGENT_BROWSER_SESSION) {
  console.error('greenhouse.js: AGENT_BROWSER_SESSION is not set — refusing to run.');
  process.exit(2);
}
const AB = P.agentBrowser();
const STATE = process.env.GH_STATE || P.path(`.gh-state-${process.env.AGENT_BROWSER_SESSION}.json`);

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function ab(args, timeoutMs = 45000) {
  return execFileSync(AB, args, { encoding: 'utf8', timeout: timeoutMs,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Page code returns JSON.stringify(...); agent-browser prints that as a JSON string
// literal, so parse twice. Never regex-unwrap (that broke form.js on Geneva's page).
function evalJson(js) {
  const raw = ab(['eval', js]).trim();
  const line = raw.split('\n').filter(l => l.trim()).pop() || '';
  let v = JSON.parse(line);
  if (typeof v === 'string') v = JSON.parse(v);
  return v;
}

const FIELDS_JS = `(function(){
  function lab(el){
    var l=el.id?document.querySelector('label[for="'+CSS.escape(el.id)+'"]'):null;
    if(!l&&el.getAttribute('aria-labelledby')) l=document.getElementById(el.getAttribute('aria-labelledby').split(' ')[0]);
    var t=l?l.innerText:(el.getAttribute('aria-label')||'');
    return t.replace(/\\s+/g,' ').replace(/\\*$/,'').trim();
  }
  var out=[], seenGroups={};
  document.querySelectorAll('input,textarea,select').forEach(function(el){
    if(el.type==='hidden'||el.type==='submit'||!el.id&&el.type!=='checkbox'&&el.type!=='radio') return;
    if((el.id||'').indexOf('iti-')===0||(el.id||'').indexOf('g-recaptcha')===0) return;
    var req=!!(el.required||el.getAttribute('aria-required')==='true');
    if(el.classList.contains('select__input')){
      var c=el.closest('.select__container')||el.closest('.select-shell')||el.parentElement.parentElement.parentElement;
      var sv=c?c.querySelectorAll('.select__single-value,.select__multi-value__label'):[];
      var vals=[].map.call(sv,function(x){return x.innerText.trim()});
      out.push({k:'select',id:el.id,label:lab(el),req:req,val:vals.join('; '),bad:el.getAttribute('aria-invalid')==='true'});
    } else if(el.type==='checkbox'||el.type==='radio'){
      var fs=el.closest('fieldset'); var g=fs?(fs.querySelector('legend')||fs).innerText.split('\\n')[0].trim():'';
      var key=(fs&&fs.id)||g; var ol=el.id?document.querySelector('label[for="'+CSS.escape(el.id)+'"]'):el.closest('label');
      if(!seenGroups[key]){ seenGroups[key]={k:el.type,id:el.id||el.name,label:g.replace(/\\*$/,'').trim(),req:req||!!(fs&&fs.querySelector('[aria-required=true],.required')),val:'',opts:[]}; out.push(seenGroups[key]); }
      var o=(ol?ol.innerText:el.value).trim(); seenGroups[key].opts.push(o);
      if(el.checked) seenGroups[key].val+=(seenGroups[key].val?'; ':'')+o;
    } else if(el.type==='file'){
      // Greenhouse: <div class="file-upload"> "Resume/CV*" … Attach button wraps the input.
      var box=el.closest('.file-upload')||el.closest('[class*=file-upload],[class*=upload]')||el.parentElement;
      var head=box?box.innerText.split('\\n')[0].trim():'';
      var fname=(el.files&&el.files.length)?el.files[0].name:'';
      var shown=box&&box.querySelector('[class*=filename],[class*=file-name],.chip');
      out.push({k:'file',id:el.id,label:((el.closest('.file-upload')&&head)||lab(el)||head).replace(/\\*$/,'').trim(),req:req||/\\*$/.test(head),val:fname||(shown?shown.innerText.trim():'')});
    } else {
      out.push({k:el.tagName==='TEXTAREA'?'textarea':(el.type||'text'),id:el.id,label:lab(el),req:req,val:el.value||'',bad:el.getAttribute('aria-invalid')==='true'});
    }
  });
  // After an upload Greenhouse removes the <input type=file> and shows the filename instead.
  document.querySelectorAll('.file-upload').forEach(function(box){
    if(box.querySelector('input[type=file]')) return;
    var head=(box.querySelector('.upload-label')||box).innerText.split('\\n')[0].trim();
    var fn=box.querySelector('.file-upload__filename');
    out.push({k:'file',id:(box.querySelector('.upload-label')||{}).id||'',label:head.replace(/\\*$/,'').trim(),req:/\\*$/.test(head),val:fn?fn.innerText.trim():''});
  });
  return JSON.stringify(out);
})()`;

const norm = s => (s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

function fields() {
  let v;
  try { v = evalJson(FIELDS_JS); } catch (e) { v = null; }
  if (!Array.isArray(v) || !v.length) {
    console.error('greenhouse: could not read the form (browser busy, or no page loaded?) — retry; check `agent-browser get url`');
    process.exit(2);
  }
  return v;
}

function find(all, label, kinds) {
  const want = norm(label);
  const pool = all.filter(f => kinds.includes(f.k));
  const score = f => { const l = norm(f.label);
    return l === want ? 0 : l.startsWith(want) ? 1 : l.includes(want) ? 2 + l.length / 1000 : 99; };
  const ranked = pool.map(f => ({ f, s: score(f) })).filter(x => x.s < 99).sort((a, b) => a.s - b.s);
  if (!ranked.length) {
    console.error(`greenhouse: no ${kinds.join('/')} field matching "${label}". Candidates:`);
    pool.slice(0, 15).forEach(f => console.error(`   ${f.label.slice(0, 70)}`));
    process.exit(3);
  }
  if (ranked.length > 1 && Math.floor(ranked[0].s) === Math.floor(ranked[1].s) && ranked[0].s >= 1) {
    console.error(`greenhouse: "${label}" is ambiguous:`);
    ranked.slice(0, 4).forEach(x => console.error(`   ${x.f.label.slice(0, 70)}`));
    process.exit(3);
  }
  return ranked[0].f;
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
function saveState(url, id, label, option) {
  const s = loadState();
  if (s.url !== url) { s.url = url; s.selects = {}; }
  s.selects[id] = { label, option };
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
}
const pageUrl = () => ab(['get', 'url']).trim().split('\n').pop();

const readSelect = id => evalJson(`(function(){var el=document.getElementById(${JSON.stringify(id)});
  if(!el) return JSON.stringify({gone:true});
  var c=el.closest('.select__container')||el.closest('.select-shell')||el.parentElement.parentElement.parentElement;
  var sv=c?c.querySelectorAll('.select__single-value,.select__multi-value__label'):[];
  return JSON.stringify({val:[].map.call(sv,function(x){return x.innerText.trim()}).join('; '),bad:el.getAttribute('aria-invalid')==='true'});})()`);

const listOptions = id => evalJson(`(function(){
  var l=document.querySelectorAll('[id^="react-select-'+${JSON.stringify(id)}+'-option-"]');
  return JSON.stringify([].map.call(l,function(o){return {id:o.id,t:o.innerText.replace(/\\s+/g,' ').trim()}}));})()`);

function pickOption(opts, want) {
  const w = norm(want);
  return opts.find(o => norm(o.t) === w)
    || opts.find(o => norm(o.t).startsWith(w))
    || opts.find(o => norm(o.t).includes(w))
    // Veeam-style "United States +1": compare with the dial code stripped
    || opts.find(o => norm(o.t.replace(/\s*\+\d[\d\s-]*$/, '')) === w);
}

function doSelect(f, option) {
  const sel = byId(f.id);
  ab(['click', sel]);
  sleep(600);
  let opts = listOptions(f.id);
  let hit = pickOption(opts, option);
  if (!hit) {
    // Async (School, Location) or long lists: type to filter, wait for results.
    ab(['fill', sel, option]);
    for (let i = 0; i < 12 && !hit; i++) {
      sleep(500);
      opts = listOptions(f.id);
      hit = pickOption(opts, option);
    }
  }
  if (!hit) {
    ab(['fill', sel, '']); sleep(400);
    const full = listOptions(f.id);
    if (full.length) opts = full;
    ab(['press', 'Escape']);
    return { ok: false, why: `no option "${option}"`, opts: opts.map(o => o.t) };
  }
  ab(['click', byId(hit.id)]);
  sleep(500);
  let r = readSelect(f.id);
  if (!r.val || r.bad) {
    process.stderr.write(`  (real click left ${r.val ? 'an invalid' : 'no'} value — retrying with native el.click())\n`);
    // Veeam fallback: native element click on a re-opened list.
    ab(['click', sel]); sleep(600);
    if (!listOptions(f.id).some(o => o.id === hit.id)) { ab(['fill', sel, option]); sleep(1500); }
    evalJson(`(function(){var o=document.getElementById(${JSON.stringify(hit.id)}); if(o) o.click(); return JSON.stringify(!!o);})()`);
    sleep(500);
    r = readSelect(f.id);
  }
  return { ok: !!r.val && !r.bad, val: r.val, bad: r.bad, chosen: hit.t };
}

// Attribute selector: safe for any id (leading digits, colons) without CSS escaping.
const byId = id => `[id="${id}"]`;

const [cmd, ...A] = process.argv.slice(2);

if (cmd === 'fields') {
  const all = fields();
  const showAll = A.includes('--all');
  let n = 0;
  for (const f of all) {
    if (!showAll && !f.req) continue;
    const flag = f.req && !f.val ? '!' : f.bad ? '?' : ' ';
    const opts = f.opts ? `  [${f.opts.slice(0, 6).join(' | ')}${f.opts.length > 6 ? ' …' : ''}]` : '';
    console.log(`${flag} ${f.k.padEnd(8)} ${f.label.slice(0, 64)}${f.val ? ' = ' + f.val.slice(0, 40) : ''}${opts}`);
    n++;
  }
  console.log(`-- ${all.length} fields, ${all.filter(f => f.req).length} required, ${all.filter(f => f.req && !f.val).length} required empty${showAll ? '' : ' (--all for optional)'}; ! empty-required ? invalid`);

} else if (cmd === 'set') {
  const f = find(fields(), A[0], ['text', 'email', 'tel', 'url', 'number', 'textarea', 'search']);
  ab(['fill', byId(f.id), A[1]]);
  const v = evalJson(`JSON.stringify(document.getElementById(${JSON.stringify(f.id)}).value)`);
  console.log(v === A[1] ? `ok ${f.label.slice(0, 50)}` : `MISMATCH ${f.label.slice(0, 50)} = ${String(v).slice(0, 40)}`);
  if (v !== A[1]) process.exit(1);

} else if (cmd === 'select') {
  const f = find(fields(), A[0], ['select']);
  const r = doSelect(f, A[1]);
  if (r.ok) {
    saveState(pageUrl(), f.id, f.label, A[1]);
    console.log(`ok ${f.label.slice(0, 50)} = ${r.val.slice(0, 50)}`);
  } else {
    console.log(`FAIL ${f.label.slice(0, 50)}: ${r.why || (r.bad ? 'still invalid' : 'no value stuck')}`);
    if (r.opts) console.log('   options: ' + r.opts.slice(0, 15).join(' | '));
    process.exit(1);
  }

} else if (cmd === 'options') {
  const f = find(fields(), A[0], ['select']);
  ab(['click', byId(f.id)]);
  sleep(600);
  const opts = listOptions(f.id);
  ab(['press', 'Escape']);
  if (!opts.length) { console.log(`(no static options for ${f.label.slice(0, 50)} - async search field; select with the real value)`); process.exit(1); }
  console.log(`${f.label.slice(0, 60)}:\n   ` + opts.map(o => o.t).join(' | '));

} else if (cmd === 'check') {
  const all = fields();
  const g = find(all, A[0], ['checkbox', 'radio']);
  const want = norm(A[1]);
  const r = evalJson(`(function(){
    var want=${JSON.stringify(want)}, lab=${JSON.stringify(norm(g.label))};
    var boxes=[].filter.call(document.querySelectorAll('input[type=checkbox],input[type=radio]'),function(el){
      var fs=el.closest('fieldset'); var t=fs?(fs.querySelector('legend')||fs).innerText.split('\\n')[0]:'';
      return t.toLowerCase().replace(/\\s+/g,' ').replace(/\\*$/,'').trim()===lab;});
    function txt(el){var l=el.id?document.querySelector('label[for="'+CSS.escape(el.id)+'"]'):el.closest('label');return (l?l.innerText:el.value).toLowerCase().replace(/\\s+/g,' ').trim();}
    var b=boxes.find(function(x){return txt(x)===want})||boxes.find(function(x){return txt(x).indexOf(want)===0})||boxes.find(function(x){return txt(x).indexOf(want)>=0});
    if(!b) return JSON.stringify({ok:false,opts:boxes.map(txt)});
    if(!b.checked) b.click();
    return JSON.stringify({ok:b.checked,t:txt(b)});})()`);
  if (r.ok) console.log(`ok ${g.label.slice(0, 40)} ✓ ${r.t.slice(0, 40)}`);
  else { console.log(`FAIL no option "${A[1]}" — options: ${(r.opts || []).join(' | ')}`); process.exit(1); }

} else if (cmd === 'file') {
  const all = fields();
  const f = find(all, A[0], ['file']);
  ab(['upload', byId(f.id), A[1]], 90000);
  const name = path.basename(A[1]);
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) {
    sleep(500);
    shown = fields().some(x => x.k === 'file' && norm(x.label) === norm(f.label) && x.val.includes(name.slice(0, 20)));
  }
  console.log(shown ? `ok upload ${name} → ${f.label}` : `UNCONFIRMED upload ${name} — ${f.label} shows no filename after 10 s`);
  if (!shown) process.exit(1);

} else if (cmd === 'verify') {
  const fix = A.includes('--fix');
  const url = pageUrl();
  const st = loadState();
  let all = fields();
  const reverted = st.url === url
    ? Object.entries(st.selects || {}).filter(([id]) => { const f = all.find(x => x.id === id); return f && !f.val; })
    : [];
  if (reverted.length) {
    console.log('REVERTED since set: ' + reverted.map(([, s]) => s.label.slice(0, 35)).join(' | '));
    if (fix) {
      for (const [id, s] of reverted) {
        const f = all.find(x => x.id === id);
        const r = doSelect(f, s.option);
        console.log(`  ${r.ok ? 'refilled' : 'FAILED'} ${s.label.slice(0, 40)}${r.ok ? ' = ' + r.val.slice(0, 40) : ''}`);
      }
      all = fields();
    }
  }
  const gaps = all.filter(f => f.req && !f.val);
  const invalid = all.filter(f => f.bad && f.val);
  console.log(`filled ${all.filter(f => f.val).length}/${all.length}`);
  if (gaps.length) console.log('MISSING REQUIRED: ' + gaps.map(f => f.label.slice(0, 40)).join(' | '));
  if (invalid.length) console.log('FILLED BUT INVALID: ' + invalid.map(f => f.label.slice(0, 40)).join(' | '));
  if (!gaps.length && !invalid.length) console.log('no required gaps');
  process.exit(gaps.length || invalid.length ? 1 : 0);

} else {
  console.log('usage: greenhouse.js fields [--all] | set <label> <text> | select <label> <option> | check <label> <option> | file <label> <path> | verify [--fix]');
  process.exit(cmd ? 1 : 0);
}
