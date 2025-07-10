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



// Store bot responses temporarily (in production, use Redis or database)
const botResponses = new Map();

// Track user messages to distinguish them from bot responses
const userMessages = new Map();

// Track multi-part bot responses
const multiPartResponses = new Map(); // conversationId -> { messages: [], lastReceived: timestamp, isComplete: boolean }

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
  
  // Store user message with timestamp to track what the user actually sent
  userMessages.set(conversationId, {
    text: text,
    timestamp: Date.now(),
    trackedAt: userTrackingTimestamp
  });
  
  console.log(`✅ USER MESSAGE TRACKED SUCCESSFULLY at ${userTrackingTimestamp}. Total tracked: ${userMessages.size}`);
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
    const timestamp = new Date().toISOString();
    console.log(`🔄 WEBHOOK RECEIVED FROM N8N at ${timestamp}:`);
    console.log('📋 Full request body:', JSON.stringify(req.body, null, 2));
    
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
      console.log(`🤖 IDENTIFIED AS BOT MESSAGE (isBot: true) at ${botMessageTimestamp} - will store and display`);
      
      if (conversationId && botText && !botText.includes('{{ $json')) {
        console.log(`💾 COLLECTING BOT RESPONSE PART at ${botMessageTimestamp}: "${botText}"`);
        
        // Get or create multi-part response tracking
        let multiPart = multiPartResponses.get(conversationId);
        if (!multiPart) {
          multiPart = {
            messages: [],
            lastReceived: Date.now(),
            isComplete: false,
            timeoutId: null
          };
          multiPartResponses.set(conversationId, multiPart);
          console.log(`📦 Started new multi-part response collection for conversation: ${conversationId} at ${botMessageTimestamp}`);
        }
        
        // Add this message part
        const partTimestamp = Date.now();
        multiPart.messages.push({
          text: botText,
          timestamp: partTimestamp,
          receivedAt: botMessageTimestamp,
          id: `bot-part-${partTimestamp}-${multiPart.messages.length}`
        });
        multiPart.lastReceived = partTimestamp;
        
        console.log(`📝 Added message part ${multiPart.messages.length} at ${botMessageTimestamp}: "${botText}"`);
        console.log(`📊 Total parts collected so far: ${multiPart.messages.length}`);
        
        // Clear any existing timeout
        if (multiPart.timeoutId) {
          clearTimeout(multiPart.timeoutId);
        }
        
        // Check if this looks like a complete single message (no more parts expected)
        // For immediate single responses, set shorter timeout
        const timeoutDelay = multiPart.messages.length === 1 && 
                            (botText.endsWith('.') || botText.endsWith('!') || botText.endsWith('?')) ? 
                            1000 : 3000; // 1 second for complete sentences, 3 seconds for potential multi-part
        
        console.log(`⏱️ Setting timeout for ${timeoutDelay}ms (${timeoutDelay === 1000 ? 'complete sentence detected' : 'waiting for potential additional parts'})...`);
        
        // Set timeout to finalize response
        multiPart.timeoutId = setTimeout(() => {
          const finalizeTimestamp = new Date().toISOString();
          console.log(`⏰ TIMEOUT: Finalizing multi-part response for ${conversationId} at ${finalizeTimestamp}`);
          console.log(`🎯 Final message count: ${multiPart.messages.length} parts`);
          
          // Show timing info for each part
          console.log(`📋 Parts received timeline:`);
          multiPart.messages.forEach((msg, index) => {
            console.log(`   Part ${index + 1}: ${msg.receivedAt} - "${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"`);
          });
          
          const finalTimestamp = Date.now();
          
          // Check if this is actually multi-part or just a single message
          const isActuallyMultiPart = multiPart.messages.length > 1;
          
          if (isActuallyMultiPart) {
            // Store as multi-part response
            botResponses.set(conversationId, {
              isMultiPart: true,
              messages: multiPart.messages,  // Array of separate messages
              timestamp: finalTimestamp,
              finalizedAt: finalizeTimestamp,
              id: `bot-multipart-${finalTimestamp}`,
              partCount: multiPart.messages.length
            });
            console.log(`📦 Stored as multi-part response (${multiPart.messages.length} parts)`);
          } else {
            // Store as single message for compatibility
            const singleMessage = multiPart.messages[0];
            botResponses.set(conversationId, {
              text: singleMessage.text,
              timestamp: finalTimestamp,
              finalizedAt: finalizeTimestamp,
              id: singleMessage.id,
              isMultiPart: false,
              partCount: 1,
              receivedAt: singleMessage.receivedAt
            });
            console.log(`📦 Stored as single message response`);
          }
          
          // Mark as complete and clean up
          multiPart.isComplete = true;
          if (isActuallyMultiPart) {
            console.log(`✅ Multi-part bot response finalized and stored at ${finalizeTimestamp} (${multiPart.messages.length} separate messages)`);
            console.log(`📄 Will display as ${multiPart.messages.length} individual chat bubbles`);
          } else {
            console.log(`✅ Single bot response finalized and stored at ${finalizeTimestamp}`);
            console.log(`📄 Will display as 1 chat bubble`);
          }
          
          // Clean up the tracked user message since we got a bot response
          userMessages.delete(conversationId);
          
        }, timeoutDelay); // Dynamic timeout based on message content
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
          const fallbackTimestamp = new Date().toISOString();
          console.log(`💾 FALLBACK: STORING SINGLE BOT RESPONSE at ${fallbackTimestamp}: "${botText}"`);
          botResponses.set(conversationId, {
            text: botText,
            timestamp: Date.now(),
            id: `bot-fallback-${Date.now()}`,
            isMultiPart: false,
            partCount: 1,
            receivedAt: fallbackTimestamp
          });
          userMessages.delete(conversationId);
          console.log(`✅ Fallback single bot response stored successfully`);
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
    for (const [key, value] of multiPartResponses.entries()) {
      if (value.lastReceived < fiveMinutesAgo) {
        if (value.timeoutId) {
          clearTimeout(value.timeoutId);
        }
        multiPartResponses.delete(key);
        console.log(`🧹 Cleaned up old multi-part response for conversation: ${key}`);
      }
    }
    
    res.json({ 
      success: true,
      conversationId: conversationId,
      message: botText,
      isBot: isBot,
      received: true
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
    const requestTimestamp = new Date().toISOString();
    console.log(`🔍 FRONTEND POLLING at ${requestTimestamp} for conversation: ${conversationId}`);
    
    const botResponse = botResponses.get(conversationId);
    const multiPart = multiPartResponses.get(conversationId);
    
    console.log(`🔍 STORAGE CHECK:`);
    console.log(`   Bot responses in storage: ${botResponses.size}`);
    console.log(`   Multi-part responses in progress: ${multiPartResponses.size}`);
    console.log(`   Found bot response for this conversation: ${!!botResponse}`);
    console.log(`   Found multi-part for this conversation: ${!!multiPart}`);
    
    if (botResponse) {
      const deliveryTimestamp = new Date().toISOString();
      console.log(`📤 Sending bot response to frontend at ${deliveryTimestamp}:`);
      
      if (botResponse.isMultiPart) {
        console.log(`   📝 Multi-part response: ${botResponse.partCount} separate messages`);
        botResponse.messages.forEach((msg, index) => {
          console.log(`     Part ${index + 1}: "${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"`);
        });
      } else {
        console.log(`   💬 Text: "${botResponse.text.substring(0, 100)}${botResponse.text.length > 100 ? '...' : ''}"`);
        console.log(`   📏 Total length: ${botResponse.text.length} characters`);
      }
      
      console.log(`   🔢 Part count: ${botResponse.partCount || 1}`);
      if (botResponse.finalizedAt) {
        console.log(`   ⏱️ Originally finalized at: ${botResponse.finalizedAt}`);
      }
      
      // Remove the response after sending it to prevent duplicates
      botResponses.delete(conversationId);
      
      // Clean up multi-part tracking
      if (multiPart) {
        if (multiPart.timeoutId) {
          clearTimeout(multiPart.timeoutId);
        }
        multiPartResponses.delete(conversationId);
        console.log(`🧹 Cleaned up multi-part tracking for conversation: ${conversationId}`);
      }
      
      res.json({ 
        success: true, 
        response: botResponse
      });
    } else {
      // Check if we're still collecting parts
      if (multiPart && !multiPart.isComplete) {
        const collectingTimestamp = new Date().toISOString();
        console.log(`⏳ Still collecting message parts at ${collectingTimestamp} (${multiPart.messages.length} so far)...`);
        res.json({ 
          success: false, 
          message: 'Multi-part response in progress',
          partsCollected: multiPart.messages.length,
          timestamp: collectingTimestamp
        });
      } else {
        console.log(`❌ NO BOT RESPONSE FOUND for conversation: ${conversationId}`);
        console.log(`🔍 Available conversation IDs in botResponses:`, Array.from(botResponses.keys()));
        console.log(`🔍 Available conversation IDs in multiPartResponses:`, Array.from(multiPartResponses.keys()));
        
        res.json({ 
          success: false, 
          message: 'No bot response available',
          debug: {
            requestedConversationId: conversationId,
            availableBotResponses: Array.from(botResponses.keys()),
            availableMultiPart: Array.from(multiPartResponses.keys()),
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  } catch (error) {
    console.error('❌ Error getting bot response:', error);
    res.status(500).json({ error: 'Failed to get bot response' });
  }
});

app.get('/api/botpress-webhook', async (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// Simple test endpoint to verify bot response format
app.get('/api/test/bot-message/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const testTimestamp = new Date().toISOString();
  
  // Store a test bot response
  botResponses.set(conversationId, {
    text: "This is a test message from the backend!",
    timestamp: Date.now(),
    id: `test-${Date.now()}`,
    isMultiPart: false,
    partCount: 1,
    receivedAt: testTimestamp
  });
  
  console.log(`🧪 TEST: Stored test bot response for conversation ${conversationId} at ${testTimestamp}`);
  
  res.json({ 
    success: true,
    message: `Test bot response stored for conversation ${conversationId}`,
    timestamp: testTimestamp
  });
});

// Debug endpoint to see what's stored
app.get('/api/debug/stored-responses', async (req, res) => {
  const allResponses = {};
  const allUserMessages = {};
  const allMultiPartResponses = {};
  
  for (const [key, value] of botResponses.entries()) {
    allResponses[key] = value;
  }
  
  for (const [key, value] of userMessages.entries()) {
    allUserMessages[key] = value;
  }
  
  for (const [key, value] of multiPartResponses.entries()) {
    allMultiPartResponses[key] = {
      messageCount: value.messages.length,
      lastReceived: value.lastReceived,
      isComplete: value.isComplete,
      hasTimeout: !!value.timeoutId,
      messages: value.messages.map(msg => ({ 
        text: msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : ''),
        timestamp: msg.timestamp,
        id: msg.id
      }))
    };
  }
  
  console.log('🔍 DEBUG ENDPOINT CALLED - Current storage state:');
  console.log(`   Bot responses: ${botResponses.size} stored`);
  console.log(`   User messages: ${userMessages.size} tracked`);
  console.log(`   Multi-part responses: ${multiPartResponses.size} in progress`);
  
  res.json({ 
    totalBotResponses: botResponses.size,
    totalUserMessages: userMessages.size,
    totalMultiPartResponses: multiPartResponses.size,
    botResponses: allResponses,
    userMessages: allUserMessages,
    multiPartResponses: allMultiPartResponses,
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📡 Frontend should connect to: http://localhost:${PORT}`);
}); 