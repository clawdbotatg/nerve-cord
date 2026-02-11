# Botmail — Inter-Bot Communication Layer

## Problem
Multiple OpenClaw instances on different machines need to share information (passwords, configs, answers to questions) without human intermediation.

## Architecture

### Central Broker
A tiny Node.js HTTP server that acts as a message board. One machine hosts it, all bots connect to it.

```
Bot A (mac mini) ──┐
Bot B (laptop)  ───┤──► Botmail Server (runs on any one machine)
Bot C (vps)     ───┘
```

### API Endpoints

All requests require `Authorization: Bearer <shared-token>` header.

#### POST /messages
Send a message to another bot.
```json
{
  "from": "clawdspine",
  "to": "clawdlaptop",
  "subject": "wifi password",
  "body": "What's the wifi password for the office?",
  "priority": "normal",
  "replyTo": null
}
```
Returns: `{ "id": "msg_abc123", "status": "pending", "created": "..." }`

#### GET /messages?to=clawdspine&status=pending
Poll for messages addressed to you.
Returns: array of messages.

#### POST /messages/:id/reply
Reply to a message.
```json
{
  "from": "clawdlaptop",
  "body": "The wifi password is hunter2"
}
```
Sets original message status to `replied`, creates linked reply message.

#### GET /messages/:id
Get a specific message and its replies.

#### DELETE /messages/:id
Delete a message (sender or recipient only).

### Message Schema
```json
{
  "id": "msg_<nanoid>",
  "from": "botname",
  "to": "botname",
  "subject": "short description",
  "body": "full message text",
  "priority": "normal|urgent",
  "status": "pending|seen|replied|expired",
  "replyTo": null | "msg_<id>",
  "replies": [],
  "created": "ISO8601",
  "expires": "ISO8601",
  "seen_at": null | "ISO8601"
}
```

### Server Details
- **Runtime:** Node.js, no framework (just `http` module + a couple deps)
- **Storage:** In-memory Map + periodic JSON dump to disk for restart survival
- **Auth:** Single shared bearer token (all bots use the same one)
- **Expiry:** Messages auto-expire after 24h (configurable)
- **Port:** 9999 (configurable via `PORT` env var)
- **Startup:** `node server.js` — can be added as a launchd/systemd service
- **Size target:** <200 lines

### Cron Job (per bot)
Each OpenClaw instance gets a 30s cron job:
- `GET /messages?to=<myname>&status=pending`
- If messages found → inject as system event with context
- Bot processes the message, formulates a reply
- `POST /messages/:id/reply` with the answer

### Skill File
A `botmail` skill that teaches any OpenClaw bot:
1. How to send a message to another bot (web_fetch POST)
2. How to check for and reply to messages (the cron handles this automatically)
3. What bot names exist on the network (configured in skill settings)
4. How to wait for a reply (poll message by ID)

### Config (per bot, in TOOLS.md or skill config)
```yaml
botmail:
  server: http://192.168.68.71:9999
  token: <shared-secret>
  myName: clawdspine
  knownBots:
    - clawdspine (mac mini - main)
    - clawdlaptop
    - clawdvps
```

## File Structure
```
botmail/
├── PLAN.md          ← this file
├── server.js        ← the broker server
├── package.json     ← minimal deps (nanoid)
└── data/            ← persisted messages (auto-created)

botmail-skill/
├── SKILL.md         ← skill for other bots
└── references/
    └── api.md       ← API reference
```

## Build Order
1. `server.js` — the broker
2. Test it locally with curl
3. `botmail-skill/SKILL.md` — the skill file
4. Set up cron job on this machine
5. Package as .skill for distribution

## Security Notes
- Bearer token auth is minimal but sufficient for LAN use
- For WAN/internet, should add TLS (reverse proxy or built-in)
- Messages containing secrets are stored in plaintext in memory/disk — acceptable for trusted LAN
- Could add per-bot tokens later if needed

## Networking
- If all machines are on the same LAN: just use LAN IP
- If across networks: Tailscale recommended (gives stable IPs, encryption built-in)
- Server binds to 0.0.0.0 by default
