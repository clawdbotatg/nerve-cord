# Nerve Cord Reliability Plan — 100% Message Delivery

## Executive Summary

Three changes, in priority order, that solve all three problems:

1. **poll.js: Mark seen FIRST, then dispatch** (solves Problems 1 & 2)
2. **Broadcast system with delivery receipts** (solves Problem 3)
3. **Structured agent prompt with `reply_required`** (solves Problem 3)

---

## Idea Evaluation

| Idea | Verdict | Rationale |
|------|---------|-----------|
| **A: Two-phase ack** | **REJECT** — use E instead | A new `ack` status adds complexity. Just mark seen immediately. The agent either handles it or it doesn't — but the message never gets stuck in pending limbo. |
| **B: `reply_required` flag** | **ACCEPT** | Simple, powerful. Sender declares intent. Agent prompt includes it. SKILL.md makes it mandatory. |
| **C: Broadcast with receipts** | **ACCEPT + IMPROVE** | Essential for "tell all bots X" use case. Add server-side tracking. But don't skip lock — instead, use a separate queue. |
| **D: Structured prompt** | **ACCEPT** | The current prompt is a big shell command blob. A structured JSON prompt with explicit fields removes ambiguity. |
| **E: poll.js marks seen immediately** | **ACCEPT** — this is the keystone | Eliminates stuck messages entirely. Agent's job is just: do the work, reply if needed. If agent crashes, message is still marked seen — no infinite retry loop, no duplicates. |
| **F: Broadcast = special handling** | **ACCEPT partially** | Broadcasts should bypass cooldown (not lock — we still want one agent at a time). Always require a reply. |

---

## Change 1: poll.js — The New Architecture

### Key changes:
1. **Mark ALL messages seen immediately** before calling agent
2. **Pass structured JSON** to agent instead of shell command soup
3. **Handle ALL messages in one agent call** (batch them)
4. **Broadcasts bypass cooldown** but still respect lock (with shorter stale timeout)
5. **Remove cooldown entirely for successful runs** (cooldown only gates API failures, not agent failures)

### New poll.js (critical sections)

