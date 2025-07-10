'use client';
import { useState, useEffect } from 'react';

// Load config from environment variables
const N8N_WEBHOOK_URL = process.env.NEXT_PUBLIC_N8N_WEBHOOK_URL || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

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
        const pollTimestamp = new Date().toISOString();
        console.log(`🔍 Polling attempt ${attempts + 1}/${maxAttempts} at ${pollTimestamp} for conversation:`, conversationId);
        const botResponseRes = await fetch(`${BACKEND_URL}/api/bot-response/${conversationId}`);
        
        if (botResponseRes.ok) {
          const botData = await botResponseRes.json();
          console.log(`📡 Backend polling response at ${pollTimestamp}:`, botData);
          
          if (botData.success && botData.response) {
            const response = botData.response;
            const receivedTimestamp = new Date().toISOString();
            
            // Handle multi-part responses
            if (response.isMultiPart) {
              console.log(`✅ GOT MULTI-PART RESPONSE at ${receivedTimestamp} - Part ${response.partNumber}/${response.totalParts}: "${response.text}"`);
              
              const botMessage = {
                id: response.id,
                text: response.text,
                isBot: true,
                partNumber: response.partNumber,
                totalParts: response.totalParts,
                receivedAt: receivedTimestamp
              };
              
              setMessages(prev => [...prev, botMessage]);
              console.log(`💬 Part ${response.partNumber}/${response.totalParts} added to chat interface at ${receivedTimestamp}`);
              
              // If this is the last part, stop polling
              if (response.isLastPart) {
                console.log(`🏁 All ${response.totalParts} parts received - stopping polling`);
                setIsLoading(false);
                return;
              } else {
                // Continue polling for next part with a short delay
                console.log(`➡️ Waiting for next part (${response.totalParts - response.partNumber} remaining)...`);
                setTimeout(() => {
                  poll();
                }, 500); // 0.5 second delay between parts for natural feel
                return;
              }
            } else {
              // Handle single-part response (legacy)
              console.log(`✅ GOT SINGLE BOT RESPONSE at ${receivedTimestamp}: "${response.text}"`);
              
              const botMessage = {
                id: response.id,
                text: response.text,
                isBot: true,
                receivedAt: receivedTimestamp
              };
              
              setMessages(prev => [...prev, botMessage]);
              setIsLoading(false);
              console.log(`💬 Single bot message added to chat interface at ${receivedTimestamp}`);
              return;
            }
          } else if (botData.message === 'Multi-part response in progress' && botData.partsCollected) {
            const progressTimestamp = botData.timestamp || new Date().toISOString();
            console.log(`📦 Multi-part response in progress at ${progressTimestamp}: ${botData.partsCollected} parts collected so far...`);
            // Continue polling but show progress
          } else {
            console.log(`⏳ No bot response available yet at ${new Date().toISOString()}, continuing to poll...`);
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
              {message.text}
              {message.isBot && (message as any).partNumber && (message as any).totalParts && (message as any).totalParts > 1 && (
                <div style={{ 
                  fontSize: '10px', 
                  opacity: 0.6, 
                  marginTop: '4px', 
                  fontStyle: 'italic' 
                }}>
                  Part {(message as any).partNumber} of {(message as any).totalParts}
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
                Bot is responding... (may send multiple parts)
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
