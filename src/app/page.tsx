'use client';
import { useState, useEffect } from 'react';

// Load config from environment variables
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Debug logging
console.log('🔧 Debug: BACKEND_URL =', BACKEND_URL);
console.log('🔧 Debug: All env vars:', process.env);

export default function Home() {
  const [messages, setMessages] = useState([
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

  // Poll for new bot messages from /api/receive-message every 2 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/receive-message');
        const data = await res.json();
        if (data.message && !messages.some(m => m.text === data.message && m.isBot)) {
          const botMessage = {
            id: `bot-receive-${Date.now()}`,
            text: data.message,
            isBot: true
          };
          setMessages(prev => [...prev, botMessage]);
        }
      } catch (err) {
        // Optionally handle polling error
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [messages]);

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
    if (!conversationId || !userKey) {
      throw new Error('Not connected to Botpress');
    }

    try {
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
    if (!conversationId || !userKey) {
      console.error('Cannot poll - missing conversationId or userKey');
      setIsLoading(false);
      return;
    }

    const maxAttempts = 15;
    let attempts = 0;

    const poll = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/messages?conversationId=${conversationId}&userKey=${encodeURIComponent(userKey)}`);

        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }

        const data = await response.json();
        const allMessages = data.messages || [];
        
        const botMessages = allMessages.filter((msg: any) =>
          userId && msg.userId !== userId && (msg.payload?.text || msg.payload?.Text)
        );
        
        const newBotMessages = botMessages.filter((msg: any) => {
          const messageId = msg.id || `bot-${msg.timestamp || Date.now()}`;
          return !displayedMessageIds.has(messageId);
        });

        if (newBotMessages.length > 0) {
          newBotMessages.forEach((msg: any) => {
            const messageId = msg.id || `bot-${msg.timestamp || Date.now()}-${Math.random()}`;
            const messageText = msg.payload?.text || msg.payload?.Text || 'No text content';
            
            if (!displayedMessageIds.has(messageId)) {
              const botMessage = {
                id: messageId,
                text: messageText,
                isBot: true
              };
              setMessages(prev => [...prev, botMessage]);
              setDisplayedMessageIds(prev => new Set(prev).add(messageId));
            }
          });
          
          setIsLoading(false);
          return;
        }
        
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

    setTimeout(poll, 500);
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
