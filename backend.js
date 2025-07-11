/**
 * backend.js
 * Backend server for Botpress Chat API integration
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

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
      origin === 'https://n8n-chatbot-psi.vercel.app'
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
const BASE_URL = `https://chat.botpress.cloud/${API_ID}`;



// Store bot messages separately by timestamp (in production, use Redis or database)
const botMessages = new Map(); // conversationId -> { messages: [...], lastDelivered: timestamp }

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
    botMessages.delete(conversationId);
    console.log(`   ✅ Removed old bot messages`);
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
    
    const body = req.body;
    let conversationId, botText, isBot;
    
    // Try multiple extraction patterns
    if (body.body && body.body.data) {
      // N8N sends: { body: { data: { conversationId, payload: { text }, isBot } } }
      conversationId = body.body.data.conversationId;
      botText = body.body.data.payload?.text || body.body.data.text;
      isBot = body.body.data.isBot;
      console.log('📍 Using body.body.data pattern');
    } else if (body.conversationId) {
      // Direct structure: { conversationId, payload: { text }, isBot }
      conversationId = body.conversationId;
      botText = body.payload?.text || body.text;
      isBot = body.isBot;
      console.log('📍 Using body.conversationId pattern');
    } else if (body.text) {
      // Simple text structure
      botText = body.text;
      isBot = body.isBot;
      console.log('📍 Using body.text pattern');
    }
    
    console.log(`🔍 Extracted: conversationId="${conversationId}", text="${botText}", isBot="${isBot}"`);
    console.log(`🔍 Type of isBot: ${typeof isBot}`);
    console.log(`🔍 Raw isBot value: ${JSON.stringify(isBot)}`);
    
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
      
      if (conversationId && botText && !botText.includes('{{ $json')) {
        console.log(`💾 STORING INDIVIDUAL BOT MESSAGE at ${botMessageTimestamp}: "${botText}"`);
        
        // Get or create conversation data
        let conversationData = botMessages.get(conversationId);
        if (!conversationData) {
          conversationData = {
            messages: [],
            lastDelivered: 0
          };
          botMessages.set(conversationId, conversationData);
          console.log(`📦 Created new conversation data for: ${conversationId}`);
        }
        
        // Check for exact duplicates to avoid storing the same message twice
        const isExactDuplicate = conversationData.messages.some(existingMsg => 
          existingMsg.text.trim() === botText.trim()
        );
        
        if (isExactDuplicate) {
          console.log(`⚠️ EXACT DUPLICATE MESSAGE DETECTED: "${botText}"`);
          console.log(`   Skipping exact duplicate`);
        } else {
          // Store this message separately with its own timestamp
          const messageTimestamp = Date.now();
          const newMessage = {
            text: botText,
            timestamp: messageTimestamp,
            receivedAt: botMessageTimestamp,
            id: `bot-msg-${messageTimestamp}-${Math.random().toString(36).substr(2, 6)}`,
            delivered: false
          };
          
          conversationData.messages.push(newMessage);
          
          // Sort messages by timestamp to maintain chronological order
          conversationData.messages.sort((a, b) => a.timestamp - b.timestamp);
          
          console.log(`📝 Stored individual message ${conversationData.messages.length} at ${botMessageTimestamp}: "${botText}"`);
          console.log(`📊 Total messages for conversation: ${conversationData.messages.length}`);
          console.log(`📋 All messages for this conversation:`);
          conversationData.messages.forEach((msg, idx) => {
            console.log(`   Message ${idx + 1}: "${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}" (${msg.receivedAt}) [delivered: ${msg.delivered}]`);
          });
          
          // Extra debugging for multiple message scenarios
          if (conversationData.messages.length >= 2) {
            console.log(`🔍 MULTIPLE MESSAGES DETECTED - Conversation ${conversationId} now has ${conversationData.messages.length} messages`);
            console.log(`🔍 Waiting for potential additional messages...`);
          }
          
          // Clean up the tracked user message since we got a bot response
          userMessages.delete(conversationId);
          console.log(`🧹 Cleaned up tracked user message for conversation: ${conversationId}`);
        }
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
        if (looksLikeBotResponse && conversationId && botText && !botText.includes('{{ $json')) {
          console.log(`💾 FALLBACK: STORING BOT MESSAGE: "${botText}"`);
          
          // Get or create conversation data
          let conversationData = botMessages.get(conversationId);
          if (!conversationData) {
            conversationData = {
              messages: [],
              lastDelivered: 0
            };
            botMessages.set(conversationId, conversationData);
          }
          
          // Store as individual message
          const messageTimestamp = Date.now();
          conversationData.messages.push({
            text: botText,
            timestamp: messageTimestamp,
            receivedAt: new Date().toISOString(),
            id: `bot-fallback-${messageTimestamp}`,
            delivered: false
          });
          
          // Sort messages by timestamp
          conversationData.messages.sort((a, b) => a.timestamp - b.timestamp);
          
          userMessages.delete(conversationId);
        }
      }
    }
    
      // Clean up old messages and user messages (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      for (const [key, value] of botMessages.entries()) {
        // Remove messages older than 5 minutes
        const filteredMessages = value.messages.filter(msg => msg.timestamp >= fiveMinutesAgo);
        if (filteredMessages.length !== value.messages.length) {
          value.messages = filteredMessages;
          console.log(`🧹 Cleaned up old messages for conversation: ${key}`);
        }
        // Remove empty conversation data
        if (value.messages.length === 0) {
          botMessages.delete(key);
        }
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
    const conversationData = botMessages.get(conversationId);
    
    if (conversationData && conversationData.messages.length > 0) {
      // Find undelivered messages sorted by timestamp
      const undeliveredMessages = conversationData.messages
        .filter(msg => !msg.delivered)
        .sort((a, b) => a.timestamp - b.timestamp);
      
      if (undeliveredMessages.length > 0) {
        const deliveryTimestamp = new Date().toISOString();
        console.log(`📤 Sending ${undeliveredMessages.length} bot messages to frontend at ${deliveryTimestamp}:`);
        console.log(`📤 Total messages in conversation: ${conversationData.messages.length}, Undelivered: ${undeliveredMessages.length}`);
        
        // Log each message being delivered
        undeliveredMessages.forEach((msg, idx) => {
          console.log(`   Message ${idx + 1}: "${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}" (${msg.receivedAt})`);
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
        console.log(`❌ NO UNDELIVERED MESSAGES for conversation: ${conversationId}`);
        console.log(`📊 Current state: ${botMessages.size} conversation(s) with messages`);
        if (conversationData) {
          console.log(`📊 This conversation has ${conversationData.messages.length} total messages, all already delivered`);
        }
        res.json({ 
          success: false, 
          message: 'No undelivered messages available' 
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

// Debug endpoint to see what's stored
app.get('/api/debug/stored-responses', async (req, res) => {
  const allBotMessages = {};
  const allUserMessages = {};
  
  for (const [key, value] of botMessages.entries()) {
    allBotMessages[key] = {
      messageCount: value.messages.length,
      lastDelivered: value.lastDelivered,
      messages: value.messages.map(msg => ({ 
        text: msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : ''),
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