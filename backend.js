/**
 * backend.js
 * Backend server for Botpress Chat API integration
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();

// Configure CORS to allow all origins temporarily for debugging
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl requests, etc.)
    if (!origin) return callback(null, true);
    
    // Allow all Vercel domains and your local development
    if (
      origin.includes('vercel.app') || 
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin === 'https://n8n-chatbot-gamma.vercel.app' ||
      origin === 'https://n8n-chatbot-git-main-yenths-projects.vercel.app'
    ) {
      return callback(null, true);
    }
    
    // Allow all origins for now (can be restricted later)
    return callback(null, true);
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-key']
}));

// Add body parser with size limits to prevent bad gateway errors
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, TXT, DOCX, and DOC files are allowed.'), false);
    }
  }
});

// Add request timeout middleware with shorter timeout for webhooks
app.use((req, res, next) => {
  const timeout = req.url.includes('/webhook') ? 5000 : 30000; // 5s for webhooks, 30s for others
  res.setTimeout(timeout, () => {
    console.log(`⚠️ Request timeout (${timeout}ms) for`, req.url);
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Load secrets from .env file
const API_ID = process.env.API_ID;
const BOTPRESS_API_TOKEN = process.env.BOTPRESS_BEARER_TOKEN|| 'bp_pat_03bBjs1WlZgPvkP0vyjIYuW9hzxQ8JWMKgvI';
const BOT_ID = process.env.BOTPRESS_BOT_ID || '73dfb145-f1c3-451f-b7c8-ed463a9dd155';
const WORKSPACE_ID = process.env.BOTPRESS_WORKSPACE_ID || 'wkspace_01JV4D1D6V3ZZFWVDZJ8PYECET';
const BASE_URL = `https://chat.botpress.cloud/${API_ID}`;



// Store bot messages separately by timestamp (in production, use Redis or database)
const botMessages = new Map(); // conversationId -> { messages: [...], lastDelivered: timestamp }

// Global message storage to prevent race conditions
const globalMessages = {}; // conversationId -> messages array

// Track user messages to distinguish them from bot responses
const userMessages = new Map();

// Track webhook processing to prevent race conditions
const webhookQueue = new Map(); // conversationId -> processing status

app.post('/api/user', async (req, res) => {
  try {
    const response = await fetch(`${BASE_URL}/users`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    
    const data = await response.json();
    
    if (!data.user || !data.key) {
      return res.status(500).json({ error: 'User or user key missing in Botpress response' });
    }
    
    res.json({ user: data.user, userKey: data.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track user messages before sending to N8N
app.post('/api/track-user-message', async (req, res) => {
  const { conversationId, text } = req.body;
  const userTrackingTimestamp = new Date().toISOString();
  console.log(`🔵 TRACKING USER MESSAGE at ${userTrackingTimestamp}: "${text}" for conversation ${conversationId}`);
  
  if (!conversationId || !text) {
    console.log('❌ TRACKING FAILED: Missing conversationId or text');
    return res.status(400).json({ error: 'Missing conversationId or text' });
  }
  
  // Clean up any previous state for this conversation before tracking new message
  console.log(`🧹 CLEANING UP PREVIOUS STATE for conversation ${conversationId}`);
  
  // Clear any existing bot messages for this conversation
  if (botMessages.has(conversationId)) {
    const oldConversationData = botMessages.get(conversationId);
    // Clear any pending timeout
    if (oldConversationData && oldConversationData.deliveryTimeoutId) {
      clearTimeout(oldConversationData.deliveryTimeoutId);
      console.log(`   ✅ Cleared old delivery timeout`);
    }
    botMessages.delete(conversationId);
    console.log(`   ✅ Removed old bot messages`);
  }
  
  // Also clear global storage for this conversation
  if (globalMessages[conversationId]) {
    delete globalMessages[conversationId];
    console.log(`   ✅ Cleared global message storage`);
  }
  
  // Store user message with timestamp to track what the user actually sent
  userMessages.set(conversationId, {
    text: text,
    timestamp: Date.now(),
    trackedAt: userTrackingTimestamp
  });
  
  console.log(`✅ USER MESSAGE TRACKED SUCCESSFULLY at ${userTrackingTimestamp}. Total tracked: ${userMessages.size}`);
  console.log(`   Stored: "${text}" for conversation ${conversationId}`);
  console.log(`   State cleaned and ready for new message cycle`);
  
  res.json({ success: true });
});

app.post('/api/conversation', async (req, res) => {
  const { userKey } = req.body;
  try {
    const response = await fetch(`${BASE_URL}/conversations`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'x-user-key': userKey
      },
      body: JSON.stringify({ body: {} })
    });
    
    const data = await response.json();
    
    if (!data.conversation || !data.conversation.id) {
      return res.status(500).json({ error: 'Conversation missing in Botpress response' });
    }
    
    res.json({ conversation: data.conversation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/message-DISABLED', async (req, res) => {
  const { conversationId, text, userKey } = req.body;
  try {
    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'x-user-key': userKey
      },
      body: JSON.stringify({
        payload: { type: 'text', text },
        conversationId
      })
    });
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  const { conversationId, userKey } = req.query;
  try {
    // Check if we have stored N8N messages for this conversation
    const conversationData = botMessages.get(conversationId);
    
    if (conversationData && conversationData.messages.length > 0) {
      // Format all messages like the old Botpress API response
      const formattedResponse = {
        messages: conversationData.messages.map(msg => ({
          id: msg.id,
            type: 'text',
            payload: {
            text: msg.text
            },
            userId: 'bot',
          createdAt: new Date(msg.timestamp).toISOString()
        }))
      };
      
      // Remove the messages after sending them
      botMessages.delete(conversationId);
      
      res.json(formattedResponse);
    } else {
      // Return empty messages array like old API
      res.json({ messages: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/botpress-webhook', async (req, res) => {
  // Immediately respond to prevent timeout/bad gateway
  const timestamp = new Date().toISOString();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Send immediate response to N8N to prevent bad gateway
  res.status(200).json({ 
    success: true,
    requestId: requestId,
    timestamp: timestamp,
    message: 'Webhook received and processing'
  });
  
  // Process webhook asynchronously to prevent blocking
  setImmediate(async () => {
    try {
      console.log(`🔄 WEBHOOK RECEIVED FROM N8N at ${timestamp} (ID: ${requestId}):`);
      console.log('📋 Full request body:', JSON.stringify(req.body, null, 2));
      
      // Show current state before processing
      console.log(`📊 CURRENT STATE BEFORE PROCESSING:`);
      console.log(`   Bot messages stored: ${botMessages.size}`);
      console.log(`   User messages tracked: ${userMessages.size}`);
      
      // Debug: Show all stored conversations
      if (botMessages.size > 0) {
        console.log(`🔍 DEBUG: All stored conversations:`);
        for (const [convId, convData] of botMessages.entries()) {
          console.log(`   📝 ${convId}: ${convData.messages.length} messages, allReceived: ${convData.allMessagesReceived}`);
        }
      }
    
    const body = req.body;
    let conversationId, botText, isBot, botImage;
    
    // Try multiple extraction patterns
    if (body.body && body.body.data) {
      // N8N sends: { body: { data: { conversationId, payload: { text, image }, isBot } } }
      conversationId = body.body.data.conversationId;
      botText = body.body.data.payload?.text || body.body.data.text;
      botImage = body.body.data.payload?.image || body.body.data.payload?.imageUrl || body.body.data.image || body.body.data.imageUrl;
      isBot = body.body.data.isBot;
      console.log('📍 Using body.body.data pattern');
    } else if (body.conversationId) {
      // Direct structure: { conversationId, payload: { text, image }, isBot }
      conversationId = body.conversationId;
      botText = body.payload?.text || body.text;
      botImage = body.payload?.image || body.payload?.imageUrl || body.image || body.imageUrl;
      isBot = body.isBot;
      console.log('📍 Using body.conversationId pattern');
    } else if (body.text || body.image || body.imageUrl) {
      // Simple text/image structure
      botText = body.text;
      botImage = body.image || body.imageUrl;
      isBot = body.isBot;
      console.log('📍 Using body.text/image/imageUrl pattern');
    }
    
    console.log(`🔍 Extracted: conversationId="${conversationId}", text="${botText}", image="${botImage ? 'present' : 'none'}", isBot="${isBot}"`);
    console.log(`🔍 Type of isBot: ${typeof isBot}`);
    console.log(`🔍 Raw isBot value: ${JSON.stringify(isBot)}`);
    if (botImage) {
      console.log(`🖼️ Image data type: ${typeof botImage}, length: ${typeof botImage === 'string' ? botImage.length : 'N/A'}`);
    }
    
    // Check if this matches a tracked user message
    const trackedUserMessage = userMessages.get(conversationId);
    if (trackedUserMessage) {
      console.log(`🔍 Tracked user message: "${trackedUserMessage.text}"`);
      console.log(`🔍 Incoming message: "${botText}"`);
      console.log(`🔍 Messages match: ${trackedUserMessage.text === botText}`);
    } else {
      console.log(`🔍 No tracked user message found for this conversation`);
    }
    
    // Use the isBot field from N8N to determine if we should display this message
    // Handle both boolean and string values for isBot
    const isBotMessage = isBot === true || isBot === "true";
    const isUserMessage = isBot === false || isBot === "false";
    
    if (isBotMessage) {
      const botMessageTimestamp = new Date().toISOString();
      console.log(`🤖 IDENTIFIED AS BOT MESSAGE (isBot: true) at ${botMessageTimestamp} - will store and display separately`);
      
      if (conversationId && (botText || botImage) && (!botText || !botText.includes('{{ $json'))) {
        console.log(`💾 STORING INDIVIDUAL BOT MESSAGE at ${botMessageTimestamp}: "${botText || '[IMAGE]'}"`);
        
        // SIMPLE FIX: Use both Map and global object to prevent race conditions
        if (!globalMessages[conversationId]) {
          globalMessages[conversationId] = [];
          console.log(`📦 Created new global storage for: ${conversationId}`);
        }
        
        // Store message in global storage immediately
        const messageTimestamp = Date.now();
        const newMessage = {
          text: botText || null,
          image: botImage || null,
          timestamp: messageTimestamp,
          receivedAt: botMessageTimestamp,
          id: `bot-msg-${messageTimestamp}-${Math.random().toString(36).substr(2, 6)}`,
          delivered: false
        };
        
        globalMessages[conversationId].push(newMessage);
        console.log(`📝 STORED MESSAGE ${globalMessages[conversationId].length}: "${botText || '[IMAGE]'}" ${botImage ? '[+IMAGE]' : ''}`);
        console.log(`📊 Total messages in global storage: ${globalMessages[conversationId].length}`);
        
        // CRITICAL FIX: Use SHARED timeout for the conversation, not per-message timeout
        // Clear any existing timeout - this is the key fix
        if (global.conversationTimeouts && global.conversationTimeouts[conversationId]) {
          clearTimeout(global.conversationTimeouts[conversationId]);
          console.log(`🧹 Cleared previous GLOBAL timeout for conversation: ${conversationId}`);
        }
        
        // Initialize global timeouts if not exists
        if (!global.conversationTimeouts) {
          global.conversationTimeouts = {};
        }
        
        // Set ONE timeout per conversation that gets reset with each new message
        console.log(`⏰ Setting 6-second timeout to deliver ALL messages after n8n finishes...`);
        global.conversationTimeouts[conversationId] = setTimeout(() => {
          console.log(`⏰ TIMEOUT: N8N finished sending messages for ${conversationId}`);
          
          // Use global storage for final count and delivery
          const finalMessages = globalMessages[conversationId] || [];
          console.log(`🎯 Final message count from global storage: ${finalMessages.length} messages`);
          
          // Sort all messages by timestamp for final delivery
          finalMessages.sort((a, b) => a.timestamp - b.timestamp);
          
          console.log(`📋 Final message order (sorted by timestamp):`);
          finalMessages.forEach((msg, index) => {
            const displayText = msg.text ? msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '') : '[IMAGE]';
            console.log(`   Position ${index + 1}: "${displayText}" ${msg.image ? '[+IMAGE]' : ''} (${msg.receivedAt})`);
          });
          
          // Update Map data for delivery
          let conversationData = botMessages.get(conversationId);
          if (!conversationData) {
            conversationData = {
              messages: [],
              lastDelivered: 0,
              allMessagesReceived: false,
              deliveryTimeoutId: null
            };
            botMessages.set(conversationId, conversationData);
          }
          
          // Set all messages as ready for delivery
          conversationData.messages = finalMessages;
          conversationData.allMessagesReceived = true;
          conversationData.deliveryTimeoutId = null;
          
          console.log(`✅ All ${finalMessages.length} messages ready for delivery in correct timestamp order`);
          
          // Clean up the tracked user message since we got bot response(s)
          userMessages.delete(conversationId);
          console.log(`🧹 Cleaned up tracked user message for conversation: ${conversationId}`);
          
          // Clean up the global timeout
          delete global.conversationTimeouts[conversationId];
          
        }, 6000); // Wait 6 seconds after last message before delivering all (increased for larger message sets)
        
        console.log(`⏱️ Waiting 6 seconds for additional messages from n8n...`);
      }
    } else if (isUserMessage) {
      console.log('👤 IDENTIFIED AS USER MESSAGE (isBot: false) - will NOT store or display');
      // Don't store user messages, they're already displayed by the frontend
    } else {
      console.log('⚠️ NO isBot FIELD FOUND - falling back to old behavior');
      // Fallback to old logic if isBot field is missing (for backwards compatibility)
      const trackedUserMessage = userMessages.get(conversationId);
      const looksLikeBotResponse = 
        botText && (
          botText.length > 20 ||                                    
          botText.includes('!') ||                                  
          botText.includes('?') ||                                  
          botText.includes('helpen') || botText.includes('kan ik') || 
          /[A-Z].*[a-z].*[.!?]/.test(botText)
        );
        
      if (!trackedUserMessage || (trackedUserMessage && botText !== trackedUserMessage.text)) {
        if ((looksLikeBotResponse || botImage) && conversationId && (botText || botImage) && (!botText || !botText.includes('{{ $json'))) {
          console.log(`💾 FALLBACK: STORING BOT MESSAGE: "${botText || '[IMAGE]'}"`);
          
          // Get or create conversation data
          let conversationData = botMessages.get(conversationId);
          if (!conversationData) {
            conversationData = {
              messages: [],
              lastDelivered: 0,
              allMessagesReceived: false,
              deliveryTimeoutId: null
            };
            botMessages.set(conversationId, conversationData);
          }
          
          // Store as individual message
          const messageTimestamp = Date.now();
          conversationData.messages.push({
            text: botText || null,
            image: botImage || null,
            timestamp: messageTimestamp,
            receivedAt: new Date().toISOString(),
            id: `bot-fallback-${messageTimestamp}`,
            delivered: false
          });
          
          // Sort messages by timestamp
          conversationData.messages.sort((a, b) => a.timestamp - b.timestamp);
          
          // Set timeout for fallback delivery as well
          if (conversationData.deliveryTimeoutId) {
            clearTimeout(conversationData.deliveryTimeoutId);
          }
          
          conversationData.deliveryTimeoutId = setTimeout(() => {
            conversationData.allMessagesReceived = true;
            conversationData.deliveryTimeoutId = null;
            console.log(`✅ FALLBACK: Messages ready for delivery`);
          }, 6000);
          
          userMessages.delete(conversationId);
        }
      }
    }
    
      // Clean up old messages and user messages (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      console.log(`🧹 CLEANUP: Starting cleanup of messages older than 5 minutes`);
      const beforeCleanup = botMessages.size;
      
      for (const [key, value] of botMessages.entries()) {
        // Don't clean up conversations that are still receiving messages
        if (!value.allMessagesReceived && value.deliveryTimeoutId) {
          console.log(`🧹 SKIPPING cleanup for conversation ${key} - still receiving messages`);
          continue;
        }
        
        // Remove messages older than 5 minutes
        const filteredMessages = value.messages.filter(msg => msg.timestamp >= fiveMinutesAgo);
        if (filteredMessages.length !== value.messages.length) {
          value.messages = filteredMessages;
          console.log(`🧹 Cleaned up old messages for conversation: ${key}`);
        }
        // Remove empty conversation data
        if (value.messages.length === 0) {
          // Clear timeout before removing conversation
          if (value.deliveryTimeoutId) {
            clearTimeout(value.deliveryTimeoutId);
            console.log(`🧹 Cleared delivery timeout for conversation: ${key}`);
        }
          botMessages.delete(key);
          console.log(`🧹 Deleted empty conversation: ${key}`);
        }
      }
      
      const afterCleanup = botMessages.size;
      console.log(`🧹 CLEANUP: ${beforeCleanup} → ${afterCleanup} conversations (removed ${beforeCleanup - afterCleanup})`);
      
      if (beforeCleanup > 0 && afterCleanup === 0) {
        console.log(`⚠️ WARNING: All conversations were cleaned up! This might indicate a timing issue.`);
      }
      for (const [key, value] of userMessages.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
          userMessages.delete(key);
        }
      }
      for (const [key, value] of webhookQueue.entries()) {
        if (value.lastUpdate < fiveMinutesAgo) {
          webhookQueue.delete(key);
          console.log(`🧹 Cleaned up old webhook queue entry for conversation: ${key}`);
        }
      }
      
      console.log(`✅ Webhook processing completed for request ${requestId}`);
      
    } catch (error) {
      console.error(`❌ WEBHOOK ERROR for request ${requestId}:`, error);
      // Note: We already sent response to N8N, so just log the error
    }
  });
});

// New endpoint for frontend to get bot messages
app.get('/api/bot-response/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    let conversationData = botMessages.get(conversationId);
    
    // FALLBACK: Use global storage if Map data is missing, but check if still collecting
    if (!conversationData && globalMessages[conversationId]) {
      console.log(`📤 FALLBACK: Found global storage for conversation: ${conversationId}`);
      
      // Check if we're still collecting messages (timeout exists)
      const stillCollecting = global.conversationTimeouts && global.conversationTimeouts[conversationId];
      
      conversationData = {
        messages: globalMessages[conversationId],
        allMessagesReceived: !stillCollecting, // Only complete if no timeout running
        lastDelivered: 0,
        deliveryTimeoutId: null
      };
      
      console.log(`📤 FALLBACK: Using global storage with ${conversationData.messages.length} messages, stillCollecting: ${stillCollecting}`);
    }
    
    if (conversationData && conversationData.messages.length > 0) {
      // Only deliver messages if n8n has finished sending all messages
      if (conversationData.allMessagesReceived) {
        // Find undelivered messages sorted by timestamp
        const undeliveredMessages = conversationData.messages
          .filter(msg => !msg.delivered)
          .sort((a, b) => a.timestamp - b.timestamp);
        
        if (undeliveredMessages.length > 0) {
          const deliveryTimestamp = new Date().toISOString();
          console.log(`📤 Sending ALL ${undeliveredMessages.length} bot messages to frontend at ${deliveryTimestamp}:`);
          console.log(`📤 Total messages in conversation: ${conversationData.messages.length}, Undelivered: ${undeliveredMessages.length}`);
          console.log(`📤 N8N finished sending - delivering complete set in timestamp order`);
          
          // Log each message being delivered
          undeliveredMessages.forEach((msg, idx) => {
            const displayText = msg.text ? msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '') : '[IMAGE]';
            console.log(`   Message ${idx + 1}: "${displayText}" ${msg.image ? '[+IMAGE: ' + msg.image.substring(0, 50) + '...]' : ''} (${msg.receivedAt})`);
          });
          
          // Mark messages as delivered
          undeliveredMessages.forEach(msg => {
            msg.delivered = true;
          });
      
          // Show final state after delivery
          console.log(`📊 STATE AFTER DELIVERY:`);
          console.log(`   Bot messages stored: ${botMessages.size}`);
          console.log(`   User messages tracked: ${userMessages.size}`);
          console.log(`🏁 Ready for next message cycle`);
      
          res.json({ 
            success: true, 
            messages: undeliveredMessages
          });
        } else {
          console.log(`❌ ALL MESSAGES ALREADY DELIVERED for conversation: ${conversationId}`);
          console.log(`📊 This conversation has ${conversationData.messages.length} total messages, all already delivered`);
          res.json({ 
            success: false, 
            message: 'All messages already delivered' 
          });
        }
      } else {
        // N8N still sending messages - wait for completion
        const timeoutExists = global.conversationTimeouts && global.conversationTimeouts[conversationId];
        console.log(`⏳ N8N still sending messages for conversation: ${conversationId}`);
        console.log(`📊 Current messages: ${conversationData.messages.length}, timeout active: ${!!timeoutExists}`);
        console.log(`📊 Expected completion in ~${timeoutExists ? '6' : '0'} seconds...`);
        res.json({ 
          success: false, 
          message: 'Still collecting messages from n8n',
          messagesReceived: conversationData.messages.length,
          timeoutActive: !!timeoutExists
        });
      }
    } else {
      console.log(`❌ NO BOT MESSAGES FOUND for conversation: ${conversationId}`);
      console.log(`📊 Current state: ${botMessages.size} conversation(s) with messages`);
      res.json({ 
        success: false, 
        message: 'No bot messages available' 
      });
    }
  } catch (error) {
    console.error('❌ Error getting bot messages:', error);
    res.status(500).json({ error: 'Failed to get bot messages' });
  }
});

app.get('/api/botpress-webhook', async (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: Date.now(),
    activeConversations: {
      botMessages: botMessages.size,
      userMessages: userMessages.size,
      totalBotMessages: Array.from(botMessages.values()).reduce((total, conv) => total + conv.messages.length, 0)
    }
  });
});

// Debug endpoint to clear all state (for testing)
app.post('/api/debug/clear-all', async (req, res) => {
  console.log('🧹 FORCE CLEARING ALL STATE');
  
  const beforeCounts = {
    botMessages: botMessages.size,
    userMessages: userMessages.size,
    totalBotMessages: Array.from(botMessages.values()).reduce((total, conv) => total + conv.messages.length, 0)
  };
  
  // Clear all maps
  botMessages.clear();
  userMessages.clear();
  webhookQueue.clear();
  
  console.log(`✅ Cleared all state. Before: ${JSON.stringify(beforeCounts)}, After: all 0`);
  
  res.json({ 
    success: true,
    message: 'All state cleared',
    clearedCounts: beforeCounts,
    timestamp: Date.now()
  });
});

// File upload endpoint for Botpress knowledge base
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`📁 File upload received: ${req.file.originalname} (${req.file.size} bytes)`);
    console.log(`📁 File type: ${req.file.mimetype}`);
    
    // Debug environment variables
    console.log(`🔍 DEBUG - Environment variables:`);
    console.log(`   BOTPRESS_BEARER_TOKEN: ${process.env.BOTPRESS_BEARER_TOKEN ? process.env.BOTPRESS_BEARER_TOKEN.substring(0, 20) + '...' : 'NOT SET'}`);
    console.log(`   BOTPRESS_BOT_ID: ${process.env.BOTPRESS_BOT_ID || 'NOT SET'}`);
    console.log(`   BOTPRESS_WORKSPACE_ID: ${process.env.BOTPRESS_WORKSPACE_ID || 'NOT SET'}`);
    console.log(`   Using BOT_ID: ${BOT_ID}`);
    console.log(`   Using WORKSPACE_ID: ${WORKSPACE_ID}`);
    console.log(`   API_ID: ${API_ID || 'NOT SET'}`);

    // Step 1: Register file and get uploadUrl
    const fileKey = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`🔍 DEBUG - Files API call:`);
    console.log(`   URL: https://api.botpress.cloud/v1/files`);
    console.log(`   Authorization: Bearer ${BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'}`);
    console.log(`   x-bot-id: ${BOT_ID}`);
    
    const registerRes = await fetch('https://api.botpress.cloud/v1/files', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: fileKey,
        contentType: req.file.mimetype,
        size: req.file.size,
        index: true,
        accessPolicies: ['public_content'],
        tags: {
          uploadedBy: 'webchat',
          originalName: req.file.originalname
        }
      })
    });

    if (!registerRes.ok) {
      const errorText = await registerRes.text();
      console.error(`❌ Botpress API error: ${registerRes.status} - ${errorText}`);
      throw new Error(`Botpress API error: ${registerRes.status}`);
    }

    const registerData = await registerRes.json();
    const fileObj = registerData.file || registerData;
    const uploadUrl = fileObj.uploadUrl;
    const fileId = fileObj.id;
    if (!uploadUrl || !fileId) {
      throw new Error('No uploadUrl or fileId in Botpress response');
    }
    console.log(`✅ File metadata registered. File ID: ${fileId}, Upload URL: ${uploadUrl}`);

    // Step 2: Upload file content to uploadUrl
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': req.file.mimetype
      },
      body: fs.readFileSync(req.file.path)
    });
    if (!uploadRes.ok) {
      const uploadErrorText = await uploadRes.text();
      console.error(`❌ File content upload error: ${uploadRes.status} - ${uploadErrorText}`);
      throw new Error(`File content upload error: ${uploadRes.status}`);
    }
    console.log(`✅ File content uploaded to storage.`);

    // Step 3: Add file to knowledge base
    console.log(`📚 Adding file to knowledge base...`);
    const knowledgeBaseResponse = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f/documents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: req.file.originalname,
        type: 'file',
        fileId: fileId,
        workspaceId: WORKSPACE_ID
      })
    });

    if (!knowledgeBaseResponse.ok) {
      const kbErrorText = await knowledgeBaseResponse.text();
      console.error(`❌ Knowledge base error: ${knowledgeBaseResponse.status} - ${kbErrorText}`);
      throw new Error(`Knowledge base error: ${knowledgeBaseResponse.status}`);
    }

    const kbData = await knowledgeBaseResponse.json();
    console.log(`✅ File added to knowledge base successfully! Document ID: ${kbData.id || 'N/A'}`);

    // Clean up temporary file
    fs.unlinkSync(req.file.path);
    console.log(`🧹 Temporary file cleaned up: ${req.file.path}`);

    res.json({ 
      success: true, 
      message: 'File uploaded to knowledge base successfully',
      fileId: fileId,
      documentId: kbData.id,
      fileName: req.file.originalname
    });
  } catch (error) {
    console.error('❌ File upload error:', error);
    // Clean up temporary file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log(`🧹 Cleaned up temporary file after error: ${req.file.path}`);
    }
    res.status(500).json({ 
      error: error.message || 'Failed to upload file to knowledge base' 
    });
  }
});

// Test token permissions endpoint
app.get('/api/test-permissions', async (req, res) => {
  try {
    console.log('🔑 Testing token permissions...');
    
    const results = {};
    
    // Test 1: Files API (we know this works)
    console.log(`🔍 Test 1: Files API...`);
    const filesResponse = await fetch('https://api.botpress.cloud/v1/files', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    results.files = { status: filesResponse.status, ok: filesResponse.ok };
    
    // Test 2: Try to get user info (to see what permissions the token has)
    console.log(`🔍 Test 2: User info...`);
    const userResponse = await fetch('https://api.botpress.cloud/v1/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.user = { status: userResponse.status, ok: userResponse.ok, data: userResponse.ok ? await userResponse.json() : null };
    
    // Test 3: Try to get workspace info
    console.log(`🔍 Test 3: Workspace info...`);
    const workspaceResponse = await fetch(`https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.workspace = { status: workspaceResponse.status, ok: workspaceResponse.ok, data: workspaceResponse.ok ? await workspaceResponse.json() : null };
    
    // Test 4: Try to get bot info
    console.log(`🔍 Test 4: Bot info...`);
    const botResponse = await fetch(`https://api.botpress.cloud/v1/bots/${BOT_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.bot = { status: botResponse.status, ok: botResponse.ok, data: botResponse.ok ? await botResponse.json() : null };
    
    // Test 5: Try different knowledge base endpoint structures
    console.log(`🔍 Test 5: Testing different KB endpoints...`);
    
    // Test 5a: List all knowledge bases
    const kbResponse1 = await fetch(`https://api.botpress.cloud/v1/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.knowledgeBases1 = { status: kbResponse1.status, ok: kbResponse1.ok, data: kbResponse1.ok ? await kbResponse1.json() : null };
    
    // Test 5b: Try with bot ID header
    const kbResponse2 = await fetch(`https://api.botpress.cloud/v1/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    results.knowledgeBases2 = { status: kbResponse2.status, ok: kbResponse2.ok, data: kbResponse2.ok ? await kbResponse2.json() : null };
    
    // Test 5c: Try workspace-specific endpoint
    const kbResponse3 = await fetch(`https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.knowledgeBases3 = { status: kbResponse3.status, ok: kbResponse3.ok, data: kbResponse3.ok ? await kbResponse3.json() : null };
    
    // Test 5d: Try bot-specific endpoint
    const kbResponse4 = await fetch(`https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.knowledgeBases4 = { status: kbResponse4.status, ok: kbResponse4.ok, data: kbResponse4.ok ? await kbResponse4.json() : null };
    
    res.json({ 
      success: true,
      message: 'Permission test completed',
      results: results,
      tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
    });
  }
});

// Debug endpoint to check environment variables
app.get('/api/debug-env', async (req, res) => {
  res.json({
    BOTPRESS_BEARER_TOKEN: process.env.BOTPRESS_BEARER_TOKEN ? process.env.BOTPRESS_BEARER_TOKEN.substring(0, 20) + '...' : 'NOT SET',
    BOTPRESS_BOT_ID: process.env.BOTPRESS_BOT_ID || 'NOT SET',
    BOTPRESS_WORKSPACE_ID: process.env.BOTPRESS_WORKSPACE_ID || 'NOT SET',
    USING_TOKEN: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET',
    USING_BOT_ID: BOT_ID,
    USING_WORKSPACE_ID: WORKSPACE_ID,
    API_ID: API_ID || 'NOT SET',
    NODE_ENV: process.env.NODE_ENV || 'NOT SET',
    // Raw values for debugging
    RAW_BOTPRESS_BEARER_TOKEN: process.env.BOTPRESS_BEARER_TOKEN ? 'SET' : 'NOT SET',
    RAW_BOTPRESS_BOT_ID: process.env.BOTPRESS_BOT_ID ? 'SET' : 'NOT SET',
    RAW_BOTPRESS_WORKSPACE_ID: process.env.BOTPRESS_WORKSPACE_ID ? 'SET' : 'NOT SET'
  });
});

// Comprehensive API diagnostic endpoint
app.get('/api/test-token', async (req, res) => {
  try {
    console.log('🔑 Testing Botpress API token...');
    console.log(`   Token: ${BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'}`);
    console.log(`   Bot ID: ${BOT_ID}`);
    console.log(`   Workspace ID: ${WORKSPACE_ID}`);
    
    const results = {};
    
    // Test 1: Check knowledge base info
    console.log(`🔍 Test 1: Checking knowledge base info...`);
    const kbResponse = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    
    results.kbInfo = {
      status: kbResponse.status,
      ok: kbResponse.ok,
      data: kbResponse.ok ? await kbResponse.json() : null
    };
    
    // Test 2: Try different API endpoint structures and HTTP methods
    console.log(`🔍 Test 2: Testing different API endpoints and HTTP methods...`);
    
    // Test 2a: GET with x-bot-id
    const test2a = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f/documents`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    results.endpoint2a = { method: 'GET', status: test2a.status, ok: test2a.ok };
    
    // Test 2b: POST with x-bot-id (maybe it's a POST endpoint)
    const test2b = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f/documents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: true })
    });
    results.endpoint2b = { method: 'POST', status: test2b.status, ok: test2b.ok };
    
    // Test 2c: GET without x-bot-id
    const test2c = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f/documents`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.endpoint2c = { method: 'GET', status: test2c.status, ok: test2c.ok };
    
    // Test 2d: POST without x-bot-id
    const test2d = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f/documents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: true })
    });
    results.endpoint2d = { method: 'POST', status: test2d.status, ok: test2d.ok };
    
    // Test 2e: Try to list all knowledge bases first
    const test2e = await fetch(`https://api.botpress.cloud/v1/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    results.endpoint2e = { method: 'GET', status: test2e.status, ok: test2e.ok, data: test2e.ok ? await test2e.json() : null };
    
    // Test 2f: Try workspace-based knowledge bases
    const test2f = await fetch(`https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.endpoint2f = { method: 'GET', status: test2f.status, ok: test2f.ok, data: test2f.ok ? await test2f.json() : null };
    
    // Test 2g: Try bot-based knowledge bases
    const test2g = await fetch(`https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-bases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.endpoint2g = { method: 'GET', status: test2g.status, ok: test2g.ok, data: test2g.ok ? await test2g.json() : null };
    
    // Find the first working endpoint
    let workingEndpoint = null;
    if (test2a.ok) workingEndpoint = '2a (GET with x-bot-id)';
    else if (test2b.ok) workingEndpoint = '2b (POST with x-bot-id)';
    else if (test2c.ok) workingEndpoint = '2c (GET without x-bot-id)';
    else if (test2d.ok) workingEndpoint = '2d (POST without x-bot-id)';
    else if (test2e.ok) workingEndpoint = '2e (list all KBs)';
    else if (test2f.ok) workingEndpoint = '2f (workspace KBs)';
    else if (test2g.ok) workingEndpoint = '2g (bot KBs)';
    
    res.json({ 
      success: workingEndpoint !== null,
      message: workingEndpoint ? `Found working endpoint: ${workingEndpoint}` : 'No working endpoints found',
      workingEndpoint: workingEndpoint,
      results: results,
      tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
    });
  }
});

// Debug endpoint to see what's stored
app.get('/api/debug/stored-responses', async (req, res) => {
  const allBotMessages = {};
  const allUserMessages = {};
  
  for (const [key, value] of botMessages.entries()) {
    allBotMessages[key] = {
      messageCount: value.messages.length,
      lastDelivered: value.lastDelivered,
      allMessagesReceived: value.allMessagesReceived,
      hasDeliveryTimeout: !!value.deliveryTimeoutId,
      messages: value.messages.map(msg => ({ 
        text: msg.text ? msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '') : null,
        hasImage: !!msg.image,
        imageType: msg.image ? typeof msg.image : null,
        timestamp: msg.timestamp,
        receivedAt: msg.receivedAt,
        id: msg.id,
        delivered: msg.delivered
      }))
    };
  }
  
  for (const [key, value] of userMessages.entries()) {
    allUserMessages[key] = value;
  }
  
  const totalBotMessages = Array.from(botMessages.values()).reduce((total, conv) => total + conv.messages.length, 0);
  
  console.log('🔍 DEBUG ENDPOINT CALLED - Current storage state:');
  console.log(`   Bot message conversations: ${botMessages.size} stored`);
  console.log(`   Total bot messages: ${totalBotMessages}`);
  console.log(`   User messages: ${userMessages.size} tracked`);
  console.log(`   Webhook queue: ${webhookQueue.size} processing`);
  
  res.json({ 
    totalBotMessageConversations: botMessages.size,
    totalBotMessages: totalBotMessages,
    totalUserMessages: userMessages.size,
    totalWebhookQueue: webhookQueue.size,
    botMessages: allBotMessages,
    userMessages: allUserMessages,
    webhookQueue: Object.fromEntries(webhookQueue),
    timestamp: Date.now()
  });
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ MULTER ERROR:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Global error handler to prevent bad gateway errors
app.use((err, req, res, next) => {
  console.error('❌ GLOBAL ERROR HANDLER:', err);
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Server error', 
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Debug endpoint: http://localhost:${PORT}/api/debug/stored-responses`);
}); 