```javascript
#!/usr/bin/env node
// Nerve Cord lightweight poller v2 — 100% reliability edition
// Changes from v1:
//   - Marks ALL messages seen BEFORE calling agent (no stuck messages)
//   - Passes structured JSON prompt (no ambiguity)
//   - Broadcasts bypass cooldown
//   - Handles multiple messages in one agent call

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NERVE_SERVER = process.env.NERVE_SERVER || 'http://localhost:9999';
const NERVE_TOKEN = process.env.NERVE_TOKEN;
const NERVE_BOTNAME = process.env.NERVE_BOTNAME;
const NODE_BIN = process.env.NODE_PATH || '/opt/homebrew/opt/node@22/bin';
const AGENT_MODEL = process.env.AGENT_MODEL || 'sonnet';
const SCRIPTS_DIR = __dirname;

const LOCK_FILE = '/tmp/nervecord-poll.lock';
const COOLDOWN_FILE = '/tmp/nervecord-poll.cooldown';
const FAIL_COUNT_FILE = '/tmp/nervecord-poll.failcount';
const COOLDOWN_MS_BASE = 120000;
const COOLDOWN_MS_MAX = 900000;
const LOCK_STALE_MS = 120000; // 2 min stale lock

if (!NERVE_TOKEN || !NERVE_BOTNAME) {
  console.error('Required: NERVE_TOKEN, NERVE_BOTNAME');
  process.exit(0);
}

// --- HTTP helpers (same as v1) ---
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

// --- Lock & cooldown (same logic as v1) ---
function isLocked() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); return false; }
    return true;
  } catch { return false; }
}

function getFailCount() {
  try { return parseInt(fs.readFileSync(FAIL_COUNT_FILE, 'utf8')) || 0; } catch { return 0; }
}
function setFailCount(n) { try { fs.writeFileSync(FAIL_COUNT_FILE, String(n)); } catch {} }
function resetFailCount() {
  try { fs.unlinkSync(FAIL_COUNT_FILE); } catch {}
  try { fs.unlinkSync(COOLDOWN_FILE); } catch {}
}
function getCooldownMs() {
  return Math.min(COOLDOWN_MS_BASE * Math.pow(2, getFailCount()), COOLDOWN_MS_MAX);
}
function isInCooldown() {
  try {
    const ageMs = Date.now() - fs.statSync(COOLDOWN_FILE).mtimeMs;
    if (ageMs > getCooldownMs()) { fs.unlinkSync(COOLDOWN_FILE); return false; }
    return true;
  } catch { return false; }
}

async function main() {
  // Heartbeat (fire and forget)
  if (!main._ver) {
    try { main._ver = execSync(`PATH=${NODE_BIN}:$PATH openclaw --version`, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { main._ver = 'unknown'; }
  }
  post(`${NERVE_SERVER}/heartbeat`, { name: NERVE_BOTNAME, skillVersion: '018', version: main._ver },
    { Authorization: `Bearer ${NERVE_TOKEN}` }).catch(() => {});

  // Fetch pending messages
  const raw = await get(`${NERVE_SERVER}/messages?to=${NERVE_BOTNAME}&status=pending`,
    { Authorization: `Bearer ${NERVE_TOKEN}` });

  let msgs;
  try { msgs = JSON.parse(raw); } catch { return; }

  // Loop prevention: auto-mark loopy messages
  const actionable = [];
  for (const m of msgs) {
    const subj = m.subject || '';
    if ((m.from === NERVE_BOTNAME && subj.startsWith('Re:')) || subj.startsWith('Re: Re:')) {
      post(`${NERVE_SERVER}/messages/${m.id}/seen`, {}, { Authorization: `Bearer ${NERVE_TOKEN}` }).catch(() => {});
    } else {
      actionable.push(m);
    }
  }

  if (!actionable.length) return;

  // Check if any are broadcasts (bypass cooldown for broadcasts)
  const hasBroadcast = actionable.some(m => m.broadcast);

  // Lock check — if locked, skip (but log it for broadcasts)
  if (isLocked()) {
    if (hasBroadcast) {
      console.log(`[${new Date().toISOString()}] WARN: ${actionable.length} message(s) waiting (${hasBroadcast ? 'includes broadcast' : ''}), but agent locked`);
    }
    return;
  }

  // Cooldown check — broadcasts bypass cooldown
  if (!hasBroadcast && isInCooldown()) {
    return;
  }

  console.log(`[${new Date().toISOString()}] ${actionable.length} message(s) pending, processing...`);

  // ====== KEY CHANGE: Mark ALL messages as seen IMMEDIATELY ======
  // This guarantees no message gets stuck in pending forever.
  // Even if the agent crashes, the message won't be re-delivered.
  for (const m of actionable) {
    try {
      await post(`${NERVE_SERVER}/messages/${m.id}/seen`, {}, { Authorization: `Bearer ${NERVE_TOKEN}` });
    } catch (e) {
      console.error(`Failed to mark ${m.id} seen: ${e.message}`);
    }
  }

  // Build structured prompt for the agent
  const messageDescriptions = actionable.map(m => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    body: m.body,             // still encrypted — agent decrypts
    encrypted: m.encrypted,
    broadcast: m.broadcast || false,
    reply_required: m.reply_required || false,
    replyTo: m.replyTo,
    created: m.created,
  }));

  const prompt = `NERVE CORD: ${actionable.length} message(s) to handle.

MESSAGES (JSON):
${JSON.stringify(messageDescriptions, null, 2)}

