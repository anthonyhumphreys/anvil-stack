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
  const transcriptRef = useRef('');

  const isSupported = SpeechRecognition !== null && enabled;

  const updateTranscript = useCallback((text: string) => {
    transcriptRef.current = text;
    setTranscript(text);
  }, []);

  const flushTranscript = useCallback(() => {
    const text = transcriptRef.current.trim();
    if (!text) return;
    onResult(text);
    transcriptRef.current = '';
    setTranscript('');
  }, [onResult]);

  const startListening = useCallback(() => {
    if (!isSupported || isListeningRef.current) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListeningRef.current = true;
      setStatus('listening');
      updateTranscript('');
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
        updateTranscript(finalTranscript);
      } else if (interimTranscript) {
        updateTranscript(interimTranscript);
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
      flushTranscript();
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      setStatus('error');
      onError?.(err instanceof Error ? err.message : 'Failed to start voice input');
    }
  }, [flushTranscript, isSupported, onError, updateTranscript]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    isListeningRef.current = false;
    setStatus('idle');
    flushTranscript();
  }, [flushTranscript]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
      isListeningRef.current = false;
      transcriptRef.current = '';
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
