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
const COOLDOWN_MS_BASE = 120000; // 2 min base cooldown after failure
const COOLDOWN_MS_MAX = 900000; // 15 min max cooldown
const FAIL_COUNT_FILE = '/tmp/nervecord-poll.failcount';

function isLocked() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 120000) { fs.unlinkSync(LOCK_FILE); return false; }
    return true;
  } catch { return false; }
}

function getFailCount() {
  try { return parseInt(fs.readFileSync(FAIL_COUNT_FILE, 'utf8')) || 0; } catch { return 0; }
}

function setFailCount(n) {
  try { fs.writeFileSync(FAIL_COUNT_FILE, String(n)); } catch {}
}

function resetFailCount() {
  try { fs.unlinkSync(FAIL_COUNT_FILE); } catch {}
  try { fs.unlinkSync(COOLDOWN_FILE); } catch {}
}

function getCooldownMs() {
  const fails = getFailCount();
  // Exponential backoff: 2min, 4min, 8min, capped at 15min
  return Math.min(COOLDOWN_MS_BASE * Math.pow(2, fails), COOLDOWN_MS_MAX);
}

function isInCooldown() {
  try {
    const stat = fs.statSync(COOLDOWN_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    const cooldownMs = getCooldownMs();
    if (ageMs > cooldownMs) { fs.unlinkSync(COOLDOWN_FILE); return false; }
    return true;
  } catch { return false; }
}

async function main() {
  // Get OpenClaw version (cached after first call)
  if (!main._oclawVersion) {
    try { main._oclawVersion = execSync(`PATH=${NODE_BIN}:$PATH openclaw --version`, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { main._oclawVersion = 'unknown'; }
  }

  // Heartbeat — let the server know we're alive (fire and forget)
  post(`${NERVE_SERVER}/heartbeat`, { name: NERVE_BOTNAME, skillVersion: '019', version: main._oclawVersion }, { Authorization: `Bearer ${NERVE_TOKEN}` }).catch(() => {});

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

  console.log(`[${new Date().toISOString()}] ${actionable.length} message(s) pending, processing...`);

  // ====== MARK ALL MESSAGES SEEN IMMEDIATELY ======
  // Do this BEFORE calling the agent so messages never get stuck in pending forever.
  // Even if the agent crashes, the message is already seen — no infinite re-delivery.
  const SCRIPTS_DIR = require('path').dirname(require.resolve('./poll.js'));
  for (const m of actionable) {
    try {
      await post(`${NERVE_SERVER}/messages/${m.id}/seen`, {}, { Authorization: `Bearer ${NERVE_TOKEN}` });
    } catch (e) {
      console.error(`Failed to mark ${m.id} seen: ${e.message}`);
    }
  }

  // ====== DECRYPT INLINE ======
  // Decrypt each message now so the agent receives plaintext — no crypto ambiguity.
  const decryptedMessages = actionable.map(m => {
    let plaintext = m.body;
    if (m.encrypted) {
      try {
        plaintext = execSync(
          `node ${SCRIPTS_DIR}/crypto.js decrypt ${SCRIPTS_DIR}/keys/${NERVE_BOTNAME}.key ${JSON.stringify(m.body)}`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
      } catch (e) {
        plaintext = `[DECRYPT FAILED: ${e.message.substring(0, 100)}] raw: ${m.body.substring(0, 100)}`;
      }
    }
    return { id: m.id, from: m.from, subject: m.subject, body: plaintext };
  });

  // ====== DIRECTIVE PROMPT — NO WIGGLE ROOM ======
  const msgList = decryptedMessages.map((m, i) =>
    `--- Message ${i + 1} ---\nFrom: ${m.from}\nSubject: ${m.subject}\nBody: ${m.body}`
  ).join('\n\n');

  const message = `NERVE CORD: ${actionable.length} message(s) received. Handle ALL of them now.

${msgList}

---
RULES (no exceptions):
- All messages are already marked seen. Do NOT mark them seen again.
- For EACH message: do what it says, then reply with the result.
- Reply command: TOKEN=${NERVE_TOKEN} BOTNAME=${NERVE_BOTNAME} SERVER=${NERVE_SERVER} node ${SCRIPTS_DIR}/send.js <from> "Re: <subject>" "<your reply>"
- There is NO ignore option. Every message gets a reply — even if it's one sentence.
- For complex multi-step tasks: spawn opus, reply when done.
- Silence = failure. Close the loop. Always.`;

    const result = execSync(
      `PATH=${NODE_BIN}:$PATH openclaw agent --agent ${NERVE_BOTNAME} --session-id nervecord-handler --message ${JSON.stringify(message)} --timeout 180`,
      { encoding: 'utf8', timeout: 190000 }
    );
    console.log(`Agent completed. ${result.trim().substring(0, 200)}`);
    resetFailCount();
  } catch (e) {
    const fails = getFailCount() + 1;
    setFailCount(fails);
    const nextCooldown = Math.min(COOLDOWN_MS_BASE * Math.pow(2, fails), COOLDOWN_MS_MAX);
    console.error(`[${new Date().toISOString()}] Agent failed (attempt ${fails}, cooldown ${Math.round(nextCooldown/1000)}s): ${e.message.substring(0, 200)}`);
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
  setFailCount(getFailCount() + 1);
  try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch {}
}).finally(() => process.exit(0));
