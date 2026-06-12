import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'error';

interface UseVoiceInputOptions {
  onResult: (text: string) => void;
  onError?: (error: string) => void;
  enabled?: boolean;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

const SpeechRecognition =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function useVoiceInput({ onResult, onError, enabled = true }: UseVoiceInputOptions) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isListeningRef = useRef(false);

  const isSupported = SpeechRecognition !== null && enabled;

  const startListening = useCallback(() => {
    if (!isSupported || isListeningRef.current) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListeningRef.current = true;
      setStatus('listening');
      setTranscript('');
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        setTranscript(finalTranscript);
      } else if (interimTranscript) {
        setTranscript(interimTranscript);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      isListeningRef.current = false;
      setStatus('error');
      onError?.(event.message || event.error);
    };

    recognition.onend = () => {
      isListeningRef.current = false;
      setStatus('idle');
      if (transcript) {
        onResult(transcript);
        setTranscript('');
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      setStatus('error');
      onError?.(err instanceof Error ? err.message : 'Failed to start voice input');
    }
  }, [isSupported, onResult, onError, transcript]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    isListeningRef.current = false;
    setStatus('idle');
    if (transcript) {
      onResult(transcript);
      setTranscript('');
    }
  }, [onResult, transcript]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
      isListeningRef.current = false;
    };
  }, []);

  return {
    status,
    transcript,
    isSupported,
    isListening: status === 'listening',
    startListening,
    stopListening,
  };
}
