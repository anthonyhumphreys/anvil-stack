import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { AlertTriangle, ChevronDown, ChevronRight, Code, RefreshCw } from 'lucide-react';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  themeVariables: {
    primaryColor: '#2c2f33',
    primaryTextColor: '#f5f2ec',
    primaryBorderColor: '#555656',
    lineColor: '#8f8880',
    secondaryColor: '#232528',
    tertiaryColor: '#1a1b1d',
    nodeTextColor: '#f5f2ec',
    mainBkg: '#2c2f33',
    nodeBorder: '#555656',
    clusterBkg: '#232528',
    edgeLabelBackground: '#232528',
    fontFamily: 'inherit',
  },
});

interface ArchitectureDiagramProps {
  mermaidSource: string;
}

/**
 * Sanitise common LLM mermaid output issues:
 * - Literal \n sequences
 * - Node labels with unescaped special chars inside brackets/parens
 * - Overly long labels that break the renderer
 */
function sanitiseMermaidSource(raw: string): string {
  let src = raw.replace(/\\n/g, '\n');

  // Truncate very long node labels (>80 chars) which commonly break mermaid
  src = src.replace(/(\[|[\(])([^\]\)]{80,?)(\]|[\)])/g, (_match, open, content, close) => {
    const truncated = content.slice(0, 77) + '...';
    return `${open}${truncated}${close}`;
  });

  // Escape problematic chars inside node labels (parentheses inside square brackets etc.)
  // Replace inner parens/brackets in labels with unicode equivalents
  src = src.replace(/\[([^\]]+)\]/g, (_match, content: string) => {
    const safe = content.replace(/\(/g, '&#40;').replace(/\)/g, '&#41;');
    return `[${safe}]`;
  });

  return src;
}

export function ArchitectureDiagram({ mermaidSource }: ArchitectureDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!containerRef.current || !mermaidSource) return;

    setRenderError(null);
    const id = `mermaid-${Date.now()}-${retryCount}`;
    const sanitised = sanitiseMermaidSource(mermaidSource);

    mermaid
      .render(id, sanitised)
      .then(({ svg }) => {
        if (containerRef.current) {
          // Mermaid returns SVG — sanitize with DOMPurify before inserting
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
        }
      })
      .catch((err) => {
        console.error('[Mermaid] Render error:', err);
        setRenderError(err instanceof Error ? err.message : String(err));
        // Clean up any partial render mermaid may have left in the DOM
        const stale = document.getElementById(id);
        stale?.remove();
      });
  }, [mermaidSource, retryCount]);

  if (!mermaidSource) {
    return <p className="text-sm text-text-tertiary">No architecture diagram available</p>;
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      {/* Rendered diagram */}
      <div ref={containerRef} className={`overflow-auto p-4 ${renderError ? 'hidden' : ''}`} />

      {/* Error state */}
      {renderError && (
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            <div className="flex-1 min-w-0">
              <p className="text-base text-text-secondary">
                Diagram could not be rendered. The mermaid source may contain unsupported syntax.
              </p>
            </div>
            <button
              onClick={() => setRetryCount((c) => c + 1)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>

          {/* Collapsible raw source */}
          <div>
            <button
              onClick={() => setShowSource(!showSource)}
              className="flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-secondary"
            >
              {showSource ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Code size={12} />
              View diagram source
            </button>
            {showSource && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-bg-primary p-3 font-mono text-sm text-text-secondary">
                {mermaidSource}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
