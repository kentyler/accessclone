import { useRef, useEffect } from 'react';
import { useUiStore } from '@/store/ui';

export default function ChatPanel() {
  const {
    chatPanelOpen, toggleChatPanel,
    chatMessages, chatInput, setChatInput,
    chatLoading, sendChatMessage,
  } = useUiStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  return (
    <div className={`chat-panel${chatPanelOpen ? '' : ' collapsed'}`}>
      <div className="chat-header">
        <span className="chat-title">Assistant</span>
        <button className="chat-toggle" onClick={toggleChatPanel}>
          {chatPanelOpen ? '>>' : '<<'}
        </button>
      </div>

      {chatPanelOpen && (
        <>
          <div className="chat-messages">
            {chatMessages.length === 0 && (
              <div className="chat-empty">Ask a question about this object...</div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                <div className="message-content">{msg.content}</div>
              </div>
            ))}
            {chatLoading && (
              <div className="chat-message assistant">
                <div className="message-content typing">...</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-action-bar">
            <button className="chat-analyze" onClick={() => {
              const store = useUiStore.getState();
              store.setChatInput('');
              // Clear and re-analyze
              const { chatTab } = store;
              if (chatTab) {
                store.addChatMessage('user', 'Analyze this object — describe its structure, purpose, and flag any issues.');
                store.sendChatMessage();
              }
            }}>
              Analyze
            </button>
            {chatMessages.length > 0 && (
              <button className="chat-clear" onClick={() => {
                const store = useUiStore.getState();
                store.chatMessages.length = 0; // Will trigger re-render via Zustand
                store.saveChatTranscript();
              }}>
                Clear
              </button>
            )}
          </div>

          <div className="chat-input-area">
            <textarea
              className="chat-input"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this object..."
              disabled={chatLoading}
            />
            <button className="chat-send" onClick={sendChatMessage} disabled={chatLoading || !chatInput.trim()}>
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
