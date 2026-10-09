#!/usr/bin/env node
/**
 * Regression tests for a workday.js substring-matching defect.
 *
 * The defect: `matchOpt`'s third tier was a bare indexOf>=0, so the target
 * "not a protected veteran" matched "I identify as a Veteran, just not a Protected
 * Veteran" — the OPPOSITE self-identification — on a form under a truth certification.
 *
 * These tests exercise the REAL code: the browser-side LIB is extracted from
 * workday.js and evaluated against a stub option list, so the test cannot drift
 * from the implementation the way a hand-copied version would.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'workday.js'), 'utf8');

// ---- extract the injected browser LIB verbatim -----------------------------
const m = SRC.match(/const LIB = `([\s\S]*?)\n`;/);
if (!m) { console.error('FAIL: could not extract LIB from workday.js'); process.exit(1); }
// LIB lives in a template literal, so \\s etc. are escaped for the JS string layer.
const LIB = m[1].replace(/\\\\/g, '\\').replace(/\\`/g, '`').replace(/\\\$/g, '$');

// ---- stub the DOM surface LIB touches --------------------------------------
function makeOpt(text) {
  return {
    _t: text,
    getAttribute: a => (a === 'data-automation-label' ? text : null),
    innerText: text,
    closest: () => null,
    setAttribute() {}, removeAttribute() {}, scrollIntoView() {},
  };
}
let CURRENT = [];
const sandbox = { document: { querySelectorAll: () => [], querySelector: () => null } };

function loadLib() {
  // `typeof` guard so this harness also loads a PRE-FIX workday.js (which has no
  // ambiguousFor) — that is how you prove these tests actually catch the defect
  // rather than passing vacuously. See the header of this file.
  const fn = new Function('document', `${LIB}; return {matchOpt:matchOpt, ambiguousFor:(typeof ambiguousFor==='function'?ambiguousFor:function(){return '';}), N:N, setOptions:function(f){options=f;}};`);
  const api = fn(sandbox.document);
  api.setOptions(() => CURRENT);
  return api;
}
const lib = loadLib();

// ---- valueMatches: re-derive from source so we test the shipped logic -------
const vmSrc = SRC.match(/const norm = [\s\S]*?\nfunction valueMatches\([\s\S]*?\n}/);
if (!vmSrc) { console.error('FAIL: could not extract valueMatches'); process.exit(1); }
const valueMatches = new Function(`${vmSrc[0]}; return valueMatches;`)();

// ---- the real Workday veteran option set that triggered the bug ------------
const VET = [
  'I identify as one or more of the classifications of a protected veteran',
  'I am not a protected veteran',
  'I identify as a Veteran, just not a Protected Veteran',
  "I don't wish to answer",
];
const RACE = ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)', 'Two or More Races (Not Hispanic or Latino)'];

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
const matchText = (opts, want) => {
  CURRENT = opts.map(makeOpt);
  const r = lib.matchOpt(want);
  return r === 'AMBIGUOUS' ? 'AMBIGUOUS' : r ? r._t : null;
};

console.log('--- matchOpt: the exact defect ---');
// THE REGRESSION: this silently returned the "just not a Protected Veteran" option before.
t('ambiguous veteran query refuses to guess', matchText(VET, 'not a protected veteran'), 'AMBIGUOUS');
t('full option text still matches exactly', matchText(VET, 'I am not a protected veteran'), 'I am not a protected veteran');
t('the opposite option also matches exactly',
  matchText(VET, 'I identify as a Veteran, just not a Protected Veteran'),
  'I identify as a Veteran, just not a Protected Veteran');
t('case/space insensitive exact', matchText(VET, "  i DON'T wish to ANSWER "), "I don't wish to answer");
t('no match returns null', matchText(VET, 'purple'), null);

console.log('\n--- matchOpt: unique loose matches still work ---');
t('unique substring still resolves', matchText(VET, 'classifications of a protected'),
  'I identify as one or more of the classifications of a protected veteran');
t('unique prefix still resolves', matchText(RACE, 'Asian'), 'Asian (Not Hispanic or Latino)');
t('shared suffix across 3 races is ambiguous', matchText(RACE, 'not hispanic or latino'), 'AMBIGUOUS');

console.log('\n--- matchOpt: decorative twins must not read as ambiguity ---');
// Every real option has a same-text promptOption twin; that is duplication, not ambiguity.
t('identical twin texts resolve, not AMBIGUOUS',
  matchText(['I am not a protected veteran', 'I am not a protected veteran'], 'not a protected veteran'),
  'I am not a protected veteran');

console.log('\n--- valueMatches: committed-value verification ---');
t('opposite answer is NOT confirmed',
  valueMatches('I identify as a Veteran, just not a Protected Veteran', 'not a protected veteran'), false);
t('exact value confirmed', valueMatches('I am not a protected veteran', 'I am not a protected veteran'), true);
t('whole leading phrase + separator confirmed', valueMatches('Asian (Not Hispanic or Latino)', 'Asian'), true);
t('mid-string substring rejected', valueMatches('Two or More Races (Not Hispanic or Latino)', 'Races'), false);
t('empty value rejected', valueMatches('', 'Asian'), false);
t('different answer rejected', valueMatches('Female', 'Male'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
