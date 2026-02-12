#!/usr/bin/env node
// Nerve Cord checker — polls for pending messages and prints them
// Usage: TOKEN=xxx BOTNAME=clawdheart SERVER=http://localhost:9999 node check.js
// Exit 0 with JSON if messages found, exit 0 with empty string if none

const http = require('http');
const https = require('https');

const SERVER = process.env.SERVER || 'http://localhost:9999';
const TOKEN = process.env.TOKEN;
const BOTNAME = process.env.BOTNAME;

if (!TOKEN || !BOTNAME) { console.error('TOKEN and BOTNAME required'); process.exit(1); }

const url = `${SERVER}/messages?to=${BOTNAME}&status=pending`;
const mod = url.startsWith('https') ? https : http;

mod.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      let msgs = JSON.parse(data);
      // Filter out messages from ourselves (prevents self-reply loops)
      msgs = msgs.filter(m => m.from !== BOTNAME);
      // Filter out reply chains (Re: Re:) to prevent ping-pong loops
      msgs = msgs.filter(m => !m.subject || !m.subject.startsWith('Re: Re:'));
      // Limit to 3 messages per poll to avoid timeouts
      msgs = msgs.slice(0, 3);
      if (!msgs.length) process.exit(0); // no output = nothing to do
      console.log(JSON.stringify(msgs, null, 2));
    } catch (e) { console.error('Parse error:', e.message); process.exit(1); }
  });
}).on('error', e => { console.error('Request error:', e.message); process.exit(1); });
