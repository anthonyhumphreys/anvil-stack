import { useState, useRef, useEffect } from 'react';
import { Send, Square, Loader2 } from 'lucide-react';
import type { DiagramFile } from '../../../shared/types';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface DiagramChatProps {
  repoId: string;
  selectedDiagram: DiagramFile | null;
  onDiagramGenerated: (title: string, xml: string) => void;
  onDiagramUpdated: (xml: string) => void;
}

export function DiagramChat({
  repoId,
  selectedDiagram,
  onDiagramGenerated,
  onDiagramUpdated,
}: DiagramChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Reset messages when switching diagrams
  useEffect(() => {
    setMessages([]);
  }, [selectedDiagram?.filename]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || generating) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setGenerating(true);

    try {
      const result = await window.anvil.diagrams.generate(repoId, trimmed, selectedDiagram?.xml);

      if (selectedDiagram) {
        onDiagramUpdated(result.drawioXml);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Updated diagram: "${result.title}"` },
        ]);
      } else {
        onDiagramGenerated(result.title, result.drawioXml);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Created diagram: "${result.title}"` },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Generation failed'}`,
        },
      ]);
    } finally {
      setGenerating(false);
    }
  };

  const handleCancel = () => {
    window.anvil.diagrams.cancelGenerate();
    setGenerating(false);
  };

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
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const placeholder = selectedDiagram
    ? `Describe changes to "${selectedDiagram.title}"...`
    : 'Describe a diagram to create...';

  return (
    <div className="flex h-full flex-col">
      {/* Context indicator */}
      {selectedDiagram && (
        <div className="border-b border-border px-3 py-1.5">
          <span className="text-xs text-accent">Editing: {selectedDiagram.filename}</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-2 space-y-2">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-sm ${
              msg.role === 'user'
                ? 'text-text-primary ml-8'
                : msg.content.startsWith('Error:')
                  ? 'text-error mr-8'
                  : 'text-text-secondary mr-8'
            }`}
          >
            {msg.content}
          </div>
        ))}
        {generating && (
          <div className="flex items-center gap-2 text-sm text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            Generating...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            disabled={generating}
            placeholder={placeholder}
            rows={1}
            className="flex-1 resize-none rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none disabled:opacity-50"
          />
          {generating ? (
            <button
              onClick={handleCancel}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-error transition-colors hover:bg-error/80"
              title="Cancel generation"
            >
              <Square size={14} className="text-white" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-accent transition-colors hover:bg-accent/80 disabled:opacity-30"
              title="Send"
            >
              <Send size={16} className="text-white" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
