import { Loader2, Mic, Square } from 'lucide-react';
import { useVoiceInput } from '../../hooks/useVoiceInput';

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  onError?: (error: string) => void;
}

export function VoiceInputButton({ onTranscript, disabled, onError }: VoiceInputButtonProps) {
  const { status, isSupported, isListening, startListening, stopListening } = useVoiceInput({
    onResult: onTranscript,
    onError,
    enabled: !disabled,
  });

  if (!isSupported) return null;

  return (
    <button
      type="button"
      onClick={() => void (isListening ? stopListening() : startListening())}
      disabled={(disabled && !isListening) || status === 'processing'}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-40 ${
        isListening
          ? 'bg-error/15 text-error'
          : status === 'error'
            ? 'text-error hover:bg-error/10'
            : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
      }`}
      title={
        status === 'processing'
          ? 'Requesting microphone access'
          : isListening
            ? 'Stop recording'
            : status === 'error'
              ? 'Voice input failed — click to try again'
              : 'Start voice input'
      }
      aria-label={
        status === 'processing'
          ? 'Requesting microphone access'
          : isListening
            ? 'Stop recording'
            : 'Start voice input'
      }
      aria-busy={status === 'processing'}
      aria-pressed={isListening}
    >
      {status === 'processing' ? (
        <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
      ) : isListening ? (
        <Square size={13} className="motion-safe:animate-pulse" fill="currentColor" />
      ) : (
        <Mic size={16} />
      )}
    </button>
  );
}
