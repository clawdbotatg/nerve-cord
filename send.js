#!/usr/bin/env node
// Nerve Cord send helper — fetch key, encrypt, send in one step
// Usage: TOKEN=xxx SERVER=http://server:9999 node send.js <to> <subject> <message>
// Env: TOKEN (required), SERVER or NERVE_SERVER (default: http://localhost:9999)

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const SERVER = process.env.SERVER || process.env.NERVE_SERVER || 'http://localhost:9999';
const TOKEN = process.env.TOKEN;
const FROM = process.env.BOTNAME || process.env.NERVE_BOTNAME;
const to = process.argv[2];
const subject = process.argv[3];
const message = process.argv[4];

if (!TOKEN || !FROM || !to || !subject || !message) {
  console.error('Usage: TOKEN=xxx BOTNAME=xxx node send.js <to> <subject> <message>');
  console.error('Env: TOKEN, BOTNAME (or NERVE_BOTNAME), SERVER (or NERVE_SERVER)');
  process.exit(1);
}

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, timeout: 10000
    };
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
      const req = mod.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, data: d }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end(payload);
    } else {
      const req = mod.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, data: d }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    }
  });
}

function encrypt(publicKeyPem, plaintext) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedKey = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  const combined = Buffer.concat([encryptedKey, iv, authTag, encrypted]);
  return combined.toString('base64');
}

async function main() {
  // 1. Fetch recipient's public key
  const botRes = await request('GET', `${SERVER}/bots/${to}`);
  if (botRes.status !== 200) {
    console.error(`Failed to get public key for ${to}: ${botRes.data}`);
    process.exit(1);
  }
  const bot = JSON.parse(botRes.data);
  const publicKey = bot.publicKey;

  // 2. Encrypt the message
  const encryptedBody = encrypt(publicKey, message);

  // 3. Send it
  const msgRes = await request('POST', `${SERVER}/messages`, {
    from: FROM, to, subject, body: encryptedBody, encrypted: true
  });
  if (msgRes.status === 201) {
    const msg = JSON.parse(msgRes.data);
    console.log(`Sent encrypted message ${msg.id} to ${to}`);
  } else {
    console.error(`Send failed: ${msgRes.data}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
