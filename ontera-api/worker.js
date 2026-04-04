// OnteraAI Worker API — eBay Integration
// Endpoints (REST Message API — v2):
//   POST /api/ebay/refresh-token    — Exchange refresh token for access token
//   POST /api/ebay/conversations    — List conversations via REST Message API
//   POST /api/ebay/conversation     — Get full conversation thread via REST Message API
//   POST /api/ebay/send-message     — Send message via REST Message API
// Webhook:
//   POST /webhook/ebay-messages     — eBay notification → forwards to OpenClaw VPS
// Legacy endpoints (Trading API — kept as fallback):
//   POST /api/ebay/messages         — Fetch message list (grouped into threads)
//   POST /api/ebay/message          — Fetch individual message detail/conversation
//   POST /api/ebay/thread           — Fetch full thread (XML parsing approach)
//   POST /api/ebay/send-reply       — Send reply via AddMemberMessageRTQ

const EBAY_CLIENT_ID = 'OnteraAI-OnteraAI-PRD-9f606c9d9-f2983eac';
const EBAY_CLIENT_SECRET = 'PRD-f606c9d91229-58ae-4b8f-8e30-18f5';
const EBAY_AUTH_HEADER = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`);

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://ontera.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- Refresh Token ---
      if (path === '/api/ebay/refresh-token' && request.method === 'POST') {
        const { refresh_token } = await request.json();
        const tokenResponse = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${EBAY_AUTH_HEADER}`,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token,
          }),
        });
        const tokenData = await tokenResponse.json();
        return new Response(JSON.stringify(tokenData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ============================================================
      // REST MESSAGE API v2 ENDPOINTS
      // ============================================================

      // --- List Conversations (REST Message API) ---
      if (path === '/api/ebay/conversations' && request.method === 'POST') {
        const { access_token } = await request.json();

        const conversationsRes = await fetch(
          'https://api.ebay.com/commerce/message/v1/conversation?conversation_type=FROM_MEMBERS&conversation_status=ACTIVE&limit=50',
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${access_token}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
          }
        );
        const conversationsData = await conversationsRes.json();

        if (conversationsData.errors) {
          return new Response(JSON.stringify({
            error: 'eBay API error',
            details: conversationsData.errors,
            _fallback: 'Use /api/ebay/messages (Trading API) as fallback',
          }), {
            status: conversationsRes.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Transform to OnteraAI format
        // For sender, use the conversationTitle which is typically the other party's username
        const threads = (conversationsData.conversations || []).map(c => {
          // The conversation title usually contains the buyer's username
          const latestSender = c.latestMessage?.senderUsername || '';
          const latestRecipient = c.latestMessage?.recipientUsername || '';
          // Use conversationTitle as the other party name (buyer)
          const buyerName = c.conversationTitle || latestSender || 'Unknown';

          return {
            id: c.conversationId,
            conversationId: c.conversationId,
            sender: buyerName,
            subject: c.conversationTitle || 'No subject',
            itemId: c.referenceId || null,
            receiveDate: c.latestMessage?.createdDate || c.createdDate,
            read: c.unreadCount === 0,
            needsReply: c.unreadCount > 0,
            unreadCount: c.unreadCount || 0,
            latestMessage: c.latestMessage?.messageBody || '',
            conversationStatus: c.conversationStatus,
          };
        });

        return new Response(JSON.stringify({ messages: threads, _source: 'REST_MESSAGE_API' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- Get Conversation Thread (REST Message API) ---
      if (path === '/api/ebay/conversation' && request.method === 'POST') {
        const { access_token, conversation_id } = await request.json();

        if (!access_token || !conversation_id) {
          return new Response(JSON.stringify({ error: 'Missing access_token or conversation_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Fetch all messages in the conversation (paginate if needed)
        let allMessages = [];
        let offset = 0;
        let total = null;

        while (total === null || offset < total) {
          const threadRes = await fetch(
            `https://api.ebay.com/commerce/message/v1/conversation/${encodeURIComponent(conversation_id)}?conversation_type=FROM_MEMBERS&limit=50&offset=${offset}`,
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
              },
            }
          );
          const threadData = await threadRes.json();

          if (threadData.errors) {
            return new Response(JSON.stringify({
              error: 'eBay API error',
              details: threadData.errors,
              _fallback: 'Use /api/ebay/thread (Trading API) as fallback',
            }), {
              status: threadRes.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          if (threadData.messages) {
            allMessages = allMessages.concat(threadData.messages);
          }
          total = threadData.total || 0;
          offset += 50;

          // Safety: don't fetch more than 500 messages
          if (offset >= 500) break;
        }

        // Sort oldest first for chat display
        allMessages.sort((a, b) => new Date(a.createdDate) - new Date(b.createdDate));

        // Determine buyer vs seller
        // The first message in a conversation is always from the buyer (they initiate)
        const usernames = new Set();
        allMessages.forEach(m => {
          if (m.senderUsername) usernames.add(m.senderUsername);
          if (m.recipientUsername) usernames.add(m.recipientUsername);
        });
        const buyerUsername = allMessages.length > 0 ? allMessages[0].senderUsername : null;

        // Transform to OnteraAI conversation format
        const conversation = allMessages.map(m => ({
          from: m.senderUsername === buyerUsername ? 'buyer' : 'seller',
          senderName: m.senderUsername,
          recipientName: m.recipientUsername,
          text: m.messageBody || '',
          time: m.createdDate,
          messageId: m.messageId,
          readStatus: m.readStatus,
          media: m.messageMedia || [],
        }));

        return new Response(JSON.stringify({
          conversation,
          conversationId: conversation_id,
          buyerUsername,
          _source: 'REST_MESSAGE_API',
          _usernames: Array.from(usernames),
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- Send Message (REST Message API) ---
      if (path === '/api/ebay/send-message' && request.method === 'POST') {
        const { access_token, conversation_id, recipient_username, message_text, item_id } = await request.json();

        if (!access_token || !message_text) {
          return new Response(JSON.stringify({ error: 'Missing access_token or message_text' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const requestBody = {
          messageText: message_text,
        };

        // Use conversationId for existing conversations, otherPartyUsername for new ones
        if (conversation_id) {
          requestBody.conversationId = conversation_id;
        } else if (recipient_username) {
          requestBody.otherPartyUsername = recipient_username;
        } else {
          return new Response(JSON.stringify({ error: 'Must provide conversation_id or recipient_username' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Optionally link to a listing
        if (item_id) {
          requestBody.reference = {
            referenceId: item_id,
            referenceType: 'LISTING',
          };
        }

        const sendRes = await fetch('https://api.ebay.com/commerce/message/v1/send_message', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
          body: JSON.stringify(requestBody),
        });
        const sendData = await sendRes.json();

        if (sendData.errors) {
          return new Response(JSON.stringify({
            success: false,
            error: sendData.errors[0]?.message || 'Failed to send message',
            details: sendData.errors,
          }), {
            status: sendRes.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Message sent successfully',
          messageId: sendData.messageId,
          createdDate: sendData.createdDate,
          _source: 'REST_MESSAGE_API',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ============================================================
      // WEBHOOK: eBay → OpenClaw (Otis)
      // ============================================================

      // --- eBay Platform Notification Endpoint ---
      // eBay sends POST notifications here when a new message arrives.
      // This endpoint verifies the notification and forwards it to the
      // OpenClaw webhook gateway on the VPS, triggering an Otis agent run.
      // --- eBay Verification Challenge (GET) ---
      // eBay sends a GET request with challenge_code as a query parameter during
      // webhook subscription setup. Must respond with a SHA-256 hash.
      if (path === '/webhook/ebay-messages' && request.method === 'GET') {
        const challengeCode = url.searchParams.get('challenge_code');
        if (challengeCode) {
          const verificationToken = env.EBAY_VERIFICATION_TOKEN || '';
          const endpoint = 'https://ontera-api.onteraai.workers.dev/webhook/ebay-messages';
          const hash = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(challengeCode + verificationToken + endpoint)
          );
          const challengeResponse = Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
          return new Response(JSON.stringify({ challengeResponse }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // No challenge_code — return 200 with status (health check)
        return new Response(JSON.stringify({ status: 'webhook endpoint active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // --- eBay Notification Handler (POST) ---
      // eBay sends POST notifications when a new message arrives.
      if (path === '/webhook/ebay-messages' && request.method === 'POST') {
        try {
          const body = await request.text();

          // Forward the notification to OpenClaw on the VPS.
          // The VPS_OPENCLAW_URL and OPENCLAW_HOOK_TOKEN are set as Worker secrets.
          const vpsUrl = env.VPS_OPENCLAW_URL || '';
          const hookToken = env.OPENCLAW_HOOK_TOKEN || '';

          if (vpsUrl && hookToken) {
            // Use ctx.waitUntil() to forward asynchronously — respond to eBay immediately
            // without waiting for the VPS call to complete.
            ctx.waitUntil(
              fetch(`${vpsUrl}/hooks/agent`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${hookToken}`,
                },
                body: JSON.stringify({
                  message: `New eBay message notification received. Run the HEARTBEAT.md workflow: refresh token, check all conversations, reply where needed, log all actions. Notification payload: ${body.substring(0, 500)}`,
                  name: 'otis-webhook-trigger',
                  timeoutSeconds: 120,
                }),
              }).catch(err => {
                console.error('Failed to forward to OpenClaw:', err);
              })
            );
          }

          // Respond 200 to eBay immediately so it doesn't retry or time out
          return new Response(JSON.stringify({ received: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          console.error('Webhook error:', err);
          return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
            status: 200, // Still 200 so eBay doesn't retry
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // ============================================================
      // LEGACY TRADING API ENDPOINTS (fallback)
      // ============================================================

      // --- Fetch Messages ---
      if (path === '/api/ebay/messages' && request.method === 'POST') {
        const { access_token } = await request.json();
        const messagesResponse = await fetch('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
            'X-EBAY-API-CALL-NAME': 'GetMyMessages',
            'X-EBAY-API-IAF-TOKEN': access_token,
            'Content-Type': 'text/xml',
          },
          body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnHeaders</DetailLevel>
  <FolderID>0</FolderID>
</GetMyMessagesRequest>`,
        });
        const messagesXml = await messagesResponse.text();
        const allMessages = parseMessagesXml(messagesXml);

        // Group messages into threads by sender + item, keeping ALL message IDs
        const threadMap = new Map();
        for (const msg of allMessages) {
          const threadKey = msg.itemId ? `${msg.sender}:${msg.itemId}` : msg.sender;
          if (!threadMap.has(threadKey)) {
            threadMap.set(threadKey, {
              ...msg,
              threadKey,
              messageCount: 1,
              allMessageIds: [{ id: msg.id, receiveDate: msg.receiveDate, sender: msg.sender, replied: msg.replied }],
              needsReply: !msg.replied && msg.responseEnabled,
            });
          } else {
            const existing = threadMap.get(threadKey);
            existing.messageCount++;
            existing.allMessageIds.push({ id: msg.id, receiveDate: msg.receiveDate, sender: msg.sender, replied: msg.replied });
            if (new Date(msg.receiveDate) > new Date(existing.receiveDate)) {
              existing.id = msg.id;
              existing.receiveDate = msg.receiveDate;
              existing.subject = msg.subject;
              existing.read = msg.read;
            }
            if (!msg.replied && msg.responseEnabled) {
              existing.needsReply = true;
            }
          }
        }

        const threads = Array.from(threadMap.values()).sort(
          (a, b) => new Date(b.receiveDate) - new Date(a.receiveDate)
        );
        return new Response(JSON.stringify({ messages: threads }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- Fetch Single Message Detail (legacy) ---
      if (path === '/api/ebay/message' && request.method === 'POST') {
        const { access_token, message_id } = await request.json();
        const messageResponse = await fetch('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
            'X-EBAY-API-CALL-NAME': 'GetMyMessages',
            'X-EBAY-API-IAF-TOKEN': access_token,
            'Content-Type': 'text/xml',
          },
          body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
    <MessageID>${message_id}</MessageID>
  </MessageIDs>
</GetMyMessagesRequest>`,
        });
        const messageXml = await messageResponse.text();
        const messageDetail = parseMessageDetailXml(messageXml);
        return new Response(JSON.stringify(messageDetail), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- Fetch Full Thread (all messages in a conversation) ---
      if (path === '/api/ebay/thread' && request.method === 'POST') {
        const { access_token, message_ids } = await request.json();

        if (!access_token || !message_ids || !message_ids.length) {
          return new Response(JSON.stringify({ error: 'Missing access_token or message_ids' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Fetch detail for each message in the thread (up to 10 at a time via eBay API)
        const messageIdTags = message_ids.map(m => `<MessageID>${escapeXml(m.id)}</MessageID>`).join('\n    ');
        const threadResponse = await fetch('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
            'X-EBAY-API-CALL-NAME': 'GetMyMessages',
            'X-EBAY-API-IAF-TOKEN': access_token,
            'Content-Type': 'text/xml',
          },
          body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
    ${messageIdTags}
  </MessageIDs>
</GetMyMessagesRequest>`,
        });
        const threadXml = await threadResponse.text();

        // Collect all messages with their dates to find the most recent one
        const allParsedMsgs = [];
        const messageRegex = /<Message>([\s\S]*?)<\/Message>/g;
        let match;
        let sellerName = null;

        while ((match = messageRegex.exec(threadXml)) !== null) {
          const msgXml = match[1];
          const sender = extractTag(msgXml, 'Sender');
          const sendToName = extractTag(msgXml, 'SendToName');
          const receiveDate = extractTag(msgXml, 'ReceiveDate');
          const msgId = extractTag(msgXml, 'MessageID');
          if (sendToName && !sellerName) sellerName = sendToName;

          const textMatch = msgXml.match(/<Text>([\s\S]*?)<\/Text>/);
          const contentMatch = msgXml.match(/<Content>([\s\S]*?)<\/Content>/);
          const rawContent = textMatch ? textMatch[1] : contentMatch ? contentMatch[1] : '';

          allParsedMsgs.push({ sender, sendToName, receiveDate, msgId, rawContent });
        }

        // Sort by date descending — the most recent message contains the full conversation chain
        allParsedMsgs.sort((a, b) => new Date(b.receiveDate) - new Date(a.receiveDate));

        // Parse the full conversation from the most recent message's HTML
        // eBay format (newest first in HTML):
        //   "Dear [seller], [buyer msg] - [buyer]"
        //   "Your previous message"
        //   "[seller reply text]"
        //   "Dear [buyer], [seller reply] - [seller]"
        //   "[older buyer msg]"
        //   "Dear [buyer], [older buyer msg] - [seller]"   ← confusing: eBay wraps buyer text in "Dear buyer" signed by seller
        //   "Your previous message"
        //   "[older seller reply]"
        //   ... repeats
        let conversation = [];

        if (allParsedMsgs.length > 0) {
          const newest = allParsedMsgs[0];
          const cleanContent = decodeHtmlEntities(newest.rawContent);
          conversation = parseEbayThread(cleanContent, sellerName, newest.sender);

          // Assign timestamps: use each eBay message's receiveDate for buyer messages
          // allParsedMsgs are sorted newest-first, conversation is oldest-first
          // Map buyer messages to eBay message dates (oldest buyer msg → oldest eBay msg date)
          const buyerMsgs = conversation.filter(m => m.from === 'buyer');
          const sortedDates = allParsedMsgs.map(m => m.receiveDate).sort((a, b) => new Date(a) - new Date(b));
          for (let i = 0; i < buyerMsgs.length && i < sortedDates.length; i++) {
            buyerMsgs[i].time = sortedDates[i];
          }
          // For seller replies, set time slightly after the buyer message they follow
          for (let i = 0; i < conversation.length; i++) {
            if (conversation[i].from === 'seller' && !conversation[i].time) {
              // Find the preceding buyer message time
              for (let j = i - 1; j >= 0; j--) {
                if (conversation[j].time) {
                  // Add 1 minute to indicate reply came after
                  const t = new Date(conversation[j].time);
                  t.setMinutes(t.getMinutes() + 1);
                  conversation[i].time = t.toISOString();
                  break;
                }
              }
            }
          }
        }

        // Get item info from first message
        const firstMsgMatch = threadXml.match(/<Message>([\s\S]*?)<\/Message>/);
        const itemTitle = firstMsgMatch ? extractTag(firstMsgMatch[1], 'ItemTitle') : '';
        const itemId = firstMsgMatch ? extractTag(firstMsgMatch[1], 'ItemID') : '';
        const buyerName = allParsedMsgs[0]?.sender;

        // --- Fetch seller replies via GetMemberMessages + Sent folder ---
        // The HTML chain parsing misses the seller's most recent reply if no new
        // buyer message has arrived after it. We try two approaches:
        //   1. GetMemberMessages — returns Q&A exchanges for the item
        //   2. GetMyMessages with Sent folder — returns outbound messages
        let memberMsgDebug = null;
        if (itemId) {
          try {
            // Approach 1: GetMemberMessages
            const memberMsgResponse = await fetch('https://api.ebay.com/ws/api.dll', {
              method: 'POST',
              headers: {
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                'X-EBAY-API-CALL-NAME': 'GetMemberMessages',
                'X-EBAY-API-IAF-TOKEN': access_token,
                'Content-Type': 'text/xml',
              },
              body: `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <MailMessageType>All</MailMessageType>
</GetMemberMessagesRequest>`,
            });
            const memberXml = await memberMsgResponse.text();
            const memberAck = extractTag(memberXml, 'Ack');
            memberMsgDebug = { ack: memberAck, rawSample: memberXml.substring(0, 3000) };

            if (memberAck === 'Success' || memberAck === 'Warning') {
              // Parse MemberMessageExchange elements — each has a Question and optionally Response(s)
              const exchangeRegex = /<MemberMessageExchange>([\s\S]*?)<\/MemberMessageExchange>/g;
              let exMatch;
              const existingTexts = new Set(conversation.map(c => c.text.trim().toLowerCase()));
              let addedCount = 0;
              let skippedOtherBuyer = 0;
              const sellerLower = (sellerName || '').toLowerCase();
              const buyerLower = (buyerName || '').toLowerCase();

              while ((exMatch = exchangeRegex.exec(memberXml)) !== null) {
                const exXml = exMatch[1];

                // Extract Question (buyer → seller)
                const questionMatch = exXml.match(/<Question>([\s\S]*?)<\/Question>/);
                if (questionMatch) {
                  const qBody = extractTag(questionMatch[1], 'Body');
                  const qSender = extractTag(questionMatch[1], 'SenderID');
                  const qDate = extractTag(questionMatch[1], 'CreationDate');

                  // Filter: only include messages from THIS thread's buyer or the seller
                  const senderLower = (qSender || '').toLowerCase();
                  if (senderLower !== sellerLower && senderLower !== buyerLower) {
                    skippedOtherBuyer++;
                    continue; // Different buyer for same item — skip
                  }

                  // Decode HTML entities in body text (GetMemberMessages can return encoded HTML)
                  const cleanBody = qBody ? qBody.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").trim() : '';

                  if (cleanBody && !existingTexts.has(cleanBody.toLowerCase())) {
                    existingTexts.add(cleanBody.toLowerCase());
                    conversation.push({
                      from: senderLower === sellerLower ? 'seller' : 'buyer',
                      senderName: qSender,
                      text: cleanBody,
                      time: qDate || undefined,
                    });
                    addedCount++;
                  }
                }

                // Extract Response(s) (seller → buyer) — these are seller replies
                const responseRegex = /<Response>([\s\S]*?)<\/Response>/g;
                let rMatch;
                while ((rMatch = responseRegex.exec(exXml)) !== null) {
                  const rBody = extractTag(rMatch[1], 'Body');
                  const rDate = extractTag(rMatch[1], 'CreationDate');

                  // Only include responses that belong to this buyer's thread
                  // Check if the parent Question was from our buyer (already filtered above)
                  // If we got here, the exchange wasn't skipped, so the response belongs to this thread
                  const cleanBody = rBody ? rBody.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").trim() : '';

                  if (cleanBody && !existingTexts.has(cleanBody.toLowerCase())) {
                    existingTexts.add(cleanBody.toLowerCase());
                    conversation.push({
                      from: 'seller',
                      senderName: sellerName,
                      text: cleanBody,
                      time: rDate || undefined,
                    });
                    addedCount++;
                  }
                }
              }

              memberMsgDebug.addedMessages = addedCount;
              memberMsgDebug.skippedOtherBuyer = skippedOtherBuyer;

              // Re-sort conversation by time after merging
              conversation.sort((a, b) => {
                if (!a.time || !b.time) return 0;
                return new Date(a.time) - new Date(b.time);
              });
            }
          } catch (e) {
            memberMsgDebug = { error: e.message };
          }

          // Approach 2: Try fetching from Sent folder
          // eBay GetMyMessages requires StartCreationTime/EndCreationTime when using FolderID
          // We look back 30 days to catch recent sent messages
          try {
            const existingTexts = new Set(conversation.map(c => c.text.trim().toLowerCase()));
            let sentDebug = {};
            const now = new Date();
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const startTime = thirtyDaysAgo.toISOString();
            const endTime = now.toISOString();

            for (const folderId of [1, 2]) {
              // Step 1: Get message HEADERS from Sent folder (with time range)
              const sentHeaderResponse = await fetch('https://api.ebay.com/ws/api.dll', {
                method: 'POST',
                headers: {
                  'X-EBAY-API-SITEID': '0',
                  'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                  'X-EBAY-API-CALL-NAME': 'GetMyMessages',
                  'X-EBAY-API-IAF-TOKEN': access_token,
                  'Content-Type': 'text/xml',
                },
                body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnHeaders</DetailLevel>
  <FolderID>${folderId}</FolderID>
  <StartCreationTime>${startTime}</StartCreationTime>
  <EndCreationTime>${endTime}</EndCreationTime>
</GetMyMessagesRequest>`,
              });
              const sentHeaderXml = await sentHeaderResponse.text();
              const sentAck = extractTag(sentHeaderXml, 'Ack');
              // Count actual <Message> elements (eBay doesn't return NumberOfMessages)
              const msgCount = (sentHeaderXml.match(/<Message>/g) || []).length;
              sentDebug[`folder${folderId}`] = {
                ack: sentAck,
                totalMessages: String(msgCount),
                rawSample: sentHeaderXml.substring(0, 1500),
              };

              if ((sentAck === 'Success' || sentAck === 'Warning') && msgCount > 0) {
                // Collect message IDs that match our buyer/item
                const sentMsgRegex = /<Message>([\s\S]*?)<\/Message>/g;
                let sm;
                const matchingIds = [];
                const allSentSenders = [];

                while ((sm = sentMsgRegex.exec(sentHeaderXml)) !== null) {
                  const smXml = sm[1];
                  const smSendTo = extractTag(smXml, 'SendToName');
                  const smSender = extractTag(smXml, 'Sender');
                  const smItemId = extractTag(smXml, 'ItemID');
                  const smMsgId = extractTag(smXml, 'MessageID');
                  const smSubject = extractTag(smXml, 'Subject');
                  allSentSenders.push({ sendTo: smSendTo, sender: smSender, itemId: smItemId, subject: smSubject, msgId: smMsgId });

                  // Match: sent TO this buyer about this item (or no item filter)
                  if (smSendTo && smSendTo.toLowerCase() === (buyerName || '').toLowerCase() &&
                      (!smItemId || smItemId === itemId) && smMsgId) {
                    matchingIds.push(smMsgId);
                  }
                }

                sentDebug[`folder${folderId}`].allMessages = allSentSenders.slice(0, 10);
                sentDebug[`folder${folderId}`].matchingIds = matchingIds;

                // Step 2: Fetch full content for matching messages
                if (matchingIds.length > 0) {
                  const idTags = matchingIds.map(id => `<MessageID>${escapeXml(id)}</MessageID>`).join('\n    ');
                  const sentDetailResponse = await fetch('https://api.ebay.com/ws/api.dll', {
                    method: 'POST',
                    headers: {
                      'X-EBAY-API-SITEID': '0',
                      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                      'X-EBAY-API-CALL-NAME': 'GetMyMessages',
                      'X-EBAY-API-IAF-TOKEN': access_token,
                      'Content-Type': 'text/xml',
                    },
                    body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
    ${idTags}
  </MessageIDs>
</GetMyMessagesRequest>`,
                  });
                  const sentDetailXml = await sentDetailResponse.text();
                  const detailAck = extractTag(sentDetailXml, 'Ack');
                  sentDebug[`folder${folderId}`].detailAck = detailAck;

                  if (detailAck === 'Success' || detailAck === 'Warning') {
                    const detailMsgRegex = /<Message>([\s\S]*?)<\/Message>/g;
                    let dm;
                    let sentCount = 0;
                    while ((dm = detailMsgRegex.exec(sentDetailXml)) !== null) {
                      const dmXml = dm[1];
                      const dmDate = extractTag(dmXml, 'ReceiveDate') || extractTag(dmXml, 'CreationDate');
                      const dmSender = extractTag(dmXml, 'Sender');
                      const textMatch = dmXml.match(/<Text>([\s\S]*?)<\/Text>/);
                      const contentMatch = dmXml.match(/<Content>([\s\S]*?)<\/Content>/);
                      const rawContent = textMatch ? textMatch[1] : contentMatch ? contentMatch[1] : '';

                      // Clean: decode entities, strip email chain from sent folder messages
                      let cleanText = decodeHtmlEntities(rawContent);
                      // Sent folder format: "New message: [preview]\n\n New message to:\n [buyer]\n (1)\n\n [FULL TEXT]\n\n Dear [buyer],\n\n[FULL TEXT]"
                      // The "New message:" line is truncated — extract the full text from between (1) and Dear
                      const fullTextMatch = cleanText.match(/\(\d+\)\s*\n\n\s*([\s\S]*?)\n\n\s*Dear\s/);
                      if (fullTextMatch) {
                        cleanText = fullTextMatch[1].trim();
                      } else if (cleanText.match(/^New message:/)) {
                        // Fallback: use the New message preview if it's short enough to not be truncated
                        const previewMatch = cleanText.match(/^New message:\s*([\s\S]*?)\n\n\s*New message to:/);
                        if (previewMatch) cleanText = previewMatch[1].trim();
                      } else {
                        // Alt format: "reply text\n\n- sellerName\n\n chain..."
                        const sigMatch = cleanText.match(/^([\s\S]*?)\n\n-\s+\S+/);
                        if (sigMatch) {
                          cleanText = sigMatch[1].trim();
                        } else {
                          // Fallback: try "Dear X," format
                          const replyMatch = cleanText.match(/Dear\s+[^,]+,\s*\n([\s\S]*?)\n-\s*\S+\s*$/);
                          if (replyMatch) {
                            cleanText = replyMatch[1].trim();
                          } else {
                            cleanText = cleanText
                              .replace(/^[\s\S]*?Dear\s+\S+,\s*\n/, '')
                              .replace(/\n-\s*\S+\s*$/, '')
                              .trim();
                          }
                        }
                      }

                      if (cleanText && !existingTexts.has(cleanText.toLowerCase())) {
                        existingTexts.add(cleanText.toLowerCase());
                        conversation.push({
                          from: 'seller',
                          senderName: sellerName || dmSender,
                          text: cleanText,
                          time: dmDate || undefined,
                        });
                        sentCount++;
                      }
                    }
                    sentDebug[`folder${folderId}`].addedMessages = sentCount;
                  }
                }
              }
            }

            // Approach 3: Try GetMyMessages with no FolderID but DetailLevel=ReturnHeaders
            // to see if there are "Sent" type messages mixed in
            try {
              const allMsgResponse = await fetch('https://api.ebay.com/ws/api.dll', {
                method: 'POST',
                headers: {
                  'X-EBAY-API-SITEID': '0',
                  'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                  'X-EBAY-API-CALL-NAME': 'GetMyMessages',
                  'X-EBAY-API-IAF-TOKEN': access_token,
                  'Content-Type': 'text/xml',
                },
                body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnHeaders</DetailLevel>
  <StartCreationTime>${startTime}</StartCreationTime>
  <EndCreationTime>${endTime}</EndCreationTime>
</GetMyMessagesRequest>`,
              });
              const allMsgXml = await allMsgResponse.text();
              // Look for messages where Sender is the seller (outbound messages in inbox view)
              const allMsgRegex = /<Message>([\s\S]*?)<\/Message>/g;
              let am;
              const sellerSentMsgs = [];
              while ((am = allMsgRegex.exec(allMsgXml)) !== null) {
                const amXml = am[1];
                const amSender = extractTag(amXml, 'Sender');
                const amSendTo = extractTag(amXml, 'SendToName');
                const amItemId = extractTag(amXml, 'ItemID');
                const amMsgId = extractTag(amXml, 'MessageID');
                // Check if this is a message sent BY the seller TO the buyer
                if (amSender && sellerName &&
                    amSender.toLowerCase() === sellerName.toLowerCase() &&
                    amSendTo && amSendTo.toLowerCase() === (buyerName || '').toLowerCase()) {
                  sellerSentMsgs.push({ msgId: amMsgId, sender: amSender, sendTo: amSendTo, itemId: amItemId });
                }
              }
              sentDebug.inboxSellerSent = sellerSentMsgs.slice(0, 5);

              // If found seller-sent messages in default inbox, fetch their content
              if (sellerSentMsgs.length > 0) {
                const sellerIdTags = sellerSentMsgs.map(m => `<MessageID>${escapeXml(m.msgId)}</MessageID>`).join('\n    ');
                const sellerDetailResponse = await fetch('https://api.ebay.com/ws/api.dll', {
                  method: 'POST',
                  headers: {
                    'X-EBAY-API-SITEID': '0',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
                    'X-EBAY-API-CALL-NAME': 'GetMyMessages',
                    'X-EBAY-API-IAF-TOKEN': access_token,
                    'Content-Type': 'text/xml',
                  },
                  body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
    ${sellerIdTags}
  </MessageIDs>
</GetMyMessagesRequest>`,
                });
                const sellerDetailXml = await sellerDetailResponse.text();
                const sellerDetailAck = extractTag(sellerDetailXml, 'Ack');
                if (sellerDetailAck === 'Success' || sellerDetailAck === 'Warning') {
                  const sdMsgRegex = /<Message>([\s\S]*?)<\/Message>/g;
                  let sdm;
                  let inboxSentCount = 0;
                  while ((sdm = sdMsgRegex.exec(sellerDetailXml)) !== null) {
                    const sdmXml = sdm[1];
                    const sdmDate = extractTag(sdmXml, 'ReceiveDate') || extractTag(sdmXml, 'CreationDate');
                    const textMatch = sdmXml.match(/<Text>([\s\S]*?)<\/Text>/);
                    const contentMatch = sdmXml.match(/<Content>([\s\S]*?)<\/Content>/);
                    const rawContent = textMatch ? textMatch[1] : contentMatch ? contentMatch[1] : '';
                    let cleanText = decodeHtmlEntities(rawContent);
                    // Sent folder format: "New message: REPLY_TEXT\n\n New message to:\n..."
                    const fullTextMatch3 = cleanText.match(/\(\d+\)\s*\n\n\s*([\s\S]*?)\n\n\s*Dear\s/);
                    if (fullTextMatch3) {
                      cleanText = fullTextMatch3[1].trim();
                    } else if (cleanText.match(/^New message:/)) {
                      const previewMatch3 = cleanText.match(/^New message:\s*([\s\S]*?)\n\n\s*New message to:/);
                      if (previewMatch3) cleanText = previewMatch3[1].trim();
                    } else {
                      const sigMatch3 = cleanText.match(/^([\s\S]*?)\n\n-\s+\S+/);
                      if (sigMatch3) {
                        cleanText = sigMatch3[1].trim();
                      } else {
                        const replyMatch = cleanText.match(/Dear\s+[^,]+,\s*\n([\s\S]*?)\n-\s*\S+\s*$/);
                        if (replyMatch) cleanText = replyMatch[1].trim();
                        else cleanText = cleanText.replace(/^[\s\S]*?Dear\s+\S+,\s*\n/, '').replace(/\n-\s*\S+\s*$/, '').trim();
                      }
                    }

                    if (cleanText && !existingTexts.has(cleanText.toLowerCase())) {
                      existingTexts.add(cleanText.toLowerCase());
                      conversation.push({
                        from: 'seller',
                        senderName: sellerName,
                        text: cleanText,
                        time: sdmDate || undefined,
                      });
                      inboxSentCount++;
                    }
                  }
                  sentDebug.inboxSentAdded = inboxSentCount;
                }
              }
            } catch (e) {
              sentDebug.inboxSentError = e.message;
            }

            if (memberMsgDebug) memberMsgDebug.sentFolders = sentDebug;

            // Final re-sort after all sources merged
            conversation.sort((a, b) => {
              if (!a.time || !b.time) return 0;
              return new Date(a.time) - new Date(b.time);
            });
          } catch (e) {
            if (memberMsgDebug) memberMsgDebug.sentFolderError = e.message;
          }
        }

        // Debug: show decoded content from newest message
        let debugDecoded = '';
        if (allParsedMsgs.length > 0) {
          debugDecoded = decodeHtmlEntities(allParsedMsgs[0].rawContent);
        }

        return new Response(JSON.stringify({
          conversation,
          itemTitle,
          itemId,
          _debug: {
            ebayMessageCount: allParsedMsgs.length,
            sellerName,
            buyerName,
            memberMessages: memberMsgDebug,
            newestDecodedContent: debugDecoded.substring(0, 5000),
            conversationParsed: conversation.map(c => ({ from: c.from, text: c.text.substring(0, 100), time: c.time })),
          },
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- Send Reply ---
      if (path === '/api/ebay/send-reply' && request.method === 'POST') {
        const { access_token, item_id, message_id, external_message_id, recipient_id, body: replyBody } = await request.json();

        // Validate required fields
        if (!access_token || !item_id || !recipient_id || !replyBody) {
          return new Response(JSON.stringify({
            error: 'Missing required fields',
            required: ['access_token', 'item_id', 'recipient_id', 'body'],
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Use ExternalMessageID as ParentMessageID (eBay requires this format for RTQ replies)
        const parentMessageId = external_message_id || message_id;

        // Call eBay AddMemberMessageRTQ (Reply to Question)
        const replyResponse = await fetch('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
            'X-EBAY-API-CALL-NAME': 'AddMemberMessageRTQ',
            'X-EBAY-API-IAF-TOKEN': access_token,
            'Content-Type': 'text/xml',
          },
          body: `<?xml version="1.0" encoding="utf-8"?>
<AddMemberMessageRTQRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(item_id)}</ItemID>
  <MemberMessage>
    <Body>${escapeXml(replyBody)}</Body>
    <ParentMessageID>${escapeXml(parentMessageId)}</ParentMessageID>
    <RecipientID>${escapeXml(recipient_id)}</RecipientID>
  </MemberMessage>
</AddMemberMessageRTQRequest>`,
        });

        const replyXml = await replyResponse.text();

        // Check for eBay API errors
        const ack = extractTag(replyXml, 'Ack');
        if (ack === 'Failure' || ack === 'PartialFailure') {
          const errorCode = extractTag(replyXml, 'ErrorCode') || 'Unknown';
          const shortMessage = extractTag(replyXml, 'ShortMessage') || 'Unknown error';
          const longMessage = extractTag(replyXml, 'LongMessage') || '';
          return new Response(JSON.stringify({
            success: false,
            error: shortMessage,
            errorCode,
            errorDetail: longMessage,
            rawXml: replyXml,
          }), {
            status: 422,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          ack,
          message: 'Reply sent successfully',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- 404 ---
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

// --- XML Parsing Helpers ---

function parseMessagesXml(xml) {
  const messages = [];
  const messageRegex = /<Message>([\s\S]*?)<\/Message>/g;
  let match;
  while ((match = messageRegex.exec(xml)) !== null) {
    const messageXml = match[1];
    const message = {
      id: extractTag(messageXml, 'MessageID'),
      sender: extractTag(messageXml, 'Sender'),
      subject: extractTag(messageXml, 'Subject'),
      itemId: extractTag(messageXml, 'ItemID'),
      receiveDate: extractTag(messageXml, 'ReceiveDate'),
      read: extractTag(messageXml, 'Read') === 'true',
      replied: extractTag(messageXml, 'Replied') === 'true',
      responseEnabled: extractTag(messageXml, 'ResponseEnabled') === 'true',
      messageType: extractTag(messageXml, 'MessageType'),
      externalMessageId: extractTag(messageXml, 'ExternalMessageID'),
    };
    // Filter out eBay system messages
    if (message.sender && message.sender !== 'eBay') {
      messages.push(message);
    }
  }
  return messages;
}

function parseMessageDetailXml(xml) {
  const textMatch = xml.match(/<Text>([\s\S]*?)<\/Text>/);
  const contentMatch = xml.match(/<Content>([\s\S]*?)<\/Content>/);
  const htmlContent = textMatch
    ? decodeHtmlEntities(textMatch[1])
    : contentMatch
    ? decodeHtmlEntities(contentMatch[1])
    : '';

  // Get the seller's username from the SendToName tag
  const sendToName = extractTag(xml, 'SendToName');
  const sender = extractTag(xml, 'Sender');
  const conversation = parseConversation(htmlContent, sendToName, sender);

  return {
    id: extractTag(xml, 'MessageID'),
    sender: sender,
    sendToName: sendToName,
    subject: extractTag(xml, 'Subject'),
    itemId: extractTag(xml, 'ItemID'),
    itemTitle: extractTag(xml, 'ItemTitle'),
    receiveDate: extractTag(xml, 'ReceiveDate'),
    conversation,
    rawHtml: htmlContent,
  };
}

function parseConversation(html, sellerName, buyerName) {
  const conversation = [];
  const seenTexts = new Set();

  // Dynamic seller name detection — no more hardcoded "ccwraps"
  const sellerLower = (sellerName || '').toLowerCase();

  // Pattern 1: Newest message — "Dear <seller>," followed by content, ending with "- <buyer>"
  const newestPattern = sellerName
    ? new RegExp(`Dear\\s+${escapeRegex(sellerName)},\\s*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+-\\s*(\\S+)`, 'i')
    : /Dear\s+\w+,\s*[\r\n]+([\s\S]*?)[\r\n]+-\s*(\S+)/;

  const newestMatch = html.match(newestPattern);
  if (newestMatch) {
    const text = newestMatch[1].trim();
    const senderName = newestMatch[2].trim();
    if (text && !seenTexts.has(text)) {
      seenTexts.add(text);
      conversation.push({
        from: 'buyer',
        senderName: senderName,
        text,
        position: html.indexOf(newestMatch[0]),
      });
    }
  }

  // Pattern 2: Older messages — "Dear <buyer>," ... "- <seller>"
  const olderPattern = sellerName
    ? new RegExp(`Dear\\s+(?!${escapeRegex(sellerName)})([^,]+),\\s*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+-\\s*${escapeRegex(sellerName)}`, 'gi')
    : /Dear\s+([^,]+),\s*[\r\n]+([\s\S]*?)[\r\n]+-\s*\w+/g;

  let match;
  while ((match = olderPattern.exec(html)) !== null) {
    const recipient = match[1].trim();
    const text = match[2].trim();
    if (!text || seenTexts.has(text)) continue;

    const beforeText = html.substring(Math.max(0, match.index - 500), match.index);
    const yourPrevIdx = beforeText.lastIndexOf('Your previous message');
    const usernameIdx = beforeText.lastIndexOf(recipient);

    let isFromSeller;
    if (yourPrevIdx >= 0 && usernameIdx >= 0) {
      isFromSeller = yourPrevIdx > usernameIdx;
    } else if (yourPrevIdx >= 0) {
      isFromSeller = true;
    } else if (usernameIdx >= 0) {
      isFromSeller = false;
    } else {
      const remainingHtml = html.substring(match.index + match[0].length);
      const hasMoreDearBlocks = new RegExp(`Dear\\s+(?!${escapeRegex(sellerName || 'NOSELLER')})[^,]+,`).test(remainingHtml);
      isFromSeller = hasMoreDearBlocks ? true : false;
    }

    seenTexts.add(text);
    conversation.push({
      from: isFromSeller ? 'seller' : 'buyer',
      senderName: isFromSeller ? sellerName : recipient,
      text,
      position: match.index,
    });
  }

  // Sort newest first
  conversation.sort((a, b) => b.position - a.position);
  return conversation.map(({ from, senderName, text }) => ({ from, senderName, text }));
}

function extractTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`);
  const match = xml.match(regex);
  return match ? match[1] : null;
}

function decodeHtmlEntities(text) {
  return text
    // First decode HTML entities so we get real HTML
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Remove entire <style> blocks (including CSS content)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove entire <script> blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove <head> blocks
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    // Convert <br> to newline
    .replace(/<br\s*\/?>/gi, '\n')
    // Convert </p>, </div>, </tr> to newline for structure
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode any remaining entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, '')
    // Clean up excessive whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse eBay's conversation thread from decoded HTML content of the most recent message.
//
// eBay nests the FULL conversation chain inside the most recent message.
// Format (reading top→bottom = newest→oldest):
//
//   [header junk: "New message:", "Reply", etc.]
//   Dear SELLER, [newest buyer msg] - BUYER          ← BUYER msg (reliable)
//
//   Your previous message                             ← SELLER reply marker
//   [seller reply text]                               ← SELLER reply (reliable)
//   Dear BUYER, [seller reply text] - SELLER          ← DUPLICATE — ignore
//
//   BUYER_NAME                                        ← username label
//   [older buyer msg text]                            ← older BUYER msg (reliable)
//   Dear BUYER, [older buyer msg] - SELLER            ← DUPLICATE — ignore
//
//   Your previous message                             ← next SELLER reply
//   [older seller reply]
//   Dear BUYER, [older seller reply] - SELLER         ← DUPLICATE — ignore
//   ...pattern repeats
//
// RULES:
//   1. "Dear [seller], text - [buyer]"  →  ALWAYS buyer message
//   2. Text after "Your previous message" (up to next Dear block) →  ALWAYS seller reply
//   3. "[buyerName]" on own line, followed by text (up to next Dear block) →  older buyer message
//   4. ALL "Dear [buyer], text - [seller]" blocks →  DUPLICATES, skip entirely
//
function parseEbayThread(html, sellerName, buyerName) {
  if (!html || !html.trim()) return [];

  const conversation = [];
  const seenTexts = new Set();

  function addMsg(from, name, rawText) {
    const text = rawText.trim().replace(/\n{3,}/g, '\n\n');
    if (!text || text.length < 2) return;
    const key = text.toLowerCase();
    if (seenTexts.has(key)) return;
    seenTexts.add(key);
    conversation.push({ from, senderName: name, text });
  }

  // Step 1: Extract the newest buyer message
  // Pattern: "Dear [sellerName], [content]\n- [buyerName]"
  if (sellerName && buyerName) {
    const newestBuyerRegex = new RegExp(
      `Dear\\s+${escapeRegex(sellerName)},\\s*\\n([\\s\\S]*?)\\n-\\s*${escapeRegex(buyerName)}`,
      'i'
    );
    const match = html.match(newestBuyerRegex);
    if (match) {
      addMsg('buyer', buyerName, match[1]);
    }
  }

  // Step 2: Split content on "Your previous message" markers
  // Section 0 = everything before first marker (contains newest buyer msg, already extracted)
  // Section 1+ = after each marker, structured as:
  //   [seller reply text]
  //   Dear BUYER, [dup] - SELLER        ← ignore
  //   BUYER_NAME                        ← older buyer msg follows
  //   [older buyer msg text]
  //   Dear BUYER, [dup] - SELLER        ← ignore
  const sections = html.split(/Your previous message\s*/i);

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];

    // 2a: Seller reply = text before the first "Dear" block in this section
    const firstDearIdx = section.search(/Dear\s+[^,\n]+,/i);
    if (firstDearIdx > 0) {
      addMsg('seller', sellerName, section.substring(0, firstDearIdx));
    } else if (firstDearIdx < 0) {
      // No Dear block at all — entire section is the seller reply
      addMsg('seller', sellerName, section);
    }

    // 2b: Older buyer messages = text after "[buyerName]" label on its own line
    // There can be MULTIPLE buyer messages in one section (buyer sent several in a row)
    // Must use global regex + exec loop to find ALL of them
    if (buyerName) {
      const buyerLabelRegex = new RegExp(
        `(?:^|\\n)\\s*${escapeRegex(buyerName)}\\s*\\n([\\s\\S]*?)(?=Dear\\s+[^,\\n]+,|$)`,
        'gi'
      );
      let buyerMatch;
      while ((buyerMatch = buyerLabelRegex.exec(section)) !== null) {
        addMsg('buyer', buyerName, buyerMatch[1]);
      }
    }
  }

  // Reverse: eBay shows newest→oldest, we want oldest→newest for chat display
  conversation.reverse();
  return conversation;
}

function extractNewestMessage(html, sellerName, buyerName) {
  // Try to get the newest/first message from the HTML thread
  // Pattern: "Dear <seller>," ... content ... "- <buyer>"
  if (sellerName) {
    const pattern = new RegExp(
      `Dear\\s+${escapeRegex(sellerName)},\\s*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+-\\s*(\\S+)`,
      'i'
    );
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }

  // Fallback: get first substantial text block
  const lines = html.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  // Skip "Dear X," and signature lines, get the meat
  const content = [];
  let inMessage = false;
  for (const line of lines) {
    if (line.match(/^Dear\s+/i)) { inMessage = true; continue; }
    if (line.match(/^-\s+\w/) && inMessage) break;
    if (line.match(/^Your previous message/i)) break;
    if (inMessage && line.length > 0) content.push(line);
  }
  if (content.length > 0) return content.join('\n').trim();

  // Last resort: return cleaned HTML if short enough
  const cleaned = html.replace(/\n+/g, ' ').trim();
  return cleaned.length > 0 && cleaned.length < 500 ? cleaned : null;
}

function extractSellerReply(html, sellerName, buyerName) {
  // Look for seller's reply in the thread HTML
  // Pattern: "Dear <buyer>," ... content ... "- <seller>"
  if (!sellerName || !buyerName) return null;

  const pattern = new RegExp(
    `Dear\\s+${escapeRegex(buyerName)},\\s*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+-\\s*${escapeRegex(sellerName)}`,
    'i'
  );
  const match = html.match(pattern);
  if (match) return match[1].trim();
  return null;
}
