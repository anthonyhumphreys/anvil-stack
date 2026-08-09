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
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

const SpeechRecognitionConstructor =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function describeVoiceInputError(error: string, message?: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone or speech recognition access was denied. Check Anvil in System Settings → Privacy & Security → Microphone, then restart the app.';
    case 'audio-capture':
      return 'Anvil could not access a microphone. Check the selected input device and macOS microphone permission.';
    case 'network':
      return 'Speech recognition could not reach its transcription service. Check your connection and try again.';
    case 'no-speech':
      return 'No speech was detected. Try again and speak after the microphone turns red.';
    case 'language-not-supported':
      return 'Speech recognition is not available for the selected language.';
    default:
      return message?.trim() || error || 'Voice input stopped unexpectedly.';
  }
}

export function useVoiceInput({ onResult, onError, enabled = true }: UseVoiceInputOptions) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const nativeModeRef = useRef(false);
  const isListeningRef = useRef(false);
  const isStartingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const recognitionErrorRef = useRef<string | null>(null);
  const transcriptRef = useRef('');
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);

  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const isSupported =
    enabled &&
    typeof window !== 'undefined' &&
    (Boolean(window.anvil?.voice) || SpeechRecognitionConstructor !== null);

  const updateTranscript = useCallback((text: string) => {
    transcriptRef.current = text;
    setTranscript(text);
  }, []);

  const flushTranscript = useCallback(() => {
    const text = transcriptRef.current.trim();
    if (!text) return;
    onResultRef.current(text);
    transcriptRef.current = '';
    setTranscript('');
  }, []);

  const startBrowserRecognition = useCallback(() => {
    if (!SpeechRecognitionConstructor) {
      const error = 'Voice input is not supported on this device.';
      recognitionErrorRef.current = error;
      isStartingRef.current = false;
      setStatus('error');
      onErrorRef.current?.(error);
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-GB';

    recognition.onstart = () => {
      isStartingRef.current = false;
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
      if (event.error === 'aborted' && stopRequestedRef.current) return;
      const error = describeVoiceInputError(event.error, event.message);
      recognitionErrorRef.current = error;
      isStartingRef.current = false;
      isListeningRef.current = false;
      setStatus('error');
      onErrorRef.current?.(error);
    };

    recognition.onend = () => {
      const didStart = isListeningRef.current;
      const wasStopped = stopRequestedRef.current;
      const error = recognitionErrorRef.current;
      recognitionRef.current = null;
      isStartingRef.current = false;
      isListeningRef.current = false;
      flushTranscript();

      if (error) {
        setStatus('error');
      } else if (!didStart && !wasStopped) {
        const unexpectedEnd =
          'Voice input stopped before recording started. Check microphone permission and try again.';
        recognitionErrorRef.current = unexpectedEnd;
        setStatus('error');
        onErrorRef.current?.(unexpectedEnd);
      } else {
        setStatus('idle');
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      isStartingRef.current = false;
      setStatus('error');
      onErrorRef.current?.(err instanceof Error ? err.message : 'Failed to start voice input');
    }
  }, [flushTranscript, updateTranscript]);

  const startListening = useCallback(async () => {
    if (!isSupported || isListeningRef.current || isStartingRef.current) return;

    isStartingRef.current = true;
    stopRequestedRef.current = false;
    recognitionErrorRef.current = null;
    nativeModeRef.current = false;
    setStatus('processing');

    let permission: Awaited<ReturnType<typeof window.anvil.voice.requestPermission>>;
    try {
      permission = await window.anvil.voice.requestPermission();
    } catch (err) {
      isStartingRef.current = false;
      setStatus('error');
      onErrorRef.current?.(
        err instanceof Error ? err.message : 'Anvil could not request microphone access.',
      );
      return;
    }
    if (!permission.granted) {
      isStartingRef.current = false;
      setStatus('error');
      onErrorRef.current?.(permission.error ?? 'Microphone access was not granted.');
      return;
    }

    let nativeResult: Awaited<ReturnType<typeof window.anvil.voice.startListening>>;
    try {
      nativeResult = await window.anvil.voice.startListening();
    } catch (err) {
      nativeResult = {
        success: false,
        fallback: true,
        error: err instanceof Error ? err.message : 'Native voice input could not start.',
      };
    }

    if (nativeResult.success) {
      nativeModeRef.current = true;
      isStartingRef.current = false;
      return;
    }

    if (nativeResult.fallback && SpeechRecognitionConstructor) {
      recognitionErrorRef.current = null;
      startBrowserRecognition();
      return;
    }

    const error = nativeResult.error || 'Voice input could not start.';
    const alreadyReported = recognitionErrorRef.current === error;
    isStartingRef.current = false;
    recognitionErrorRef.current = error;
    setStatus('error');
    if (!alreadyReported) onErrorRef.current?.(error);
  }, [isSupported, startBrowserRecognition]);

  const stopListening = useCallback(() => {
    stopRequestedRef.current = true;
    if (nativeModeRef.current) {
      setStatus('processing');
      void window.anvil.voice.stopListening();
      return;
    }

    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
    } else if (recognitionRef.current) {
      recognitionRef.current.abort();
    }
    recognitionRef.current = null;
    isStartingRef.current = false;
    isListeningRef.current = false;
    setStatus('idle');
    flushTranscript();
  }, [flushTranscript]);

  useEffect(() => {
    const removeResultListener = window.anvil.voice.onResult((text) => {
      if (!nativeModeRef.current && !isStartingRef.current) return;
      updateTranscript(text);
    });
    const removeErrorListener = window.anvil.voice.onError((error) => {
      if (!nativeModeRef.current && !isStartingRef.current) return;
      recognitionErrorRef.current = error;
      nativeModeRef.current = false;
      isStartingRef.current = false;
      isListeningRef.current = false;
      setStatus('error');
      onErrorRef.current?.(error);
    });
    const removeStatusListener = window.anvil.voice.onStatus((nextStatus) => {
      if (nextStatus === 'listening') {
        nativeModeRef.current = true;
        isStartingRef.current = false;
        isListeningRef.current = true;
        setStatus('listening');
        updateTranscript('');
        return;
      }

      if (nextStatus === 'stopped') {
        nativeModeRef.current = false;
        isStartingRef.current = false;
        isListeningRef.current = false;
        flushTranscript();
        if (!recognitionErrorRef.current) setStatus('idle');
      }
    });

    return () => {
      removeResultListener();
      removeErrorListener();
      removeStatusListener();
      if (nativeModeRef.current) void window.anvil.voice.stopListening();
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
      isStartingRef.current = false;
      isListeningRef.current = false;
      nativeModeRef.current = false;
      stopRequestedRef.current = true;
      transcriptRef.current = '';
    };
  }, [flushTranscript, updateTranscript]);

  return {
    status,
    transcript,
    isSupported,
    isListening: status === 'listening',
    startListening,
    stopListening,
  };
}
