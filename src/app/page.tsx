'use client';
import { useState, useEffect } from 'react';

// Load config from environment variables
const N8N_WEBHOOK_URL = process.env.NEXT_PUBLIC_N8N_WEBHOOK_URL || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Message type definition
interface Message {
  id: string;
  text: string;
  isBot: boolean;
  parts?: number;
  partNumber?: number;
  totalParts?: number;
  batchId?: string;
}

// Bot response from backend
interface BotMessagePart {
  id: string;
  text: string;
  timestamp: number;
}

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
      console.log(`🔵 Tracking user message: "${userMessage}" for conversation: ${conversationId}`);
      
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
      console.log('✅ User message tracking response:', trackingResult);

      // Small delay to ensure tracking is processed
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log(`🚀 Sending to N8N: "${userMessage}"`);
      
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
    if (!conversationId) {
      console.error('Cannot poll - missing conversationId');
      setIsLoading(false);
      return;
    }

    const maxAttempts = 15;
    let attempts = 0;

    const poll = async () => {
      try {
        // Check for bot responses from N8N backend only
        console.log(`🔍 Polling attempt ${attempts + 1}/${maxAttempts} for conversation:`, conversationId);
        const botResponseRes = await fetch(`${BACKEND_URL}/api/bot-response/${conversationId}`);
        
        if (botResponseRes.ok) {
          const botData = await botResponseRes.json();
          console.log('📡 Backend polling response:', botData);
          
          if (botData.success && botData.response) {
            const response = botData.response;
            
            // Handle new format with multiple messages
            if (response.messages && Array.isArray(response.messages)) {
              const messages = response.messages as BotMessagePart[];
              const totalParts = response.totalParts || messages.length;
              
              console.log(`✅ GOT ${messages.length} BOT MESSAGE(S):`);
              messages.forEach((msg: BotMessagePart, index: number) => {
                console.log(`   Part ${index + 1}: "${msg.text}"`);
              });
              
              // Add each message as a separate bubble
              const botMessages = messages.map((msg: BotMessagePart, index: number) => ({
                id: msg.id,
                text: msg.text,
                isBot: true,
                partNumber: index + 1,
                totalParts: totalParts,
                batchId: response.batchId
              }));
              
              setMessages(prev => [...prev, ...botMessages]);
              setIsLoading(false);
              console.log(`💬 ${messages.length} separate bot bubbles added to chat interface`);
              return;
            } else {
              // Fallback for old single message format
              const messageText = response.text;
              console.log(`✅ GOT SINGLE BOT RESPONSE: "${messageText}"`);
              
              const botMessage = {
                id: response.id,
                text: messageText,
                isBot: true
              };
              
              setMessages(prev => [...prev, botMessage]);
              setIsLoading(false);
              console.log(`💬 Single bot message added to chat interface`);
              return;
            }
          } else {
            console.log('⏳ No bot response available yet, continuing to poll...');
          }
        } else {
          console.log(`❌ Backend polling request failed with status: ${botResponseRes.status}`);
        }
        
        // No bot response available yet, try again
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 1000);
        } else {
          const timeoutMessage = {
            id: `timeout-${Date.now()}`,
            text: "I'm taking longer than usual to respond. Please try sending your message again.",
            isBot: true
          };
          setMessages(prev => [...prev, timeoutMessage]);
          setIsLoading(false);
        }
        
      } catch (error) {
        attempts++;
        
        if (attempts >= maxAttempts) {
          const errorMessage = {
            id: `poll-error-${Date.now()}`,
            text: "I'm having trouble connecting right now. Please try again.",
            isBot: true
          };
          setMessages(prev => [...prev, errorMessage]);
          setIsLoading(false);
        } else {
          setTimeout(poll, 1000);
        }
      }
    };

    console.log('🚀 Starting to poll for bot response in 2 seconds...');
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
              {message.text}
              {message.isBot && message.totalParts && message.totalParts > 1 && (
                <div className="message-parts-indicator">
                  Part {message.partNumber} of {message.totalParts}
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
