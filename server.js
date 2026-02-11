#!/usr/bin/env node
// Nerve Cord — Inter-bot message broker with E2E encryption
// Usage: PORT=9999 TOKEN=secret node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '9999', 10);
const TOKEN = process.env.TOKEN || 'nerve-cord-default-token';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 30_000; // 30s

// --- Storage ---
let messages = new Map();
let bots = new Map(); // name -> { name, publicKey, registered }

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

// --- Routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Public endpoints (no auth)
  if (req.method === 'GET' && p === '/skill') {
    try {
      const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      return res.end(skill);
    } catch { return json(res, 500, { error: 'skill file not found' }); }
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
