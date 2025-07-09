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

app.use(express.json());

// Load secrets from .env file
const API_ID = process.env.API_ID;
const BASE_URL = `https://chat.botpress.cloud/${API_ID}`;

// Configuration for multi-part responses
let MULTI_PART_ENABLED = process.env.MULTI_PART_ENABLED !== 'false'; // Default: enabled
let MULTI_PART_TIMER_MS = parseInt(process.env.MULTI_PART_TIMER_MS) || 3000; // Default: 3 seconds

console.log('⚙️ Multi-part response configuration:');
console.log(`   Enabled: ${MULTI_PART_ENABLED}`);
console.log(`   Timer: ${MULTI_PART_TIMER_MS}ms`);



// Store bot responses temporarily (in production, use Redis or database)
const botResponses = new Map();

// Track user messages to distinguish them from bot responses
const userMessages = new Map();

// Track multiple bot responses for the same conversation
const multipleResponses = new Map();

// Track timing for detecting when bot is done sending multiple messages
const responseTimers = new Map();

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
  console.log(`🔵 TRACKING USER MESSAGE: "${text}" for conversation ${conversationId}`);
  
  if (!conversationId || !text) {
    console.log('❌ TRACKING FAILED: Missing conversationId or text');
    return res.status(400).json({ error: 'Missing conversationId or text' });
  }
  
  // Store user message with timestamp to track what the user actually sent
  userMessages.set(conversationId, {
    text: text,
    timestamp: Date.now()
  });
  
  console.log(`✅ USER MESSAGE TRACKED SUCCESSFULLY. Total tracked: ${userMessages.size}`);
  console.log(`   Stored: "${text}" for conversation ${conversationId}`);
  console.log(`   This will help identify if N8N echoes this message back`);
  
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
    // Check if we have a stored N8N response for this conversation
    const storedResponse = botResponses.get(conversationId);
    
    if (storedResponse) {
      // Format it like the old Botpress API response
      const formattedResponse = {
        messages: [
          {
            id: storedResponse.id,
            type: 'text',
            payload: {
              text: storedResponse.text
            },
            userId: 'bot',
            createdAt: new Date(storedResponse.timestamp).toISOString()
          }
        ]
      };
      
      // Remove the response after sending it
      botResponses.delete(conversationId);
      
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
  try {
    console.log('🔄 WEBHOOK RECEIVED FROM N8N:');
    console.log('📋 Full request body:', JSON.stringify(req.body, null, 2));
    
    // Quick response to N8N to prevent timeouts
    const quickResponse = {
      success: true,
      received: true,
      timestamp: Date.now(),
      status: 'processing'
    };
    
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
      console.log('🤖 IDENTIFIED AS BOT MESSAGE (isBot: true) - will store and display');
      
      if (conversationId && botText && !botText.includes('{{ $json')) {
        
        if (MULTI_PART_ENABLED) {
          console.log(`💾 COLLECTING BOT RESPONSE PART: "${botText}"`);
          
          // Initialize array for this conversation if it doesn't exist
          if (!multipleResponses.has(conversationId)) {
            multipleResponses.set(conversationId, []);
          }
          
          // Add this response to the collection
          const responses = multipleResponses.get(conversationId);
          responses.push({
            text: botText,
            timestamp: Date.now(),
            id: `bot-${Date.now()}-part${responses.length + 1}`
          });
          
          console.log(`📊 COLLECTED ${responses.length} RESPONSE PART(S) FOR CONVERSATION ${conversationId}`);
          console.log(`   Latest part: "${botText}"`);
          
          // Clear any existing timer for this conversation
          if (responseTimers.has(conversationId)) {
            clearTimeout(responseTimers.get(conversationId));
            console.log('⏰ Cleared existing timer - more parts incoming');
          }
          
          // Set a timer to wait for more responses
          const timer = setTimeout(() => {
            console.log(`⏰ TIMER EXPIRED - Processing ${responses.length} collected response(s)`);
            
            if (responses.length === 1) {
              // Single response - store as before
              console.log(`📤 SINGLE RESPONSE: "${responses[0].text}"`);
              botResponses.set(conversationId, responses[0]);
            } else {
              // Multiple responses - combine them
              const combinedText = responses.map((r, index) => `${r.text}`).join('\n\n');
              console.log(`📤 COMBINED ${responses.length} RESPONSES INTO ONE MESSAGE:`);
              console.log(`   Combined text: "${combinedText}"`);
              
              botResponses.set(conversationId, {
                text: combinedText,
                timestamp: Date.now(),
                id: `bot-combined-${Date.now()}`,
                partCount: responses.length
              });
            }
            
            // Clean up
            multipleResponses.delete(conversationId);
            responseTimers.delete(conversationId);
            userMessages.delete(conversationId);
            
            console.log(`✅ Bot response(s) finalized and ready for frontend polling`);
          }, MULTI_PART_TIMER_MS);
          
          responseTimers.set(conversationId, timer);
          console.log(`⏰ SET TIMER: Waiting ${MULTI_PART_TIMER_MS}ms for additional response parts...`);
          
        } else {
          // Multi-part disabled - store immediately
          console.log(`💾 STORING SINGLE BOT RESPONSE (multi-part disabled): "${botText}"`);
          botResponses.set(conversationId, {
            text: botText,
            timestamp: Date.now(),
            id: `bot-${Date.now()}`
          });
          userMessages.delete(conversationId);
          console.log('✅ Bot response stored immediately');
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
          console.log(`💾 FALLBACK: STORING BOT RESPONSE: "${botText}"`);
          botResponses.set(conversationId, {
            text: botText,
            timestamp: Date.now(),
            id: `bot-${Date.now()}`
          });
          userMessages.delete(conversationId);
        }
      }
    }
    
    // Clean up old responses and user messages (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [key, value] of botResponses.entries()) {
      if (value.timestamp < fiveMinutesAgo) {
        botResponses.delete(key);
      }
    }
    for (const [key, value] of userMessages.entries()) {
      if (value.timestamp < fiveMinutesAgo) {
        userMessages.delete(key);
      }
    }
    // Clean up old multiple responses and timers
    for (const [key, responses] of multipleResponses.entries()) {
      const oldestResponse = Math.min(...responses.map(r => r.timestamp));
      if (oldestResponse < fiveMinutesAgo) {
        multipleResponses.delete(key);
        if (responseTimers.has(key)) {
          clearTimeout(responseTimers.get(key));
          responseTimers.delete(key);
        }
      }
    }
    
    // Respond to N8N immediately to prevent timeouts
    res.json({ 
      success: true,
      conversationId: conversationId,
      message: botText,
      isBot: isBot,
      received: true,
      multiPartEnabled: MULTI_PART_ENABLED,
      processing: isBotMessage && MULTI_PART_ENABLED ? 'collecting' : 'immediate',
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error);
    res.status(500).json({ 
      error: 'Webhook processing failed',
      success: false 
    });
  }
});

