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
  origin: true, // Allow all origins temporarily
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-key']
}));

app.use(express.json());

// Load secrets from .env file
const API_ID = process.env.API_ID;
const BASE_URL = `https://chat.botpress.cloud/${API_ID}`;

console.log('🤖 Botpress Backend Server Starting...');
console.log('📡 API_ID:', API_ID);

// Store bot responses temporarily (in production, use Redis or database)
const botResponses = new Map();

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
    console.error('Error creating user:', err);
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
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/message', async (req, res) => {
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
    console.error('Error sending message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  const { conversationId, userKey } = req.query;
  try {
    const response = await fetch(`${BASE_URL}/conversations/${conversationId}/messages`, {
      headers: {
        'accept': 'application/json',
        'x-user-key': userKey
      }
    });
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/botpress-webhook', async (req, res) => {
  try {
    console.log('🔄 Webhook received from N8N:');
    console.log('📋 Full request body:', JSON.stringify(req.body, null, 2));
    
    const body = req.body;
    let conversationId, botText;
    
    // Extract data based on the actual N8N structure we see
    if (body.body && body.body.data) {
      // N8N sends: { body: { data: { conversationId, payload: { text } } } }
      conversationId = body.body.data.conversationId;
      botText = body.body.data.payload?.text;
    } else if (body.conversationId) {
      // Direct structure: { conversationId, payload: { text } }
      conversationId = body.conversationId;
      botText = body.payload?.text;
    } else {
      console.log('❌ Unknown data structure');
    }
    
    console.log('🔍 Extracted values:');
    console.log('  - conversationId:', conversationId);
    console.log('  - botText:', botText);
    
    if (conversationId && botText && !botText.includes('{{ $json')) {
      console.log(`✅ Bot response received for conversation ${conversationId}:`, botText);
      
      // Store the bot response so the frontend can retrieve it
      botResponses.set(conversationId, {
        text: botText,
        timestamp: Date.now(),
        id: `bot-${Date.now()}`
      });
      
      // Clean up old responses (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      for (const [key, value] of botResponses.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
          botResponses.delete(key);
        }
      }
      
      console.log('💾 Stored bot response for frontend polling');
    } else {
      console.log('⚠️ No valid bot response to store');
    }
    
    res.json({ 
      success: true,
      conversationId: conversationId,
      message: 'Bot response received and stored',
      received: true
    });
  } catch (error) {
    console.error('❌ Webhook error:', error);
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
      console.log(`📤 Sending bot response to frontend for conversation ${conversationId}`);
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
    console.error('❌ Error getting bot response:', error);
    res.status(500).json({ error: 'Failed to get bot response' });
  }
});

app.get('/api/botpress-webhook', async (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log('🚀 Backend server running on port', PORT);
}); 