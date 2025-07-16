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

// Botpress Files API Configuration
const BOTPRESS_BOT_ID = process.env.BOTPRESS_BOT_ID;
const BOTPRESS_WORKSPACE_ID = process.env.BOTPRESS_WORKSPACE_ID;
const BOTPRESS_BEARER_TOKEN = process.env.BOTPRESS_BEARER_TOKEN;
const BOTPRESS_FILES_API_URL = process.env.BOTPRESS_FILES_API_URL;

// Debug environment variables (without exposing sensitive data)
console.log('🔧 Environment Variables Debug:');
console.log(`   BOTPRESS_BOT_ID: ${BOTPRESS_BOT_ID ? 'SET' : 'MISSING'}`);
console.log(`   BOTPRESS_WORKSPACE_ID: ${BOTPRESS_WORKSPACE_ID ? 'SET' : 'MISSING'}`);
console.log(`   BOTPRESS_BEARER_TOKEN: ${BOTPRESS_BEARER_TOKEN ? 'SET' : 'MISSING'}`);
console.log(`   BOTPRESS_FILES_API_URL: ${BOTPRESS_FILES_API_URL ? 'SET' : 'MISSING'}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`   All env vars:`, Object.keys(process.env).filter(key => key.includes('BOTPRESS')));



// Store bot messages separately by timestamp (in production, use Redis or database)
const botMessages = new Map(); // conversationId -> { messages: [...], lastDelivered: timestamp }

// Global message storage to prevent race conditions
const globalMessages = {}; // conversationId -> messages array

// Track user messages to distinguish them from bot responses
const userMessages = new Map();

// Track webhook processing to prevent race conditions
const webhookQueue = new Map(); // conversationId -> processing status

// File Upload Endpoints for Botpress Files API

// Upload file to Botpress (try both Files API and Knowledge Base API)
app.post('/api/upload-file', async (req, res) => {
  try {
    const { name, type, content } = req.body;
    
    if (!name || !type || !content) {
      return res.status(400).json({ error: 'Missing required fields: name, type, content' });
    }
    
    console.log(`📁 Uploading file to Botpress: ${name} (${type})`);
    console.log(`🔑 Using botId: ${BOTPRESS_BOT_ID}, workspaceId: ${BOTPRESS_WORKSPACE_ID}`);
    console.log(`🌐 Upload URL: ${BOTPRESS_FILES_API_URL}`);
    console.log(`📄 Content length: ${content.length} characters`);
    
    // Check if environment variables are properly loaded
    if (!BOTPRESS_BOT_ID || !BOTPRESS_WORKSPACE_ID || !BOTPRESS_BEARER_TOKEN || !BOTPRESS_FILES_API_URL) {
      console.error('❌ Environment variables not properly loaded!');
      return res.status(500).json({ 
        error: 'Server configuration error', 
        message: 'Botpress environment variables are missing. Please check your deployment configuration.' 
      });
    }
    
    const requestBody = {
      name: name,
      type: type,
      content: content,
      botId: BOTPRESS_BOT_ID,
      workspaceId: BOTPRESS_WORKSPACE_ID
    };
    
    console.log('📋 Request body (without content):', { 
      name: requestBody.name, 
      type: requestBody.type, 
      botId: requestBody.botId, 
      workspaceId: requestBody.workspaceId,
      contentLength: requestBody.content.length 
    });
    
    const response = await fetch(BOTPRESS_FILES_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
        'x-bot-id': BOTPRESS_BOT_ID,
        'x-workspace-id': BOTPRESS_WORKSPACE_ID
      },
      body: JSON.stringify(requestBody)
    });
    
    console.log(`📡 Response status: ${response.status} ${response.statusText}`);
    console.log(`📡 Response headers:`, Object.fromEntries(response.headers.entries()));
    
    const data = await response.json();
    console.log('📋 Raw Botpress upload response:', JSON.stringify(data, null, 2));
    
    if (!response.ok) {
      console.error('❌ Botpress Files API failed, trying Knowledge Base API...');
      
      // Try Knowledge Base API as fallback
      try {
        const kbResponse = await fetch('https://api.botpress.cloud/v1/knowledge-bases', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
            'x-bot-id': BOTPRESS_BOT_ID,
            'x-workspace-id': BOTPRESS_WORKSPACE_ID
          },
          body: JSON.stringify({
            name: name,
            type: type,
            content: content,
            botId: BOTPRESS_BOT_ID,
            workspaceId: BOTPRESS_WORKSPACE_ID
          })
        });
        
        const kbData = await kbResponse.json();
        console.log('📋 Knowledge Base API response:', JSON.stringify(kbData, null, 2));
        
        if (kbResponse.ok) {
          console.log('✅ File uploaded successfully via Knowledge Base API:', kbData);
          return res.json({ success: true, file: kbData, method: 'knowledge-base' });
        } else {
          console.error('❌ Knowledge Base API also failed:', kbData);
          return res.status(response.status).json({ 
            error: 'Failed to upload file to Botpress', 
            details: { filesApi: data, knowledgeBaseApi: kbData },
            message: 'Both Files API and Knowledge Base API failed'
          });
        }
      } catch (kbError) {
        console.error('❌ Knowledge Base API error:', kbError);
        return res.status(response.status).json({ 
          error: 'Failed to upload file to Botpress', 
          details: data,
          fallbackError: kbError.message
        });
      }
    }
    
    console.log('✅ File uploaded successfully to Botpress:', data);
    res.json({ success: true, file: data, method: 'files-api' });
    
  } catch (error) {
    console.error('❌ File upload error:', error);
    res.status(500).json({ error: 'File upload failed', message: error.message });
  }
});

// List uploaded files from Botpress (try both Files API and Knowledge Base API)
app.get('/api/files', async (req, res) => {
  try {
    console.log('📂 Fetching files from Botpress...');
    console.log(`🔑 Using botId: ${BOTPRESS_BOT_ID}, workspaceId: ${BOTPRESS_WORKSPACE_ID}`);
    
    // Check if environment variables are properly loaded
    if (!BOTPRESS_BOT_ID || !BOTPRESS_WORKSPACE_ID || !BOTPRESS_BEARER_TOKEN) {
      console.error('❌ Environment variables not properly loaded!');
      return res.status(500).json({ 
        error: 'Server configuration error', 
        message: 'Botpress environment variables are missing.' 
      });
    }
    
    let filesApiSuccess = false;
    let kbApiSuccess = false;
    let filesData = null;
    let kbData = null;
    let filesApiError = null;
    let kbApiError = null;
    
    // Try Files API first
    try {
      const filesApiUrl = `${BOTPRESS_FILES_API_URL}?botId=${BOTPRESS_BOT_ID}&workspaceId=${BOTPRESS_WORKSPACE_ID}`;
      console.log(`🌐 Files API URL: ${filesApiUrl}`);
      
      const filesApiResponse = await fetch(filesApiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          'x-bot-id': BOTPRESS_BOT_ID,
          'x-workspace-id': BOTPRESS_WORKSPACE_ID
        }
      });
      
      console.log(`📡 Files API response: ${filesApiResponse.status} ${filesApiResponse.statusText}`);
      
      if (filesApiResponse.ok) {
        filesData = await filesApiResponse.json();
        console.log('📋 Files API response:', JSON.stringify(filesData, null, 2));
        console.log(`✅ Retrieved ${filesData.files ? filesData.files.length : 0} files via Files API`);
        filesApiSuccess = true;
      } else {
        filesData = await filesApiResponse.json();
        filesApiError = { status: filesApiResponse.status, data: filesData };
        console.log(`❌ Files API failed:`, filesData);
      }
    } catch (error) {
      filesApiError = { error: error.message };
      console.error('❌ Files API error:', error);
    }
    
    // Try Knowledge Base API as fallback
    try {
      const kbApiUrl = `https://api.botpress.cloud/v1/knowledge-bases?botId=${BOTPRESS_BOT_ID}&workspaceId=${BOTPRESS_WORKSPACE_ID}`;
      console.log(`🌐 Knowledge Base API URL: ${kbApiUrl}`);
      
      const kbResponse = await fetch(kbApiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          'x-bot-id': BOTPRESS_BOT_ID,
          'x-workspace-id': BOTPRESS_WORKSPACE_ID
        }
      });
      
      console.log(`📡 Knowledge Base API response: ${kbResponse.status} ${kbResponse.statusText}`);
      
      if (kbResponse.ok) {
        kbData = await kbResponse.json();
        console.log('📋 Knowledge Base API response:', JSON.stringify(kbData, null, 2));
        console.log(`✅ Retrieved ${kbData.knowledgeBases ? kbData.knowledgeBases.length : 0} knowledge bases via Knowledge Base API`);
        kbApiSuccess = true;
      } else {
        kbData = await kbResponse.json();
        kbApiError = { status: kbResponse.status, data: kbData };
        console.log(`❌ Knowledge Base API failed:`, kbData);
      }
    } catch (error) {
      kbApiError = { error: error.message };
      console.error('❌ Knowledge Base API error:', error);
    }
    
    // Return data from whichever API succeeded
    if (filesApiSuccess) {
      return res.json({ ...filesData, method: 'files-api' });
    } else if (kbApiSuccess) {
      // Convert knowledge base format to match files format
      const convertedData = {
        files: kbData.knowledgeBases || [],
        method: 'knowledge-base'
      };
      return res.json(convertedData);
    }
    
    // If both APIs failed, return detailed error
    console.error('❌ Both APIs failed to fetch files');
    return res.status(500).json({ 
      error: 'Failed to fetch files from both APIs', 
      message: 'Could not retrieve files from Botpress',
      details: {
        filesApi: filesApiError,
        knowledgeBaseApi: kbApiError
      }
    });
    
  } catch (error) {
    console.error('❌ Files fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch files', message: error.message });
  }
});

