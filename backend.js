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
        console.log(`💾 STORING INDIVIDUAL BOT MESSAGE PART at ${botMessageTimestamp}: "${botText}"`);
        
        // Get or create multi-part response tracking
        let multiPart = multiPartResponses.get(conversationId);
        if (!multiPart) {
          multiPart = {
            messages: [],
            lastReceived: Date.now(),
            isComplete: false,
            timeoutId: null,
            nextPartIndex: 0
          };
          multiPartResponses.set(conversationId, multiPart);
          console.log(`📦 Started new multi-part response collection for conversation: ${conversationId} at ${botMessageTimestamp}`);
        }
        
        // Create individual message part
        const partTimestamp = Date.now();
        const partMessage = {
          text: botText,
          timestamp: partTimestamp,
          receivedAt: botMessageTimestamp,
          id: `bot-part-${partTimestamp}-${multiPart.messages.length}`,
          partIndex: multiPart.messages.length,
          conversationId: conversationId
        };
        
        // Add to tracking
        multiPart.messages.push(partMessage);
        multiPart.lastReceived = partTimestamp;
        
        // IMMEDIATELY store this individual part for frontend polling
        const partKey = `${conversationId}-part-${partMessage.partIndex}`;
        botResponses.set(partKey, {
          text: botText,
          timestamp: partTimestamp,
          receivedAt: botMessageTimestamp,
          id: partMessage.id,
          partIndex: partMessage.partIndex,
          isIndividualPart: true,
          conversationId: conversationId
        });
        
        console.log(`📝 IMMEDIATELY STORED message part ${multiPart.messages.length} at ${botMessageTimestamp}: "${botText}"`);
        console.log(`📊 Part stored with key: ${partKey}`);
        console.log(`📊 Total parts collected so far: ${multiPart.messages.length}`);
        
        // Clear any existing timeout
        if (multiPart.timeoutId) {
          clearTimeout(multiPart.timeoutId);
        }
        
        // Set timeout to mark response as complete (wait 3 seconds for more parts)
        multiPart.timeoutId = setTimeout(() => {
          const finalizeTimestamp = new Date().toISOString();
          console.log(`⏰ TIMEOUT: Marking multi-part response as complete for ${conversationId} at ${finalizeTimestamp}`);
          console.log(`🎯 Final message count: ${multiPart.messages.length} parts`);
          
          // Show timing info for each part
          console.log(`📋 Parts received timeline:`);
          multiPart.messages.forEach((msg, index) => {
            console.log(`   Part ${index + 1}: ${msg.receivedAt} - "${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"`);
          });
          
          // Mark as complete - no more parts expected
          multiPart.isComplete = true;
          console.log(`✅ Multi-part response marked as complete at ${finalizeTimestamp} (${multiPart.messages.length} parts)`);
          
          // Clean up the tracked user message since we got a bot response
          userMessages.delete(conversationId);
          
        }, 3000); // Wait 3 seconds for additional parts
        
        console.log(`⏱️ Part immediately available for frontend. Waiting 3 seconds for additional parts...`);
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

// New endpoint for frontend to get individual bot message parts
app.get('/api/bot-response/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const multiPart = multiPartResponses.get(conversationId);
    
    if (!multiPart) {
      // No conversation tracking found
      res.json({ 
        success: false, 
        message: 'No conversation found',
        allPartsDelivered: true
      });
      return;
    }
    
    // Look for the next undelivered part
    const nextPartKey = `${conversationId}-part-${multiPart.nextPartIndex || 0}`;
    const nextPart = botResponses.get(nextPartKey);
    
    if (nextPart) {
      const deliveryTimestamp = new Date().toISOString();
      console.log(`📤 Sending individual bot message part ${nextPart.partIndex + 1} to frontend at ${deliveryTimestamp}:`);
      console.log(`   💬 Text: "${nextPart.text.substring(0, 100)}${nextPart.text.length > 100 ? '...' : ''}"`);
      console.log(`   🔢 Part ${nextPart.partIndex + 1} of ${multiPart.messages.length} collected so far`);
      console.log(`   ⏱️ Originally received at: ${nextPart.receivedAt}`);
      
      // Remove the delivered part
      botResponses.delete(nextPartKey);
      
      // Update next part index
      multiPart.nextPartIndex = (multiPart.nextPartIndex || 0) + 1;
      
      res.json({ 
        success: true, 
        response: {
          text: nextPart.text,
          id: nextPart.id,
          partIndex: nextPart.partIndex,
          timestamp: nextPart.timestamp,
          receivedAt: nextPart.receivedAt,
          isIndividualPart: true
        },
        morePartsExpected: !multiPart.isComplete,
        totalPartsCollected: multiPart.messages.length,
        partNumber: nextPart.partIndex + 1
      });
      
    } else {
      // No more parts available right now
      if (multiPart.isComplete) {
        // All parts have been collected and delivered
        const allDeliveredTimestamp = new Date().toISOString();
        console.log(`✅ All bot message parts delivered for conversation ${conversationId} at ${allDeliveredTimestamp}`);
        console.log(`🧹 Cleaning up multi-part tracking for conversation: ${conversationId}`);
        
        // Clean up multi-part tracking
        if (multiPart.timeoutId) {
          clearTimeout(multiPart.timeoutId);
        }
        multiPartResponses.delete(conversationId);
        
        // Clean up user message tracking
        userMessages.delete(conversationId);
        
        res.json({ 
          success: false, 
          message: 'All parts delivered',
          allPartsDelivered: true,
          totalPartsDelivered: multiPart.messages.length
        });
      } else {
        // Still waiting for more parts
        const waitingTimestamp = new Date().toISOString();
        console.log(`⏳ Waiting for more message parts at ${waitingTimestamp} (${multiPart.messages.length} collected, ${multiPart.nextPartIndex || 0} delivered)...`);
        
        res.json({ 
          success: false, 
          message: 'Waiting for more parts',
          morePartsExpected: true,
          partsCollected: multiPart.messages.length,
          partsDelivered: multiPart.nextPartIndex || 0,
          timestamp: waitingTimestamp
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
      nextPartIndex: value.nextPartIndex || 0,
      messages: value.messages.map(msg => ({ 
        text: msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : ''),
        timestamp: msg.timestamp,
        receivedAt: msg.receivedAt,
        partIndex: msg.partIndex,
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

const PORT = process.env.PORT;
app.listen(PORT, () => {
}); 