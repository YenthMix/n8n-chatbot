/**
 * backend.js
 * Backend server for Botpress Chat API integration
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
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
  
  if (!conversationId || !text) {
    return res.status(400).json({ error: 'Missing conversationId or text' });
  }
  
  // Clean up any previous state for this conversation before tracking new message
  
  // Clear any existing bot messages for this conversation
  if (botMessages.has(conversationId)) {
    const oldConversationData = botMessages.get(conversationId);
    // Clear any pending timeout
    if (oldConversationData && oldConversationData.deliveryTimeoutId) {
      clearTimeout(oldConversationData.deliveryTimeoutId);
    }
    botMessages.delete(conversationId);
  }
  
  // Also clear global storage for this conversation
  if (globalMessages[conversationId]) {
    delete globalMessages[conversationId];
  }
  
  // Store user message with timestamp to track what the user actually sent
  userMessages.set(conversationId, {
    text: text,
    timestamp: Date.now(),
    trackedAt: userTrackingTimestamp
  });
  
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
      const body = req.body;
      let conversationId, botText, isBot, botImage;
      
      // Try multiple extraction patterns
      if (body.body && body.body.data) {
        // N8N sends: { body: { data: { conversationId, payload: { text, image }, isBot } } }
        conversationId = body.body.data.conversationId;
        botText = body.body.data.payload?.text || body.body.data.text;
        botImage = body.body.data.payload?.image || body.body.data.payload?.imageUrl || body.body.data.image || body.body.data.imageUrl;
        isBot = body.body.data.isBot;
      } else if (body.conversationId) {
        // Direct structure: { conversationId, payload: { text, image }, isBot }
        conversationId = body.conversationId;
        botText = body.payload?.text || body.text;
        botImage = body.payload?.image || body.payload?.imageUrl || body.image || body.imageUrl;
        isBot = body.isBot;
      } else if (body.text || body.image || body.imageUrl) {
        // Simple text/image structure
        botText = body.text;
        botImage = body.image || body.imageUrl;
        isBot = body.isBot;
      }
      
      // Use the isBot field from N8N to determine if we should display this message
      // Handle both boolean and string values for isBot
      const isBotMessage = isBot === true || isBot === "true";
      const isUserMessage = isBot === false || isBot === "false";
      
      if (isBotMessage) {
        const botMessageTimestamp = new Date().toISOString();
        
        if (conversationId && (botText || botImage) && (!botText || !botText.includes('{{ $json'))) {
          
          // SIMPLE FIX: Use both Map and global object to prevent race conditions
          if (!globalMessages[conversationId]) {
            globalMessages[conversationId] = [];
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
          
          // CRITICAL FIX: Use SHARED timeout for the conversation, not per-message timeout
          // Clear any existing timeout - this is the key fix
          if (global.conversationTimeouts && global.conversationTimeouts[conversationId]) {
            clearTimeout(global.conversationTimeouts[conversationId]);
          }
          
          // Initialize global timeouts if not exists
          if (!global.conversationTimeouts) {
            global.conversationTimeouts = {};
          }
          
          // Set ONE timeout per conversation that gets reset with each new message
          global.conversationTimeouts[conversationId] = setTimeout(() => {
            // Use global storage for final count and delivery
            const finalMessages = globalMessages[conversationId] || [];
            
            // Sort all messages by timestamp for final delivery
            finalMessages.sort((a, b) => a.timestamp - b.timestamp);
            
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
            
            // Clean up the tracked user message since we got bot response(s)
            userMessages.delete(conversationId);
            
            // Clean up the global timeout
            delete global.conversationTimeouts[conversationId];
            
          }, 6000); // Wait 6 seconds after last message before delivering all (increased for larger message sets)
          
        }
      } else if (isUserMessage) {
        // Don't store user messages, they're already displayed by the frontend
      } else {
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
            
            // Set timeout for fallback delivery as well
            if (conversationData.deliveryTimeoutId) {
              clearTimeout(conversationData.deliveryTimeoutId);
            }
            
            conversationData.deliveryTimeoutId = setTimeout(() => {
              conversationData.allMessagesReceived = true;
              conversationData.deliveryTimeoutId = null;
            }, 6000);
            
            userMessages.delete(conversationId);
          }
        }
      }
      
      // Clean up old messages and user messages (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      
      for (const [key, value] of botMessages.entries()) {
        // Don't clean up conversations that are still receiving messages
        if (!value.allMessagesReceived && value.deliveryTimeoutId) {
          continue;
        }
        
        // Remove messages older than 5 minutes
        const filteredMessages = value.messages.filter(msg => msg.timestamp >= fiveMinutesAgo);
        if (filteredMessages.length !== value.messages.length) {
          value.messages = filteredMessages;
        }
        // Remove empty conversation data
        if (value.messages.length === 0) {
          // Clear timeout before removing conversation
          if (value.deliveryTimeoutId) {
            clearTimeout(value.deliveryTimeoutId);
        }
          botMessages.delete(key);
        }
      }
      
      if (beforeCleanup > 0 && afterCleanup === 0) {
      }
      for (const [key, value] of userMessages.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
          userMessages.delete(key);
        }
      }
      for (const [key, value] of webhookQueue.entries()) {
        if (value.lastUpdate < fiveMinutesAgo) {
          webhookQueue.delete(key);
        }
      }
      
    } catch (error) {
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
      
      // Check if we're still collecting messages (timeout exists)
      const stillCollecting = global.conversationTimeouts && global.conversationTimeouts[conversationId];
      
      conversationData = {
        messages: globalMessages[conversationId],
        allMessagesReceived: !stillCollecting, // Only complete if no timeout running
        lastDelivered: 0,
        deliveryTimeoutId: null
      };
      
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
          
          res.json({ 
            success: true, 
            messages: undeliveredMessages
          });
        } else {
          console.log(`❌ ALL MESSAGES ALREADY DELIVERED for conversation: ${conversationId}`);
          res.json({ 
            success: false, 
            message: 'All messages already delivered' 
          });
        }
      } else {
        // N8N still sending messages - wait for completion
        const timeoutExists = global.conversationTimeouts && global.conversationTimeouts[conversationId];
        res.json({ 
          success: false, 
          message: 'Still collecting messages from n8n',
          messagesReceived: conversationData.messages.length,
          timeoutActive: !!timeoutExists
        });
      }
    } else {
      console.log(`❌ NO BOT MESSAGES FOUND for conversation: ${conversationId}`);
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
  // Clear all maps
  botMessages.clear();
  userMessages.clear();
  webhookQueue.clear();
  
  res.json({ 
    success: true,
    message: 'All state cleared',
    clearedCounts: {
      botMessages: botMessages.size,
      userMessages: userMessages.size,
      totalBotMessages: Array.from(botMessages.values()).reduce((total, conv) => total + conv.messages.length, 0)
    },
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
    
    try {
      const registerRes = await axios.put('https://api.botpress.cloud/v1/files', {
        key: fileKey,
        contentType: req.file.mimetype,
        size: req.file.size,
        index: true,
        accessPolicies: ['public_content'],
        tags: {
          uploadedBy: 'webchat',
          originalName: req.file.originalname
        }
      }, {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'x-bot-id': BOT_ID,
          'Content-Type': 'application/json'
        }
      });

      const registerData = registerRes.data;
      const fileObj = registerData.file || registerData;
      const uploadUrl = fileObj.uploadUrl;
      const fileId = fileObj.id;
      if (!uploadUrl || !fileId) {
        throw new Error('No uploadUrl or fileId in Botpress response');
      }
      console.log(`✅ File metadata registered. File ID: ${fileId}, Upload URL: ${uploadUrl}`);

      // Step 2: Upload file content to uploadUrl
      const uploadRes = await axios.put(uploadUrl, fs.readFileSync(req.file.path), {
        headers: {
          'Content-Type': req.file.mimetype
        }
      });
      console.log(`✅ File content uploaded to storage.`);

      // Step 3: Add file to knowledge base
      console.log(`📚 Adding file to knowledge base...`);
      
      // First, let's check what knowledge bases are available
      console.log(`🔍 Checking available knowledge bases...`);
      let knowledgeBaseId = null;
      
      try {
        // Try to list knowledge bases
        const kbListResponse = await axios.get('https://api.botpress.cloud/v1/knowledge-bases', {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (kbListResponse.data && kbListResponse.data.length > 0) {
          // Use the first available knowledge base
          knowledgeBaseId = kbListResponse.data[0].id;
          console.log(`✅ Found knowledge base: ${knowledgeBaseId}`);
        } else {
          console.log(`⚠️ No knowledge bases found, trying to create one...`);
          // Try to create a knowledge base
          const createKbResponse = await axios.post('https://api.botpress.cloud/v1/knowledge-bases', {
            name: 'Documents',
            description: 'Knowledge base for uploaded documents'
          }, {
            headers: {
              'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          
          knowledgeBaseId = createKbResponse.data.id;
          console.log(`✅ Created new knowledge base: ${knowledgeBaseId}`);
        }
      } catch (error) {
        // Fall back to the hardcoded ID
        knowledgeBaseId = 'kb-bfdcb1988f';
        console.log(`🔄 Falling back to hardcoded knowledge base ID: ${knowledgeBaseId}`);
      }
      
      console.log(`🔍 DEBUG - Knowledge Base API call:`);
      console.log(`   URL: https://api.botpress.cloud/v3/knowledge-bases/${knowledgeBaseId}/documents`);
      console.log(`   Authorization: Bearer ${BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'}`);
      console.log(`   x-bot-id: ${BOT_ID}`);
      console.log(`   Request body:`, {
        name: req.file.originalname,
        type: 'file',
        fileId: fileId,
        workspaceId: WORKSPACE_ID
      });

      const knowledgeBaseResponse = await axios.post(`https://api.botpress.cloud/v3/knowledge-bases/${knowledgeBaseId}/documents`, {
        name: req.file.originalname,
        type: 'file',
        fileId: fileId,
        workspaceId: WORKSPACE_ID
      }, {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'x-bot-id': BOT_ID,
          'Content-Type': 'application/json'
        }
      });

      const kbData = knowledgeBaseResponse.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`${error.response.status} - ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        throw new Error('No response received from server');
      } else {
        throw new Error(`Request error: ${error.message}`);
      }
    }
    console.log(`✅ File added to knowledge base successfully! Document ID: ${kbData.id || 'N/A'}`);

    // Clean up temporary file
    fs.unlinkSync(req.file.path);

    res.json({ 
      success: true, 
      message: 'File uploaded to knowledge base successfully',
      fileId: fileId,
      documentId: kbData.id,
      fileName: req.file.originalname
    });
  } catch (error) {
    // Clean up temporary file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ 
      error: error.message || 'Failed to upload file to knowledge base' 
    });
  }
});

// Comprehensive Knowledge Base API diagnostic
app.get('/api/test-kb-comprehensive', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Get bot configuration to see if knowledge base is configured
    try {
      const botConfigResponse = await axios.get(`https://api.botpress.cloud/v1/bots/${BOT_ID}`, {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      results.botConfig = { status: botConfigResponse.status, data: botConfigResponse.data };
    } catch (error) {
      results.botConfig = { error: error.response?.status || error.message };
    }
    
    // Test 2: Try different API versions
    const apiVersions = ['v1', 'v2', 'v3'];
    for (const version of apiVersions) {
      try {
        const response = await axios.get(`https://api.botpress.cloud/${version}/knowledge-bases`, {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        results[`api${version}`] = { status: response.status, data: response.data };
      } catch (error) {
        results[`api${version}`] = { error: error.response?.status || error.message };
      }
    }
    
    // Test 3: Try different endpoint patterns
    const patterns = [
      'https://api.botpress.cloud/v1/knowledge-bases',
      'https://api.botpress.cloud/v1/knowledge-base',
      'https://api.botpress.cloud/v1/knowledgebases',
      'https://api.botpress.cloud/v1/knowledgebase',
      'https://api.botpress.cloud/v3/knowledge-bases',
      'https://api.botpress.cloud/v3/knowledge-base',
      'https://api.botpress.cloud/v3/knowledgebases',
      'https://api.botpress.cloud/v3/knowledgebase',
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-bases`,
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-base`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/knowledge-bases`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/knowledge-base`,
      `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-bases`,
      `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-base`,
      `https://api.botpress.cloud/v3/workspaces/${WORKSPACE_ID}/knowledge-bases`,
      `https://api.botpress.cloud/v3/workspaces/${WORKSPACE_ID}/knowledge-base`
    ];
    
    for (let i = 0; i < patterns.length; i++) {
      try {
        const response = await axios.get(patterns[i], {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        results[`pattern${i + 1}`] = { status: response.status, data: response.data };
      } catch (error) {
        results[`pattern${i + 1}`] = { error: error.response?.status || error.message };
      }
    }
    
    // Test 4: Try with different headers
    const headerTests = [
      { name: 'with-bot-id', headers: { 'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`, 'x-bot-id': BOT_ID, 'Content-Type': 'application/json' } },
      { name: 'with-workspace-id', headers: { 'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`, 'x-workspace-id': WORKSPACE_ID, 'Content-Type': 'application/json' } },
      { name: 'with-both-ids', headers: { 'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`, 'x-bot-id': BOT_ID, 'x-workspace-id': WORKSPACE_ID, 'Content-Type': 'application/json' } },
      { name: 'minimal-headers', headers: { 'Authorization': `Bearer ${BOTPRESS_API_TOKEN}` } }
    ];
    
    for (let i = 0; i < headerTests.length; i++) {
      try {
        const response = await axios.get('https://api.botpress.cloud/v1/knowledge-bases', {
          headers: headerTests[i].headers
        });
        results[`headers${i + 1}`] = { status: response.status, data: response.data, headers: headerTests[i].name };
      } catch (error) {
        results[`headers${i + 1}`] = { error: error.response?.status || error.message, headers: headerTests[i].name };
      }
    }
    
    // Test 5: Check if knowledge base exists by trying to get specific KB
    const kbIds = ['kb-bfdcb1988f', 'bfdcb1988f', 'kb-bfdcb1988f-documents', 'bfdcb1988f-documents'];
    const apiVersionsForKb = ['v1', 'v3'];
    
    for (const version of apiVersionsForKb) {
      for (let i = 0; i < kbIds.length; i++) {
        const kbId = kbIds[i];
        const testKey = `kbId_${version}_${i + 1}`;
        try {
          const response = await axios.get(`https://api.botpress.cloud/${version}/knowledge-bases/${kbId}`, {
            headers: {
              'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          results[testKey] = { status: response.status, data: response.data, kbId, version };
        } catch (error) {
          results[testKey] = { error: error.response?.status || error.message, kbId, version };
        }
      }
    }
    
    res.json({ 
      success: true,
      message: 'Comprehensive Knowledge Base API diagnostic completed',
      results: results,
      config: {
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Advanced Knowledge Base Discovery
app.get('/api/discover-kb', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Check if knowledge base is accessed through different paths
    const alternativePaths = [
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/config`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/config`,
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/settings`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/settings`,
      `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/bots/${BOT_ID}`,
      `https://api.botpress.cloud/v3/workspaces/${WORKSPACE_ID}/bots/${BOT_ID}`,
      `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/config`,
      `https://api.botpress.cloud/v3/workspaces/${WORKSPACE_ID}/config`
    ];
    
    for (let i = 0; i < alternativePaths.length; i++) {
      try {
        const response = await axios.get(alternativePaths[i], {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        results[`altPath${i + 1}`] = { status: response.status, data: response.data, path: alternativePaths[i] };
      } catch (error) {
        results[`altPath${i + 1}`] = { error: error.response?.status || error.message, path: alternativePaths[i] };
      }
    }
    
    // Test 2: Try different knowledge base endpoint structures
    const kbEndpoints = [
      `https://api.botpress.cloud/v1/knowledge-bases/kb-bfdcb1988f`,
      `https://api.botpress.cloud/v3/knowledge-bases/kb-bfdcb1988f`,
      `https://api.botpress.cloud/v1/knowledge-bases/bfdcb1988f`,
      `https://api.botpress.cloud/v3/knowledge-bases/bfdcb1988f`,
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-bases/kb-bfdcb1988f`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/knowledge-bases/kb-bfdcb1988f`,
      `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-bases/kb-bfdcb1988f`,
      `https://api.botpress.cloud/v3/workspaces/${WORKSPACE_ID}/knowledge-bases/kb-bfdcb1988f`
    ];
    
    for (let i = 0; i < kbEndpoints.length; i++) {
      try {
        const response = await axios.get(kbEndpoints[i], {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        results[`kbEndpoint${i + 1}`] = { status: response.status, data: response.data, endpoint: kbEndpoints[i] };
      } catch (error) {
        results[`kbEndpoint${i + 1}`] = { error: error.response?.status || error.message, endpoint: kbEndpoints[i] };
      }
    }
    
    // Test 3: Try to find knowledge base through bot's modules or features
    const moduleEndpoints = [
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/modules`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/modules`,
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/features`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/features`,
      `https://api.botpress.cloud/v1/bots/${BOT_ID}/integrations`,
      `https://api.botpress.cloud/v3/bots/${BOT_ID}/integrations`
    ];
    
    for (let i = 0; i < moduleEndpoints.length; i++) {
      try {
        const response = await axios.get(moduleEndpoints[i], {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        results[`moduleEndpoint${i + 1}`] = { status: response.status, data: response.data, endpoint: moduleEndpoints[i] };
      } catch (error) {
        results[`moduleEndpoint${i + 1}`] = { error: error.response?.status || error.message, endpoint: moduleEndpoints[i] };
      }
    }
    
    res.json({ 
      success: true,
      message: 'Advanced Knowledge Base Discovery completed',
      results: results,
      config: {
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Quick Bot Configuration Check
app.get('/api/check-bot-config', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Get basic bot info
    try {
      const botResponse = await axios.get(`https://api.botpress.cloud/v1/bots/${BOT_ID}`, {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      results.botInfo = { status: botResponse.status, data: botResponse.data };
    } catch (error) {
      results.botInfo = { error: error.response?.status || error.message };
    }
    
    // Test 2: Check if knowledge base is mentioned in bot config
    if (results.botInfo && results.botInfo.data) {
      const botData = results.botInfo.data;
      const kbInfo = {
        hasKnowledgeBase: false,
        knowledgeBaseId: null,
        knowledgeBaseConfig: null,
        modules: null,
        features: null
      };
      
      // Check for knowledge base in various possible locations
      if (botData.knowledgeBase) {
        kbInfo.hasKnowledgeBase = true;
        kbInfo.knowledgeBaseConfig = botData.knowledgeBase;
      }
      if (botData.knowledgeBaseId) {
        kbInfo.hasKnowledgeBase = true;
        kbInfo.knowledgeBaseId = botData.knowledgeBaseId;
      }
      if (botData.modules) {
        kbInfo.modules = botData.modules;
        // Check if knowledge base is in modules
        if (botData.modules.some(module => module.name === 'knowledge-base' || module.type === 'knowledge-base')) {
          kbInfo.hasKnowledgeBase = true;
        }
      }
      if (botData.features) {
        kbInfo.features = botData.features;
        // Check if knowledge base is in features
        if (botData.features.some(feature => feature.name === 'knowledge-base' || feature.type === 'knowledge-base')) {
          kbInfo.hasKnowledgeBase = true;
        }
      }
      
      results.knowledgeBaseAnalysis = kbInfo;
    }
    
    // Test 3: Try to get workspace info
    try {
      const workspaceResponse = await axios.get(`https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}`, {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      results.workspaceInfo = { status: workspaceResponse.status, data: workspaceResponse.data };
    } catch (error) {
      results.workspaceInfo = { error: error.response?.status || error.message };
    }
    
    res.json({ 
      success: true,
      message: 'Quick Bot Configuration Check completed',
      results: results,
      config: {
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Comprehensive API Discovery
app.get('/api/discover-apis', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Check what APIs are available
    const apiEndpoints = [
      // Core APIs
      { name: 'files', url: 'https://api.botpress.cloud/v1/files' },
      { name: 'bots', url: `https://api.botpress.cloud/v1/bots/${BOT_ID}` },
      { name: 'workspaces', url: `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}` },
      { name: 'users', url: 'https://api.botpress.cloud/v1/users/me' },
      
      // Knowledge Base APIs (v1)
      { name: 'kb_list_v1', url: 'https://api.botpress.cloud/v1/knowledge-bases' },
      { name: 'kb_create_v1', url: 'https://api.botpress.cloud/v1/knowledge-bases', method: 'POST' },
      
      // Knowledge Base APIs (v3)
      { name: 'kb_list_v3', url: 'https://api.botpress.cloud/v3/knowledge-bases' },
      { name: 'kb_create_v3', url: 'https://api.botpress.cloud/v3/knowledge-bases', method: 'POST' },
      
      // Alternative knowledge base endpoints
      { name: 'kb_bot_v1', url: `https://api.botpress.cloud/v1/bots/${BOT_ID}/knowledge-bases` },
      { name: 'kb_workspace_v1', url: `https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}/knowledge-bases` },
      
      // Other potential APIs
      { name: 'conversations', url: 'https://api.botpress.cloud/v1/conversations' },
      { name: 'messages', url: 'https://api.botpress.cloud/v1/messages' },
      { name: 'integrations', url: 'https://api.botpress.cloud/v1/integrations' },
      { name: 'modules', url: `https://api.botpress.cloud/v1/bots/${BOT_ID}/modules` },
      { name: 'features', url: `https://api.botpress.cloud/v1/bots/${BOT_ID}/features` }
    ];
    
    for (const endpoint of apiEndpoints) {
      try {
        const config = {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        };
        
        let response;
        if (endpoint.method === 'POST') {
          response = await axios.post(endpoint.url, {}, config);
        } else {
          response = await axios.get(endpoint.url, config);
        }
        
        results[endpoint.name] = { 
          status: response.status, 
          success: true,
          data: response.data,
          url: endpoint.url
        };
      } catch (error) {
        results[endpoint.name] = { 
          error: error.response?.status || error.message,
          success: false,
          url: endpoint.url
        };
      }
    }
    
    // Test 2: Check subscription/plan info
    try {
      const subscriptionResponse = await axios.get('https://api.botpress.cloud/v1/subscription', {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      results.subscription = { status: subscriptionResponse.status, data: subscriptionResponse.data };
    } catch (error) {
      results.subscription = { error: error.response?.status || error.message };
    }
    
    // Test 3: Check what features are available
    try {
      const featuresResponse = await axios.get('https://api.botpress.cloud/v1/features', {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      results.features = { status: featuresResponse.status, data: featuresResponse.data };
    } catch (error) {
      results.features = { error: error.response?.status || error.message };
    }
    
    res.json({ 
      success: true,
      message: 'Comprehensive API Discovery completed',
      results: results,
      summary: {
        workingApis: Object.keys(results).filter(key => results[key].success),
        failingApis: Object.keys(results).filter(key => !results[key].success),
        totalApis: Object.keys(results).length
      },
      config: {
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        tokenPreview: BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Test specific token endpoint
app.get('/api/test-specific-token', async (req, res) => {
  try {
    const testToken = req.query.token || BOTPRESS_API_TOKEN;
    
    const results = {};
    
    // Test 1: Files API
    const filesResponse = await fetch('https://api.botpress.cloud/v1/files', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`,
        'x-bot-id': BOT_ID,
        'Content-Type': 'application/json'
      }
    });
    results.files = { status: filesResponse.status, ok: filesResponse.ok };
    
    // Test 2: Knowledge Bases
    const kbResponse = await fetch('https://api.botpress.cloud/v1/knowledge-bases', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`,
        'Content-Type': 'application/json'
      }
    });
    results.knowledgeBases = { status: kbResponse.status, ok: kbResponse.ok, data: kbResponse.ok ? await kbResponse.json() : null };
    
    // Test 3: User info
    const userResponse = await fetch('https://api.botpress.cloud/v1/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`,
        'Content-Type': 'application/json'
      }
    });
    results.user = { status: userResponse.status, ok: userResponse.ok, data: userResponse.ok ? await userResponse.json() : null };
    
    res.json({ 
      success: true,
      message: 'Specific token test completed',
      results: results,
      tokenPreview: testToken ? testToken.substring(0, 20) + '...' : 'NOT SET'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Test token permissions endpoint
app.get('/api/test-permissions', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Files API (we know this works)
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
    const userResponse = await fetch('https://api.botpress.cloud/v1/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.user = { status: userResponse.status, ok: userResponse.ok, data: userResponse.ok ? await userResponse.json() : null };
    
    // Test 3: Try to get workspace info
    const workspaceResponse = await fetch(`https://api.botpress.cloud/v1/workspaces/${WORKSPACE_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.workspace = { status: workspaceResponse.status, ok: workspaceResponse.ok, data: workspaceResponse.ok ? await workspaceResponse.json() : null };
    
    // Test 4: Try to get bot info
    const botResponse = await fetch(`https://api.botpress.cloud/v1/bots/${BOT_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    results.bot = { status: botResponse.status, ok: botResponse.ok, data: botResponse.ok ? await botResponse.json() : null };
    
    // Test 5: Try different knowledge base endpoint structures
    
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
    console.log(`   Token: ${BOTPRESS_API_TOKEN ? BOTPRESS_API_TOKEN.substring(0, 20) + '...' : 'NOT SET'}`);
    console.log(`   Bot ID: ${BOT_ID}`);
    console.log(`   Workspace ID: ${WORKSPACE_ID}`);
    
    const results = {};
    
    // Test 1: Check knowledge base info
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
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Global error handler to prevent bad gateway errors
app.use((err, req, res, next) => {
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Server error', 
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test Knowledge Base API structure
app.get('/api/test-kb-structure', async (req, res) => {
  try {
    const results = {};
    
    // Test 1: Try to list knowledge bases first
    try {
      const kbListResponse = await axios.get('https://api.botpress.cloud/v1/knowledge-bases', {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'x-bot-id': BOT_ID,
          'Content-Type': 'application/json'
        }
      });
      results.kbList = { status: kbListResponse.status, data: kbListResponse.data };
    } catch (error) {
      results.kbList = { error: error.response?.status || error.message };
    }
    
    
    for (let i = 0; i < testEndpoints.length; i++) {
      try {
        const response = await axios.get(testEndpoints[i], {
          headers: {
            'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
            'x-bot-id': BOT_ID,
            'Content-Type': 'application/json'
          }
        });
        results[`endpoint${i + 2}`] = { status: response.status, data: response.data };
      } catch (error) {
        results[`endpoint${i + 2}`] = { error: error.response?.status || error.message };
      }
    }
    
    res.json({ 
      success: true,
      message: 'Knowledge Base API structure test completed',
      results: results
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});