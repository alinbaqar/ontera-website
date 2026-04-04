# OpenClaw Agent — Otis (OnteraAI)

These files configure the Otis AI agent that handles customer service for eBay stores via OpenClaw.

## Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Primary agent config — identity, core rules, workflow, tone |
| `IDENTITY.md` | Who Otis is — internal vs external identity |
| `STORE.md` | Store profile — products, pricing, shipping, return policy (customize per customer) |
| `CONVERSATION_GUIDE.md` | How to handle every type of buyer message, with examples |
| `HEARTBEAT.md` | The recurring task — what to do every cron run or webhook trigger |

## Architecture

```
eBay buyer sends message
        │
        ├─── Webhook path (fast): eBay notification → Cloudflare Worker → OpenClaw /hooks/agent
        │
        └─── Cron path (fallback): OpenClaw cron every 30 min → checks for unreplied conversations
                │
                ▼
        Otis (OpenClaw agent) runs HEARTBEAT.md workflow
                │
                ├── refresh_token (MCP tool)
                ├── list_conversations (MCP tool)
                ├── get_conversation_thread (MCP tool)
                ├── send_reply (MCP tool) → auto-logs to Supabase
                └── log_activity (MCP tool) → powers dashboard feed
```

## Setup on VPS

See `OTIS_SETUP_GUIDE.md` in the project root for complete setup instructions.

### Quick reference

```bash
# 1. Install MCP server
cd ~/otis-mcp-server && npm install

# 2. Register MCP server with OpenClaw
openclaw mcp set otis-ebay '{
  "command": "node",
  "args": ["/home/ubuntu/otis-mcp-server/index.js"],
  "env": {
    "ONTERA_API_URL": "https://ontera-api.onteraai.workers.dev",
    "SUPABASE_URL": "https://tgyqxgppwqijvuxgybvm.supabase.co",
    "SUPABASE_SERVICE_KEY": "<service-role-key>",
    "EBAY_REFRESH_TOKEN": "<store-refresh-token>",
    "STORE_ID": "<supabase-store-uuid>"
  }
}'

# 3. Copy agent files to workspace
cp SOUL.md IDENTITY.md STORE.md CONVERSATION_GUIDE.md HEARTBEAT.md ~/.openclaw/workspace/

# 4. Add cron job
openclaw cron add \
  --name "otis-check-messages" \
  --cron "*/30 * * * *" \
  --session isolated \
  --message "Run the HEARTBEAT.md workflow: refresh token, check all conversations, reply where needed, log all actions."

# 5. Restart gateway
pkill -9 -f openclaw-gateway && sleep 2 && openclaw gateway restart
```
