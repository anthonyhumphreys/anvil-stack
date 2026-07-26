import { Loader2, Mic, Square } from 'lucide-react';
import { useVoiceInput, type VoiceStatus } from '../../hooks/useVoiceInput';

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  colour?: string;
  onError?: (error: string) => void;
}

const STATUS_COLOURS: Record<VoiceStatus, string> = {
  idle: '',
  listening: '#e67a79',
  processing: '#fd9029',
  error: '#e67a79',
};

export function VoiceInputButton({
  onTranscript,
  disabled,
  colour,
  onError,
}: VoiceInputButtonProps) {
  const { status, isSupported, isListening, startListening, stopListening } = useVoiceInput({
    onResult: onTranscript,
    onError,
    enabled: !disabled,
  });

  if (!isSupported) return null;

  const activeColour = STATUS_COLOURS[status] || colour || '#b5121b';

  return (
    <button
      type="button"
      onClick={() => void (isListening ? stopListening() : startListening())}
      disabled={(disabled && !isListening) || status === 'processing'}
      className="flex h-9 w-9 items-center justify-center rounded-xl transition-[background-color,color,transform] duration-200 hover:bg-bg-tertiary disabled:opacity-30"
      style={{
        backgroundColor: isListening ? activeColour : `${activeColour}20`,
      }}
      title={
        status === 'processing'
          ? 'Requesting microphone access'
          : isListening
            ? 'Stop recording'
            : status === 'error'
              ? 'Voice input failed — click to try again'
              : 'Start voice input'
      }
      aria-label={isListening ? 'Stop recording' : 'Start voice input'}
      aria-pressed={isListening}
    >
      {status === 'processing' ? (
        <Loader2 size={16} className="animate-spin" style={{ color: activeColour }} />
      ) : isListening ? (
        <Square size={14} className="voice-recording-pulse text-white" fill="currentColor" />
      ) : (
        <Mic size={17} style={{ color: activeColour }} />
      )}
    </button>
  );
}
