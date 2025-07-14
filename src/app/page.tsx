'use client';
import { useState, useEffect } from 'react';

// Define message interface with image support
interface Message {
  id: string;
  text: string;
  isBot: boolean;
  receivedAt?: string;
  timestamp?: number;
  image?: string | null;
  hasImage?: boolean;
}

// Load config from environment variables
const N8N_WEBHOOK_URL = process.env.NEXT_PUBLIC_N8N_WEBHOOK_URL || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 'welcome-1', text: "Hallo! Hoe kan ik u vandaag helpen?", isBot: true }
  ]);
  const [displayedMessageIds, setDisplayedMessageIds] = useState(new Set(['welcome-1']));
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userKey, setUserKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    console.log(`🔧 FRONTEND CONFIG: N8N_WEBHOOK_URL=${N8N_WEBHOOK_URL}, BACKEND_URL=${BACKEND_URL}`);
    initializeChatAPI();
  }, []);

  // Removed old polling mechanism - now using direct bot response endpoint

  const initializeChatAPI = async () => {
    try {
      const userResponse = await fetch(`${BACKEND_URL}/api/user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      if (!userResponse.ok) {
        throw new Error(`User creation failed: ${userResponse.status}`);
      }
      
      const userData = await userResponse.json();
      
      if (!userData.userKey) {
        throw new Error('User key missing from backend response');
      }
      
      setUserKey(userData.userKey);
      
      const convResponse = await fetch(`${BACKEND_URL}/api/conversation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userKey: userData.userKey })
      });
      
      if (!convResponse.ok) {
        throw new Error(`Conversation creation failed: ${convResponse.status}`);
      }
      
      const convData = await convResponse.json();
      
      if (!convData.conversation?.id) {
        throw new Error('Conversation ID missing from backend response');
      }
      
      setConversationId(convData.conversation.id);
      setUserId(userData.user.id);
      setIsConnected(true);
      
    } catch (error) {
      console.error('Failed to initialize chat API:', error);
      const errorMessage = {
        id: `error-${Date.now()}`,
        text: "Failed to connect to Botpress. Please make sure the backend server is running with 'npm run backend'.",
        isBot: true
      };
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  const sendToBotpress = async (userMessage: string) => {
    if (!conversationId) {
      throw new Error('Not connected to chat system');
    }

    try {
      const sendTimestamp = new Date().toISOString();
      console.log(`🔵 Tracking user message at ${sendTimestamp}: "${userMessage}" for conversation: ${conversationId}`);
      
      // First, track the user message so backend can distinguish it from bot response
      const trackingResponse = await fetch(`${BACKEND_URL}/api/track-user-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversationId,
          text: userMessage
        })
      });

      if (!trackingResponse.ok) {
        console.error('❌ Failed to track user message:', trackingResponse.status);
        throw new Error('Failed to track user message');
      }

      const trackingResult = await trackingResponse.json();
      console.log(`✅ User message tracking response at ${sendTimestamp}:`, trackingResult);

      // Small delay to ensure tracking is processed
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log(`🚀 Sending to N8N at ${sendTimestamp}: "${userMessage}"`);
      
      // Then send to N8N
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversationId,
          text: userMessage,
          userKey
        })
      });

      if (!response.ok) {
        throw new Error(`N8N error: ${response.status}`);
      }

      const data = await response.json();
      pollForBotResponse();
      return data;
      
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  };

  const pollForBotResponse = async () => {
    console.log(`🚀 FRONTEND: Starting pollForBotResponse, conversationId: ${conversationId}, BACKEND_URL: ${BACKEND_URL}`);
    
    if (!conversationId) {
      console.error('Cannot poll - missing conversationId');
      setIsLoading(false);
      return;
    }

    const maxAttempts = 15;
    let attempts = 0;
    let consecutiveEmptyPolls = 0;
    const maxEmptyPolls = 8; // Stop after 8 consecutive empty polls (increased for multiple messages)

    const poll = async () => {
      try {
        // Check for bot responses from N8N backend only
        const pollTimestamp = new Date().toISOString();
        const pollUrl = `${BACKEND_URL}/api/bot-response/${conversationId}`;
        console.log(`🔍 FRONTEND: Polling attempt ${attempts + 1}/${maxAttempts} at ${pollTimestamp}`);
        console.log(`🔍 FRONTEND: Polling URL: ${pollUrl}`);
        console.log(`🔍 FRONTEND: For conversation: ${conversationId}`);
        
        const botResponseRes = await fetch(pollUrl);
        
        if (botResponseRes.ok) {
          const botData = await botResponseRes.json();
          console.log(`📡 FRONTEND: Backend polling response at ${pollTimestamp}:`, botData);
          console.log(`📡 FRONTEND: Response details - success: ${botData.success}, messages: ${botData.messages?.length || 0}`);
          
          if (botData.success && botData.messages) {
            const receivedTimestamp = new Date().toISOString();
            console.log(`✅ GOT ${botData.messages.length} BOT MESSAGES at ${receivedTimestamp}`);
            
            // Log each message received
            botData.messages.forEach((msg: any, idx: number) => {
              console.log(`   FRONTEND Message ${idx + 1}: text="${msg.text}", hasImage=${msg.hasImage}, image="${msg.image ? 'YES' : 'NO'}" (received: ${msg.receivedAt})`);
            });
            
            // Add each message separately to the chat in timestamp order
            const botMessages = botData.messages.map((msg: any) => ({
              id: msg.id,
              text: msg.text,
              isBot: true,
              receivedAt: msg.receivedAt,
              timestamp: msg.timestamp,
              // Add image support
              image: msg.image || null,
              hasImage: msg.hasImage || false
            }));
            
            setMessages(prev => [...prev, ...botMessages]);
            console.log(`💬 FRONTEND: ${botMessages.length} bot messages added to chat interface at ${receivedTimestamp}`);
            
            // Debug: Log what was actually added to state
            botMessages.forEach((msg: Message, idx: number) => {
              console.log(`   FRONTEND Added to State ${idx + 1}: text="${msg.text}", hasImage=${msg.hasImage}, image="${msg.image ? 'YES' : 'NO'}"`);
            });
            
            // Stop polling since we received the complete set of messages from backend
            setIsLoading(false);
            console.log(`✅ All messages received and displayed - stopping polling`);
            return;
          } else if (botData.message === 'Still collecting messages from n8n') {
            console.log(`⏳ Backend still collecting messages from n8n (${botData.messagesReceived || 0} received so far)...`);
            consecutiveEmptyPolls = 0; // Reset counter since backend is actively collecting
          } else {
            console.log(`⏳ No bot messages available yet at ${new Date().toISOString()}, continuing to poll...`);
            consecutiveEmptyPolls++;
          }
        } else {
          console.log(`❌ Backend polling request failed with status: ${botResponseRes.status}`);
        }
        
        // No bot response available yet, try again
        attempts++;
        
        // Stop polling if we've tried too many times OR if we've had too many consecutive empty polls
        if (attempts >= maxAttempts) {
          const timeoutMessage = {
            id: `timeout-${Date.now()}`,
            text: "I'm taking longer than usual to respond. Please try sending your message again.",
            isBot: true
          };
          setMessages(prev => [...prev, timeoutMessage]);
          setIsLoading(false);
        } else if (consecutiveEmptyPolls >= maxEmptyPolls) {
          // We've received some messages but no new ones for a while - stop polling
          console.log(`✅ Stopping polling after ${consecutiveEmptyPolls} consecutive empty polls - assuming all messages received`);
          setIsLoading(false);
        } else {
          setTimeout(poll, 1000);
        }
        
      } catch (error) {
        attempts++;
        consecutiveEmptyPolls++;
        
        if (attempts >= maxAttempts) {
          const errorMessage = {
            id: `poll-error-${Date.now()}`,
            text: "I'm having trouble connecting right now. Please try again.",
            isBot: true
          };
          setMessages(prev => [...prev, errorMessage]);
          setIsLoading(false);
        } else if (consecutiveEmptyPolls >= maxEmptyPolls) {
          console.log(`✅ Stopping polling after ${consecutiveEmptyPolls} consecutive errors/empty polls`);
          setIsLoading(false);
        } else {
          setTimeout(poll, 1000);
        }
      }
    };

    const startPollTimestamp = new Date().toISOString();
    console.log(`🚀 Starting to poll for bot response at ${startPollTimestamp} in 2 seconds...`);
    setTimeout(poll, 2000);
  };

  const handleSendMessage = async () => {
    if (inputValue.trim() === '' || isLoading || !isConnected) return;
    
    const userMessage = inputValue.trim();
    setInputValue('');
    setIsLoading(true);
    
    const userMessageObj = { id: `user-${Date.now()}`, text: userMessage, isBot: false };
    setMessages(prev => [...prev, userMessageObj]);
    
    try {
      await sendToBotpress(userMessage);
    } catch (error) {
      const errorMessage = { 
        id: `error-${Date.now()}`, 
        text: "Sorry, I'm having trouble connecting to the bot right now. Please try again later.", 
        isBot: true 
      };
      setMessages(prev => [...prev, errorMessage]);
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleSendMessage();
    }
  };

  return (
    <div className="chatbot-container">
      <div className="chatbot-header">
        <h1>💬 Botpress ChatBot</h1>
        <div className={`connection-status ${isConnected ? 'connected' : 'connecting'}`}>
          {isConnected ? '🟢 Connected to Botpress' : '🟡 Connecting...'}
        </div>
      </div>
      
      <div className="chatbot-messages">
        {messages.map((message) => (
          <div 
            key={message.id} 
            className={`message ${message.isBot ? 'bot-message' : 'user-message'}`}
          >
            <div className="message-content">
              {message.text && (
                <div className="message-text">
                  {message.text}
                </div>
              )}
              {message.hasImage && message.image && (
                <div className="message-image">
                  <img 
                    src={message.image} 
                    alt="Image from bot" 
                    style={{
                      maxWidth: '100%',
                      maxHeight: '300px',
                      borderRadius: '8px',
                      marginTop: message.text ? '8px' : '0'
                    }}
                    onError={(e) => {
                      console.log('Image failed to load:', message.image);
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="message bot-message">
            <div className="message-content loading">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div style={{ fontSize: '11px', marginTop: '5px', opacity: 0.7 }}>
                Bot is responding...
              </div>
            </div>
          </div>
        )}
      </div>
      
      <div className="chatbot-input">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={
            !isConnected 
              ? "Connecting to Botpress..." 
              : isLoading 
                ? "Bot is typing..." 
                : "Type your message here..."
          }
          className="message-input"
          disabled={isLoading || !isConnected}
        />
        <button 
          onClick={handleSendMessage} 
          className={`send-button ${isLoading ? 'loading' : ''}`}
          disabled={isLoading || !isConnected}
        >
          {!isConnected ? 'Connecting...' : isLoading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
