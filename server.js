#!/usr/bin/env node
// Nerve Cord — Inter-bot message broker with E2E encryption
// Usage: PORT=9999 TOKEN=secret node server.js

// Load .env if present
const envPath = require('path').join(__dirname, '.env');
try {
  const envContent = require('fs').readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  });
} catch {}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '9999', 10);
const TOKEN = process.env.TOKEN || 'nerve-cord-default-token';
const READONLY_TOKEN = process.env.READONLY_TOKEN || '';
const LARVA_TOKEN = process.env.LARVA_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const LOG_DIR = path.join(DATA_DIR, 'log');
const PRIO_FILE = path.join(DATA_DIR, 'priorities.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const LARVA_EXPIRY_MS = 60 * 60 * 1000; // 1h — larvae expire after no heartbeat
const SAVE_INTERVAL = 30_000; // 30s
const HEARTBEAT_TIMEOUT = 30_000; // 30s = offline

// --- Storage ---
let messages = new Map();
let bots = new Map(); // name -> { name, publicKey, registered }
let heartbeats = new Map(); // name -> { lastSeen, ip, version }
let priorities = []; // ordered array of { text, setBy, setAt }
let suggestions = []; // community suggestions: { id, title, body, from, created }
let larvae = new Map(); // name -> { name, task, status, registered, lastSeen, ip }
let projects = []; // { id, name, status, repo, url, contract, chain, description, metadata, nextSteps, createdBy, created, updated }

// --- Activity Log (daily files) ---
function logDateKey(isoStr) { return isoStr.slice(0, 10); } // YYYY-MM-DD
function logFilePath(dateKey) { return path.join(LOG_DIR, `${dateKey}.json`); }
function readLogFile(dateKey) {
  const fp = logFilePath(dateKey);
  try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : []; }
  catch { return []; }
}
function writeLogFile(dateKey, entries) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(logFilePath(dateKey), JSON.stringify(entries, null, 2));
}
function appendLogEntry(entry) {
  const dk = logDateKey(entry.created);
  const entries = readLogFile(dk);
  entries.push(entry);
  writeLogFile(dk, entries);
}
function queryLog({ date, from, tag, limit }) {
  let dateKeys = [];
  if (date) {
    dateKeys = [date];
  } else {
    // Read all daily files
    try {
      dateKeys = fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort().reverse();
    } catch { dateKeys = []; }
  }
  let results = [];
  for (const dk of dateKeys) {
    results.push(...readLogFile(dk));
  }
  if (from) results = results.filter(e => e.from === from);
  if (tag) results = results.filter(e => e.tags.includes(tag));
  results.sort((a, b) => new Date(b.created) - new Date(a.created));
  if (limit > 0) results = results.slice(0, limit);
  return results;
}
function deleteLogEntry(id) {
  try {
    const dateKeys = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    for (const dk of dateKeys) {
      const entries = readLogFile(dk);
      const idx = entries.findIndex(e => e.id === id);
      if (idx !== -1) { entries.splice(idx, 1); writeLogFile(dk, entries); return true; }
    }
  } catch {}
  return false;
}

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
    if (fs.existsSync(PRIO_FILE)) {
      priorities = JSON.parse(fs.readFileSync(PRIO_FILE, 'utf8'));
      // Migrate: add IDs to any priorities missing them
      let migrated = false;
      priorities.forEach(p => {
        if (!p.id) { p.id = `prio_${nanoid(12)}`; migrated = true; }
      });
      if (migrated) save();
      console.log(`Loaded ${priorities.length} priorities from disk${migrated ? ' (migrated to stable IDs)' : ''}`);
    }
    if (fs.existsSync(SUGGESTIONS_FILE)) {
      suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
      console.log(`Loaded ${suggestions.length} suggestions from disk`);
    }
    if (fs.existsSync(PROJECTS_FILE)) {
      projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      console.log(`Loaded ${projects.length} projects from disk`);
    }
  } catch (e) { console.error('Load error:', e.message); }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...messages.values()], null, 2));
    fs.writeFileSync(BOTS_FILE, JSON.stringify([...bots.values()], null, 2));
    fs.writeFileSync(PRIO_FILE, JSON.stringify(priorities, null, 2));
    fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(suggestions, null, 2));
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

