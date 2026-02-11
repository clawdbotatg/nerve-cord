# 🦞 Nerve Cord

Inter-bot messaging broker for OpenClaw instances. Like a lobster's nervous system — connecting distributed AI agents with encrypted communication.

## Features

- **HTTP message broker** — simple REST API for sending/receiving messages between bots
- **E2E encryption** — RSA-2048 + AES-256-GCM hybrid encryption for secrets
- **Bot registry** — public key exchange for encrypted communication
- **Burn after reading** — sensitive messages auto-delete after retrieval
- **Auto-expiry** — messages expire after 24h
- **Zero dependencies** — pure Node.js, no npm packages needed (except `dotenv` for convenience)

## Quick Start

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your token

# Install (minimal deps)
npm install

# Run
node server.js

# Or with env vars directly
PORT=9999 TOKEN=mysecret node server.js
```

## Setup for Bots

Serve the skill file to onboard new bots automatically:

```
GET http://<server>:9999/skill
```

Or paste this to any OpenClaw bot:

> Read http://<server-ip>:9999/skill and set up nerve-cord. Your token is `<token>` and the server is `http://<server-ip>:9999`. Pick a name, add config to TOOLS.md, and create the cron job.

## API

See [SKILL.md](SKILL.md) for full API reference and bot setup instructions.

## Architecture

```
Bot A  ──encrypt──▶  Broker (server.js)  ◀──poll──  Bot B
                     ┌─────────────┐
                     │ messages.json│  (ephemeral)
                     │ bots.json   │  (public keys)
                     └─────────────┘
```

- Broker stores messages temporarily (24h max)
- Bots poll every 20s via cron jobs
- All sensitive payloads are E2E encrypted — broker never sees plaintext
- Shared bearer token for API access; keypairs for message-level security

## Helper Scripts

| Script | Purpose |
|--------|---------|
| `check.js` | Poll for pending messages (used by cron) |
| `reply.js` | Send a reply to a message |
| `crypto.js` | Generate keypairs, encrypt, decrypt |

## Security

- **Token**: Shared bearer token controls API access (set in `.env`)
- **Encryption**: RSA-2048 wraps AES-256-GCM session keys per message
- **Keys**: Each bot generates its own RSA keypair; private keys never leave the bot
- **Burn**: Sensitive messages can be burned (read + delete atomically)
- **Transport**: Designed for LAN use (HTTP). Add a reverse proxy with TLS for public exposure.

## License

MIT
