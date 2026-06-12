import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square, Loader2, Shield } from 'lucide-react';
import { useBa } from '../../contexts/BaContext';
import { BaMessageContent } from './BaMessageContent';

export function BaChatArea() {
  const { messages, streamingText, status, session, sendMessage, endSession } = useBa();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBusy = status === 'busy';
  const isReady = status === 'ready';

  // Auto-scroll on new messages or streaming text
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isBusy) return;
    sendMessage(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, isBusy, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const statusLabel =
    status === 'starting'
      ? 'Starting...'
      : status === 'busy'
        ? 'Thinking...'
        : status === 'error'
          ? 'Error'
          : status === 'ready'
            ? 'Ready'
            : 'Idle';

  const statusDotColor =
    status === 'ready'
      ? 'bg-success'
      : status === 'busy' || status === 'starting'
        ? 'bg-warning'
        : status === 'error'
          ? 'bg-error'
          : 'bg-text-tertiary';

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1">
            <Shield size={14} className="text-accent" />
            <span className="text-sm font-medium text-accent">BA</span>
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotColor}`} />
            <span className="text-sm text-text-tertiary">{statusLabel}</span>
          </div>
        </div>

        {session && (
          <div className="flex items-center gap-2">
            <button
              onClick={endSession}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              End Session
            </button>
          </div>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 && !streamingText && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Shield size={32} className="mx-auto mb-3 text-accent/50" />
              <p className="text-base text-text-secondary">
                BA session active. Ask questions about feasibility, dependencies, or risks.
              </p>
              <p className="mt-2 text-sm text-text-tertiary">
                Findings will be extracted automatically from the agent's responses.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg rounded-br-sm bg-accent/20 px-3 py-2">
                  <p className="whitespace-pre-wrap text-sm text-text-primary">{msg.content}</p>
                </div>
              </div>
            );
          }
          if (msg.role === 'assistant') {
            return (
              <div key={msg.id} className="flex justify-start">
                <div className="max-w-[80%] rounded-lg rounded-bl-sm bg-bg-elevated px-3 py-2">
                  <BaMessageContent content={msg.content} />
                </div>
              </div>
            );
          }
          // system messages
          return (
            <div key={msg.id} className="text-center">
              <span className="text-sm text-text-secondary">{msg.content}</span>
            </div>
          );
        })}

        {/* Streaming text */}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg rounded-bl-sm bg-bg-elevated px-3 py-2">
              <BaMessageContent content={streamingText} />
              <Loader2 size={12} className="mt-1 animate-spin text-text-tertiary" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border bg-bg-secondary p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            disabled={isBusy || !isReady}
            placeholder={
              isBusy
                ? 'Waiting for response...'
                : !session
                  ? 'Session not started...'
                  : 'Type a message... (Shift+Enter for newline)'
            }
            rows={1}
            className="flex-1 resize-none rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none disabled:opacity-50"
          />
          {isBusy ? (
            <button
              className="flex h-9 w-9 items-center justify-center rounded-md bg-error transition-colors hover:bg-error/80"
              title="Stop generation"
            >
              <Square size={14} className="text-white" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={isBusy || !isReady || !input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-accent transition-colors hover:bg-accent/90 disabled:opacity-30"
            >
              <Send size={16} className="text-white" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
