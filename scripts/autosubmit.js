#!/usr/bin/env node
/**
 * autosubmit.js — the submit gate for the application pipeline.
 *
 * Submitting a job application is something done in the applicant's name, so it is
 * OWNER-ONLY. This gate exists so that authorization is a fact on disk set by the
 * account owner, not a judgement call an applier agent makes in the middle of a run.
 *
 *   autosubmit.js check     exit 0 = submitting allowed, exit 1 = fill and park
 *   autosubmit.js status    human-readable
 *
 * There is deliberately no `enable` subcommand. Only the account owner turns it on:
 *   echo "on  # <date> <who>" > "$PIPELINE_HOME/AUTOSUBMIT"
 * Absent, empty or "off" = every posting is filled, screenshotted and parked for review.
 */
import fs from 'node:fs';
import * as P from './pipeline-config.js';

const FLAG = P.path('AUTOSUBMIT');

function readFlag() {
  try {
    const raw = fs.readFileSync(FLAG, 'utf8');
    const first = raw.split('\n')[0].trim().split(/\s+/)[0].toLowerCase();
    return { on: first === 'on' || first === 'true' || first === '1', raw: raw.trim() };
  } catch {
    return { on: false, raw: null };
  }
}

const cmd = process.argv[2] || 'status';
const { on, raw } = readFlag();

if (cmd === 'check') {
  process.exit(on ? 0 : 1);
}

if (on) {
  console.log('AUTOSUBMIT: ON — appliers may submit end-to-end.');
  console.log(`  flag: ${FLAG}`);
  console.log(`  contents: ${raw}`);
  console.log('  Still never submit on a guessed or unverified answer:');
  console.log('  application questions sit under a truth certification.');
} else {
  console.log('AUTOSUBMIT: OFF — fill the form, screenshot it, and PARK.');
  console.log(`  flag: ${FLAG} ${raw === null ? '(not present)' : `(= "${raw}")`}`);
  console.log('  Parking is the correct outcome here, not a failure.');
  console.log('  Only the account owner can turn this on.');
}
