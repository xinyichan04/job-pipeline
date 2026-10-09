/**
 * pipeline-config.js — shared configuration for the Node scripts (ESM).
 * Mirrors scripts/pipeline_config.py; see that file for the directory layout.
 *
 *   import * as P from './pipeline-config.js';
 *   P.path('runs')            -> $PIPELINE_HOME/runs
 *   P.cfg('caps.per_company') -> value from config.json (falls back to config.example.json)
 *   P.env().ATS_DEFAULT_PW    -> secret from .env (never print it)
 *   P.notify('text')          -> NOTIFY_CMD on stdin, else stderr
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const expand = p => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
export const home = () => expand(process.env.PIPELINE_HOME || '~/.job-pipeline');
export const pathOf = (...parts) => path.join(home(), ...parts);
export { pathOf as path };

const loadJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k])
      ? merge(a[k], v) : v;
  }
  return out;
}

let _cfg;
export function config() {
  if (!_cfg) {
    _cfg = merge(loadJson(path.join(REPO, 'config.example.json'), {}),
      loadJson(process.env.PIPELINE_CONFIG || pathOf('config.json'), {}));
  }
  return _cfg;
}

export function cfg(dotted, dflt) {
  let cur = config();
  for (const k of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return dflt;
    cur = cur[k];
  }
  return cur;
}

export function profilePath() {
  return process.env.PIPELINE_PROFILE || pathOf('profile.json');
}

export function profile() {
  const p = profilePath();
  const d = loadJson(p, null);
  if (!d) { console.error(`profile not found at ${p} - copy profile.example.json there and edit it`); process.exit(2); }
  return d;
}

export function env() {
  const out = {};
  for (const p of [process.env.PIPELINE_ENV, pathOf('.env'), path.join(REPO, '.env')]) {
    if (p && fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
      break;
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (/^[A-Z0-9_]+$/.test(k)) out[k] = v;
  return out;
}

/** Path of the agent-browser CLI (override with AGENT_BROWSER). */
export const agentBrowser = () => process.env.AGENT_BROWSER || 'agent-browser';

/**
 * Send a message to the human operator. NOTIFY_CMD (env or config notify.command) is a
 * shell command that receives the text on stdin; with nothing configured, print to stderr.
 */
export function notify(text) {
  const cmd = env().NOTIFY_CMD || cfg('notify.command', '');
  if (!cmd) { console.error('[notify] ' + text); return true; }
  execFileSync('/bin/sh', ['-c', cmd], { input: text, stdio: ['pipe', 'ignore', 'inherit'], timeout: 30000 });
  return true;
}
