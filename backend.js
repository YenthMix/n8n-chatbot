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

// Store incoming messages temporarily to compare lengths (2 messages per conversation)
const pendingMessages = new Map();

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
  try {
    const { conversationId, userKey } = req.query;
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
    
    const body = req.body;
    let conversationId, messageText;
    
    // Try multiple extraction patterns
    if (body.body && body.body.data) {
      // N8N sends: { body: { data: { conversationId, payload: { text } } } }
      conversationId = body.body.data.conversationId;
      messageText = body.body.data.payload?.text || body.body.data.text;
      console.log('📍 Using body.body.data pattern');
    } else if (body.conversationId) {
      // Direct structure: { conversationId, payload: { text } }
      conversationId = body.conversationId;
      messageText = body.payload?.text || body.text;
      console.log('📍 Using body.conversationId pattern');
    } else if (body.text) {
      // Simple text structure
      messageText = body.text;
      console.log('📍 Using body.text pattern');
    }
    
    console.log(`🔍 Extracted: conversationId="${conversationId}", text="${messageText}"`);
    
    if (conversationId && messageText && !messageText.includes('{{ $json')) {
      
      // Get or create pending messages array for this conversation
      if (!pendingMessages.has(conversationId)) {
        pendingMessages.set(conversationId, []);
      }
      
      const messages = pendingMessages.get(conversationId);
      
      // Add the new message with timestamp
      messages.push({
        text: messageText,
        timestamp: Date.now(),
        length: messageText.length
      });
      
      console.log(`📝 Added message (length: ${messageText.length}): "${messageText}"`);
      console.log(`📊 Total messages for conversation ${conversationId}: ${messages.length}`);
      
      // If we have 2 messages, compare lengths and determine bot response
      if (messages.length >= 2) {
        console.log('🔍 COMPARING 2 MESSAGES:');
        
        // Sort messages by length (longest first)
        const sortedMessages = messages.sort((a, b) => b.length - a.length);
        
        const longerMessage = sortedMessages[0];
        const shorterMessage = sortedMessages[1];
        
        console.log(`   Longer message (${longerMessage.length} chars): "${longerMessage.text}"`);
        console.log(`   Shorter message (${shorterMessage.length} chars): "${shorterMessage.text}"`);
        
        // The longer message is always the bot response
        console.log(`💾 STORING BOT RESPONSE (longer message): "${longerMessage.text}"`);
        
        botResponses.set(conversationId, {
          text: longerMessage.text,
          timestamp: longerMessage.timestamp,
          id: `bot-${longerMessage.timestamp}`
        });
        
        // Clear pending messages for this conversation
        pendingMessages.delete(conversationId);
        
        console.log('✅ Bot response stored successfully, pending messages cleared');
      } else {
        console.log(`⏳ Waiting for second message (have ${messages.length}/2)`);
      }
      
      // Clean up old pending messages and bot responses (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      
      for (const [key, messageArray] of pendingMessages.entries()) {
        if (messageArray.length > 0 && messageArray[0].timestamp < fiveMinutesAgo) {
          pendingMessages.delete(key);
          console.log(`🧹 Cleaned up old pending messages for conversation: ${key}`);
        }
      }
      
      for (const [key, value] of botResponses.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
          botResponses.delete(key);
          console.log(`🧹 Cleaned up old bot response for conversation: ${key}`);
        }
      }
    }
    
    res.json({ 
      success: true,
      conversationId: conversationId,
      message: messageText,
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

// Debug endpoint to see what's stored
app.get('/api/debug/stored-responses', async (req, res) => {
  const allResponses = {};
  const allPendingMessages = {};
  
  for (const [key, value] of botResponses.entries()) {
    allResponses[key] = value;
  }
  
  for (const [key, value] of pendingMessages.entries()) {
    allPendingMessages[key] = value;
  }
  
  console.log('🔍 DEBUG ENDPOINT CALLED - Current storage state:');
  console.log(`   Bot responses: ${botResponses.size} stored`);
  console.log(`   Pending messages: ${pendingMessages.size} conversations`);
  
  res.json({ 
    totalBotResponses: botResponses.size,
    totalPendingConversations: pendingMessages.size,
    botResponses: allResponses,
    pendingMessages: allPendingMessages,
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
}); 