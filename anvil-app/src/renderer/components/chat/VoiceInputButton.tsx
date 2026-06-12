import { Mic, Square } from 'lucide-react';
import { useVoiceInput, type VoiceStatus } from '../../hooks/useVoiceInput';

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  colour?: string;
}

const STATUS_COLOURS: Record<VoiceStatus, string> = {
  idle: '',
  listening: '#e67a79',
  processing: '#fd9029',
  error: '#e67a79',
};

export function VoiceInputButton({ onTranscript, disabled, colour }: VoiceInputButtonProps) {
  const { status, isSupported, isListening, startListening, stopListening } = useVoiceInput({
    onResult: onTranscript,
    enabled: !disabled,
  });

  if (!isSupported) return null;

  const activeColour = STATUS_COLOURS[status] || colour || '#b5121b';

  return (
    <button
      onClick={isListening ? stopListening : startListening}
      disabled={disabled && !isListening}
      className="flex h-10 w-10 items-center justify-center rounded-lg transition-all duration-200 hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
      style={{
        backgroundColor: isListening ? activeColour : `${activeColour}20`,
      }}
      title={isListening ? 'Stop recording' : 'Start voice input'}
      aria-label={isListening ? 'Stop recording' : 'Start voice input'}
    >
      {isListening ? (
        <Square size={16} className="text-white animate-pulse" fill="currentColor" />
      ) : (
        <Mic size={18} style={{ color: activeColour }} />
      )}
    </button>
  );
}
