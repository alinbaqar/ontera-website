#!/usr/bin/env node

/**
 * Otis eBay MCP Server
 *
 * Provides OpenClaw with structured tools for:
 *   - Refreshing eBay access tokens
 *   - Listing conversations that need a reply
 *   - Reading full conversation threads
 *   - Sending replies to buyers
 *   - Logging Otis activity to Supabase
 *   - Checking if Otis already replied (deduplication)
 *
 * Communicates via stdio (standard MCP transport for OpenClaw).
 * All eBay calls go through the Cloudflare Worker proxy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ─── Configuration ──────────────────────────────────────────────────────────
// These are read from environment variables set in OpenClaw's MCP config.

const API_URL = process.env.ONTERA_API_URL || "https://ontera-api.onteraai.workers.dev";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://tgyqxgppwqijvuxgybvm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const STORE_REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN || "";
const STORE_ID = process.env.STORE_ID || null; // Supabase stores.id — required for dashboard visibility

// ─── Supabase Client ────────────────────────────────────────────────────────

const supabase = SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ─── In-memory token cache ──────────────────────────────────────────────────

let cachedToken = { access_token: null, expires_at: 0 };

// ─── Helper: call Worker API ────────────────────────────────────────────────

async function workerPost(endpoint, body) {
  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (err) {
    return { error: `Network error calling ${endpoint}: ${err.message}` };
  }
}

// ─── MCP Server Setup ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "otis-ebay",
  version: "1.0.0",
});

// ─── Tool: refresh_token ────────────────────────────────────────────────────

server.tool(
  "refresh_token",
  "Refresh the eBay access token. Call this before any eBay API operation. Returns the access token. Tokens last ~2 hours.",
  {
    refresh_token: z.string().optional().describe(
      "eBay refresh token. If omitted, uses the store's configured token."
    ),
  },
  async ({ refresh_token }) => {
    const token = refresh_token || STORE_REFRESH_TOKEN;
    if (!token) {
      return { content: [{ type: "text", text: "ERROR: No refresh token available. Set EBAY_REFRESH_TOKEN env var." }] };
    }

    // Return cached token if still valid (with 5 min buffer)
    if (cachedToken.access_token && Date.now() < cachedToken.expires_at - 300_000) {
      return {
        content: [{ type: "text", text: JSON.stringify({ access_token: cachedToken.access_token, cached: true }) }],
      };
    }

    const data = await workerPost("/api/ebay/refresh-token", { refresh_token: token });

    if (data.access_token) {
      cachedToken = {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in || 7200) * 1000,
      };
      return { content: [{ type: "text", text: JSON.stringify({ access_token: data.access_token, expires_in: data.expires_in }) }] };
    }

    return { content: [{ type: "text", text: `ERROR: ${JSON.stringify(data)}` }] };
  }
);

// ─── Tool: list_conversations ───────────────────────────────────────────────

server.tool(
  "list_conversations",
  "Fetch all active eBay conversations. Returns each conversation with its ID, buyer name, latest message preview, whether it needs a reply, and the unread count. Use this to find conversations that need Otis's attention.",
  {
    access_token: z.string().describe("eBay access token from refresh_token tool"),
  },
  async ({ access_token }) => {
    const data = await workerPost("/api/ebay/conversations", { access_token });

    if (data.error) {
      return { content: [{ type: "text", text: `ERROR: ${JSON.stringify(data)}` }] };
    }

    const summary = (data.messages || []).map((m) => ({
      conversation_id: m.conversationId,
      buyer: m.sender,
      needs_reply: m.needsReply,
      unread_count: m.unreadCount,
      latest_message_preview: m.latestMessage?.substring(0, 120) || "",
      item_id: m.itemId,
      last_activity: m.receiveDate,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ conversations: summary, total: summary.length }) }],
    };
  }
);

// ─── Tool: get_conversation_thread ──────────────────────────────────────────

server.tool(
  "get_conversation_thread",
  "Fetch the full message thread for a specific eBay conversation. Returns all messages in chronological order with sender info (buyer vs seller). ALWAYS call this before replying to understand the full context. If the last message is from the seller, do NOT reply — Otis (or the store owner) already responded.",
  {
    access_token: z.string().describe("eBay access token"),
    conversation_id: z.string().describe("The conversation ID to fetch"),
  },
  async ({ access_token, conversation_id }) => {
    const data = await workerPost("/api/ebay/conversation", { access_token, conversation_id });

    if (data.error) {
      return { content: [{ type: "text", text: `ERROR: ${JSON.stringify(data)}` }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          conversation_id: data.conversationId,
          buyer: data.buyerUsername,
          messages: data.conversation,
          message_count: data.conversation?.length || 0,
          last_message_from: data.conversation?.length > 0
            ? data.conversation[data.conversation.length - 1].from
            : "unknown",
        }),
      }],
    };
  }
);

// ─── Tool: send_reply ───────────────────────────────────────────────────────

server.tool(
  "send_reply",
  "Send a reply message in an eBay conversation. Only call this after reading the full thread and confirming the last message is from the buyer (not the seller). The message should follow store tone guidelines — friendly, concise, 1-3 sentences.",
  {
    access_token: z.string().describe("eBay access token"),
    conversation_id: z.string().describe("The conversation ID to reply to"),
    recipient_username: z.string().describe("The buyer's eBay username"),
    message_text: z.string().describe("The reply message text"),
    item_id: z.string().optional().describe("Optional eBay listing ID to link the message to"),
  },
  async ({ access_token, conversation_id, recipient_username, message_text, item_id }) => {
    const body = { access_token, conversation_id, recipient_username, message_text };
    if (item_id) body.item_id = item_id;

    const data = await workerPost("/api/ebay/send-message", body);

    if (data.success) {
      // Auto-log the activity to Supabase
      if (supabase) {
        await supabase.from("otis_activity").insert({
          conversation_id,
          action_type: "message_sent",
          buyer_username: recipient_username,
          details: message_text,
          status: "success",
          store_id: STORE_ID,
        }).catch((err) => console.error("Failed to log activity:", err));
      }

      return { content: [{ type: "text", text: JSON.stringify({ success: true, message_id: data.messageId }) }] };
    }

    return { content: [{ type: "text", text: `ERROR: ${JSON.stringify(data)}` }] };
  }
);

// ─── Tool: check_already_replied ────────────────────────────────────────────

server.tool(
  "check_already_replied",
  "Check if Otis has already replied to a conversation recently (within the last 2 hours). Use this as a deduplication check before sending a reply, especially during cron runs. Returns true if a reply was already sent.",
  {
    conversation_id: z.string().describe("The conversation ID to check"),
  },
  async ({ conversation_id }) => {
    if (!supabase) {
      return { content: [{ type: "text", text: JSON.stringify({ already_replied: false, reason: "No Supabase configured — skipping check" }) }] };
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("otis_activity")
      .select("id, created_at")
      .eq("conversation_id", conversation_id)
      .eq("action_type", "message_sent")
      .gte("created_at", twoHoursAgo)
      .limit(1);

    if (error) {
      return { content: [{ type: "text", text: `ERROR checking activity log: ${error.message}` }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          already_replied: data.length > 0,
          last_reply_at: data[0]?.created_at || null,
        }),
      }],
    };
  }
);

// ─── Tool: log_activity ─────────────────────────────────────────────────────

server.tool(
  "log_activity",
  "Log an Otis action to the activity feed. Use this for non-message actions like: generating daily reports, flagging conversations for review, making recommendations, or skipping a conversation. This powers the Otis activity feed on the dashboard.",
  {
    action_type: z.enum([
      "message_sent",
      "daily_report",
      "conversation_flagged",
      "conversation_skipped",
      "recommendation",
      "error",
    ]).describe("The type of action being logged"),
    conversation_id: z.string().optional().describe("Related conversation ID, if applicable"),
    buyer_username: z.string().optional().describe("Related buyer username, if applicable"),
    details: z.string().describe("Human-readable description of what happened"),
    status: z.enum(["success", "failed", "flagged", "skipped"]).default("success"),
  },
  async ({ action_type, conversation_id, buyer_username, details, status }) => {
    if (!supabase) {
      return { content: [{ type: "text", text: "WARNING: No Supabase configured. Activity not logged." }] };
    }

    const { data, error } = await supabase
      .from("otis_activity")
      .insert({
        action_type,
        conversation_id: conversation_id || null,
        buyer_username: buyer_username || null,
        details,
        status,
        store_id: STORE_ID,
      })
      .select()
      .single();

    if (error) {
      return { content: [{ type: "text", text: `ERROR logging activity: ${error.message}` }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ logged: true, activity_id: data.id }) }] };
  }
);

// ─── Tool: get_recent_activity ──────────────────────────────────────────────

server.tool(
  "get_recent_activity",
  "Fetch recent Otis activity from the log. Use this to review what actions have been taken today or recently. Useful for generating daily reports or checking what's already been handled.",
  {
    limit: z.number().optional().default(20).describe("Max number of activity entries to return"),
    since_hours: z.number().optional().default(24).describe("Only return activity from the last N hours"),
  },
  async ({ limit, since_hours }) => {
    if (!supabase) {
      return { content: [{ type: "text", text: "WARNING: No Supabase configured." }] };
    }

    const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("otis_activity")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return { content: [{ type: "text", text: `ERROR: ${error.message}` }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ activities: data, count: data.length }) }] };
  }
);

// ─── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Otis eBay MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
