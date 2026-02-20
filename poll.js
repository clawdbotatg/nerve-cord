#!/usr/bin/env node
// Nerve Cord lightweight poller — no AI cost when inbox is empty
// Checks for pending messages; if found, triggers an OpenClaw agent turn directly.
// No cron job dependency — gateway restarts don't break anything.
// Run on a system interval (launchd every 15s). Zero AI cost when idle.
//
// IMPORTANT: Always exits 0 — even on errors. This prevents launchd/systemd from
// throttling the polling interval after transient failures (e.g. server restart).
//
// Required env:
//   NERVE_TOKEN       — nerve-cord bearer token
//   NERVE_BOTNAME     — this bot's name
//
// Optional env:
//   NERVE_SERVER      — nerve-cord server (default: http://localhost:9999)
//   NODE_PATH         — path to node binary dir (for openclaw CLI)
//   AGENT_MODEL       — model for agent turn (default: sonnet)

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const NERVE_SERVER = process.env.NERVE_SERVER || 'http://localhost:9999';
const NERVE_TOKEN = process.env.NERVE_TOKEN;
const NERVE_BOTNAME = process.env.NERVE_BOTNAME;
const NODE_BIN = process.env.NODE_PATH || '/opt/homebrew/opt/node@22/bin';
const AGENT_MODEL = process.env.AGENT_MODEL || 'sonnet';

if (!NERVE_TOKEN || !NERVE_BOTNAME) {
  console.error('Required: NERVE_TOKEN, NERVE_BOTNAME');
  process.exit(0);
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

function post(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const body = JSON.stringify(data);
    const u = new URL(url);
    const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 5000
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.end(body);
  });
}

// Lock file to prevent overlapping agent runs
// Cooldown file to back off after failures (don't hammer API)
const fs = require('fs');
const LOCK_FILE = '/tmp/nervecord-poll.lock';
const COOLDOWN_FILE = '/tmp/nervecord-poll.cooldown';
const COOLDOWN_MS = 120000; // 2 min cooldown after failure

function isLocked() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 120000) { fs.unlinkSync(LOCK_FILE); return false; }
    return true;
  } catch { return false; }
}

function isInCooldown() {
  try {
    const stat = fs.statSync(COOLDOWN_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > COOLDOWN_MS) { fs.unlinkSync(COOLDOWN_FILE); return false; }
    return true;
  } catch { return false; }
}

async function main() {
  // Get OpenClaw version (cached after first call)
  if (!main._oclawVersion) {
    try { main._oclawVersion = execSync(`PATH=${NODE_BIN}:$PATH openclaw --version`, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { main._oclawVersion = 'unknown'; }
  }

  // Heartbeat — let the server know we're alive (fire and forget)
  post(`${NERVE_SERVER}/heartbeat`, { name: NERVE_BOTNAME, skillVersion: '013', version: main._oclawVersion }, { Authorization: `Bearer ${NERVE_TOKEN}` }).catch(() => {});

  // Check for pending messages
  const url = `${NERVE_SERVER}/messages?to=${NERVE_BOTNAME}&status=pending`;
  const raw = await get(url, { Authorization: `Bearer ${NERVE_TOKEN}` });

  let msgs;
  try { msgs = JSON.parse(raw); } catch (e) {
    return; // Server might be restarting
  }

  // Loop prevention: mark loopy messages as seen, filter them out
  const actionable = [];
  for (const m of msgs) {
    const subj = m.subject || '';
    if ((m.from === NERVE_BOTNAME && subj.startsWith('Re:')) || subj.startsWith('Re: Re:')) {
      post(`${NERVE_SERVER}/messages/${m.id}/seen`, {}, { Authorization: `Bearer ${NERVE_TOKEN}` }).catch(() => {});
    } else {
      actionable.push(m);
    }
  }

  if (!actionable.length) return; // Empty inbox — zero cost

  // Don't overlap — if an agent is already running, skip this cycle
  if (isLocked()) {
    return;
  }

  // Don't hammer API after failures — respect cooldown
  if (isInCooldown()) {
    return;
  }

  console.log(`[${new Date().toISOString()}] ${actionable.length} message(s) pending, triggering agent...`);

  // Create lock
  fs.writeFileSync(LOCK_FILE, String(process.pid));

  try {
    const message = `Check nerve cord inbox and process pending messages. Run 'cd /Users/clawd/clawd/nerve-cord && BOTNAME=clawdheart TOKEN=${NERVE_TOKEN} SERVER=${NERVE_SERVER} node check.js' to see them. Read the SKILL.md at /Users/clawd/clawd/nerve-cord/SKILL.md for full API docs. Decrypt messages, handle requests, and reply (encrypted) if needed. For complex tasks, use sessions_spawn with opus model. Mark messages as seen after handling. Only reply when genuinely needed — no acks or filler.`;

    const result = execSync(
      `PATH=${NODE_BIN}:$PATH openclaw agent --session-id nervecord-handler --message ${JSON.stringify(message)} --timeout 120`,
      { encoding: 'utf8', timeout: 130000 }
    );
    console.log(`Agent completed. ${result.trim().substring(0, 200)}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Agent failed: ${e.message.substring(0, 200)}`);
    // Set cooldown so we don't hammer the API
    try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch {}
  } finally {
    // Always remove lock
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] Poll error (will retry): ${e.message}`);
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch {}
}).finally(() => process.exit(0));
