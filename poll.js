#!/usr/bin/env node
// Nerve Cord lightweight poller — no AI cost when inbox is empty
// Checks for pending messages; if found, triggers an OpenClaw cron job to handle them.
// Run on a system interval (launchd). Zero AI cost when idle.
//
// IMPORTANT: Always exits 0 — even on errors. This prevents launchd/systemd from
// throttling the polling interval after transient failures (e.g. server restart).
//
// Required env:
//   NERVE_TOKEN       — nerve-cord bearer token
//   NERVE_BOTNAME     — this bot's name
//   OPENCLAW_CRON_ID  — the cron job ID to trigger
//
// Optional env:
//   NERVE_SERVER      — nerve-cord server (default: http://localhost:9999)
//   NODE_PATH         — path to node binary dir (for openclaw CLI)

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const NERVE_SERVER = process.env.NERVE_SERVER || 'http://localhost:9999';
const NERVE_TOKEN = process.env.NERVE_TOKEN;
const NERVE_BOTNAME = process.env.NERVE_BOTNAME;
const CRON_ID = process.env.OPENCLAW_CRON_ID;
const NODE_BIN = process.env.NODE_PATH || '/opt/homebrew/opt/node@22/bin';

if (!NERVE_TOKEN || !NERVE_BOTNAME || !CRON_ID) {
  console.error('Required: NERVE_TOKEN, NERVE_BOTNAME, OPENCLAW_CRON_ID');
  process.exit(0); // Exit 0 even on config error — don't let launchd throttle
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 5000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
  });
}

async function main() {
  // Check for pending messages
  const url = `${NERVE_SERVER}/messages?to=${NERVE_BOTNAME}&status=pending`;
  const raw = await get(url, { Authorization: `Bearer ${NERVE_TOKEN}` });

  let msgs;
  try { msgs = JSON.parse(raw); } catch (e) {
    // Server might be restarting — silently exit, try again next cycle
    return;
  }

  // Filter out self-messages
  // Loop prevention (MUST match check.js filters exactly or poll triggers forever):
  // 1. Self-replies (Re: anything from myself) — always a loop
  // 2. Deep reply chains (Re: Re: from anyone) — ping-pong between bots
  msgs = msgs.filter(m => {
    const subj = m.subject || '';
    if (m.from === NERVE_BOTNAME && subj.startsWith('Re:')) return false;
    if (subj.startsWith('Re: Re:')) return false;
    return true;
  }).slice(0, 3);

  if (!msgs.length) {
    // Empty inbox — exit silently, zero cost
    return;
  }

  // Messages found — trigger the OpenClaw cron job
  console.log(`[${new Date().toISOString()}] ${msgs.length} message(s) pending, triggering agent...`);

  try {
    const result = execSync(
      `PATH=${NODE_BIN}:$PATH openclaw cron run ${CRON_ID} --timeout 60000`,
      { encoding: 'utf8', timeout: 70000 }
    );
    console.log(`Agent triggered. ${result.trim()}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Trigger failed: ${e.message}`);
    // Don't exit 1 — launchd will throttle us
  }
}

// ALWAYS exit 0 — transient errors (server restart, network blip) should not
// cause launchd to throttle our polling interval. We'll retry next cycle.
main().catch(e => {
  console.error(`[${new Date().toISOString()}] Poll error (will retry): ${e.message}`);
}).finally(() => process.exit(0));