// Delete file from Botpress (try both Files API and Knowledge Base API)
app.delete('/api/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    console.log(`🗑️ Deleting file from Botpress: ${fileId}`);
    
    // Check if environment variables are properly loaded
    if (!BOTPRESS_BOT_ID || !BOTPRESS_WORKSPACE_ID || !BOTPRESS_BEARER_TOKEN) {
      console.error('❌ Environment variables not properly loaded!');
      return res.status(500).json({ 
        error: 'Server configuration error', 
        message: 'Botpress environment variables are missing.' 
      });
    }
    
    let filesApiSuccess = false;
    let kbApiSuccess = false;
    let filesApiError = null;
    let kbApiError = null;
    
    // Try Files API first
    try {
      const filesApiResponse = await fetch(`${BOTPRESS_FILES_API_URL}/${fileId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          'x-bot-id': BOTPRESS_BOT_ID,
          'x-workspace-id': BOTPRESS_WORKSPACE_ID
        }
      });
      
      console.log(`📡 Files API delete response: ${filesApiResponse.status} ${filesApiResponse.statusText}`);
      
      if (filesApiResponse.ok) {
        console.log('✅ File deleted successfully via Files API');
        filesApiSuccess = true;
      } else {
        const filesData = await filesApiResponse.json();
        filesApiError = { status: filesApiResponse.status, data: filesData };
        console.log(`❌ Files API delete failed:`, filesData);
      }
    } catch (error) {
      filesApiError = { error: error.message };
      console.error('❌ Files API delete error:', error);
    }
    
    // Try Knowledge Base API as fallback
    try {
      const kbResponse = await fetch(`https://api.botpress.cloud/v1/knowledge-bases/${fileId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          'x-bot-id': BOTPRESS_BOT_ID,
          'x-workspace-id': BOTPRESS_WORKSPACE_ID
        }
      });
      
      console.log(`📡 Knowledge Base API delete response: ${kbResponse.status} ${kbResponse.statusText}`);
      
      if (kbResponse.ok) {
        console.log('✅ File deleted successfully via Knowledge Base API');
        kbApiSuccess = true;
      } else {
        const kbData = await kbResponse.json();
        kbApiError = { status: kbResponse.status, data: kbData };
        console.log(`❌ Knowledge Base API delete failed:`, kbData);
      }
    } catch (error) {
      kbApiError = { error: error.message };
      console.error('❌ Knowledge Base API delete error:', error);
    }
    
    // Return success if either API succeeded
    if (filesApiSuccess || kbApiSuccess) {
      const method = filesApiSuccess ? 'files-api' : 'knowledge-base';
      console.log(`✅ File deletion successful via ${method}`);
      return res.json({ 
        success: true, 
        message: 'File deleted successfully', 
        method: method,
        details: {
          filesApi: filesApiSuccess ? 'success' : filesApiError,
          knowledgeBaseApi: kbApiSuccess ? 'success' : kbApiError
        }
      });
    }
    
    // If both APIs failed, return detailed error
    console.error('❌ Both APIs failed to delete file');
    return res.status(500).json({ 
      error: 'Failed to delete file from both APIs', 
      message: 'File could not be deleted from Botpress',
      details: {
        filesApi: filesApiError,
        knowledgeBaseApi: kbApiError
      }
    });
    
  } catch (error) {
    console.error('❌ File delete error:', error);
    res.status(500).json({ error: 'Failed to delete file', message: error.message });
  }
});