// New endpoint for frontend to get bot responses
app.get('/api/bot-response/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const botResponse = botResponses.get(conversationId);
    
    if (botResponse) {
      // Remove the response after sending it to prevent duplicates
      botResponses.delete(conversationId);
      res.json({ 
        success: true, 
        response: botResponse 
      });
    } else {
      res.json({ 
        success: false, 
        message: 'No bot response available' 
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to get bot response' });
  }
});

app.get('/api/botpress-webhook', async (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// Endpoint to temporarily disable/enable multi-part responses for testing
app.post('/api/config/multipart', async (req, res) => {
  const { enabled, timerMs } = req.body;
  
  if (typeof enabled === 'boolean') {
    // This only works for the current session - restarting will reset to env vars
    MULTI_PART_ENABLED = enabled;
    console.log(`⚙️ Multi-part responses ${enabled ? 'ENABLED' : 'DISABLED'} via API`);
  }
  
  if (timerMs && !isNaN(timerMs) && timerMs > 100 && timerMs < 10000) {
    MULTI_PART_TIMER_MS = timerMs;
    console.log(`⚙️ Multi-part timer set to ${timerMs}ms via API`);
  }
  
  res.json({
    success: true,
    multiPartEnabled: MULTI_PART_ENABLED,
    timerMs: MULTI_PART_TIMER_MS,
    message: 'Configuration updated (session only - restart resets to env vars)'
  });
});

app.get('/api/config/multipart', async (req, res) => {
  res.json({
    multiPartEnabled: MULTI_PART_ENABLED,
    timerMs: MULTI_PART_TIMER_MS,
    activeCollections: multipleResponses.size,
    activeTimers: responseTimers.size
  });
});

// Debug endpoint to see what's stored
app.get('/api/debug/stored-responses', async (req, res) => {
  const allResponses = {};
  const allUserMessages = {};
  const allMultipleResponses = {};
  const allActiveTimers = {};
  
  for (const [key, value] of botResponses.entries()) {
    allResponses[key] = value;
  }
  
  for (const [key, value] of userMessages.entries()) {
    allUserMessages[key] = value;
  }
  
  for (const [key, value] of multipleResponses.entries()) {
    allMultipleResponses[key] = value;
  }
  
  for (const [key, value] of responseTimers.entries()) {
    allActiveTimers[key] = 'Timer active';
  }
  
  console.log('🔍 DEBUG ENDPOINT CALLED - Current storage state:');
  console.log(`   Bot responses: ${botResponses.size} stored`);
  console.log(`   User messages: ${userMessages.size} tracked`);
  console.log(`   Multiple responses collecting: ${multipleResponses.size}`);
  console.log(`   Active timers: ${responseTimers.size}`);
  
  res.json({ 
    totalBotResponses: botResponses.size,
    totalUserMessages: userMessages.size,
    totalMultipleResponsesCollecting: multipleResponses.size,
    totalActiveTimers: responseTimers.size,
    botResponses: allResponses,
    userMessages: allUserMessages,
    multipleResponsesCollecting: allMultipleResponses,
    activeTimers: allActiveTimers,
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
}); 