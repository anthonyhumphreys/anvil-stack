import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { DiagramFile } from '../../../shared/types';

interface DiagramViewerProps {
  diagram: DiagramFile;
}

export function DiagramViewer({ diagram }: DiagramViewerProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendXmlToIframe = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      JSON.stringify({ action: 'load', xml: diagram.xml }),
      '*',
    );
  }, [diagram.xml]);

  // Listen for postMessage events from the draw.io embed
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      let msg: { event?: string };
      try {
        msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      if (msg.event === 'init') {
        // draw.io is ready — send the diagram XML
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        setIframeLoaded(true);
        setIframeError(false);
        sendXmlToIframe();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [sendXmlToIframe]);

  // Reset state and set a timeout when switching diagrams
  useEffect(() => {
    setIframeLoaded(false);
    setIframeError(false);
    timeoutRef.current = setTimeout(() => {
      setIframeError(true);
    }, 10000);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [diagram.filename]);

  // When diagram XML changes while already loaded, re-send it
  useEffect(() => {
    if (iframeLoaded) {
      sendXmlToIframe();
    }
  }, [diagram.xml, iframeLoaded, sendXmlToIframe]);

  return (
    <div className="h-full w-full relative">
      {!iframeLoaded && !iframeError && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-secondary">
          <Loader2 size={24} className="animate-spin text-text-tertiary" />
        </div>
      )}
      {iframeError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-secondary gap-2">
          <AlertTriangle size={24} className="text-warning" />
          <p className="text-sm text-text-secondary">Failed to load draw.io viewer</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src="https://embed.diagrams.net/?embed=1&spin=1&proto=json&dark=1"
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full border-none"
        title={diagram.title}
      />
    </div>
  );
}