// Test Botpress API connectivity and find correct workspace
app.get('/api/test-botpress', async (req, res) => {
  try {
    console.log('🧪 Testing Botpress API connectivity...');
    console.log(`🔑 Bot ID: ${BOTPRESS_BOT_ID}`);
    console.log(`🔑 Workspace ID: ${BOTPRESS_WORKSPACE_ID}`);
    console.log(`🔑 Bearer Token: ${BOTPRESS_BEARER_TOKEN.substring(0, 10)}...`);
    console.log(`🌐 API URL: ${BOTPRESS_FILES_API_URL}`);
    
    const results = {};
    
    // Test different approaches to find the correct workspace
    const testCases = [
      {
        name: 'Files API with current workspace',
        method: 'GET',
        url: `${BOTPRESS_FILES_API_URL}?botId=${BOTPRESS_BOT_ID}&workspaceId=${BOTPRESS_WORKSPACE_ID}`
      },
      {
        name: 'Files API without workspace',
        method: 'GET', 
        url: `${BOTPRESS_FILES_API_URL}?botId=${BOTPRESS_BOT_ID}`
      },
      {
        name: 'Files API with empty workspace',
        method: 'GET',
        url: `${BOTPRESS_FILES_API_URL}?botId=${BOTPRESS_BOT_ID}&workspaceId=`
      },
      {
        name: 'Bot info endpoint',
        method: 'GET',
        url: `https://api.botpress.cloud/v1/bots/${BOTPRESS_BOT_ID}`
      },
      {
        name: 'Files API base endpoint',
        method: 'GET',
        url: BOTPRESS_FILES_API_URL
      },
      {
        name: 'Knowledge Base API',
        method: 'GET',
        url: `https://api.botpress.cloud/v1/knowledge-bases?botId=${BOTPRESS_BOT_ID}`
      }
    ];
    
    for (const test of testCases) {
      console.log(`\n🧪 Testing: ${test.name}`);
      console.log(`   URL: ${test.url}`);
      
      try {
        const response = await fetch(test.url, {
          method: test.method,
          headers: {
            'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        
        console.log(`   Status: ${response.status} ${response.statusText}`);
        
        let responseData = {};
        try {
          responseData = await response.json();
        } catch (e) {
          responseData = { error: 'Non-JSON response' };
        }
        
        results[test.name] = {
          status: response.status,
          statusText: response.statusText,
          data: responseData
        };
        
        if (response.ok) {
          console.log(`   ✅ Success!`);
          console.log(`   Response:`, JSON.stringify(responseData, null, 2));
          
          // Look for workspace information in the response
          if (responseData.workspace || responseData.workspaceId) {
            console.log(`   🎯 FOUND WORKSPACE INFO:`, {
              workspace: responseData.workspace,
              workspaceId: responseData.workspaceId
            });
          }
        } else {
          console.log(`   ❌ Failed:`, responseData.message || responseData.error || 'Unknown error');
        }
      } catch (err) {
        console.log(`   ❌ Network error: ${err.message}`);
        results[test.name] = { error: err.message };
      }
    }
    
    res.json({ 
      message: 'API connectivity test completed',
      timestamp: new Date().toISOString(),
      currentConfig: {
        botId: BOTPRESS_BOT_ID,
        workspaceId: BOTPRESS_WORKSPACE_ID,
        apiUrl: BOTPRESS_FILES_API_URL
      },
      results: results
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ error: 'Test failed', message: error.message });
  }
});

// Search files in Botpress
app.post('/api/search-files', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Missing search query' });
    }
    
    console.log(`🔍 Searching files in Botpress for: "${query}"`);
    
    const response = await fetch(`${BOTPRESS_FILES_API_URL}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTPRESS_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: query,
        botId: BOTPRESS_BOT_ID,
        workspaceId: BOTPRESS_WORKSPACE_ID
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Failed to search files in Botpress:', data);
      return res.status(response.status).json({ error: 'Failed to search files', details: data });
    }
    
    console.log(`✅ Found ${data.results ? data.results.length : 0} search results in Botpress`);
    res.json(data);
    
  } catch (error) {
    console.error('❌ File search error:', error);
    res.status(500).json({ error: 'Failed to search files', message: error.message });
  }
});

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