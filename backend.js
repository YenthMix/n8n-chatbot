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
const botResponses = new Map();// Track user messages to ignore them when they come back from N8N
const userMessages = new Map();

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

// Track user messages so we can ignore them when they come back from N8N
app.post('/api/track-user-message', async (req, res) => {
  const { conversationId, text } = req.body;
  try {
    // Store user message temporarily (5 minutes)
    userMessages.set(conversationId, {
      text: text,
      timestamp: Date.now()
    });
    
    // Clean up old user messages
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [key, value] of userMessages.entries()) {
      if (value.timestamp < fiveMinutesAgo) {
        userMessages.delete(key);
      }
    }
    
    res.json({ success: true });
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
      // Only return if message is at least 2 seconds old (ensuring both webhook calls completed)
      const messageAge = Date.now() - storedResponse.timestamp;
      
      if (messageAge >= 2000) {
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
    const body = req.body;
    let conversationId, botText;
    
    // Try multiple extraction patterns
    if (body.body && body.body.data) {
      // N8N sends: { body: { data: { conversationId, payload: { text } } } }
      conversationId = body.body.data.conversationId;
      botText = body.body.data.payload?.text || body.body.data.text;
    } else if (body.conversationId) {
      // Direct structure: { conversationId, payload: { text } }
      conversationId = body.conversationId;
      botText = body.payload?.text || body.text;
    } else if (body.text) {
      // Simple text structure
      botText = body.text;
    }
    
    // Determine if this is a bot response or user message
    const isUserMessage = body.type === 'text' && body.payload && !body.botpressConversationId;
    const isBotResponse = body.botpressConversationId || (body.payload && body.payload.text && body.payload.text !== body.text);
    
    if (conversationId && botText && !botText.includes('{{ $json')) {
      // ONLY store if isBot is true - this is the reliable way to identify bot responses
      if (body.isBot === true) {
        botResponses.set(conversationId, {
          text: botText,
          timestamp: Date.now(),
          id: `bot-${Date.now()}`
        });
      }
      
      // Clean up old responses (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      for (const [key, value] of botResponses.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
          botResponses.delete(key);
        }
      }
    }
    
    res.json({ 
      success: true,
      conversationId: conversationId,
      message: botText,
      received: true
    });
  } catch (error) {
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
      // Only return if message is at least 2 seconds old (ensuring both webhook calls completed)
      const messageAge = Date.now() - botResponse.timestamp;
      
      if (messageAge >= 2000) {
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
  for (const [key, value] of botResponses.entries()) {
    allResponses[key] = value;
  }
  res.json({ 
    totalStored: botResponses.size,
    responses: allResponses,
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
}); 