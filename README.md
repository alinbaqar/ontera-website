# OnteraAI

AI-powered customer service agent for eBay sellers. Otis — the AI agent — monitors your eBay inbox, reads buyer messages, and sends replies automatically, 24/7.

🌐 **Website:** [ontera.io](https://ontera.io)

---

## What It Does

OnteraAI runs **Otis**, an AI agent that handles eBay customer messages so sellers don't have to. When a buyer sends a message, Otis picks it up in real time, reads the full conversation thread, and replies with a helpful, on-brand response — typically within minutes.

**Current capabilities:**
- 💬 **Real-time message handling** — eBay webhooks trigger Otis instantly when a new message arrives
- 🔍 **Full thread context** — reads the entire conversation before replying, never repeats itself
- 🧠 **Escalation detection** — flags disputes, frustrated buyers, and edge cases for the store owner
- 📊 **Activity feed** — every action Otis takes is logged to the seller dashboard
- 🔄 **Fallback cron** — runs every 3 hours as a safety net if webhooks miss anything

---

## Architecture

```
eBay buyer message
    ↓
eBay webhook notification
    ↓
Cloudflare Worker (ontera-api)
    ↓  [ctx.waitUntil — async, returns 200 to eBay immediately]
Apache reverse proxy on VPS (port 80 → 18789)
    ↓
OpenClaw gateway (port 18789)
    ↓  [triggers HEARTBEAT.md agent workflow]
Otis AI agent (Claude via AWS Bedrock)
    ↓  [uses otis-ebay MCP tools]
eBay REST Messaging API → reply sent
    ↓
Supabase activity log → dashboard updated
```

---

## Project Structure

```
/
├── index.html               # Marketing landing page
├── about.html
├── dashboard.html           # Seller dashboard (React app)
├── privacy.html
├── terms.html
├── waitlist.html
│
├── ontera-api/              # Cloudflare Worker
│   ├── worker.js            # API + webhook handler
│   └── wrangler.toml
│
├── otis-mcp-server/         # MCP server Otis uses as tools
│   ├── index.js             # 7 tools: refresh_token, list_conversations,
│   │                        # get_conversation_thread, send_reply,
│   │                        # check_already_replied, log_activity,
│   │                        # get_recent_activity
│   └── package.json
│
└── openclaw-agent/          # Otis agent configuration
    ├── SOUL.md              # Otis personality, tone, store guidelines
    ├── HEARTBEAT.md         # Main workflow: check inbox → reply
    └── CONVERSATION_GUIDE.md
```

---

## Stack

| Layer | Technology |
|---|---|
| AI agent runtime | [OpenClaw](https://openclaw.ai) on AWS Lightsail |
| AI model | Claude Sonnet (AWS Bedrock) |
| Worker / API proxy | Cloudflare Workers |
| Auth & database | Supabase |
| Frontend | Cloudflare Pages |
| eBay integration | eBay REST Messaging API + OAuth2 |

---

## Deployment

**Cloudflare Worker:**
```bash
cd ontera-api
npx wrangler deploy
```

**Frontend (dashboard + marketing site):**
Push to `main` — Cloudflare Pages auto-deploys.

**Otis (VPS):**
```bash
# On the VPS (Ubuntu, AWS Lightsail)
cd ~/ontera-website && git pull
openclaw gateway stop && sleep 2 && openclaw gateway start
```

---

## License

Proprietary — All rights reserved. See [LICENSE](LICENSE) for details.

---

## Contact

- **Email:** hello@ontera.io
- **Website:** [ontera.io](https://ontera.io)
