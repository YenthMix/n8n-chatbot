'use client';
import { useState, useEffect } from 'react';

// Load config from environment variables
const N8N_WEBHOOK_URL = process.env.NEXT_PUBLIC_N8N_WEBHOOK_URL || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export default function Home() {
  console.log('🎯 HOME COMPONENT LOADED - Console logging is working!');
  
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
    console.log('🔄 SEND TO BOTPRESS - Starting...');
    console.log('📋 Environment check:');
    console.log('  - N8N_WEBHOOK_URL:', N8N_WEBHOOK_URL);
    console.log('  - BACKEND_URL:', BACKEND_URL);
    console.log('  - conversationId:', conversationId);
    console.log('  - userKey:', userKey);
    
    if (!conversationId) {
      console.error('❌ No conversation ID available');
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
      console.log('✅ N8N request completed successfully, starting polling...');
      pollForBotResponse();
      return data;
      
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  };

  const pollForBotResponse = async () => {
    console.log('🚀 STARTING POLL FOR BOT RESPONSE');
    console.log('🔍 Conversation ID:', conversationId);
    console.log('🔍 Backend URL:', BACKEND_URL);
    
    if (!conversationId) {
      console.error('❌ Cannot poll - missing conversationId');
      setIsLoading(false);
      return;
    }

    const maxAttempts = 15;
    let attempts = 0;
    
    console.log(`📊 Will poll up to ${maxAttempts} times`);
  

    const poll = async () => {
      try {
        // Check for bot responses from N8N backend only
        console.log(`🔍 Polling attempt ${attempts + 1}/${maxAttempts} for conversation:`, conversationId);
        const botResponseRes = await fetch(`${BACKEND_URL}/api/bot-response/${conversationId}`);
        
        console.log(`📡 Response status: ${botResponseRes.status}`);
        
        if (botResponseRes.ok) {
          const botData = await botResponseRes.json();
          console.log('📡 Backend polling response:', botData);
          console.log('📡 Response has success:', botData.success);
          console.log('📡 Response has response:', !!botData.response);
          
          if (botData.response) {
            console.log('📡 Response structure:', Object.keys(botData.response));
            console.log('📡 Is multi-part:', botData.response.isMultiPart);
            console.log('📡 Has responses array:', !!botData.response.responses);
            console.log('📡 Has text field:', !!botData.response.text);
          }
          
                    if (botData.success && botData.response) {
            console.log(`✅ GOT BOT RESPONSE - Type: ${botData.response.isMultiPart ? 'MULTI-PART' : 'SINGLE'}`);
            
            try {
              // Check if this is a multi-part response (separate bubbles)
              if (botData.response.isMultiPart && botData.response.responses && Array.isArray(botData.response.responses)) {
                console.log(`📬 PROCESSING MULTI-PART: ${botData.response.responses.length} separate bubbles`);
                
                // Add each response as a separate bubble with a small delay
                botData.response.responses.forEach((response: any, index: number) => {
                  setTimeout(() => {
                    console.log(`💬 Adding bubble ${index + 1}/${botData.response.responses.length}: "${response.text}"`);
                    
                    const botMessage = {
                      id: response.id || `part-${index}`,
                      text: response.text || 'No text available',
                      isBot: true,
                      partNumber: index + 1,
                      totalParts: botData.response.responses.length
                    };
                    
                    setMessages(prev => [...prev, botMessage]);
                    
                    // Remove loading indicator after the last message
                    if (index === botData.response.responses.length - 1) {
                      setIsLoading(false);
                      console.log(`✅ All ${botData.response.responses.length} bubbles added successfully`);
                    }
                  }, index * 800); // 800ms delay between bubbles for natural feel
                });
                
              } else {
                // Single response
                console.log(`💬 PROCESSING SINGLE RESPONSE: "${botData.response.text}"`);
                
                const botMessage = {
                  id: botData.response.id || `single-${Date.now()}`,
                  text: botData.response.text || 'No text available',
                  isBot: true,
                  partNumber: 1,
                  totalParts: 1
                };
                
                setMessages(prev => [...prev, botMessage]);
                setIsLoading(false);
                console.log('✅ Single bot message added successfully');
              }
            } catch (error) {
              console.error('❌ ERROR processing bot response:', error);
              console.error('❌ Response data:', botData.response);
              
              // Fallback: try to display as single message
              const fallbackMessage = {
                id: `fallback-${Date.now()}`,
                text: botData.response.text || 'Error processing response',
                isBot: true
              };
              setMessages(prev => [...prev, fallbackMessage]);
              setIsLoading(false);
            }
            return;
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
    console.log('🚀 HANDLE SEND MESSAGE called');
    console.log('📝 Input value:', inputValue);
    console.log('🔄 Is loading:', isLoading);
    console.log('🔗 Is connected:', isConnected);
    
    if (inputValue.trim() === '' || isLoading || !isConnected) {
      console.log('❌ Send message blocked - empty input, loading, or not connected');
      return;
    }
    
    const userMessage = inputValue.trim();
    setInputValue('');
    setIsLoading(true);
    
    console.log('💬 User message:', userMessage);
    console.log('🔄 Set loading to true, adding user message to chat');
    
    const userMessageObj = { id: `user-${Date.now()}`, text: userMessage, isBot: false };
    setMessages(prev => [...prev, userMessageObj]);
    
    try {
      console.log('📡 Calling sendToBotpress...');
      await sendToBotpress(userMessage);
      console.log('✅ sendToBotpress completed successfully');
    } catch (error) {
      console.error('❌ Error in sendToBotpress:', error);
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
