#!/usr/bin/env node
// Nerve Cord lightweight poller — no AI cost when inbox is empty
// Checks for pending messages; if found, triggers an OpenClaw cron job to handle them.
// Run on a system interval (launchd). Zero AI cost when idle.
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
  process.exit(1);
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  // Check for pending messages
  const url = `${NERVE_SERVER}/messages?to=${NERVE_BOTNAME}&status=pending`;
  const raw = await get(url, { Authorization: `Bearer ${NERVE_TOKEN}` });

  let msgs;
  try { msgs = JSON.parse(raw); } catch (e) {
    console.error(`[${new Date().toISOString()}] Parse error: ${e.message}`);
    process.exit(1);
  }

  // Filter out self-messages
  msgs = msgs.filter(m => m.from !== NERVE_BOTNAME).slice(0, 3);

  if (!msgs.length) {
    // Empty inbox — exit silently, zero cost
    process.exit(0);
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
    console.error(`Trigger failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
