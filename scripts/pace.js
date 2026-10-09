// pace.js - optional human-cadence layer for the form drivers.
//
// What it is for: when a form is filled by a script, every field lands instantly,
// the pointer never moves, and the gaps between actions are perfectly regular.
// Some sites run passive timing heuristics (spam scores, invisible risk scoring)
// that look at exactly that. This module spaces actions out the way a person
// filling a form normally would: pauses between fields, pointer travel before a
// click, and text entered in uneven bursts instead of one programmatic fill.
//
// What it is NOT for: it does not solve, click through, or otherwise get around
// captchas or bot walls, and it does no fingerprint spoofing of any kind. When an
// explicit challenge appears, the run parks that application for a human via
// challenge.js.
//
// Disabled (the default) means every pause is a no-op and typeInto/click reduce
// to a plain agent-browser fill/click.

let on = false;
let run = null;            // caller's agent-browser runner: (args, timeoutMs?) => stdout, throws on failure

// Per-run capability cache, filled in lazily the first time each thing is tried.
const caps = {
  pointer: null,           // 'mouse' | 'hover'
  typer: null,             // 'type' | 'keyboard'
};
let cursor = null;         // last pointer position we moved to, {x, y}

export function init({ enabled, ab } = {}) {
  on = Boolean(enabled);
  run = typeof ab === 'function' ? ab : null;
  caps.pointer = null;
  caps.typer = null;
  cursor = null;
}

export function enabled() {
  return on;
}

// ---------------------------------------------------------------- randomness

const between = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function gauss() {
  // Box-Muller; 1 - random() keeps the log argument away from zero.
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Log-normal sample whose median is `median` ms; sigma controls the right tail.
const logNormal = (median, sigma) => median * Math.exp(sigma * gauss());

// ---------------------------------------------------------------- sleeping

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function block(ms) {
  const n = Math.round(ms);
  if (n > 0) Atomics.wait(sleepCell, 0, 0, n);
}

export function paceSleep(ms) {
  if (!on) return;
  block(ms);
}

export function fieldPause() {
  if (!on) return;
  // Roughly one in twelve gaps is a longer "reading the next question" pause.
  const ms = Math.random() < 0.08
    ? between(2500, 4000)
    : clamp(logNormal(1000, 0.45), 600, 3200);
  block(ms);
}

export function microPause() {
  if (!on) return;
  block(clamp(logNormal(170, 0.4), 80, 400));
}

// ---------------------------------------------------------------- targeting

// form.js hands us its scan index (a number) which it stamps on the element as
// data-zf; anything already shaped like a ref or selector is passed through.
function target(ref) {
  const s = String(ref);
  if (/^\d+$/.test(s)) return `[data-zf="${s}"]`;
  if (s.startsWith('@') || /[\[\].#=:\s>]/.test(s)) return s;
  return '@' + s;
}

function readBox(out) {
  const text = String(out).trim();
  try {
    const j = JSON.parse(text);
    const b = j && (j.box || j.data || j);
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)) return b;
  } catch { /* not JSON, try plain numbers */ }
  const nums = (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (nums.length >= 4) return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  return null;
}

// Glide the pointer onto a random spot inside the element in a few jittered steps.
function glideTo(sel) {
  const box = readBox(run(['get', 'box', sel]));
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('no usable box');

  const dest = {
    x: box.x + box.width * between(0.25, 0.75),
    y: box.y + box.height * between(0.3, 0.7),
  };
  const from = cursor || { x: dest.x + between(-220, 220), y: dest.y + between(-160, 160) };
  const steps = 2 + Math.floor(Math.random() * 3);   // 2-4 hops

  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const ease = t * t * (3 - 2 * t);                 // slow-fast-slow
    const wobble = k === steps ? 0 : 6;
    const x = from.x + (dest.x - from.x) * ease + between(-wobble, wobble);
    const y = from.y + (dest.y - from.y) * ease + between(-wobble, wobble);
    run(['mouse', 'move', String(Math.round(x)), String(Math.round(y))]);
    if (k < steps) block(between(25, 90));
  }
  cursor = dest;
}

// Returns a note string when it had to fall back, '' otherwise.
function approach(sel) {
  if (caps.pointer !== 'hover') {
    try {
      glideTo(sel);
      caps.pointer = 'mouse';
      return '';
    } catch {
      // Only give up on mouse moves for the run if they never worked; a single
      // element without a box (hidden, detached) should not disable them.
      if (caps.pointer !== 'mouse') caps.pointer = 'hover';
    }
  }
  try {
    run(['hover', sel]);
    return 'hover-fallback';
  } catch {
    return 'no-approach';   // pointer travel is cosmetic; the click itself still decides
  }
}

// ---------------------------------------------------------------- typing

function chunksOf(value) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    const len = 1 + Math.floor(Math.random() * 6);  // 1-6 chars
    out.push(value.slice(i, i + len));
    i += len;
  }
  return out;
}

function sendChunk(sel, chunk) {
  if (caps.typer === 'type') return run(['type', sel, chunk]);
  if (caps.typer === 'keyboard') return run(['keyboard', 'type', chunk]);
  // First chunk of the run: find out which form agent-browser accepts.
  try {
    run(['type', sel, chunk]);
    caps.typer = 'type';
  } catch {
    run(['keyboard', 'type', chunk]);
    caps.typer = 'keyboard';
  }
}

function gapAfter(chunk) {
  let ms = clamp(logNormal(110, 0.5), 35, 450);
  const last = chunk[chunk.length - 1];
  if (last === ' ') ms += between(40, 160);
  else if (/[.,;:!?\-\/@]/.test(last)) ms += between(90, 280);
  return ms;
}

const msgOf = e => String((e && (e.stderr || e.message)) || e).trim().split('\n')[0].slice(0, 200);

export function typeInto(ref, value) {
  const sel = target(ref);
  const text = value == null ? '' : String(value);
  try {
    if (!run) throw new Error('pace.init was not given an ab runner');
    if (!on) return { ok: true, out: String(run(['fill', sel, text]) || '').trim() };

    const notes = [];
    const note = approach(sel);
    if (note) notes.push(note);
    microPause();
    run(['click', sel]);
    microPause();
    run(['press', 'Meta+a']);
    run(['press', 'Backspace']);
    block(between(120, 300));

    const parts = chunksOf(text);
    parts.forEach((chunk, n) => {
      sendChunk(sel, chunk);
      if (n < parts.length - 1) block(gapAfter(chunk));
    });
    if (caps.typer === 'keyboard') notes.push('keyboard-type');
    return { ok: true, out: notes.join(' ') };
  } catch (e) {
    return { ok: false, out: msgOf(e) };
  }
}

export function click(ref) {
  const sel = target(ref);
  try {
    if (!run) throw new Error('pace.init was not given an ab runner');
    if (!on) return { ok: true, out: String(run(['click', sel]) || '').trim() };
    const note = approach(sel);
    microPause();
    run(['click', sel]);
    return { ok: true, out: note };
  } catch (e) {
    return { ok: false, out: msgOf(e) };
  }
}
