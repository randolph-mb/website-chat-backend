require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(bodyParser.json());

// Map: sessionId -> WebSocket connection
const clients = new Map();

// HTTP server
const server = http.createServer(app);

// WebSocket server
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

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    connectedClients: clients.size,
    timestamp: new Date().toISOString(),
  });
});

// POST /api/message - receive message from website, forward to Google Chat
app.post('/api/message', async (req, res) => {
  const { sessionId, message, userName } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  console.log(`[API] Message from sessionId=${sessionId}, user=${userName}: ${message}`);

  // TODO: forward to Google Chat Space via Google Chat API
  // Example:
  // await chatClient.spaces.messages.create({
  //   parent: `spaces/${SPACE_ID}`,
  //   requestBody: {
  //     text: `[${userName || 'Anonymous'} | session:${sessionId}] ${message}`,
  //     thread: { name: `spaces/${SPACE_ID}/threads/${sessionId}` },
  //   },
  // });

  res.json({ success: true, sessionId });
});

// POST /webhook - receive messages from Google Chat
app.post('/webhook', (req, res) => {
  const event = req.body;

  // Always acknowledge immediately
  res.json({ text: '' });

  // Filter out bot messages to avoid loops
  if (event?.message?.sender?.type === 'BOT') {
    console.log('[Webhook] Bot message ignored');
    return;
  }

  const messageText = event?.message?.text;
  const threadName = event?.message?.thread?.name; // e.g. "spaces/XXX/threads/SESSION_ID"

  if (!messageText || !threadName) {
    console.log('[Webhook] Missing text or threadName, skipping');
    return;
  }

  // Extract sessionId from thread name (last segment)
  const sessionId = threadName.split('/').pop();
  console.log(`[Webhook] Message for sessionId=${sessionId}: ${messageText}`);

  // Send to browser client via WebSocket
  const ws = clients.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'message', text: messageText, from: 'agent' }));
    console.log(`[Webhook] Delivered to WebSocket client sessionId=${sessionId}`);
  } else {
    console.log(`[Webhook] No active WebSocket for sessionId=${sessionId}`);
  }
});

server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket ready on ws://localhost:${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
});