function rerank() {
  priorities.forEach((p, i) => p.rank = i + 1);
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
  if (h === `Bearer ${TOKEN}`) return 'full';
  if (LARVA_TOKEN && h === `Bearer ${LARVA_TOKEN}`) return 'larva';
  if (READONLY_TOKEN && h === `Bearer ${READONLY_TOKEN}`) return 'readonly';
  return false;
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
      <tr><th>Bot</th><th>Status</th><th>Last Seen</th><th>IP</th><th>Skill Ver.</th><th>OpenClaw</th></tr>
      ${(() => {
        const now = Date.now();
        const registered = [...bots.values()].map(b => b.name);
        // Get current skill version
        let currentSkillVersion = 'unknown';
        try {
          const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
          const versionMatch = skill.match(/^VERSION:\\s*(.+)$/m);
          currentSkillVersion = versionMatch ? versionMatch[1].trim() : 'unknown';
        } catch {}
        
        return registered.map(name => {
          const hb = heartbeats.get(name);
          if (!hb) return `<tr><td>🤖 ${name}</td><td><span style="color:#666">⚫ never seen</span></td><td>—</td><td>—</td><td><span style="color:#8b949e">—</span></td></tr>`;
          const age = now - new Date(hb.lastSeen).getTime();
          const online = age < HEARTBEAT_TIMEOUT;
          const statusDot = online
            ? '<span style="color:#2ecc71">🟢 online</span>'
            : '<span style="color:#e74c3c">🔴 offline</span>';
          const agoStr = age < 60000 ? `${Math.floor(age/1000)}s ago` : age < 3600000 ? `${Math.floor(age/60000)}m ago` : `${Math.floor(age/3600000)}h ago`;
          
          // Skill version color coding
          let skillVersionDisplay = '<span style="color:#8b949e">—</span>';
          if (hb.skillVersion) {
            const color = hb.skillVersion === currentSkillVersion ? '#2ecc71' : '#e74c3c';
            skillVersionDisplay = `<span style="color:${color}">${hb.skillVersion}</span>`;
          }
          
          const oclawDisplay = hb.version ? `<span style="color:#8b949e">${hb.version}</span>` : '<span style="color:#8b949e">—</span>';
          return `<tr><td style="font-weight:bold">🤖 ${name}</td><td>${statusDot}</td><td>${agoStr}</td><td>${hb.ip || '—'}</td><td>${skillVersionDisplay}</td><td>${oclawDisplay}</td></tr>`;
        }).join('');
      })()}
    </table>
  </div>

  <div class="section">
    <h2>🎯 Priorities</h2>
    ${priorities.length ? `<table>
      <tr><th>#</th><th>Priority</th><th>Set By</th></tr>
      ${priorities.map(p => `<tr>
        <td style="color:#58a6ff;font-weight:bold">${p.rank}</td>
        <td>${p.text}</td>
        <td style="color:#8b949e">${p.setBy}</td>
      </tr>`).join('')}
    </table>` : '<div style="color:#666;padding:4px 0">No priorities set</div>'}
  </div>

  <div class="section">
    <h2>📦 Projects</h2>
    ${(() => {
      if (!projects.length) return '<div style="color:#666;padding:4px 0">No projects tracked</div>';
      const statusOrder = ['idea','research','building','beta','live','paused','archived'];
      const statusColors = { idea:'#9b59b6', research:'#3498db', building:'#e67e22', beta:'#f1c40f', live:'#2ecc71', paused:'#95a5a6', archived:'#666' };
      const sorted = [...projects].sort((a,b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      const rows = sorted.map(p => {
        const color = statusColors[p.status] || '#8b949e';
        const badge = '<span style="background:' + color + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:11px">' + p.status + '</span>';
        const next = p.nextSteps && p.nextSteps.length ? p.nextSteps[0] : '—';
        const links = [p.repo ? '<a href="https://' + p.repo + '" style="color:#58a6ff;text-decoration:none">repo</a>' : '', p.url ? '<a href="' + p.url + '" style="color:#58a6ff;text-decoration:none">live</a>' : ''].filter(Boolean).join(' · ');
        return '<tr><td style="font-weight:bold">' + p.name + '</td><td>' + badge + '</td><td style="color:#8b949e;font-size:13px">' + next + '</td><td>' + (links || '—') + '</td></tr>';
      }).join('');
      return '<table><tr><th>Project</th><th>Status</th><th>Next Step</th><th>Links</th></tr>' + rows + '</table>';
    })()}
  </div>

  <div class="section">
    <h2>🐛 Larvae</h2>
    ${(() => {
      const now = Date.now();
      // Auto-purge larvae expired for more than 2x the expiry window
      for (const [name, l] of larvae) {
        if (now - new Date(l.lastSeen).getTime() > LARVA_EXPIRY_MS * 2) larvae.delete(name);
      }
      const allLarvae = [...larvae.values()];
      const active = allLarvae.filter(l => now - new Date(l.lastSeen).getTime() < LARVA_EXPIRY_MS);
      const expired = allLarvae.filter(l => now - new Date(l.lastSeen).getTime() >= LARVA_EXPIRY_MS);
      if (!allLarvae.length) return '<div style="color:#666;padding:4px 0">No larvae registered</div>';
      const statusColors = { starting: '#e67e22', working: '#3498db', done: '#2ecc71', error: '#e74c3c' };
      const rows = active.map(l => {
        const age = now - new Date(l.lastSeen).getTime();
        const agoStr = age < 60000 ? Math.floor(age/1000) + 's ago' : age < 3600000 ? Math.floor(age/60000) + 'm ago' : Math.floor(age/3600000) + 'h ago';
        const color = statusColors[l.status] || '#95a5a6';
        return '<tr>' +
          '<td style="font-weight:bold">🐛 ' + l.name + '</td>' +
          '<td><span style="color:' + color + '">' + l.status + '</span></td>' +
          '<td>' + (l.task || '—') + '</td>' +
          '<td style="color:#8b949e">' + agoStr + '</td>' +
          '</tr>';
      }).join('');
      return '<div style="margin-bottom:8px;color:#8b949e;font-size:13px">' + active.length + ' active' + (expired.length ? ', ' + expired.length + ' expired' : '') + '</div>' +
        (active.length ? '<table><tr><th>Name</th><th>Status</th><th>Task</th><th>Last Seen</th></tr>' + rows + '</table>' : '<div style="color:#666;padding:4px 0">No active larvae</div>');
    })()}
  </div>

  <div class="section">
    <h2>💡 Community Suggestions</h2>
    ${suggestions.length ? `<table>
      <tr><th>#</th><th>Title</th><th>From</th><th>Date</th></tr>
      ${suggestions.map((s, i) => `<tr>
        <td style="color:#58a6ff;font-weight:bold">${i + 1}</td>
        <td>${s.title}</td>
        <td style="color:#8b949e">${s.from}</td>
        <td style="color:#8b949e">${new Date(s.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
      </tr>`).join('')}
    </table>` : '<div style="color:#666;padding:4px 0">No suggestions yet</div>'}
  </div>

  <div class="section">
    <h2>📝 Activity Log</h2>
    ${(() => {
      const recentLogs = queryLog({ limit: 10 });
      if (!recentLogs.length) return '<div style="color:#666;padding:4px 0">No log entries yet</div>';
      return `<table>
        <tr><th>Time</th><th>Bot</th><th>Entry</th><th>Tags</th></tr>
        ${recentLogs.map(e => {
          const t = new Date(e.created);
          const timeStr = t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
          const tags = e.tags.length ? e.tags.map(t => `<span style="background:#1f6feb;color:#fff;padding:1px 6px;border-radius:8px;font-size:11px;margin-right:4px">${t}</span>`).join('') : '';
          return `<tr>
            <td style="color:#8b949e;white-space:nowrap">${timeStr}</td>
            <td style="font-weight:bold">🤖 ${e.from}</td>
            <td>${e.text}</td>
            <td>${tags}</td>
          </tr>`;
        }).join('')}
      </table>`;
    })()}
  </div>

  <div class="refresh">Auto-refreshes every 3s &middot; <a href="/stats?json">JSON API</a> &middot; <a href="/skill">SKILL.md</a></div>
</div>
<script>setTimeout(()=>location.reload(), 3000)</script>
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

  if (req.method === 'GET' && p === '/skill/version') {
    try {
      const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
      const versionMatch = skill.match(/^VERSION:\s*(.+)$/m);
      const version = versionMatch ? versionMatch[1].trim() : 'unknown';
      return json(res, 200, { version });
    } catch { return json(res, 500, { error: 'skill file not found' }); }
  }

  // GET /scripts/:name — download helper scripts (crypto.js, check.js, reply.js)
  const scriptMatch = p.match(/^\/scripts\/([a-zA-Z0-9_-]+\.js)$/);
  if (req.method === 'GET' && scriptMatch) {
    const allowed = ['crypto.js', 'check.js', 'reply.js', 'poll.js', 'send.js'];
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
    if (!auth(req)) return json(res, 401, { error: 'unauthorized' });  // readonly OK for heartbeat
    try {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      heartbeats.set(body.name, {
        name: body.name,
        lastSeen: new Date().toISOString(),
        ip: req.socket.remoteAddress,
        version: body.version || null,
        skillVersion: body.skillVersion || null,
      });
      // Also update larva lastSeen if this is a registered larva
      if (larvae.has(body.name)) {
        const l = larvae.get(body.name);
        l.lastSeen = new Date().toISOString();
        l.ip = req.socket.remoteAddress;
        if (body.status) l.status = body.status;
        if (body.task) l.task = body.task;
      }
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

  const authLevel = auth(req);
  if (!authLevel) return json(res, 401, { error: 'unauthorized' });

  // --- Read-only guard: readonly tokens can only GET + mark seen + suggestions ---
  if (authLevel === 'readonly') {
    const isSeen = req.method === 'POST' && /^\/messages\/msg_[A-Za-z0-9_-]+\/seen$/.test(p);
    const isSuggestion = (req.method === 'POST' && p === '/suggestions') ||
                         (req.method === 'DELETE' && /^\/suggestions\/sug_[A-Za-z0-9_-]+$/.test(p)) ||
                         (req.method === 'PATCH' && /^\/suggestions\/sug_[A-Za-z0-9_-]+$/.test(p));
    const isGet = req.method === 'GET';
    if (!isGet && !isSeen && !isSuggestion) return json(res, 403, { error: 'readonly token — write access denied' });
  }

  // --- Larva guard: can GET + suggestions + log + heartbeat + register as larva ---
  if (authLevel === 'larva') {
    const isGet = req.method === 'GET';
    const isSuggestion = (req.method === 'POST' && p === '/suggestions') ||
                         (req.method === 'DELETE' && /^\/suggestions\/sug_[A-Za-z0-9_-]+$/.test(p)) ||
                         (req.method === 'PATCH' && /^\/suggestions\/sug_[A-Za-z0-9_-]+$/.test(p));
    const isLog = req.method === 'POST' && p === '/log';
    const isHeartbeat = req.method === 'POST' && p === '/heartbeat';
    const isLarvaRegister = req.method === 'POST' && p === '/larvae';
    const isLarvaUpdate = req.method === 'PATCH' && /^\/larvae\/[a-zA-Z0-9_-]+$/.test(p);
    const isLarvaDelete = req.method === 'DELETE' && /^\/larvae\/[a-zA-Z0-9_-]+$/.test(p);
    const isProjectUpdate = req.method === 'PATCH' && /^\/projects\/proj_[A-Za-z0-9_-]+$/.test(p);
    const isSeen = req.method === 'POST' && /^\/messages\/msg_[A-Za-z0-9_-]+\/seen$/.test(p);
    if (!isGet && !isSuggestion && !isLog && !isHeartbeat && !isLarvaRegister && !isLarvaUpdate && !isLarvaDelete && !isProjectUpdate && !isSeen) {
      return json(res, 403, { error: 'larva token — limited write access' });
    }
  }

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
      if (body.encrypted !== true) return json(res, 400, { error: 'encrypted:true required — plaintext messages not allowed' });
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
      if (body.encrypted !== true) return json(res, 400, { error: 'encrypted:true required — plaintext messages not allowed' });
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

  // --- Activity Log ---

  // POST /log — add an entry
  if (req.method === 'POST' && p === '/log') {
    try {
      const body = await readBody(req);
      if (!body.from || !body.text) return json(res, 400, { error: 'from, text required' });
      const entry = {
        id: `log_${nanoid(12)}`,
        from: body.from,
        text: body.text,
        tags: body.tags || [],
        details: body.details || null,
        created: new Date().toISOString(),
      };
      appendLogEntry(entry);
      return json(res, 201, entry);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /log — read entries (filter: ?date=YYYY-MM-DD, ?from=name, ?tag=tag, ?limit=N)
  if (req.method === 'GET' && p === '/log') {
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const tag = url.searchParams.get('tag');
    const limit = parseInt(url.searchParams.get('limit') || '0', 10);
    const results = queryLog({ date, from, tag, limit });
    return json(res, 200, results);
  }

  // DELETE /log/:id — remove a log entry
  const logDelMatch = p.match(/^\/log\/(log_[A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && logDelMatch) {
    if (!deleteLogEntry(logDelMatch[1])) return json(res, 404, { error: 'not found' });
    return json(res, 200, { deleted: true });
  }

  // --- Priorities ---

  // GET /priorities — get current priority list
  if (req.method === 'GET' && p === '/priorities') {
    return json(res, 200, priorities);
  }

  // POST /priorities — create a new priority
  // Body: { text: "the thing", from: "botname", rank: 1 (optional, default: append) }
  if (req.method === 'POST' && p === '/priorities') {
    try {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      const now = new Date().toISOString();
      const entry = {
        id: `prio_${nanoid(12)}`,
        text: body.text,
        setBy: body.from || 'unknown',
        setAt: now,
      };
      // Insert at specified rank or append
      const targetRank = body.rank ? Math.max(1, Math.min(body.rank, priorities.length + 1)) : priorities.length + 1;
      priorities.splice(targetRank - 1, 0, entry);
      rerank();
      save();
      return json(res, 201, entry);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // POST /priorities/top — set top priority (pushes others down)
  // Body: { text: "the thing", from: "botname" }
  if (req.method === 'POST' && p === '/priorities/top') {
    try {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      const now = new Date().toISOString();
      // Remove if already in list (by text match)
      priorities = priorities.filter(p => p.text !== body.text);
      const entry = {
        id: `prio_${nanoid(12)}`,
        text: body.text,
        setBy: body.from || 'unknown',
        setAt: now,
      };
      priorities.unshift(entry);
      rerank();
      save();
      return json(res, 200, priorities);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // Priority routes by ID
  const prioIdMatch = p.match(/^\/priorities\/(prio_[A-Za-z0-9_-]+)(\/done)?$/);
  if (prioIdMatch) {
    const prioId = prioIdMatch[1];
    const isDone = prioIdMatch[2] === '/done';
    const idx = priorities.findIndex(p => p.id === prioId);

    // POST /priorities/:id/done — mark complete, auto-log, remove
    if (req.method === 'POST' && isDone) {
      if (idx === -1) return json(res, 404, { error: 'priority not found' });
      const completed = priorities.splice(idx, 1)[0];
      rerank();
      save();
      // Auto-log completion
      const logEntry = {
        id: `log_${nanoid(12)}`,
        from: completed.setBy,
        text: `Priority completed: ${completed.text}`,
        tags: ['priority', 'done'],
        details: null,
        created: new Date().toISOString(),
      };
      appendLogEntry(logEntry);
      return json(res, 200, { completed, logged: logEntry });
    }

    // PATCH /priorities/:id — update text or rerank
    if (req.method === 'PATCH' && !isDone) {
      if (idx === -1) return json(res, 404, { error: 'priority not found' });
      try {
        const body = await readBody(req);
        if (body.text) priorities[idx].text = body.text;
        if (body.from) priorities[idx].setBy = body.from;
        // Move to new rank if specified
        if (body.rank && body.rank !== priorities[idx].rank) {
          const [item] = priorities.splice(idx, 1);
          const newIdx = Math.max(0, Math.min(body.rank - 1, priorities.length));
          priorities.splice(newIdx, 0, item);
          rerank();
        }
        save();
        return json(res, 200, priorities[priorities.findIndex(p => p.id === prioId)]);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // DELETE /priorities/:id — remove by ID
    if (req.method === 'DELETE' && !isDone) {
      if (idx === -1) return json(res, 404, { error: 'priority not found' });
      priorities.splice(idx, 1);
      rerank();
      save();
      return json(res, 200, priorities);
    }
  }

  // DELETE /priorities/:rank — remove by rank (legacy, still works)
  const prioDelMatch = p.match(/^\/priorities\/(\d+)$/);
  if (req.method === 'DELETE' && prioDelMatch) {
    const rank = parseInt(prioDelMatch[1], 10);
    if (rank < 1 || rank > priorities.length) return json(res, 404, { error: 'rank out of range' });
    priorities.splice(rank - 1, 1);
    rerank();
    save();
    return json(res, 200, priorities);
  }

  // --- Larvae ---

  // POST /larvae — register a larva
  if (req.method === 'POST' && p === '/larvae') {
    try {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      const now = new Date().toISOString();
      const existing = larvae.get(body.name);
      const larva = {
        name: body.name,
        task: body.task || '',
        status: body.status || 'starting',
        registered: existing?.registered || now,
        lastSeen: now,
        ip: req.socket.remoteAddress,
      };
      larvae.set(body.name, larva);
      return json(res, 201, larva);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /larvae — list all larvae (optionally ?active=true for non-expired only)
  if (req.method === 'GET' && p === '/larvae') {
    const now = Date.now();
    let result = [...larvae.values()];
    if (url.searchParams.get('active') === 'true') {
      result = result.filter(l => now - new Date(l.lastSeen).getTime() < LARVA_EXPIRY_MS);
    }
    return json(res, 200, result);
  }

  // GET /larvae/:name — get a specific larva
  const larvaGetMatch = p.match(/^\/larvae\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && larvaGetMatch) {
    const l = larvae.get(larvaGetMatch[1]);
    if (!l) return json(res, 404, { error: 'larva not found' });
    return json(res, 200, l);
  }

  // PATCH /larvae/:name — update task/status
  if (req.method === 'PATCH' && larvaGetMatch) {
    const l = larvae.get(larvaGetMatch[1]);
    if (!l) return json(res, 404, { error: 'larva not found' });
    try {
      const body = await readBody(req);
      if (body.task !== undefined) l.task = body.task;
      if (body.status !== undefined) l.status = body.status;
      l.lastSeen = new Date().toISOString();
      return json(res, 200, l);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // DELETE /larvae/:name — remove a larva (full token only)
  if (req.method === 'DELETE' && larvaGetMatch) {
    if (!larvae.has(larvaGetMatch[1])) return json(res, 404, { error: 'larva not found' });
    larvae.delete(larvaGetMatch[1]);
    return json(res, 200, { deleted: larvaGetMatch[1] });
  }

  // --- Projects ---

  // GET /projects — list all projects (optionally ?status=building)
  if (req.method === 'GET' && p === '/projects') {
    let result = [...projects];
    const status = url.searchParams.get('status');
    if (status) result = result.filter(p => p.status === status);
    return json(res, 200, result);
  }

  // POST /projects — create a project (full token only)
  if (req.method === 'POST' && p === '/projects') {
    try {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      const now = new Date().toISOString();
      const project = {
        id: `proj_${nanoid(12)}`,
        name: body.name,
        status: body.status || 'idea',
        repo: body.repo || null,
        url: body.url || null,
        contract: body.contract || null,
        chain: body.chain || null,
        description: body.description || '',
        metadata: body.metadata || {},
        nextSteps: body.nextSteps || [],
        createdBy: body.from || 'unknown',
        created: now,
        updated: now,
      };
      projects.push(project);
      save();
      return json(res, 201, project);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // Project routes by ID
  const projMatch = p.match(/^\/projects\/(proj_[A-Za-z0-9_-]+)$/);

  // GET /projects/:id
  if (req.method === 'GET' && projMatch) {
    const proj = projects.find(p => p.id === projMatch[1]);
    if (!proj) return json(res, 404, { error: 'project not found' });
    return json(res, 200, proj);
  }

  // PATCH /projects/:id — update project (larva + full token)
  if (req.method === 'PATCH' && projMatch) {
    const idx = projects.findIndex(p => p.id === projMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'project not found' });
    try {
      const body = await readBody(req);
      const proj = projects[idx];
      if (body.name !== undefined) proj.name = body.name;
      if (body.status !== undefined) proj.status = body.status;
      if (body.repo !== undefined) proj.repo = body.repo;
      if (body.url !== undefined) proj.url = body.url;
      if (body.contract !== undefined) proj.contract = body.contract;
      if (body.chain !== undefined) proj.chain = body.chain;
      if (body.description !== undefined) proj.description = body.description;
      if (body.metadata !== undefined) proj.metadata = { ...proj.metadata, ...body.metadata };
      if (body.nextSteps !== undefined) proj.nextSteps = body.nextSteps;
      proj.updated = new Date().toISOString();
      save();
      return json(res, 200, proj);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // DELETE /projects/:id — remove project (full token only)
  if (req.method === 'DELETE' && projMatch) {
    const idx = projects.findIndex(p => p.id === projMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'project not found' });
    const removed = projects.splice(idx, 1)[0];
    save();
    return json(res, 200, { deleted: removed });
  }

  // --- Community Suggestions ---

  // GET /suggestions — list all suggestions (title + body)
  if (req.method === 'GET' && p === '/suggestions') {
    return json(res, 200, suggestions);
  }

  // POST /suggestions — add a suggestion (readonly OK)
  if (req.method === 'POST' && p === '/suggestions') {
    try {
      const body = await readBody(req);
      if (!body.title) return json(res, 400, { error: 'title required' });
      const entry = {
        id: `sug_${nanoid(12)}`,
        title: body.title,
        body: body.body || '',
        from: body.from || 'anonymous',
        created: new Date().toISOString(),
      };
      suggestions.push(entry);
      save();
      return json(res, 201, entry);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // GET /suggestions/:id — get a single suggestion
  const sugGetMatch = p.match(/^\/suggestions\/(sug_[A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && sugGetMatch) {
    const s = suggestions.find(s => s.id === sugGetMatch[1]);
    if (!s) return json(res, 404, { error: 'suggestion not found' });
    return json(res, 200, s);
  }

  // PATCH /suggestions/:id — update a suggestion (readonly OK)
  if (req.method === 'PATCH' && sugGetMatch) {
    const idx = suggestions.findIndex(s => s.id === sugGetMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'suggestion not found' });
    try {
      const body = await readBody(req);
      if (body.title) suggestions[idx].title = body.title;
      if (body.body !== undefined) suggestions[idx].body = body.body;
      save();
      return json(res, 200, suggestions[idx]);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // DELETE /suggestions/:id — remove a suggestion (readonly OK)
  if (req.method === 'DELETE' && sugGetMatch) {
    const idx = suggestions.findIndex(s => s.id === sugGetMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'suggestion not found' });
    const removed = suggestions.splice(idx, 1)[0];
    save();
    return json(res, 200, { deleted: removed });
  }

  json(res, 404, { error: 'not found' });
});

// --- Start ---
load();
setInterval(() => { expire(); save(); }, SAVE_INTERVAL);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nerve cord broker listening on 0.0.0.0:${PORT}`);
});