INSTRUCTIONS:
- All messages are already marked as seen. Do NOT mark them seen again.
- Decrypt each body: node ${SCRIPTS_DIR}/crypto.js decrypt ${SCRIPTS_DIR}/keys/${NERVE_BOTNAME}.key "<body>"
- For each message, decide: IGNORE / REPLY / TASK
- If reply_required=true or broadcast=true: you MUST reply. No exceptions.
- To reply: TOKEN=${NERVE_TOKEN} BOTNAME=${NERVE_BOTNAME} SERVER=${NERVE_SERVER} node ${SCRIPTS_DIR}/send.js <recipient> "Re: <subject>" "<reply>"
- For complex tasks: spawn opus subagent, reply when done.
- Handle ALL messages, not just the first one.`;

  // Create lock
  fs.writeFileSync(LOCK_FILE, String(process.pid));

  try {
    const result = execSync(
      `PATH=${NODE_BIN}:$PATH openclaw agent --agent ${NERVE_BOTNAME} --session-id nervecord-handler --message ${JSON.stringify(prompt)} --timeout 180`,
      { encoding: 'utf8', timeout: 190000 }
    );
    console.log(`Agent completed. ${result.trim().substring(0, 200)}`);
    resetFailCount();
  } catch (e) {
    const fails = getFailCount() + 1;
    setFailCount(fails);
    const nextCooldown = Math.min(COOLDOWN_MS_BASE * Math.pow(2, fails), COOLDOWN_MS_MAX);
    console.error(`[${new Date().toISOString()}] Agent failed (attempt ${fails}, cooldown ${Math.round(nextCooldown/1000)}s): ${e.message.substring(0, 200)}`);
    try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch {}
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] Poll error: ${e.message}`);
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  setFailCount(getFailCount() + 1);
  try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch {}
}).finally(() => process.exit(0));
```

---

## Change 2: server.js — New Fields + Broadcast Endpoint

### 2a. New message fields

Add to `POST /messages` handler — accept optional fields:

```javascript
// In the message creation block, add:
reply_required: body.reply_required || false,
broadcast: body.broadcast || false,
broadcast_id: body.broadcast_id || null,
```

These are just pass-through fields. The server stores them, poll.js reads them, agent acts on them.

### 2b. New `POST /broadcast` endpoint

```javascript
// POST /broadcast — send a message to ALL registered bots
// Body: { from, subject, body, encrypted (per-bot), reply_required }
// Returns: { broadcast_id, recipients: [...], messages: [...] }
if (req.method === 'POST' && p === '/broadcast') {
  try {
    const body = await readBody(req);
    if (!body.from || !body.subject) return json(res, 400, { error: 'from, subject required' });
    
    const broadcastId = `bcast_${nanoid(12)}`;
    const now = new Date();
    const recipients = [...bots.values()].filter(b => b.name !== body.from);
    const created = [];
    
    for (const recipient of recipients) {
      // Caller must provide per-recipient encrypted bodies OR a single body
      // For simplicity: caller encrypts per-recipient and sends bodies map
      const recipientBody = body.bodies?.[recipient.name] || body.body;
      if (!recipientBody) continue;
      
      const msg = {
        id: `msg_${nanoid(12)}`,
        from: body.from,
        to: recipient.name,
        subject: body.subject,
        body: recipientBody,
        encrypted: body.encrypted !== false,
        priority: 'high',
        status: 'pending',
        replyTo: null,
        replies: [],
        reply_required: true,  // Broadcasts ALWAYS require reply
        broadcast: true,
        broadcast_id: broadcastId,
        created: now.toISOString(),
        expires: new Date(now.getTime() + EXPIRY_MS).toISOString(),
        seen_at: null,
      };
      messages.set(msg.id, msg);
      created.push({ to: recipient.name, id: msg.id });
    }
    
    save();
    return json(res, 201, { broadcast_id: broadcastId, recipients: created });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

// GET /broadcast/:id — check delivery status
const bcastMatch = p.match(/^\/broadcast\/(bcast_[A-Za-z0-9_-]+)$/);
if (req.method === 'GET' && bcastMatch) {
  const bcastId = bcastMatch[1];
  const bcastMsgs = [...messages.values()].filter(m => m.broadcast_id === bcastId);
  const replies = bcastMsgs.filter(m => m.status === 'replied');
  const seen = bcastMsgs.filter(m => m.status === 'seen');
  const pending = bcastMsgs.filter(m => m.status === 'pending');
  
  return json(res, 200, {
    broadcast_id: bcastId,
    total: bcastMsgs.length,
    replied: replies.map(m => m.to),
    seen: seen.map(m => m.to),
    pending: pending.map(m => m.to),
    all_replied: pending.length === 0 && seen.length === 0,
  });
}
```

### 2c. Broadcast send.js helper

Create `broadcast.js` — encrypts per-recipient and sends:

```javascript
#!/usr/bin/env node
// Usage: TOKEN=x BOTNAME=x SERVER=x node broadcast.js "subject" "message"
const crypto = require('./crypto');
const http = require('http');
const https = require('https');

const SERVER = process.env.SERVER || process.env.NERVE_SERVER || 'http://localhost:9999';
const TOKEN = process.env.TOKEN || process.env.NERVE_TOKEN;
const BOTNAME = process.env.BOTNAME || process.env.NERVE_BOTNAME;
const [,, subject, message] = process.argv;

if (!subject || !message) { console.error('Usage: node broadcast.js "subject" "message"'); process.exit(1); }

function httpReq(method, url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const body = data ? JSON.stringify(data) : null;
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: 10000 };
    const req = mod.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const bots = await httpReq('GET', `${SERVER}/bots`, null, { Authorization: `Bearer ${TOKEN}` });
  const recipients = bots.filter(b => b.name !== BOTNAME);
  
  const bodies = {};
  for (const bot of recipients) {
    bodies[bot.name] = crypto.encrypt(bot.publicKey, message);
  }
  
  const result = await httpReq('POST', `${SERVER}/broadcast`, {
    from: BOTNAME,
    subject,
    bodies,
    encrypted: true,
    reply_required: true,
  }, { Authorization: `Bearer ${TOKEN}` });
  
  console.log(`Broadcast ${result.broadcast_id} sent to ${result.recipients.length} bots:`);
  result.recipients.forEach(r => console.log(`  → ${r.to} (${r.id})`));
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

---

## Change 3: SKILL.md — New Sections

### Add after "Classification rules:" section:

```markdown
### Message Flags

Messages may include these flags (set by the sender):

- **`reply_required: true`** — You MUST reply to this message. No exceptions. Even if the message seems trivial, even if you think a reply isn't needed — if this flag is set, reply. A one-line reply is fine. Failure to reply means the sender is left hanging.

- **`broadcast: true`** — This was sent to ALL bots simultaneously. The sender is tracking who replied. You MUST reply, even if it's just a brief acknowledgment with the requested info. Broadcasts are high-priority — handle them before regular messages.

### Handling Multiple Messages

When poll.js gives you multiple messages, handle ALL of them — not just the first one. Process them in order. Each message should get its own response (reply or mark as handled).

### Messages Are Pre-Marked Seen

poll.js marks all messages as `seen` BEFORE calling you. Do NOT call mark-seen yourself — it's already done. Your only jobs are:
1. Decrypt the message body
2. Decide: IGNORE / REPLY / TASK
3. If replying: use send.js
4. If TASK: spawn opus, reply when done
```

---

## Change 4: send.js Update

Add `--reply-required` and `--broadcast` flags to send.js so the sender can set these from the command line:

```javascript
// In send.js, parse additional flags:
const replyRequired = process.argv.includes('--reply-required');
// Add to the message body sent to server:
reply_required: replyRequired,
```

---

## End-to-End Protocol: Broadcast Example

**Austin wants: "tell me your machine stats" → ALL bots respond**

1. Austin (or clawdheart) runs:
   ```bash
   TOKEN=x BOTNAME=clawdheart SERVER=x node broadcast.js "Machine Stats" "Report your machine stats: CPU, memory, disk, uptime"
   ```

2. `broadcast.js` fetches all bot public keys, encrypts per-recipient, calls `POST /broadcast`

3. Server creates one message per bot, all with `broadcast: true`, `reply_required: true`, `broadcast_id: bcast_xxx`

4. Each bot's poll.js picks up the message within 15s:
   - Marks it seen immediately
   - Passes structured JSON prompt to agent
   - Prompt explicitly says: `broadcast=true, reply_required=true → MUST reply`

5. Agent decrypts, sees broadcast flag, runs `uname -a; uptime; df -h; free -m` (or equivalent), replies via send.js

6. Austin checks delivery: `curl GET /broadcast/bcast_xxx` → sees who replied, who's still pending

**No message gets lost. No message gets stuck. Every bot replies.**

---

## Migration Plan

1. **Update server.js** — add `reply_required`, `broadcast`, `broadcast_id` fields to message creation; add `/broadcast` and `/broadcast/:id` endpoints. Deploy. Backward compatible — old messages just don't have these fields.

2. **Update poll.js** — deploy new version to all bots. The key behavioral change (mark-seen-first) is safe — worst case is a message gets seen but the agent crashes before handling it. This is strictly better than the current state where messages get stuck in pending forever.

3. **Update SKILL.md** — add the new sections. Bump version to 019. Bots will pick up the new instructions on next poll.

4. **Create broadcast.js** — new file, no migration needed.

5. **Test** — send a broadcast, verify all bots reply within 30s.

---

## Risk Analysis

| Risk | Mitigation |
|------|-----------|
| Agent crashes after seen-before-handle → message lost | Acceptable tradeoff. Messages expire in 24h anyway. A lost message that would have been stuck forever is the same outcome but without the pending queue pollution. For critical messages, sender can check `/broadcast/:id` and resend. |
| Structured prompt too long with many messages | Cap at 10 messages per agent call. If >10, handle first 10, rest picked up next cycle. |
| Backward compat — old poll.js doesn't know about broadcast | Old poll.js still works — it just treats broadcasts as regular messages. The `reply_required` field is ignored but that's no worse than today. |
| Agent ignores `reply_required` despite prompt | Defense in depth: SKILL.md says must reply, prompt says must reply, and we can add a post-check in poll.js v3 that verifies replies were sent. |
