import DOMPurify from 'dompurify';
import { useEffect, useMemo, useState } from 'react';
import { renderMermaid } from '../../../../utils/mermaid';
import { sketchThemeName, useSketchTokens } from '../../sketch-tokens';
import { mermaidConfigForTokens, sizeMermaidSvg } from './model';

export interface MermaidRender {
  status: 'idle' | 'pending' | 'ready' | 'error';
  /** Sanitised SVG with explicit pixel size (last good render survives errors). */
  svg: string | null;
  width: number;
  height: number;
  error: string | null;
}

const IDLE: MermaidRender = { status: 'idle', svg: null, width: 0, height: 0, error: null };

/**
 * Renders Mermaid source to sanitised SVG, themed from the active app theme
 * and re-rendered when the theme changes. Strict security level; the output
 * is additionally passed through DOMPurify's SVG profile.
 */
export function useMermaidSvg(source: string): MermaidRender {
  const tokens = useSketchTokens();
  const config = useMemo(() => mermaidConfigForTokens(tokens, sketchThemeName(tokens)), [tokens]);
  const [state, setState] = useState<MermaidRender>(IDLE);

  useEffect(() => {
    if (!source.trim()) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    const renderId = `anvil-diagram-${crypto.randomUUID()}`;
    setState((current) => ({ ...current, status: 'pending', error: null }));
    void renderMermaid(renderId, source, config)
      .then(({ svg }) => {
        if (cancelled) return;
        const safe = DOMPurify.sanitize(svg, {
          // html: Mermaid draws flowchart labels as HTML inside <foreignObject>.
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignObject'],
        });
        const sized = sizeMermaidSvg(safe);
        setState({ status: 'ready', error: null, ...sized });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, status: 'error', error: detail }));
      })
      .finally(() => document.getElementById(renderId)?.remove());
    return () => {
      cancelled = true;
      document.getElementById(renderId)?.remove();
    };
  }, [source, config]);

  return state;
}
