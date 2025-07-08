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
    console.log('TRACKING USER MESSAGE:', { conversationId, text });
    
    // Store user message temporarily (5 minutes)
    userMessages.set(conversationId, {
      text: text,
      timestamp: Date.now()
    });
    
    console.log('USER MESSAGE STORED. Total stored:', userMessages.size);
    
    res.json({ success: true });
  } catch (err) {
    console.log('ERROR tracking user message:', err.message);
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
      conversationId = body.body.data.conversationId;
      botText = body.body.data.payload?.text || body.body.data.text;
    } else if (body.conversationId) {
      conversationId = body.conversationId;
      botText = body.payload?.text || body.text;
    } else if (body.text) {
      botText = body.text;
    }
    
    if (conversationId && botText && !botText.includes('{{ $json')) {
      const storedUserMessage = userMessages.get(conversationId);
      
      console.log('WEBHOOK:', {
        text: botText,
        stored: storedUserMessage?.text,
        different: storedUserMessage ? botText.trim() !== storedUserMessage.text.trim() : 'no stored message'
      });
      
      if (storedUserMessage) {
        if (botText.trim() !== storedUserMessage.text.trim()) {
          console.log('STORING BOT RESPONSE:', botText);
          botResponses.set(conversationId, {
            text: botText,
            timestamp: Date.now(),
            id: `msg-${Date.now()}`,
            isBot: true
          });
        } else {
          console.log('IGNORING USER ECHO:', botText);
        }
      } else {
        console.log('NO STORED USER MESSAGE FOR:', conversationId);
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// New endpoint for frontend to get bot responses
app.get('/api/bot-response/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const response = botResponses.get(conversationId);
    
    if (response) {
      // ONLY return if it's a bot message AND old enough (2 seconds)
      const messageAge = Date.now() - response.timestamp;
      const isActuallyBot = response.isBot === true;
      
      console.log('DEBUG: Checking response:', {
        text: response.text,
        isBot: response.isBot,
        isActuallyBot,
        age: messageAge
      });
      
      if (isActuallyBot && messageAge >= 2000) {
        // Remove the response after sending it to prevent duplicates
        botResponses.delete(conversationId);
        res.json({ 
          success: true, 
          response: response 
        });
      } else {
        res.json({ 
          success: false, 
          message: isActuallyBot ? 'Response too recent' : 'Not a bot message'
        });
      }
    } else {
      res.json({ 
        success: false, 
        message: 'No response available' 
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