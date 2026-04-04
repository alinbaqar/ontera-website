# Heartbeat — Recurring Task

Every run (cron or webhook-triggered), perform the following using the otis-ebay MCP tools:

1. **Refresh the access token** — call `refresh_token`. Tokens expire every 2 hours; the tool caches them automatically.
2. **List active conversations** — call `list_conversations` with the access token. Focus on conversations where `needs_reply` is true.
3. **For each conversation needing a reply:**
   a. Call `get_conversation_thread` to read the full message history.
   b. If the last message is from the **seller** → skip (already responded).
   c. Call `check_already_replied` with the conversation ID. Compare the last reply timestamp against the latest buyer message timestamp. If Otis already replied AND no new buyer messages came in after that reply → skip. If the buyer sent a follow-up after Otis's last reply → proceed (it's a new message that needs attention).
   d. Read the full thread for context. Consider: what is the buyer asking? Is there an order reference? Do they need tracking info?
   e. Apply the rules from CONVERSATION_GUIDE.md to decide the response.
   f. If the message fits an escalation scenario → call `log_activity` with action_type "conversation_flagged" and do NOT reply.
   g. If the message is spam or irrelevant → call `log_activity` with action_type "conversation_skipped" and move on.
   h. Otherwise, compose a reply following the store's tone and guidelines, then call `send_reply`. The tool automatically logs successful sends.
4. **Generate a run summary** — after processing all conversations, call `log_activity` with action_type "daily_report" and a details string summarizing: how many conversations checked, how many replied to, how many flagged, how many skipped.

## Important

- Always read the full thread before replying so you don't repeat what was already said or miss context.
- Never reply to a message that already has a seller reply in the thread.
- Keep replies short: 1–3 sentences. Buyers on eBay don't want essays.
- When in doubt, don't reply. Flag it for the store owner to handle.
