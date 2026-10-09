#!/usr/bin/env node
/**
 * workday.js — Workday-specific driver for the apply pipeline.
 *
 *   workday.js auth [--pw-var ATS_<CO>_PW] [--email ADDR] [--dry-run]
 *                                            create account / sign in, report the real outcome
 *   workday.js select "<label>" "<option>" ["<sub-option>"] [--nth N]
 *     --nth picks among identically-labelled fields; without it an ambiguous
 *     label EXITS 5 rather than silently filling the first.
 *                                            commit a dropdown value and PROVE it stuck
 *   workday.js fields                         list every field: required, kind, current value
 *   workday.js experience [--replace] [--dry-run] [--data <json>]
 *                                            fill the whole My Experience page in one call
 *   workday.js selfid [--save]                fill Self Identify (CC-305) with TODAY's date from the
 *                                            browser clock; fixes the VPS|... crash
 *
 * Why it replaces workday-answer.sh + the 6d/6f snapshot recipe:
 *  - Fields are addressed by their LABEL, found in the DOM by Workday's stable
 *    data-automation-id attributes — not by snapshot index or ref, which renumber
 *    every time a popup opens (the root cause of earlier "value silently
 *    discarded" failures).
 *  - Nested menus ("How Did You Hear About Us" -> "Job Board" -> "LinkedIn") are one
 *    call: pass each level as its own argument. The inner level is polled for after
 *    the outer click, so no manual second open.
 *  - Virtualised lists that ignore typing ("Country Phone Code") are scrolled until
 *    the option renders, instead of parking.
 *  - Every select ends with blur + re-read; a value that did not survive is retried
 *    once from scratch and otherwise exits non-zero. Nothing is reported "ok" unread.
 *  - auth clicks Workday's `click_filter` overlay, which sits on top of the Create
 *    Account / Sign In buttons and swallows clicks aimed at the button itself — the
 *    cause of "account creation failed silently". It then waits for a real outcome.
 *
 * Credentials: new accounts use ATS_DEFAULT_EMAIL / ATS_DEFAULT_PW from the pipeline
 * .env (see pipeline-config.js). --pw-var / --email only for a tenant whose account was
 * created with other credentials. Secrets are never printed.
 *
 * Applicant data comes from the profile (profile.json, schema = profile.example.json);
 * --data <json> overrides it.
 *
 * Requires AGENT_BROWSER_SESSION (shared browser; an unpinned call hijacks another
 * applier's tab).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as P from './pipeline-config.js';

if (!process.env.AGENT_BROWSER_SESSION) {
  console.error('workday.js: AGENT_BROWSER_SESSION is not set — refusing to run.');
  process.exit(2);
}

const ab = (args, timeoutMs = 45000) => execFileSync(P.agentBrowser(), args, {
  encoding: 'utf8', timeout: timeoutMs, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = s => execFileSync('sleep', [String(s)]);

// agent-browser prints the eval result as a JSON string literal; unwrap it.
function evalJs(js) {
  const raw = ab(['eval', js]).trim();
  try { const v = JSON.parse(raw); return typeof v === 'string' ? v : JSON.stringify(v); }
  catch { return raw.replace(/^"|"$/g, ''); }
}
const evalJson = js => { const s = evalJs(js); try { return JSON.parse(s); } catch { return null; } };

// Shared in-page helpers, prepended to every eval.
const LIB = `
var N=function(s){return (s||'').replace(/[*\\u00a0]/g,' ').replace(/\\s+/g,' ').trim().toLowerCase();};
var vis=function(e){if(!e)return false;var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
var fieldLabel=function(c){var l=c.querySelector('label,legend');return l?l.innerText:(c.getAttribute('aria-label')||'');};
var fields=function(){return [...document.querySelectorAll('[data-automation-id^="formField-"]')].filter(vis);};
var kindOf=function(c){
  if(c.querySelector('button[aria-haspopup="listbox"]'))return 'button';
  if(c.querySelector('[data-uxi-widget-type="selectinput"],[data-automation-id="multiselectInputContainer"],[data-automation-id="searchBox"]'))return 'search';
  if(c.querySelector('input[type="checkbox"],input[type="radio"]'))return 'choice';
  if(c.querySelector('textarea'))return 'textarea';
  if(c.querySelector('input'))return 'text';
  return 'other';};
var valueOf=function(c){
  var k=kindOf(c);
  if(k==='button'){var b=c.querySelector('button[aria-haspopup="listbox"]');var t=b.innerText.trim();return /^select one$/i.test(t)?'':t;}
  if(k==='search'){return [...c.querySelectorAll('[data-automation-id="selectedItem"]')].map(function(x){return x.innerText.trim();}).join(' | ');}
  // Workday radios are React-controlled: aria-checked is authoritative, .checked may lag
  if(k==='choice'){return [...c.querySelectorAll('input')].filter(function(i){return i.checked||i.getAttribute('aria-checked')==='true';})
    .map(function(i){var l=i.id&&c.querySelector('label[for="'+i.id+'"]');return l?l.innerText.trim():'on';}).join(' | ');}
  var i=c.querySelector('input,textarea');return i?i.value:'';};
// Ambiguity tracking: a form had 3 language blocks each with
// identically-labelled Reading/Speaking/Writing Proficiency dropdowns. findField silently
// returned the FIRST every time, so select read a field that was already filled and reported
// "already set" while the 2nd and 3rd blocks were never answered. The applier believed it had
// answered them. Same failure class the option matcher was hardened against -
// a loose match hitting 2+ candidates must be visible, not silently resolved to DOM order.
// Default behaviour is UNCHANGED (still returns the first) so existing callers that rely on
// first-match keep working; the tie count is exposed for cmdSelect to refuse on, and nth
// (1-based) addresses a specific instance.
var findField=function(want,nth){
  want=N(want);var best=null,score=9,ties=[];
  fields().forEach(function(c){var l=N(fieldLabel(c));if(!l)return;
    var s=l===want?0:l.indexOf(want)===0?1:l.indexOf(want)>=0?2:9;
    if(s<score){score=s;best=c;ties=[c];}
    else if(s===score&&s<9){ties.push(c);}});
  window.__zwdFieldTies=ties.length;
  if(nth)return ties[nth-1]||null;
  return best;};
var options=function(){
  var sel='[data-automation-id="promptOption"],[role="listbox"] [role="option"]';
  // selected-value pills in OTHER fields also carry promptOption — never treat those as choices
  return [...document.querySelectorAll(sel)].filter(function(o){
    return vis(o)&&!o.closest('[data-automation-id="selectedItem"],[data-automation-id="selectedItemList"]');});};
var optText=function(o){return o.getAttribute('data-automation-label')||o.innerText||'';};
// Matching is UNIQUENESS-GATED at the loose tiers. The old third tier was a
// bare indexOf>=0, which once selected "I identify as a Veteran, just not a Protected
// Veteran" for the target "not a protected veteran" — the opposite self-identification, on a form
// under a truth certification. Workday's EEO/veteran/disability options are deliberately
// near-identical negations, so a loose match that hits 2+ distinct options must FAIL LOUDLY
// rather than silently take the first in DOM order.
// Note each real option has a decorative twin (promptOption) carrying identical text, so
// ambiguity is counted over DISTINCT normalised texts, never raw node count.
var distinctTexts=function(os){var t={};os.forEach(function(o){t[N(optText(o))]=1;});return Object.keys(t);};
var matchOpt=function(want){
  want=N(want);var os=options();
  var exact=os.filter(function(o){return N(optText(o))===want;});
  if(exact.length)return exact[0];            // exact text is unambiguous even with twins
  var pre=os.filter(function(o){return N(optText(o)).indexOf(want)===0;});
  if(distinctTexts(pre).length>1)return 'AMBIGUOUS';
  if(pre.length)return pre[0];
  var sub=os.filter(function(o){return N(optText(o)).indexOf(want)>=0;});
  if(distinctTexts(sub).length>1)return 'AMBIGUOUS';
  if(sub.length)return sub[0];
  return null;};
var ambiguousFor=function(want){
  want=N(want);var os=options();
  var m=os.filter(function(o){var x=N(optText(o));return x.indexOf(want)===0||x.indexOf(want)>=0;});
  return distinctTexts(m).join(' | ');};
var popup=function(){
  return document.querySelector('[data-automation-id="activeListContainer"]')||
         document.querySelector('[role="listbox"]');};
`;
const run = body => evalJs(`(function(){${LIB}${body}})()`);
const runJson = body => evalJson(`(function(){${LIB}return JSON.stringify((function(){${body}})());})()`);

function untag() { run(`document.querySelectorAll('[data-zwd]').forEach(function(e){e.removeAttribute('data-zwd');});return 'ok';`); }
// Real CDP click first; if the element never becomes actionable (zero-size input behind a
// selected pill, etc.) fall back to a synthetic pointer sequence rather than hanging 45 s.
function clickTag(tag) {
  try { ab(['click', `[data-zwd="${tag}"]`], 12000); }
  catch {
    run(`var e=document.querySelector('[data-zwd="${tag}"]');if(!e)return 'NONE';
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
        e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return 'ok';`);
  }
}

// ------------------------------------------------------------------ fields
function cmdFields() {
  const rows = runJson(`return fields().map(function(c){
    var req=!!c.querySelector('[aria-required="true"],[required]')||/\\*/.test(fieldLabel(c));
    return {req:req,kind:kindOf(c),label:fieldLabel(c).replace(/\\s+/g,' ').trim().slice(0,60),value:valueOf(c).slice(0,40)};});`) || [];
  let gaps = 0;
  for (const r of rows) {
    const gap = r.req && !r.value;
    if (gap) gaps++;
    console.log(`${gap ? '!' : r.req ? 'R' : ' '} ${r.kind.padEnd(8)} ${r.label.padEnd(60)} ${r.value}`);
  }
  console.log(`-- ${rows.length} fields, ${gaps} required still empty (marked !)`);
}

// ------------------------------------------------------------------ select
// Does a COMMITTED field value confirm the requested target? Exact, or target as a whole
// leading phrase. Never a bare substring (past defect): "I identify as a Veteran, just
// not a Protected Veteran" contains "not a protected veteran", so the old `includes()` check
// would confirm — and silently record — the opposite answer on a certified EEO field.
const norm = s => String(s || '').replace(/[* ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function valueMatches(value, target) {
  const v = norm(value), t = norm(target);
  if (!v || !t) return false;
  if (v === t) return true;
  if (v.indexOf(t) === 0) { const rest = v.slice(t.length); return rest === '' || /^[\s,(\-–—:/]/.test(rest); }
  return false;
}

function waitOption(want, { scroll = false, tries = 12 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = run(`var o=matchOpt(${JSON.stringify(want)});
      if(o==='AMBIGUOUS')return 'AMBIGUOUS '+ambiguousFor(${JSON.stringify(want)});
      if(o){o.setAttribute('data-zwd','opt');o.scrollIntoView({block:'center'});return 'FOUND '+optText(o);}
      var p=popup();
      if(${scroll} && p){var sc=p;for(var d=0;d<4&&sc&&sc.scrollHeight<=sc.clientHeight+2;d++)sc=sc.parentElement;
        if(sc&&sc!==document.body&&sc!==document.documentElement&&sc.scrollHeight>sc.clientHeight+2){var before=sc.scrollTop;sc.scrollTop+=sc.clientHeight*0.8;return sc.scrollTop===before?'END':'SCROLLED';}}
      return p?(options().length?'STATIC':'OPEN'):'NOPOPUP';`);
    if (r.startsWith('FOUND')) return r.slice(6);
    // Ambiguous is terminal, never retryable: more polling cannot make a query specific.
    // Surface the rival options so the caller can pass the full option text instead.
    if (r.startsWith('AMBIGUOUS')) {
      console.log(`AMBIGUOUS "${want}" matches multiple options: ${r.slice(10)}`);
      console.log('  -> pass the FULL option text; refusing to guess on a certified field.');
      return null;
    }
    // early END/STATIC can just mean options are still rendering; after a few polls it is final
    if ((r === 'END' || r === 'STATIC') && i >= 4) return null;
    sleep(r === 'SCROLLED' ? 0.3 : 0.5);
  }
  return null;
}

function listOptions() {
  return (runJson(`return options().slice(0,25).map(optText);`) || []).join(' | ');
}

function attemptSelect(label, levels) {
  levels = [...levels];
  untag();
  ab(['press', 'Escape']);
  const info = runJson(`var c=findField(${JSON.stringify(label)});if(!c)return null;
    c.setAttribute('data-zwd','field');var k=kindOf(c);
    var t=k==='button'?c.querySelector('button[aria-haspopup="listbox"]'):
          [...c.querySelectorAll('[data-automation-id="searchBox"],[data-uxi-widget-type="selectinput"],input')].find(vis)||
          c.querySelector('[data-automation-id="multiselectInputContainer"]');
    if(t)t.setAttribute('data-zwd','trigger');
    return {kind:k,label:fieldLabel(c).trim(),value:valueOf(c)};`);
  if (!info) {
    console.error(`NO FIELD "${label}". Fields on page:`);
    cmdFields();
    process.exit(3);
  }
  const target = levels[levels.length - 1];
  if (info.value && valueMatches(info.value, target)) {
    return { ok: true, value: info.value, already: true };
  }
  if (!['button', 'search'].includes(info.kind)) {
    console.error(`"${info.label}" is a ${info.kind} field, not a dropdown — use form.js set/pick.`);
    process.exit(3);
  }

  for (let depth = 0; depth < levels.length; depth++) {
    const want = levels[depth];
    if (depth === 0) {
      ab(['scrollintoview', '[data-zwd="trigger"]']);
      clickTag('trigger');
      sleep(0.8);
    }
    // 1) look without typing, scrolling a virtualised list (Country Phone Code ignores typing)
    if (depth > 0) {
      // Some tenants' "How Did You Hear" is flat: the first pick closes the menu and commits.
      const open = run(`return options().length?'OPEN':'CLOSED';`);
      if (open === 'CLOSED') {
        const v = run(`var c=findField(${JSON.stringify(label)});return c?valueOf(c):'';`);
        if (valueMatches(v, levels[depth - 1])) {
          console.log(`note: no sub-menu on this tenant; "${levels.slice(depth).join(' > ')}" not applicable`);
          levels = levels.slice(0, depth);
          break;
        }
      }
    }
    let hit = waitOption(want, { scroll: true, tries: depth === 0 ? 40 : 15 });
    // 2) searchable box: type to filter, then look again
    if (!hit && info.kind === 'search' && depth === 0) {
      run(`var c=document.querySelector('[data-zwd="field"]');var i=c&&[...c.querySelectorAll('input')].find(vis);
        document.querySelectorAll('[data-zwd="trigger"]').forEach(function(e){e.removeAttribute('data-zwd');});
        if(i)i.setAttribute('data-zwd','trigger');return i?'ok':'NOINPUT';`);
      ab(['fill', '[data-zwd="trigger"]', want]);
      ab(['press', 'Enter']);
      sleep(1);
      hit = waitOption(want, { tries: 10 });
    }
    if (!hit) {
      console.log(`NO OPTION "${want}" (level ${depth + 1}). Visible options: ${listOptions()}`);
      ab(['press', 'Escape']);
      process.exit(3);
    }
    clickTag('opt');
    run(`var o=document.querySelector('[data-zwd="opt"]');if(o)o.removeAttribute('data-zwd');return 'ok';`);
    sleep(1);
  }

  // Auto-drill (found live on a J&J tenant): the last requested level can itself be
  // a CATEGORY the caller had no way to name a leaf for -- J&J's "How Did You Hear
  // About Us?" -> "Company Web Site" drills into a single, unguessable leaf
  // ("careers.jnj.com") instead of committing. This is the root cause behind 6+ parked
  // Workday applications (J&J x2, Vanguard, NCR Atleos, Moog, Applied Materials): the
  // click "succeeds" (an option highlights) but no selectedItem chip ever lands, so
  // Save and Continue rejects the field as required. While nothing has committed yet
  // and a fresh option list is still open, keep drilling: prefer an option matching the
  // originally requested text, otherwise take the lone option (the common
  // category -> single-leaf case), up to 3 extra unrequested hops.
  // options() over-counts: each real option (data-automation-id="menuItem") has a
  // decorative twin (data-automation-id="promptOption", same text, not wired to any
  // handler) matched by the same selector, so a genuine single leaf reads as 2 DOM
  // nodes, not 1. Count DISTINCT normalised texts instead.
  const distinctOptionCount = () => Number(run(`var t={};options().forEach(function(o){t[N(optText(o))]=1;});return Object.keys(t).length;`)) || 0;
  let drilled = false;
  for (let hop = 0; hop < 3; hop++) {
    const got = run(`var c=findField(${JSON.stringify(label)});return c?valueOf(c):'';`);
    if (valueMatches(got, target)) break;
    const n = distinctOptionCount();
    if (!n) break; // nothing open to drill into -- let the caller see the failure below
    let hit = waitOption(target, { tries: 3 });
    if (!hit && n === 1) hit = run(`var os=options();if(!os.length)return null;os[0].setAttribute('data-zwd','opt');return optText(os[0]);`);
    if (!hit) break;
    clickTag('opt');
    run(`var o=document.querySelector('[data-zwd="opt"]');if(o)o.removeAttribute('data-zwd');return 'ok';`);
    drilled = true;
    sleep(1);
  }

  // blur on the field itself (Tab), never a nav link, then re-read after re-render
  ab(['press', 'Tab']);
  sleep(1);
  const value = run(`var c=findField(${JSON.stringify(label)});return c?valueOf(c):'';`);
  // A drilled leaf's own text (e.g. "careers.jnj.com") was never the requested target
  // ("Company Web Site") and can't be predicted, so any non-empty commit counts as a
  // match once auto-drill has fired; otherwise require the requested text itself.
  const ok = drilled ? !!value : valueMatches(value, target);
  return { ok, value };
}

function cmdSelect(label, levels) {
  // --nth N (1-based) addresses one of several identically-labelled fields.
  let nth = 0;
  const i = levels.indexOf('--nth');
  if (i >= 0) { nth = parseInt(levels[i + 1], 10) || 0; levels = levels.slice(0, i).concat(levels.slice(i + 2)); }
  if (!label || !levels.length) { console.error('usage: workday.js select "<label>" "<option>" ["<sub-option>"] [--nth N]'); process.exit(1); }

  // Refuse an ambiguous label rather than silently taking the first match. Seen live:
  // 3 identically-labelled proficiency dropdowns, select always hit the first and reported
  // "already set" while two fields stayed empty — a silent wrong-success on a form submitted
  // under a truth certification. A caller that genuinely wants instance k passes --nth k.
  if (!nth) {
    const ties = Number(run(`findField(${JSON.stringify(label)});return window.__zwdFieldTies||0;`)) || 0;
    if (ties > 1) {
      console.log(`AMBIGUOUS ${label}: ${ties} fields share this label — rerun with --nth 1..${ties} (refusing to guess)`);
      process.exit(5);
    }
  }
  if (nth) {
    const have = Number(run(`findField(${JSON.stringify(label)});return window.__zwdFieldTies||0;`)) || 0;
    if (nth > have) {
      console.log(`FAILED ${label}: --nth ${nth} requested but only ${have} field(s) match`);
      process.exit(5);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = attemptSelect(label, levels);
    if (r.ok) {
      console.log(`ok ${label} = ${r.value}${r.already ? ' (already set)' : attempt > 1 ? ' (on retry)' : ''}`);
      return;
    }
    console.error(`attempt ${attempt}: value after blur = "${r.value || ''}"`);
  }
  console.log(`FAILED ${label} -> ${levels.join(' > ')}: value did not survive two attempts`);
  process.exit(4);
}

// ------------------------------------------------------------------ auth
const env = () => P.env();

function pageState() {
  return runJson(`
    var q=function(id){var e=document.querySelector('[data-automation-id="'+id+'"]');return vis(e)?e:null;};
    var txt=document.body.innerText;
    // role=alert is also Workday's screen-reader announcer ("<title> page is loaded") — not an error.
    var err=[...document.querySelectorAll('[data-automation-id="errorMessage"],[role="alert"],[data-automation-id="inputAlert"]')]
      .filter(vis).map(function(e){return e.innerText.trim();})
      .filter(function(t){return t&&!/page is loaded$/i.test(t);}).join(' / ');
    var authed=!!document.querySelector('[data-automation-id="utilityButtonAccountTasksMenu"],[data-automation-id="navigationItem-Candidate Home"],[data-automation-id="accountSettingsButton"]');
    var st=q('verifyPassword')?'create':(q('password')&&q('signInSubmitButton'))?'signin':
      (q('password')?'signin':null);
    // Social sign-in chooser (Google / LinkedIn / "Sign in with email") hides the email form
    if(!st&&q('SignInWithEmailButton'))st='chooser';
    // The apply flow's progress bar is present on the Create Account/Sign In step too
    var step=q('progressBarActiveStep');
    var onAuthStep=!!q('signInContent')||(step&&/sign in|create account/i.test(step.innerText));
    if(!st&&/verify your (email|account)|verification (email|link)|check your email/i.test(txt))st='verify';
    if(!st&&authed)st='in';
    if(!st&&onAuthStep)st='signin-pending';
    if(!st&&(q('progressBar')||q('applyFlowPage')||q('myInformation')||/my information|my experience|application questions/i.test(txt)))st='in';
    if(!st&&(q('utilityButtonSignIn')||q('signInLink')))st='landing';
    return {state:st||'unknown',error:err.slice(0,200),hasCreateLink:!!q('createAccountLink')};`) || { state: 'unknown' };
}

// Workday puts a transparent div[data-automation-id="click_filter"] over submit buttons.
function tagSubmit(buttonId) {
  return run(`var b=document.querySelector('[data-automation-id="${buttonId}"]');if(!b)return 'NONE';
    var p=b.parentElement,f=null;
    for(var i=0;i<3&&p&&!f;i++){f=p.querySelector('[data-automation-id="click_filter"]');p=p.parentElement;}
    (f&&vis(f)?f:b).setAttribute('data-zwd','submit');return f?'FILTER':'BUTTON';`);
}

function waitOutcome(fromState, seconds = 20) {
  let s;
  for (let i = 0; i < seconds; i++) {
    sleep(1);
    s = pageState();
    if (s.error || s.state !== fromState) return s;
  }
  return s;
}

function submitForm(buttonId, fromState) {
  untag();
  const how = tagSubmit(buttonId);
  if (how === 'NONE') return { state: fromState, error: `no ${buttonId} on page` };
  clickTag('submit');
  let s = waitOutcome(fromState);
  if (!s.error && s.state === fromState) {
    // silent no-op: try the other click target once (button vs overlay), then give up loudly
    untag();
    run(`var b=document.querySelector('[data-automation-id="${buttonId}"]');
      var f=document.querySelector('[data-automation-id="click_filter"]');
      ${how === 'FILTER' ? 'b' : '(f||b)'}.setAttribute('data-zwd','submit');return 'ok';`);
    clickTag('submit');
    s = waitOutcome(fromState);
    if (!s.error && s.state === fromState) s.silent = true;
  }
  return s;
}

function fillCreds(email, pw, create) {
  ab(['fill', '[data-automation-id="email"]', email]);
  ab(['fill', '[data-automation-id="password"]', pw]);
  if (create) {
    ab(['fill', '[data-automation-id="verifyPassword"]', pw]);
    run(`var c=document.querySelector('input[data-automation-id="createAccountCheckbox"]');
      if(c&&!c.checked){c.setAttribute('data-zwd','agree');return 'TAG';}return 'ok';`) === 'TAG' &&
      clickTag('agree');
  }
}

function report(s, prefix) {
  if (s.state === 'in' || s.state === 'landing' && !s.error) return console.log(`${prefix}LOGGED_IN`), 0;
  if (s.state === 'verify') return console.log(`${prefix}NEEDS_EMAIL_VERIFY — fetch the link with inbox-code.py, open it, then rerun auth`), 5;
  if (s.silent) return console.log(`${prefix}SILENT_FAIL — submit had no effect on both click targets; page state ${s.state}`), 6;
  return console.log(`${prefix}ERROR state=${s.state} ${s.error || ''}`), 7;
}

function cmdAuth(args) {
  const e = env();
  // Tenants registered under another address: pass --email.
  const email = args.includes('--email') ? args[args.indexOf('--email') + 1] : e.ATS_DEFAULT_EMAIL;
  const dry = args.includes('--dry-run');
  const pwVar = args.includes('--pw-var') ? args[args.indexOf('--pw-var') + 1] : 'ATS_DEFAULT_PW';
  const pw = e[pwVar];
  if (!email || !pw) { console.error(`workday.js: ATS_DEFAULT_EMAIL or ${pwVar} missing from the pipeline .env`); process.exit(2); }

  let s = pageState();
  if (s.state === 'in') return process.exit(report(s, ''));
  for (let i = 0; i < 6 && s.state === 'signin-pending'; i++) { sleep(1); s = pageState(); }
  if (s.state === 'chooser') {
    untag();
    run(`document.querySelector('[data-automation-id="SignInWithEmailButton"]').setAttribute('data-zwd','em');return 'ok';`);
    clickTag('em'); sleep(2); s = pageState();
  }
  if (s.state === 'landing') {
    untag();
    run(`var b=document.querySelector('[data-automation-id="utilityButtonSignIn"],[data-automation-id="signInLink"]');if(b)b.setAttribute('data-zwd','si');return 'ok';`);
    clickTag('si'); sleep(2); s = pageState();
  }

  // Existing tenant credentials given -> sign in only. Otherwise create first, fall back to sign in.
  const wantCreate = pwVar === 'ATS_DEFAULT_PW';
  if (wantCreate && s.state === 'signin' && s.hasCreateLink) {
    untag();
    run(`document.querySelector('[data-automation-id="createAccountLink"]').setAttribute('data-zwd','cl');return 'ok';`);
    clickTag('cl'); sleep(2); s = pageState();
  }

  if (s.state === 'create') {
    fillCreds(email, pw, true);
    if (dry) { untag(); console.log(`dry-run: create form filled, submit target = ${tagSubmit('createAccountSubmitButton')}`); return; }
    s = submitForm('createAccountSubmitButton', 'create');
    if (s.state === 'create' && /already|exists|in use/i.test(s.error || '')) {
      console.log('account already exists for this email — signing in instead');
      untag();
      run(`var l=document.querySelector('[data-automation-id="signInLink"]');if(l)l.setAttribute('data-zwd','sl');return l?'ok':'NONE';`) === 'ok' && clickTag('sl');
      sleep(2); s = pageState();
    } else {
      return process.exit(report(s, 'create: '));
    }
  }

  if (s.state === 'signin') {
    fillCreds(email, pw, false);
    if (dry) { untag(); console.log(`dry-run: sign-in form filled, submit target = ${tagSubmit('signInSubmitButton')}`); return; }
    s = submitForm('signInSubmitButton', 'signin');
    return process.exit(report(s, 'signin: '));
  }
  process.exit(report(s, ''));
}

// ------------------------------------------------------------------ experience
/*
 * workday.js experience [--replace] [--dry-run] [--data <profile.json>]
 *
 * Fills the whole "My Experience" page in one invocation: Work Experience
 * (exactly the profile's entries, in profile order), Education and Languages when those
 * sections exist. Values come from the profile (profile.json; experiences, education,
 * languages). Each panel is filled by ONE in-page eval; real clicks/keystrokes
 * are used only as a fallback when an in-page write does not read back.
 *
 * Reconcile model: panel i is rewritten to profile entry i (autofilled / garbage /
 * duplicate panels get overwritten), surplus panels are deleted from the end, missing
 * ones are added with "Add"/"Add Another". --replace first deletes every deletable panel
 * and adds fresh ones (use it when an edited panel keeps misbehaving).
 *
 * Commit rules found live on a wd1 tenant:
 *  - text/textarea: uncontrolled React (onInput + onBlur) -> native value setter,
 *    input + change events, focusout/blur.
 *  - From/To dateSectionMonth/Year spinbuttons: native setter + input event commits;
 *    the field's "current value is M/YYYY" help text is React state, so it is the read-back.
 *    Write the YEAR before the month: on an empty widget a month written first becomes a year.
 *  - Verified end to end: after Save and Continue, a fresh "Continue Application" load showed
 *    exactly the 7 entries, education and languages as written (descriptions byte-identical),
 *    including a 17 -> 7 cleanup (10 deletes).
 *  - NEVER run this on a My Experience page reached with the Back button: Back renders a partial,
 *    stale entry list; "adding" the apparently missing entries then saves server DUPLICATES
 *    (one tenant accumulated 17). Reach the page forward, or reload + Continue Application.
 *    (`agent-browser type "022026"` drops keys; single `press` per digit works = fallback.)
 *  - listbox buttons: in-page .click() opens the list and selects the option.
 */
function pageLib() {
  /* eslint-disable no-undef */ // runs in the page; N, vis, fieldLabel, kindOf, valueOf come from LIB
  const W = ms => new Promise(r => setTimeout(r, ms));
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.blur();
  };
  const HEAD = {
    work: /^(work experience|work history|employment history|employment|professional experience|experience)$/,
    edu: /^(education|educational background|education history)$/,
    lang: /^(languages?|language skills|language proficiency)$/,
  };
  const KEYS = { work: ['jobTitle', 'companyName'], edu: ['schoolName', 'school', 'degree'], lang: ['language'] };
  const ffSel = id => `[data-automation-id="formField-${id}"]`;
  const section = kind => {
    const keySel = KEYS[kind].map(ffSel).join(',');
    const hs = [...document.querySelectorAll('h2,h3,h4,legend')].filter(h => vis(h) && HEAD[kind].test(N(h.innerText)));
    for (const h of hs) {
      const g = h.closest('[role="group"]');
      if (g && g !== document.body) return g;
      let p = h.parentElement;
      for (let k = 0; k < 5 && p && p !== document.body; k++, p = p.parentElement) {
        if (p.querySelector(keySel)) return p;
        if (p.querySelectorAll('[data-automation-id="add-button"]').length === 1) return p;
      }
    }
    const f = document.querySelector(keySel);
    return f ? (f.closest('[role="group"][aria-labelledby$="-section"]') || null) : null;
  };
  const keyOf = (sec, kind) => KEYS[kind].find(id => sec.querySelector(ffSel(id)));
  const panels = kind => {
    const sec = section(kind);
    if (!sec) return [];
    const key = keyOf(sec, kind);
    if (!key) return [];
    const out = [];
    for (const f of sec.querySelectorAll(ffSel(key))) {
      if (!vis(f)) continue;
      let p = f;
      while (p.parentElement && p.parentElement !== sec &&
             p.parentElement.querySelectorAll(ffSel(key)).length === 1) p = p.parentElement;
      if (!out.includes(p)) out.push(p);
    }
    return out;
  };
  const ff = (panel, ...ids) => { for (const id of ids) { const c = panel.querySelector(ffSel(id)); if (c && vis(c)) return c; } return null; };
  const deleteBtn = panel => [...panel.querySelectorAll('button')].find(b => vis(b) &&
    (b.getAttribute('data-automation-id') === 'panel-set-delete-button' || /^delete$/i.test(b.innerText.trim())));
  const addBtn = sec => [...sec.querySelectorAll('[data-automation-id="add-button"]')].filter(vis).pop() ||
    [...sec.querySelectorAll('button')].filter(b => vis(b) && /^add( another)?$/i.test(b.innerText.trim())).pop();
  const loading = sec => !!sec && [...sec.querySelectorAll('div,span')].some(e => !e.childElementCount && vis(e) && e.textContent.trim() === 'Loading');
  const readDate = c => {
    const help = [...c.querySelectorAll('[id^="helpText-"]')].map(e => e.textContent).find(t => /current value is/i.test(t));
    const m = help && help.match(/(?:(\d{1,2})\/)?(\d{4})\s*$/);
    if (m) return m[1] ? `${m[2]}-${m[1].padStart(2, '0')}` : m[2];
    const mi = c.querySelector('[data-automation-id="dateSectionMonth-input"]');
    const yi = c.querySelector('[data-automation-id="dateSectionYear-input"]');
    if (yi) return mi ? (mi.value && yi.value ? `${yi.value}-${mi.value.padStart(2, '0')}` : '') : yi.value;
    const t = c.querySelector('input');
    const x = t && t.value.match(/^(\d{1,2})\/(\d{4})$/);
    return x ? `${x[2]}-${x[1].padStart(2, '0')}` : (t ? t.value : '');
  };
  const setDate = async (c, ym) => {
    const mi = c.querySelector('[data-automation-id="dateSectionMonth-input"]');
    const yi = c.querySelector('[data-automation-id="dateSectionYear-input"]');
    const want = mi || !yi ? ym : ym.slice(0, 4);
    if (readDate(c) === want) return want;
    // YEAR FIRST: on an empty widget ("MM/YYYY") a month written first is taken as a year
    // ("5" -> MM/2005). Year-then-month works on empty and filled widgets alike (verified live).
    if (yi) { setVal(yi, ym.slice(0, 4)); await W(60); }
    if (mi) { setVal(mi, String(+ym.slice(5, 7))); await W(60); }
    if (mi && readDate(c) !== want) { setVal(mi, String(+ym.slice(5, 7))); await W(80); }
    if (!mi && !yi) { const t = c.querySelector('input'); if (t) setVal(t, `${ym.slice(5, 7)}/${ym.slice(0, 4)}`); }
    await W(80);
    return readDate(c);
  };
  const isChecked = i => i.checked || i.getAttribute('aria-checked') === 'true';
  const setCheck = async (c, want) => {
    const i = c.querySelector('input[type="checkbox"]');
    if (!i) return false;
    if (isChecked(i) !== want) { i.click(); await W(350); }
    return isChecked(i) === want;
  };
  const lists = () => [...document.querySelectorAll('[role="listbox"],[data-automation-id="activeListContainer"]')]
    .filter(l => vis(l) && l.getAttribute('data-automation-id') !== 'selectedItemList' && !l.closest('[data-automation-id="selectedItemList"]'));
  const optsIn = l => [...l.querySelectorAll('[role="option"],[data-automation-id="promptOption"]')]
    .filter(o => vis(o) && !o.closest('[data-automation-id="selectedItem"]'));
  const rankOf = (t, prefs) => { t = N(t); for (let k = 0; k < prefs.length; k++) if (new RegExp(prefs[k], 'i').test(t)) return k; return 99; };
  const scroller = l => { let s = l; for (let d = 0; d < 4 && s && s.scrollHeight <= s.clientHeight + 2; d++) s = s.parentElement; return s && s !== document.body && s.scrollHeight > s.clientHeight + 2 ? s : null; };
  const closeLists = () => { const a = document.activeElement; if (a) a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); };
  // Open a listbox button, choose the best-ranked option (prefs = regex sources, best first).
  // highest: when nothing ranks, take the option with the largest leading number ("5 - Fluent").
  const pickButton = async (btn, prefs, { highest = false } = {}) => {
    const id = btn.id;
    const cur = btn.innerText.trim();
    if (rankOf(cur, prefs) === 0) return { ok: true, value: cur, already: true };
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    // A freshly added panel's list renders "Select One" first and fetches the real options
    // a moment later (seen live on a languages panel): wait for real options, then for the count to settle.
    const real = x => optsIn(x).filter(o => !/^select one$/i.test(o.innerText.trim())).length;
    let l = null;
    for (let t = 0; t < 50 && !(l && real(l)); t++) { await W(100); l = lists().find(x => optsIn(x).length); }
    if (!l) return { ok: false, why: 'list did not open', id };
    for (let t = 0, n = -1; t < 10 && real(l) !== n; t++) { n = real(l); await W(120); }
    let bestText = null, bestRank = 99;
    const seen = [];
    const sc = scroller(l);
    for (let s = 0; s < 40; s++) {
      for (const o of optsIn(l)) {
        const t = o.innerText.trim();
        if (!seen.includes(t)) seen.push(t);
        const r = rankOf(t, prefs);
        if (r < bestRank) { bestRank = r; bestText = t; }
      }
      if (bestRank === 0 || !sc) break;
      const b4 = sc.scrollTop; sc.scrollTop += sc.clientHeight * 0.8; await W(120);
      if (sc.scrollTop === b4) break;
    }
    if (bestRank === 99 && highest) {
      const nums = seen.map(t => [t, parseFloat(t)]).filter(x => !isNaN(x[1])).sort((a, b) => b[1] - a[1]);
      if (nums.length) bestText = nums[0][0];
    }
    if (!bestText) { closeLists(); return { ok: false, why: 'no matching option', options: seen.slice(0, 30), id }; }
    if (N(bestText) === N(cur)) { closeLists(); return { ok: true, value: cur, already: true }; }
    if (sc) { sc.scrollTop = 0; await W(80); }
    let o = null;
    for (let s = 0; s < 40 && !o; s++) {
      o = optsIn(l).find(x => x.innerText.trim() === bestText);
      if (!o && sc) { const b4 = sc.scrollTop; sc.scrollTop += sc.clientHeight * 0.8; await W(120); if (sc.scrollTop === b4) break; }
    }
    if (!o) { closeLists(); return { ok: false, why: `option "${bestText}" vanished`, id }; }
    o.scrollIntoView({ block: 'center' });
    o.click();
    for (let t = 0; t < 10; t++) { await W(100); const b = document.getElementById(id) || btn; if (N(b.innerText) === N(bestText)) break; }
    const now = (document.getElementById(id) || btn).innerText.trim();
    if (lists().length) closeLists();
    return { ok: N(now) === N(bestText), value: now, want: bestText, id };
  };
  return { W, setVal, section, panels, ff, deleteBtn, addBtn, loading, readDate, setDate, setCheck, isChecked, pickButton, lists, optsIn, rankOf, closeLists };
}

// Run fn(X, args) in the page, X = pageLib(). fn must be self-contained (it is stringified).
function runPage(fn, args = {}, timeoutMs = 60000) {
  const js = `(async function(){${LIB}var X=(${pageLib.toString()})();` +
    `try{return JSON.stringify(await (${fn.toString()})(X,${JSON.stringify(args)}));}` +
    `catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
  const raw = ab(['eval', js], timeoutMs).trim();
  let s = raw;
  try { const v = JSON.parse(raw); s = typeof v === 'string' ? v : JSON.stringify(v); } catch { /* raw */ }
  try { return JSON.parse(s); } catch { return { error: `unparseable eval result: ${s.slice(0, 200)}` }; }
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Option-text preferences per language (regex sources, tried in order). Any language not
// listed falls back to ^<language>$ then ^<language> (see fillLangPanel).
const LANG_PREFS = {
  english: ['^english$', '^english \\((us|united states|american)', '^english'],
  spanish: ['^spanish$', '^spanish \\(', '^espa(n|ñ)ol', '^spanish'],
  french: ['^french$', '^french \\(', '^fran(c|ç)ais', '^french'],
  german: ['^german$', '^german \\(', '^deutsch', '^german'],
  portuguese: ['^portuguese$', '^portuguese \\((brazil|brazilian)', '^portuguese'],
  chinese: ['^chinese$', '^chinese \\(mandarin\\)$', '^mandarin( chinese)?$', '^chinese[ -]+mandarin', 'mandarin', '^chinese'],
  mandarin: ['^chinese \\(mandarin\\)$', '^mandarin( chinese)?$', '^chinese[ -]+mandarin', 'mandarin', '^chinese$', '^chinese'],
  cantonese: ['^chinese \\(cantonese\\)$', '^cantonese', 'cantonese'],
  japanese: ['^japanese$', '^japanese'],
  korean: ['^korean$', '^korean'],
  hindi: ['^hindi$', '^hindi'],
};
const LEVEL_PREFS = {
  native: ['native', 'bilingual', 'mother tongue', '^fluent$', 'fluent', 'full professional', 'expert', 'advanced'],
  fluent: ['^fluent$', 'fluent', 'full professional', 'advanced', 'expert', 'proficient'],
};
const DEGREE_PREFS = ["^bachelor'?s?( degree)?$", '^bachelor of science$', '^b\\.? ?s\\.?$', 'bachelor.*science', "^bachelor'?s", '^bachelor(?!.*\\b(arts|fine|business|commerce|laws)\\b)', 'bachelor'];

function waitSections(maxS = 25) {
  let st;
  for (let i = 0; i < maxS * 2; i++) {
    st = runPage(X => {
      const out = {};
      for (const k of ['work', 'edu', 'lang']) {
        const sec = X.section(k);
        out[k] = sec ? { present: true, count: X.panels(k).length, loading: X.loading(sec) } : { present: false, count: 0 };
      }
      return out;
    });
    if (!st.error && st.work.present && !['work', 'edu', 'lang'].some(k => st[k].loading)) return st;
    sleep(0.5);
  }
  return st;
}

function describePanels(kind) {
  return runPage((X, { kind }) => X.panels(kind).map(p => {
    const v = (...ids) => { const c = X.ff(p, ...ids); return c ? valueOf(c) : ''; };
    if (kind === 'work') return `${v('jobTitle')} @ ${v('companyName')}`;
    if (kind === 'edu') return `${v('schoolName', 'school')} / ${v('degree')}`;
    return `${v('language')}`;
  }), { kind });
}

// Real click on an element tagged in the page (fallback for in-page clicks that didn't take).
function realClickTagged(tagJs, tag) {
  untag();
  const r = run(`${tagJs}`);
  if (r !== 'ok') return false;
  try { ab(['scrollintoview', `[data-zwd="${tag}"]`], 10000); } catch { /* ignore */ }
  clickTag(tag);
  return true;
}

function panelCountChange(kind, from, dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const n = runPage((X, { kind }) => X.panels(kind).length, { kind });
    if (typeof n === 'number' && (dir > 0 ? n > from : n < from)) return n;
    sleep(0.3);
  }
  return from;
}

function addPanel(kind) {
  const r = runPage(async (X, { kind }) => {
    const sec = X.section(kind);
    if (!sec) return { error: 'no section' };
    const before = X.panels(kind).length;
    const b = X.addBtn(sec);
    if (!b) return { error: 'no Add button' };
    b.scrollIntoView({ block: 'center' });
    b.click();
    for (let t = 0; t < 30; t++) { await X.W(100); if (X.panels(kind).length > before && !X.loading(sec)) break; }
    return { before, after: X.panels(kind).length };
  }, { kind });
  if (r.error) return { ok: false, why: r.error };
  if (r.after > r.before) return { ok: true, count: r.after };
  // fallback: real click
  realClickTagged(`var X=(${pageLib.toString()})();var s=X.section(${JSON.stringify(kind)});var b=s&&X.addBtn(s);if(!b)return 'NONE';b.setAttribute('data-zwd','add');return 'ok';`, 'add');
  const n = panelCountChange(kind, r.before, +1);
  return { ok: n > r.before, count: n, why: n > r.before ? '' : 'Add click had no effect' };
}

function deletePanel(kind, idx) {
  const r = runPage(async (X, { kind, idx }) => {
    const ps = X.panels(kind);
    const p = ps[idx];
    if (!p) return { error: `no panel ${idx + 1}` };
    const b = X.deleteBtn(p);
    if (!b) return { error: 'not deletable', noDelete: true };
    b.scrollIntoView({ block: 'center' });
    b.click();
    for (let t = 0; t < 30; t++) { await X.W(100); if (X.panels(kind).length < ps.length) break; }
    return { before: ps.length, after: X.panels(kind).length };
  }, { kind, idx });
  if (r.error) return { ok: false, why: r.error, noDelete: r.noDelete };
  if (r.after < r.before) return { ok: true, count: r.after };
  realClickTagged(`var X=(${pageLib.toString()})();var p=X.panels(${JSON.stringify(kind)})[${idx}];var b=p&&X.deleteBtn(p);if(!b)return 'NONE';b.setAttribute('data-zwd','del');return 'ok';`, 'del');
  const n = panelCountChange(kind, r.before, -1);
  return { ok: n < r.before, count: n, why: n < r.before ? '' : 'Delete click had no effect' };
}

// Make a section hold exactly `want` panels. Returns { ok, notes[] }.
function reconcileCount(kind, want, replace) {
  const notes = [];
  let n = runPage((X, { kind }) => X.panels(kind).length, { kind });
  if (replace) {
    for (let idx = n - 1; idx >= 0; idx--) {
      const d = deletePanel(kind, idx);
      if (d.ok) n = d.count;
      else if (!d.noDelete) notes.push(`delete ${kind} ${idx + 1}: ${d.why}`);
    }
  }
  while (n > want) {
    const d = deletePanel(kind, n - 1);
    if (!d.ok) { notes.push(`delete ${kind} ${n}: ${d.why}`); break; }
    n = d.count;
  }
  while (n < want) {
    const ta = Date.now();
    const a = addPanel(kind);
    if (process.env.PIPELINE_DEBUG) console.error(`[debug] add ${kind}: ${JSON.stringify(a)} ${Date.now() - ta} ms`);
    if (!a.ok) { notes.push(`add ${kind}: ${a.why}`); break; }
    n = a.count;
  }
  return { ok: n === want, count: n, notes };
}

// Real-keystroke fallback for a date that did not read back (month digits auto-advance to year).
function realDate(kind, idx, fids, ym) {
  untag();
  const how = run(`var X=(${pageLib.toString()})();var p=X.panels(${JSON.stringify(kind)})[${idx}];
    var c=p&&X.ff(p,${fids.map(f => JSON.stringify(f)).join(',')});if(!c)return 'NONE';
    var m=c.querySelector('[data-automation-id="dateSectionMonth-display"]')||c.querySelector('[data-automation-id="dateSectionMonth-input"]');
    var y=c.querySelector('[data-automation-id="dateSectionYear-display"]')||c.querySelector('[data-automation-id="dateSectionYear-input"]');
    (m||y||c.querySelector('input')).setAttribute('data-zwd','date');return m?'MY':y?'Y':'TEXT';`);
  if (how === 'NONE') return '';
  try { ab(['scrollintoview', '[data-zwd="date"]'], 10000); } catch { /* ignore */ }
  clickTag('date');
  const keys = how === 'MY' ? `${ym.slice(5, 7)}${ym.slice(0, 4)}` : how === 'Y' ? ym.slice(0, 4) : `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
  if (how === 'TEXT') { ab(['press', 'Meta+a']); ab(['press', 'Backspace']); }
  for (const k of keys) ab(['press', k], 10000);
  ab(['press', 'Tab']);
  sleep(0.4);
  return run(`var X=(${pageLib.toString()})();var p=X.panels(${JSON.stringify(kind)})[${idx}];
    var c=p&&X.ff(p,${fids.map(f => JSON.stringify(f)).join(',')});return c?X.readDate(c):'';`);
}

// Real-click fallback for a listbox button: open it, click the option whose text is `want`.
function realPick(btnId, want) {
  untag();
  if (run(`var b=document.getElementById(${JSON.stringify(btnId)});if(!b)return 'NONE';b.setAttribute('data-zwd','rb');return 'ok';`) !== 'ok') return false;
  try { ab(['scrollintoview', '[data-zwd="rb"]'], 10000); } catch { /* ignore */ }
  clickTag('rb');
  sleep(0.8);
  if (!waitOption(want, { scroll: true, tries: 15 })) { ab(['press', 'Escape']); return false; }
  clickTag('opt');
  sleep(0.8);
  return run(`var b=document.getElementById(${JSON.stringify(btnId)});return b?b.innerText.trim():'';`).toLowerCase() === want.toLowerCase();
}

// Multiselect / typeahead prompt (Field of Study, School on some tenants): type, Enter, click.
function searchPick(kind, idx, fids, text, prefs) {
  const tagJs = extra => `var X=(${pageLib.toString()})();var p=X.panels(${JSON.stringify(kind)})[${idx}];
    var c=p&&X.ff(p,${fids.map(f => JSON.stringify(f)).join(',')});if(!c)return 'NONE';${extra}`;
  // drop pills that don't match, report if one already matches
  const pre = run(tagJs(`var pills=[...c.querySelectorAll('[data-automation-id="selectedItem"]')];
    var pr=${JSON.stringify(prefs)};var good=pills.some(function(x){return X.rankOf(x.innerText,pr)<99;});
    pills.forEach(function(x){if(X.rankOf(x.innerText,pr)===99){var d=x.querySelector('[data-automation-id="DELETE_charm"]');if(d)d.click();}});
    if(good)return 'HAVE';
    var i=[...c.querySelectorAll('input')].find(vis);if(!i)return 'NOINPUT';i.setAttribute('data-zwd','sin');return 'ok';`));
  if (pre === 'HAVE') return { ok: true, already: true };
  if (pre !== 'ok') return { ok: false, why: pre };
  ab(['fill', '[data-zwd="sin"]', text]);
  ab(['press', 'Enter']);
  let tagged = 'NOOPT';
  for (let t = 0; t < 10 && tagged !== 'ok'; t++) {
    sleep(0.4);
    // A search with a single hit is auto-selected on Enter (e.g. "Computer and Information Science")
    const auto = run(tagJs(`var pr=${JSON.stringify(prefs)};var pills=[...c.querySelectorAll('[data-automation-id="selectedItem"]')];
      if(pills.some(function(x){return X.rankOf(x.innerText,pr)<99;}))return 'HAVE:'+valueOf(c);
      if(pills.length){pills.forEach(function(x){var d=x.querySelector('[data-automation-id="DELETE_charm"]');if(d)d.click();});return 'WRONG:'+pills.map(function(x){return x.innerText.trim();}).join(' | ');}
      return 'NONE';`));
    if (auto.startsWith('HAVE:')) { try { ab(['press', 'Escape']); } catch { /* ignore */ } return { ok: true, value: auto.slice(5) }; }
    if (auto.startsWith('WRONG:')) return { ok: false, why: `search auto-selected "${auto.slice(6)}" (removed; not an accepted match)` };
    tagged = run(`var pr=${JSON.stringify(prefs)};var X=(${pageLib.toString()})();var best=null,br=99;
      X.lists().forEach(function(l){X.optsIn(l).forEach(function(o){var r=X.rankOf(o.innerText,pr);if(r<br){br=r;best=o;}});});
      if(!best)return 'NOOPT';document.querySelectorAll('[data-zwd="sopt"]').forEach(function(e){e.removeAttribute('data-zwd');});
      best.setAttribute('data-zwd','sopt');best.scrollIntoView({block:'center'});return 'ok';`);
  }
  if (tagged !== 'ok') {
    const seen = run(`var X=(${pageLib.toString()})();return X.lists().map(function(l){return X.optsIn(l).slice(0,10).map(function(o){return o.innerText.trim();}).join(' | ');}).join(' || ');`);
    ab(['press', 'Escape']);
    return { ok: false, why: `no option for "${text}"${seen ? `; saw: ${seen.slice(0, 160)}` : ''}` };
  }
  clickTag('sopt');
  sleep(0.8);
  const v = run(tagJs(`return valueOf(c);`));
  try { ab(['press', 'Escape']); } catch { /* ignore */ }
  return { ok: new RegExp(prefs.join('|'), 'i').test(v), value: v };
}

function fillWorkPanel(idx, e) {
  return runPage(async (X, { idx, e }) => {
    const p = X.panels('work')[idx];
    if (!p) return { error: `panel ${idx + 1} missing` };
    p.scrollIntoView({ block: 'center' });
    const r = {};
    const txt = async (key, want, ...ids) => {
      const c = X.ff(p, ...ids);
      if (!c) { r[key] = want ? 'n/a' : 'ok'; return; }
      const i = c.querySelector('textarea') || c.querySelector('input');
      if (!i) { r[key] = 'no input'; return; }
      if (i.value.replace(/\r\n/g, '\n') !== want) { X.setVal(i, want); await X.W(40); }
      r[key] = i.value.replace(/\r\n/g, '\n') === want ? 'ok' : `got "${i.value.slice(0, 30)}"`;
    };
    await txt('title', e.title, 'jobTitle', 'title');
    await txt('company', e.company, 'companyName', 'company');
    // Location rule: profile locationOptional "omit" -> blank unless the field is required.
    const locC = X.ff(p, 'location');
    const locReq = !!locC && (!!locC.querySelector('[aria-required="true"],[required]') || /\*/.test(fieldLabel(locC)));
    await txt('location', e.locationOptional === 'omit' && !locReq ? '' : (e.location || ''), 'location');
    const cw = X.ff(p, 'currentlyWorkHere', 'currentlyWorkingHere');
    if (cw) r.current = (await X.setCheck(cw, !!e.current)) ? 'ok' : 'checkbox did not stick';
    else if (e.current) r.current = 'n/a';
    const sd = X.ff(p, 'startDate', 'fromDate');
    if (sd) { const got = await X.setDate(sd, e.start); r.from = got === e.start ? 'ok' : `got "${got}"`; }
    else r.from = 'field missing';
    if (!e.current) {
      await X.W(50);
      const ed = X.ff(p, 'endDate', 'toDate');
      if (ed) { const got = await X.setDate(ed, e.end); r.to = got === e.end ? 'ok' : `got "${got}"`; }
      else r.to = 'field missing';
    }
    await txt('description', e.description, 'roleDescription', 'description');
    return r;
  }, { idx, e });
}

function fillEduPanel(idx, e) {
  return runPage(async (X, { idx, e, DEGREE }) => {
    const p = X.panels('edu')[idx];
    if (!p) return { error: `panel ${idx + 1} missing` };
    p.scrollIntoView({ block: 'center' });
    const r = {}, need = {};
    const school = X.ff(p, 'schoolName', 'school');
    if (school) {
      const k = kindOf(school);
      if (k === 'text' || k === 'textarea') { const i = school.querySelector('input,textarea'); if (i.value !== e.school) X.setVal(i, e.school); r.school = i.value === e.school ? 'ok' : `got "${i.value}"`; }
      else if (k === 'button') { const x = await X.pickButton(school.querySelector('button'), [`^${e.school.toLowerCase()}$`, e.school.toLowerCase()]); r.school = x.ok ? 'ok' : x; }
      else need.school = true;
    }
    const deg = X.ff(p, 'degree');
    if (deg) {
      const k = kindOf(deg);
      if (k === 'button') { const x = await X.pickButton(deg.querySelector('button'), DEGREE); r.degree = x.ok ? 'ok' : x; }
      else if (k === 'text') { const i = deg.querySelector('input'); if (i.value !== e.degree) X.setVal(i, e.degree); r.degree = i.value === e.degree ? 'ok' : `got "${i.value}"`; }
      else need.degree = true;
    }
    const fos = X.ff(p, 'fieldOfStudy', 'major');
    if (fos) {
      const k = kindOf(fos);
      if (k === 'text') { const i = fos.querySelector('input'); if (i.value !== e.field) X.setVal(i, e.field); r.field = i.value === e.field ? 'ok' : `got "${i.value}"`; }
      else if (k === 'button') { const x = await X.pickButton(fos.querySelector('button'), [`^${e.field.toLowerCase()}$`, e.field.toLowerCase()]); r.field = x.ok ? 'ok' : x; }
      else need.field = true;
    }
    const gpa = X.ff(p, 'gradeAverage', 'gpa');
    if (gpa) {
      // profile rule: optional GPA -> blank, required GPA -> profile education.gpa
      const req = !!gpa.querySelector('[aria-required="true"],[required]') || /\*/.test(fieldLabel(gpa));
      const i = gpa.querySelector('input');
      const want = req ? (e.gpa || '') : '';
      if (i && i.value !== want) X.setVal(i, want);
      r.gpa = i && i.value === want ? 'ok' : 'fail';
    }
    for (const [key, ids, ym] of [['from', ['firstYearAttended', 'startDate', 'fromDate'], e.start], ['to', ['lastYearAttended', 'endDate', 'toDate'], e.end]]) {
      const c = X.ff(p, ...ids);
      if (!c || !ym) continue;
      const got = await X.setDate(c, ym);
      r[key] = got === ym || got === ym.slice(0, 4) ? 'ok' : `got "${got}"`;
    }
    return { r, need };
  }, { idx, e, DEGREE: DEGREE_PREFS });
}

function fillLangPanel(idx, l) {
  const lk = l.language.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
  const prefs = LANG_PREFS[lk] || [`^${esc(l.language.toLowerCase())}$`, `^${esc(lk)}$`, `^${esc(lk)}`];
  return runPage(async (X, { idx, l, prefs, level }) => {
    const p = X.panels('lang')[idx];
    if (!p) return { error: `panel ${idx + 1} missing` };
    p.scrollIntoView({ block: 'center' });
    const r = {};
    const lc = X.ff(p, 'language');
    const lb = lc && lc.querySelector('button[aria-haspopup="listbox"]');
    if (lb) { const x = await X.pickButton(lb, prefs); r.language = x.ok ? 'ok' : x; }
    else r.language = 'no language dropdown';
    await X.W(150);
    for (const c of [...p.querySelectorAll('[data-automation-id^="formField-"]')].filter(vis)) {
      if (c === lc) continue;
      const lab = fieldLabel(c).replace(/\s+/g, ' ').replace(/\*/g, '').trim();
      const cb = c.querySelector('input[type="checkbox"]');
      if (cb) {
        const want = /fluent/i.test(lab) ? true : /native|mother/i.test(lab) ? l.level === 'native' : null;
        if (want === null) { r[lab] = 'skipped (unknown checkbox)'; continue; }
        r[lab] = (await X.setCheck(c, want)) ? 'ok' : 'checkbox did not stick';
        continue;
      }
      const b = c.querySelector('button[aria-haspopup="listbox"]');
      if (b) { const x = await X.pickButton(b, level, { highest: true }); r[lab] = x.ok ? 'ok' : x; }
    }
    return r;
  }, { idx, l, prefs, level: LEVEL_PREFS[l.level] || LEVEL_PREFS.fluent });
}

// Fold a result map into [okFlag, "failure detail"]; object values are pickButton failures.
function verdict(r) {
  const bad = Object.entries(r).filter(([, v]) => v !== 'ok' && !/^skipped/.test(String(v)) && v !== 'n/a');
  return [bad.length === 0, bad.map(([k, v]) => `${k}: ${typeof v === 'object' ? (v.why || `got "${v.value}" want "${v.want}"`) + (v.options ? ` [${v.options.slice(0, 12).join(' | ')}]` : '') : v}`).join('; ')];
}

// Retry failed listbox picks with real clicks.
function retryPicks(r) {
  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === 'object' && !v.ok && v.id && v.want) {
      if (realPick(v.id, v.want)) r[k] = 'ok';
    }
  }
}

function requiredGaps() {
  return runJson(`return fields().filter(function(c){
      var req=!!c.querySelector('[aria-required="true"],[required]')||/\\*/.test(fieldLabel(c));
      if(!req)return false;
      if(c.querySelector('input[type="file"]'))return !/successfully uploaded|\\.(pdf|docx?|rtf|txt)\\b/i.test(c.innerText);
      return !valueOf(c);})
    .map(function(c){var p=c.closest('[role="group"][aria-labelledby$="-panel"]');var h=p&&document.getElementById(p.getAttribute('aria-labelledby'));
      return (h?h.innerText.trim()+' > ':'')+fieldLabel(c).replace(/\\s+/g,' ').replace(/\\*/g,'').trim();});`) || [];
}

function cmdExperience(args) {
  const t0 = Date.now();
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dataPath = args.includes('--data') ? args[args.indexOf('--data') + 1] : P.profilePath();
  const replace = args.includes('--replace');
  const dry = args.includes('--dry-run');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  // Writing-style rule (config apply.no_em_dashes): nothing typed contains an em dash or spaced en dash.
  const noDash = s => typeof s !== 'string' || !P.cfg('apply.no_em_dashes', true) ? s : s
    .replace(/\s*—\s*/g, ', ').replace(/\s+–\s+/g, ', ')
    .replace(/,\s*([,.;:])/g, '$1').replace(/\(\s*,\s*/g, '(').replace(/[ \t]{2,}/g, ' ').trim();
  for (const e of data.experiences) for (const k of ['title', 'company', 'location', 'description']) e[k] = noDash(e[k]);
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  let failures = 0;

  const st = waitSections();
  if (st.error || !st.work || !st.work.present) {
    console.log(`FAILED: no Work Experience section on this page${st.error ? ` (${st.error})` : ''} — is this the My Experience step?`);
    process.exit(3);
  }
  if (st.work.loading || st.edu.loading || st.lang.loading) console.log('note: a section still shows "Loading" after 25 s; continuing');

  if (dry) {
    console.log(`work: ${st.work.count} panel(s) now -> ${data.experiences.length} wanted`);
    (describePanels('work') || []).forEach((d, i) => console.log(`  now ${i + 1}: ${d}`));
    data.experiences.forEach((e, i) => console.log(`  want ${i + 1}: ${e.title} @ ${e.company} ${e.start}..${e.end || 'current'}`));
    if (st.edu.present) console.log(`education: ${st.edu.count} panel(s): ${(describePanels('edu') || []).join(' ; ')}`);
    if (st.lang.present) console.log(`languages: ${st.lang.count} panel(s): ${(describePanels('lang') || []).join(' ; ')}`);
    return;
  }

  // ---- work experience
  const W = data.experiences;
  const before = describePanels('work') || [];
  if (before.length > W.length) console.log(`note: ${before.length} work panels on the page, deleting ${before.length - W.length} surplus`);
  const rc = reconcileCount('work', W.length, replace);
  rc.notes.forEach(n => console.log(`note: ${n}`));
  if (!rc.ok) { console.log(`FAIL work: have ${rc.count} panels, need ${W.length}`); failures++; }
  for (let i = 0; i < Math.min(W.length, rc.count); i++) {
    const e = W[i];
    let r = fillWorkPanel(i, e);
    if (process.env.PIPELINE_DEBUG) console.error(`[debug ${secs()}s] work ${i + 1} in-page: ${JSON.stringify(r)}`);
    if (r.error) { console.log(`FAIL work ${i + 1} ${e.company}: ${r.error}`); failures++; continue; }
    for (const [key, ids, ym] of [['from', ['startDate', 'fromDate'], e.start], ['to', ['endDate', 'toDate'], e.end]]) {
      if (r[key] && r[key] !== 'ok' && ym && !/missing/.test(r[key])) {
        const got = realDate('work', i, ids, ym);
        r[key] = got === ym ? 'ok' : `got "${got}" (in-page and real typing)`;
      }
    }
    if (Object.values(r).some(v => v !== 'ok' && v !== 'n/a')) {
      const again = fillWorkPanel(i, e);            // one in-page retry for text/checkbox
      if (!again.error) for (const k of Object.keys(r)) if (r[k] !== 'ok' && again[k] === 'ok') r[k] = 'ok';
    }
    const [ok, why] = verdict(r);
    if (!ok) failures++;
    const was = before[i] ? (before[i] === `${e.title} @ ${e.company}` ? 'kept' : 'edited') : 'added';
    console.log(`${ok ? 'ok  ' : 'FAIL'} work ${i + 1} ${e.title} @ ${e.company} ${e.start}..${e.end || 'current'} (${replace ? 'replaced' : was})${ok ? '' : ` — ${why}`} [${secs()}s]`);
  }

  // ---- education
  if (st.edu.present && data.education && data.education.length) {
    const E = data.education;
    const erc = reconcileCount('edu', E.length, replace);
    erc.notes.forEach(n => console.log(`note: ${n}`));
    for (let i = 0; i < Math.min(E.length, erc.count); i++) {
      const e = E[i];
      const res = fillEduPanel(i, e);
      if (res.error) { console.log(`FAIL education ${i + 1}: ${res.error}`); failures++; continue; }
      const r = res.r;
      retryPicks(r);
      if (res.need.school) { const s = searchPick('edu', i, ['schoolName', 'school'], e.school, [`^${esc(e.school.toLowerCase())}$`, esc(e.school.toLowerCase())]); r.school = s.ok ? 'ok' : s.why || `got "${s.value}"`; }
      if (res.need.degree) { const s = searchPick('edu', i, ['degree'], "Bachelor", DEGREE_PREFS); r.degree = s.ok ? 'ok' : s.why || `got "${s.value}"`; }
      if (res.need.field) {
        // Tenant taxonomies rarely have the exact major: accept the closest same-discipline entry
        // (some tenants only offer "Computer and Information Science").
        const f = esc(e.field.toLowerCase());
        const words = e.field.toLowerCase().split(/\s+/).map(esc);
        const s = searchPick('edu', i, ['fieldOfStudy', 'major'], e.field,
          [`^${f}$`, `^${f}`, f, `^${words[0]} and information ${words.slice(1).join(' ')}$`, `^${words.join('.*')}$`]);
        r.field = s.ok ? 'ok' : s.why || `got "${s.value}"`;
        if (s.ok && s.value && !new RegExp(`^${f}$`, 'i').test(s.value.trim())) console.log(`note: field of study = "${s.value}" (tenant has no exact "${e.field}")`);
      }
      const [ok, why] = verdict(r);
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} education ${i + 1} ${e.school} ${e.degree} ${e.field} (expected ${e.end})${ok ? '' : ` — ${why}`} [${secs()}s]`);
    }
    if (!erc.ok) { console.log(`FAIL education: have ${erc.count} panels, need ${E.length}`); failures++; }
  } else if (!st.edu.present) console.log('education: no section on this page');

  // ---- languages
  if (st.lang.present && data.languages && data.languages.length) {
    const L = data.languages;
    const lrc = reconcileCount('lang', L.length, replace);
    lrc.notes.forEach(n => console.log(`note: ${n}`));
    for (let i = 0; i < Math.min(L.length, lrc.count); i++) {
      const l = L[i];
      const r = fillLangPanel(i, l);
      if (r.error) { console.log(`FAIL language ${i + 1} ${l.language}: ${r.error}`); failures++; continue; }
      retryPicks(r);
      const [ok, why] = verdict(r);
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} language ${i + 1} ${l.language} (${l.level})${ok ? '' : ` — ${why}`} [${secs()}s]`);
    }
    if (!lrc.ok) { console.log(`FAIL languages: have ${lrc.count} panels, need ${L.length}`); failures++; }
  } else if (!st.lang.present) console.log('languages: no section on this page');

  // ---- final read-back of the whole work list + required gaps
  const after = describePanels('work') || [];
  const mismatch = W.map((e, i) => after[i] === `${e.title} @ ${e.company}` ? null : `${i + 1}: "${after[i] || '(none)'}"`).filter(Boolean);
  if (after.length !== W.length || mismatch.length) {
    console.log(`FAIL work read-back: ${after.length} panels; ${mismatch.join(', ')}`);
    failures++;
  }
  const gaps = requiredGaps();
  console.log(gaps.length ? `REQUIRED GAPS (${gaps.length}): ${gaps.join(' | ')}` : 'no required gaps');
  console.log(`-- experience: ${after.length}/${W.length} work entries, ${failures} failure(s), ${secs()} s. Nothing saved — click Save and Continue yourself.`);
  process.exit(failures ? 4 : 0);
}

// ------------------------------------------------------------------ selfid
/*
 * workday.js selfid [--save]                       (VPS crash fix)
 *
 * Fills the "Self Identify" page (OFCCP form CC-305, Voluntary Self-Identification of
 * Disability): Name = profile legal name, Date = TODAY as the browser's own clock sees it,
 * disability = profile eeo.disability (default "No, I do not have a disability"). With
 * --save it also clicks Save and Continue and reports Review vs. error.
 *
 * Root cause of the "Something went wrong / Error Code: VPS|..." crash, proven live with a
 * fetch hook shortly after local midnight:
 *   POST .../selfidentify {"dateSignedOn":"<yesterday>", ..., "clientTimeZone":"America/New_York"}
 *     -> HTTP 400 {"errorCode":"HTTP_400","message":""}  -> the page shows the VPS error.
 *   Same page, same session, only the date changed to today -> HTTP 200 -> Review.
 * Workday requires dateSignedOn == today in clientTimeZone (a future date gets a
 * client-side "Enter today's date"; a PAST date is only rejected server-side, as a VPS
 * crash). An applier typed the run's date after local midnight. So the date is
 * never typed from the agent's notion of "today": it is computed in the page at fill time.
 * Recovery after a VPS error on this page: fix the date on the SAME page and save again
 * (verified). Re-saving the unchanged form resets the flow to step 1.
 * Related but distinct: "The field Date is required" with the date visibly set = value
 * typed via form.js/execCommand never reached React state. The native setter used here
 * commits it (verified on an empty widget).
 */
function cmdSelfId(args) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dataPath = args.includes('--data') ? args[args.indexOf('--data') + 1] : P.profilePath();
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const name = data.contact && data.contact.legalName;
  if (!name) { console.log('FAIL selfid: no contact.legalName in the profile'); process.exit(4); }
  // Disability answer from the profile; matched on its leading words.
  const disab = (data.eeo && data.eeo.disability) || 'No, I do not have a disability';
  const disKey = disab.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  const today = () => runJson(`var d=new Date();
    var dayIn=document.querySelector('[data-automation-id="dateSectionDay-input"]');
    var isSelf=/self-identification of disability|do not have a disability/i.test(document.body.innerText);
    return {m:d.getMonth()+1,d:d.getDate(),y:d.getFullYear(),h:d.getHours(),min:d.getMinutes(),
      tz:Intl.DateTimeFormat().resolvedOptions().timeZone,page:!!(dayIn&&isSelf)};`);
  let t = today();
  if (!t || !t.page) { console.log('selfid: not on a Workday Self Identify (CC-305) page with a M/D/Y date — nothing done'); process.exit(5); }
  // Midnight guard: a date filled at 23:59 and saved at 00:00 is yesterday to the server.
  for (let i = 0; i < 40 && t.h === 23 && t.min >= 58; i++) { if (!i) console.log('note: within 2 min of midnight, waiting for the date to roll over'); sleep(5); t = today(); }
  const want = `${t.m}/${t.d}/${t.y}`;
  let failures = 0;

  // Name (plain text input labelled exactly "Name").
  untag();
  const nm = run(`var c=findField('name');var i=c&&c.querySelector('input');if(!i)return 'NONE';i.setAttribute('data-zwd','sn');return i.value;`);
  if (nm === 'NONE') { console.log('FAIL name: field not found'); failures++; }
  else if (nm !== name) { ab(['fill', '[data-zwd="sn"]', name], 15000); }
  const nmBack = run(`var i=document.querySelector('[data-zwd="sn"]');return i?i.value:'';`);
  if (nm !== 'NONE') { const ok = nmBack === name; if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} name = "${nmBack}"`); }

  // Date: fill month/day/year spinbuttons with the page's today, read back React's help text.
  const readBack = () => run(`var c=document.querySelector('[data-automation-id="dateSectionDay-input"]').closest('[data-automation-id^="formField-"]')||document.body;
    var m=(c.innerText||'').match(/current value is (\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);return m?m[1]:'';`);
  // agent-browser `fill` on a PRE-FILLED M/D/Y widget scrambles it (fill Day "14" on 9/15 gave
  // 12/15; tested live). Native setter + input event, Year -> Month -> Day, commits cleanly.
  const fillDate = () => {
    runPage(async (X, a) => {
      for (const [k, v] of [['Year', a.y], ['Month', a.m], ['Day', a.d]]) {
        const e = document.querySelector(`[data-automation-id="dateSection${k}-input"]`);
        if (e) { X.setVal(e, String(v)); await X.W(80); }
      }
      return 'ok';
    }, { y: t.y, m: t.m, d: t.d });
    sleep(0.5);
    return readBack();
  };
  let got = readBack();
  if (got !== want) got = fillDate();
  if (got !== want) got = fillDate();
  if (got !== want) failures++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} date = "${got || '(empty)'}" (browser today ${want}, ${t.tz})`);

  // Disability: the profile's answer (default "No, I do not have a disability...").
  const tagNo = () => run(`var box=[...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')].find(function(i){
      var l=(i.id&&document.querySelector('label[for="'+i.id+'"]'))||i.closest('label')||i.parentElement;
      var t=((l&&l.innerText)||i.getAttribute('aria-label')||'').toLowerCase().replace(/[^a-z ]+/g,' ').replace(/\\s+/g,' ').trim();
      return t.indexOf(${JSON.stringify(disKey)})===0;});
    if(!box)return 'NONE';box.setAttribute('data-zwd','dno');return (box.checked||box.getAttribute('aria-checked')==='true')?'checked':'unchecked';`);
  untag();
  let st = tagNo();
  for (let i = 0; i < 2 && st === 'unchecked'; i++) { clickTag('dno'); sleep(0.8); untag(); st = tagNo(); }
  if (st !== 'checked') failures++;
  console.log(`${st === 'checked' ? 'ok  ' : 'FAIL'} disability = ${disab} (${st})`);

  if (failures) { console.log(`-- selfid: ${failures} failure(s); not saved`); process.exit(4); }
  if (!args.includes('--save')) { console.log('-- selfid: filled; Save and Continue not clicked (pass --save)'); return; }

  // Re-check the clock right before saving (midnight guard, second half).
  const t2 = today();
  if (t2 && `${t2.m}/${t2.d}/${t2.y}` !== want) { console.log('FAIL date rolled over before save — rerun selfid'); process.exit(4); }
  untag();
  const nb = run(`var b=document.querySelector('[data-automation-id="pageFooterNextButton"]')||[...document.querySelectorAll('button')].find(function(x){return /^(save and continue|next)$/i.test(x.innerText.trim());});
    if(!b)return 'NONE';b.setAttribute('data-zwd','nx');return 'ok';`);
  if (nb === 'NONE') { console.log('FAIL save: no Save and Continue button'); process.exit(4); }
  clickTag('nx');
  for (let i = 0; i < 30; i++) {
    sleep(1);
    const r = runJson(`var t=document.body.innerText;var m=t.match(/Error Code: (VPS\\|[\\w-]+)/);
      return {vps:m?m[1]:'',err:/Errors Found/.test(t)?(t.match(/Error-([^\\n]{0,80})/)||['',''])[1]:'',
        review:/current step \\d+ of \\d+\\s*Review/i.test(t)||!!document.querySelector('[data-automation-id="pageFooterSubmitButton"]'),
        self:!!document.querySelector('[data-automation-id="dateSectionDay-input"]')};`);
    if (!r) continue;
    if (r.review) { console.log('ok   saved -> Review page'); return; }
    if (r.vps) { console.log(`FAIL save: Workday ${r.vps} (server rejected the self-identify POST; check the date, then rerun selfid --save on this same page)`); process.exit(4); }
    if (r.err && i > 3) { console.log(`FAIL save: validation error "${r.err}"`); process.exit(4); }
  }
  console.log('FAIL save: no Review page after 30 s');
  process.exit(4);
}

// ------------------------------------------------------------------ main
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'fields') cmdFields();
else if (cmd === 'select') cmdSelect(rest[0], rest.slice(1));
else if (cmd === 'auth') cmdAuth(rest);
else if (cmd === 'experience') cmdExperience(rest);
else if (cmd === 'selfid') cmdSelfId(rest);
else { console.log('usage: workday.js auth [--pw-var ATS_<CO>_PW] | select "<label>" "<option>" ["<sub>"] [--nth N] | fields | experience [--replace] [--dry-run] | selfid [--save]'); process.exit(1); }
