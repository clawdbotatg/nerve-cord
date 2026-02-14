#!/usr/bin/env node
// Nerve Cord — Inter-bot message broker with E2E encryption
// Usage: PORT=9999 TOKEN=secret node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '9999', 10);
const TOKEN = process.env.TOKEN || 'nerve-cord-default-token';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 30_000; // 30s
const HEARTBEAT_TIMEOUT = 30_000; // 30s = offline

// --- Storage ---
let messages = new Map();
let bots = new Map(); // name -> { name, publicKey, registered }
let heartbeats = new Map(); // name -> { lastSeen, ip, version }

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      messages = new Map(raw.map(m => [m.id, m]));
      console.log(`Loaded ${messages.size} messages from disk`);
    }
    if (fs.existsSync(BOTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
      bots = new Map(raw.map(b => [b.name, b]));
      console.log(`Loaded ${bots.size} bots from disk`);
    }
  } catch (e) { console.error('Load error:', e.message); }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...messages.values()], null, 2));
    fs.writeFileSync(BOTS_FILE, JSON.stringify([...bots.values()], null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

function expire() {
  const now = Date.now();
  for (const [id, msg] of messages) {
    if (now > new Date(msg.expires).getTime()) messages.delete(id);
  }
}

// --- HTTP helpers ---
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

function formatUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

// --- Routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Public endpoints (no auth)
  if (req.method === 'GET' && p === '/stats') {
    expire();
    const now = Date.now();
    const allMsgs = [...messages.values()];
    const botList = [...bots.values()];

    const botStats = {};
    for (const b of botList) {
      const sent = allMsgs.filter(m => m.from === b.name);
      const recv = allMsgs.filter(m => m.to === b.name);
      const pending = recv.filter(m => m.status === 'pending');
      const lastSent = sent.length ? sent.reduce((a, c) => new Date(c.created) > new Date(a.created) ? c : a) : null;
      const lastRecv = recv.length ? recv.reduce((a, c) => new Date(c.created) > new Date(a.created) ? c : a) : null;
      botStats[b.name] = {
        registered: b.registered,
        sent: sent.length,
        received: recv.length,
        pending: pending.length,
        lastSentAt: lastSent?.created || null,
        lastReceivedAt: lastRecv?.created || null,
      };
    }

    const statusCounts = {};
    for (const m of allMsgs) statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;

    const oneHourAgo = now - 3600_000;
    const recentMsgs = allMsgs.filter(m => new Date(m.created).getTime() > oneHourAgo);

    // JSON API
    const wantsJson = (req.headers.accept || '').includes('application/json') ||
                      url.searchParams.has('json');
    if (wantsJson) {
      return json(res, 200, {
        uptime: Math.floor(process.uptime()),
        uptimeHuman: formatUptime(process.uptime()),
        totalMessages: allMsgs.length,
        statusBreakdown: statusCounts,
        messagesLastHour: recentMsgs.length,
        bots: botStats,
        botCount: botList.length,
        serverTime: new Date().toISOString(),
      });
    }

    // HTML dashboard
    const ago = (iso) => {
      if (!iso) return '<span style="color:#666">never</span>';
      const s = Math.floor((now - new Date(iso).getTime()) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s/60)}m ago`;
      if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
      return `${Math.floor(s/86400)}d ago`;
    };

    const botRows = Object.entries(botStats).map(([name, b]) => {
      const pendingBadge = b.pending > 0
        ? `<span style="background:#e74c3c;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:bold">${b.pending}</span>`
        : `<span style="color:#666">0</span>`;
      return `<tr>
        <td style="font-weight:bold">🤖 ${name}</td>
        <td>${b.sent}</td>
        <td>${b.received}</td>
        <td>${pendingBadge}</td>
        <td>${ago(b.lastSentAt)}</td>
        <td>${ago(b.lastReceivedAt)}</td>
      </tr>`;
    }).join('');

    const statusBars = Object.entries(statusCounts).map(([s, c]) => {
      const colors = { pending: '#e67e22', seen: '#3498db', replied: '#2ecc71' };
      const color = colors[s] || '#95a5a6';
      return `<div style="display:inline-block;margin-right:16px">
        <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle"></span>
        <strong>${c}</strong> ${s}
      </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🦀 Nerve Cord</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
  .card .num { font-size: 28px; font-weight: bold; color: #58a6ff; }
  .card .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { font-size: 16px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #8b949e; font-weight: normal; padding: 6px 8px; border-bottom: 1px solid #30363d; }
  td { padding: 8px; border-bottom: 1px solid #21262d; }
  .refresh { color: #8b949e; font-size: 12px; text-align: center; margin-top: 16px; }
  .refresh a { color: #58a6ff; text-decoration: none; }
</style>
</head><body>
<div class="container">
  <h1>🦀 Nerve Cord</h1>
  <div class="subtitle">Inter-bot message broker &middot; Up ${formatUptime(process.uptime())}</div>

  <div class="cards">
    <div class="card"><div class="num">${allMsgs.length}</div><div class="label">Total Messages</div></div>
    <div class="card"><div class="num">${recentMsgs.length}</div><div class="label">Last Hour</div></div>
    <div class="card"><div class="num">${statusCounts.pending || 0}</div><div class="label">Pending</div></div>
    <div class="card"><div class="num">${botList.length}</div><div class="label">Bots</div></div>
  </div>

  <div class="section">
    <h2>Message Status</h2>
    <div style="padding:4px 0">${statusBars}</div>
  </div>

  <div class="section">
    <h2>Bots</h2>
    <table>
      <tr><th>Name</th><th>Sent</th><th>Recv</th><th>Pending</th><th>Last Sent</th><th>Last Recv</th></tr>
      ${botRows}
    </table>
  </div>

  <div class="section">
    <h2>Heartbeat</h2>
    <table>
      <tr><th>Bot</th><th>Status</th><th>Last Seen</th><th>IP</th></tr>
      ${(() => {
        const now = Date.now();
        const registered = [...bots.values()].map(b => b.name);
        return registered.map(name => {
          const hb = heartbeats.get(name);
          if (!hb) return `<tr><td>🤖 ${name}</td><td><span style="color:#666">⚫ never seen</span></td><td>—</td><td>—</td></tr>`;
          const age = now - new Date(hb.lastSeen).getTime();
          const online = age < HEARTBEAT_TIMEOUT;
          const statusDot = online
            ? '<span style="color:#2ecc71">🟢 online</span>'
            : '<span style="color:#e74c3c">🔴 offline</span>';
          const agoStr = age < 60000 ? `${Math.floor(age/1000)}s ago` : age < 3600000 ? `${Math.floor(age/60000)}m ago` : `${Math.floor(age/3600000)}h ago`;
          return `<tr><td style="font-weight:bold">🤖 ${name}</td><td>${statusDot}</td><td>${agoStr}</td><td>${hb.ip || '—'}</td></tr>`;
        }).join('');
      })()}
    </table>
  </div>

  <div class="refresh">Auto-refreshes every 0.5s &middot; <a href="/stats?json">JSON API</a></div>
</div>
<script>setTimeout(()=>location.reload(), 500)</script>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'GET' && p === '/skill') {
    try {
      const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      return res.end(skill);
    } catch { return json(res, 500, { error: 'skill file not found' }); }
  }

  // GET /scripts/:name — download helper scripts (crypto.js, check.js, reply.js)
  const scriptMatch = p.match(/^\/scripts\/([a-zA-Z0-9_-]+\.js)$/);
  if (req.method === 'GET' && scriptMatch) {
    const allowed = ['crypto.js', 'check.js', 'reply.js'];
    const name = scriptMatch[1];
    if (!allowed.includes(name)) return json(res, 404, { error: 'not found' });
    try {
      const script = fs.readFileSync(path.join(__dirname, name), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(script);
    } catch { return json(res, 500, { error: 'script not found' }); }
  }

  // --- Heartbeat (public read, auth write) ---

  // POST /heartbeat — bot checks in
  if (req.method === 'POST' && p === '/heartbeat') {
    if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      heartbeats.set(body.name, {
        name: body.name,
        lastSeen: new Date().toISOString(),
        ip: req.socket.remoteAddress,
        version: body.version || null,
      });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /heartbeat — who's alive (public)
  if (req.method === 'GET' && p === '/heartbeat') {
    const now = Date.now();
    const result = [];
    for (const [name, hb] of heartbeats) {
      const age = now - new Date(hb.lastSeen).getTime();
      result.push({ ...hb, online: age < HEARTBEAT_TIMEOUT, ageMs: age });
    }
    return json(res, 200, result);
  }

  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });

  // --- Bot Registry ---

  // POST /bots — register a bot with a public key
  if (req.method === 'POST' && p === '/bots') {
    try {
      const body = await readBody(req);
      if (!body.name || !body.publicKey) return json(res, 400, { error: 'name, publicKey required' });
      const bot = {
        name: body.name,
        publicKey: body.publicKey,
        registered: new Date().toISOString(),
      };
      bots.set(bot.name, bot);
      save();
      return json(res, 201, bot);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /bots — list all bots (names + public keys)
  if (req.method === 'GET' && p === '/bots') {
    return json(res, 200, [...bots.values()]);
  }

  // GET /bots/:name — get a specific bot's public key
  const botMatch = p.match(/^\/bots\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && botMatch) {
    const bot = bots.get(botMatch[1]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    return json(res, 200, bot);
  }

  // DELETE /bots/:name — unregister a bot (admin only)
  if (req.method === 'DELETE' && botMatch) {
    if (!ADMIN_TOKEN) return json(res, 403, { error: 'admin token not configured' });
    const adminAuth = (req.headers['x-admin-token'] || '').trim();
    if (adminAuth !== ADMIN_TOKEN) return json(res, 403, { error: 'admin access required' });
    if (!bots.has(botMatch[1])) return json(res, 404, { error: 'bot not found' });
    bots.delete(botMatch[1]);
    save();
    return json(res, 200, { deleted: botMatch[1] });
  }

  // --- Messages ---

  // POST /messages — send a new message
  if (req.method === 'POST' && p === '/messages') {
    try {
      const body = await readBody(req);
      if (!body.from || !body.to || !body.body) return json(res, 400, { error: 'from, to, body required' });
      const now = new Date();
      const msg = {
        id: `msg_${nanoid(12)}`,
        from: body.from,
        to: body.to,
        subject: body.subject || '',
        body: body.body,
        encrypted: body.encrypted || false,
        priority: body.priority || 'normal',
        status: 'pending',
        replyTo: body.replyTo || null,
        replies: [],
        created: now.toISOString(),
        expires: new Date(now.getTime() + EXPIRY_MS).toISOString(),
        seen_at: null,
      };
      messages.set(msg.id, msg);
      // If this is a reply, update the parent message
      if (msg.replyTo) {
        const parent = messages.get(msg.replyTo);
        if (parent) {
          parent.replies.push(msg.id);
          if (parent.status !== 'replied') parent.status = 'replied';
        }
      }
      save();
      return json(res, 201, msg);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /messages — list/filter messages
  if (req.method === 'GET' && p === '/messages') {
    expire();
    let results = [...messages.values()];
    const to = url.searchParams.get('to');
    const from = url.searchParams.get('from');
    const status = url.searchParams.get('status');
    if (to) results = results.filter(m => m.to === to);
    if (from) results = results.filter(m => m.from === from);
    if (status) results = results.filter(m => m.status === status);
    results.sort((a, b) => new Date(b.created) - new Date(a.created));
    return json(res, 200, results);
  }

  // GET /messages/:id
  const getMatch = p.match(/^\/messages\/(msg_[A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && getMatch) {
    const msg = messages.get(getMatch[1]);
    if (!msg) return json(res, 404, { error: 'not found' });
    return json(res, 200, msg);
  }

  // POST /messages/:id/reply
  const replyMatch = p.match(/^\/messages\/(msg_[A-Za-z0-9_-]+)\/reply$/);
  if (req.method === 'POST' && replyMatch) {
    try {
      const original = messages.get(replyMatch[1]);
      if (!original) return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (!body.from || !body.body) return json(res, 400, { error: 'from, body required' });
      const now = new Date();
      const reply = {
        id: `msg_${nanoid(12)}`,
        from: body.from,
        to: original.from,
        subject: `Re: ${original.subject}`,
        body: body.body,
        encrypted: body.encrypted || false,
        priority: original.priority,
        status: 'pending',
        replyTo: original.id,
        replies: [],
        created: now.toISOString(),
        expires: new Date(now.getTime() + EXPIRY_MS).toISOString(),
        seen_at: null,
      };
      messages.set(reply.id, reply);
      original.status = 'replied';
      original.replies.push(reply.id);
      save();
      return json(res, 201, reply);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // POST /messages/:id/seen
  const seenMatch = p.match(/^\/messages\/(msg_[A-Za-z0-9_-]+)\/seen$/);
  if (req.method === 'POST' && seenMatch) {
    const msg = messages.get(seenMatch[1]);
    if (!msg) return json(res, 404, { error: 'not found' });
    if (msg.status === 'pending') msg.status = 'seen';
    msg.seen_at = new Date().toISOString();
    save();
    return json(res, 200, msg);
  }

  // POST /messages/:id/burn — read and delete in one shot
  const burnMatch = p.match(/^\/messages\/(msg_[A-Za-z0-9_-]+)\/burn$/);
  if (req.method === 'POST' && burnMatch) {
    const msg = messages.get(burnMatch[1]);
    if (!msg) return json(res, 404, { error: 'not found' });
    messages.delete(burnMatch[1]);
    save();
    return json(res, 200, msg);
  }

  // DELETE /messages/:id
  const delMatch = p.match(/^\/messages\/(msg_[A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && delMatch) {
    if (!messages.has(delMatch[1])) return json(res, 404, { error: 'not found' });
    messages.delete(delMatch[1]);
    save();
    return json(res, 200, { deleted: true });
  }

  // GET /health
  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, { ok: true, messages: messages.size, bots: bots.size, uptime: process.uptime() });
  }

  json(res, 404, { error: 'not found' });
});

// --- Start ---
load();
setInterval(() => { expire(); save(); }, SAVE_INTERVAL);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nerve cord broker listening on 0.0.0.0:${PORT}`);
});
