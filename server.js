require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 8080;

// --- OAuth2 Setup ---
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`
);

const SCOPES = ['https://www.googleapis.com/auth/chat.messages'];
const SPACE_NAME = process.env.GOOGLE_CHAT_SPACE; // e.g. "spaces/XXXXXXX"

// In-memory token storage (replace with DB in production)
let storedTokens = null;

// Map: threadName (from Google Chat) -> sessionId
const threadToSession = new Map();

// Map: sessionId -> WebSocket connection
const clients = new Map();

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());

// --- HTTP + WebSocket Server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    console.log('[WS] Connection without sessionId rejected');
    ws.close(1008, 'sessionId required');
    return;
  }

  clients.set(sessionId, ws);
  console.log(`[WS] Client connected: sessionId=${sessionId} (total: ${clients.size})`);

  ws.on('message', (data) => {
    console.log(`[WS] Message from sessionId=${sessionId}: ${data}`);
  });

  ws.on('close', () => {
    clients.delete(sessionId);
    console.log(`[WS] Client disconnected: sessionId=${sessionId} (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for sessionId=${sessionId}:`, err.message);
    clients.delete(sessionId);
  });
});

// --- Routes ---

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    authenticated: !!storedTokens,
    connectedClients: clients.size,
    trackedThreads: threadToSession.size,
    timestamp: new Date().toISOString(),
  });
});

// OAuth: Start flow
app.get('/oauth/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured');
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('[OAuth] Redirecting to Google for authorization');
  res.redirect(authUrl);
});

// OAuth: Callback
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[OAuth] User denied access or error:', error);
    return res.status(400).send(`OAuth error: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    storedTokens = tokens;
    console.log('[OAuth] Tokens received and stored in memory');
    res.send('<h2>Authentication successful!</h2><p>You can close this window.</p>');
  } catch (err) {
    console.error('[OAuth] Token exchange failed:', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// POST /api/message - receive from website, send to Google Chat
app.post('/api/message', async (req, res) => {
  const { sessionId, message, userName } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  if (!storedTokens) {
    return res.status(401).json({ error: 'Not authenticated. Visit /oauth/start first.' });
  }

  if (!SPACE_NAME) {
    return res.status(500).json({ error: 'GOOGLE_CHAT_SPACE not configured' });
  }

  console.log(`[API] Message from sessionId=${sessionId}, user=${userName || 'Anonymous'}: ${message}`);

  try {
    oauth2Client.setCredentials(storedTokens);
    const chat = google.chat({ version: 'v1', auth: oauth2Client });

    const response = await chat.spaces.messages.create({
      parent: SPACE_NAME,
      threadKey: sessionId,
      messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      requestBody: {
        text: `[${userName || 'Anonymous'}]\n${message}`,
      },
    });

    // Store thread name -> sessionId mapping for webhook routing
    const threadName = response.data?.thread?.name;
    if (threadName && !threadToSession.has(threadName)) {
      threadToSession.set(threadName, sessionId);
      console.log(`[API] Thread mapping stored: ${threadName} -> ${sessionId}`);
    }

    // Persist updated token (handles refresh)
    storedTokens = oauth2Client.credentials;

    console.log(`[API] Message sent to Google Chat space ${SPACE_NAME}`);
    res.json({ success: true, sessionId });
  } catch (err) {
    console.error('[API] Failed to send to Google Chat:', err.message);
    res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// POST /webhook - receive from Google Chat, forward via WebSocket
app.post('/webhook', (req, res) => {
  const event = req.body;

  // Always acknowledge immediately
  res.json({ text: '' });

  // Filter out bot/app messages to avoid loops
  if (event?.message?.sender?.type === 'BOT') {
    console.log('[Webhook] Bot message ignored');
    return;
  }

  const messageText = event?.message?.text;
  const threadName = event?.message?.thread?.name; // e.g. "spaces/XXX/threads/YYY"

  if (!messageText || !threadName) {
    console.log('[Webhook] Missing text or threadName, skipping');
    return;
  }

  // Lookup sessionId from stored thread mapping
  const sessionId = threadToSession.get(threadName);

  if (!sessionId) {
    console.log(`[Webhook] No session mapped for thread: ${threadName}`);
    return;
  }

  console.log(`[Webhook] Message for sessionId=${sessionId}: ${messageText}`);

  // Deliver to browser client via WebSocket
  const ws = clients.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'message', text: messageText, from: 'agent' }));
    console.log(`[Webhook] Delivered to WebSocket client sessionId=${sessionId}`);
  } else {
    console.log(`[Webhook] No active WebSocket for sessionId=${sessionId}`);
  }
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket ready on ws://localhost:${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Server] OAuth start: http://localhost:${PORT}/oauth/start`);
  if (!process.env.GOOGLE_CLIENT_ID) console.warn('[Server] WARNING: GOOGLE_CLIENT_ID not set');
  if (!process.env.GOOGLE_CHAT_SPACE) console.warn('[Server] WARNING: GOOGLE_CHAT_SPACE not set');
});
