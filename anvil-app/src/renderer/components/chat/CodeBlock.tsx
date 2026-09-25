import {
  Component,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type ErrorInfo,
} from 'react';
import { Check, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { highlightCode } from './shiki';
import { copyTextToClipboard } from '../../utils/clipboard';

const COLLAPSE_THRESHOLD = 20;
const HIGHLIGHT_DEBOUNCE_MS = 120;

interface CodeBlockProps {
  children?: ReactNode;
  className?: string;
  node?: any;
  /** Injected by our custom `pre` override to mark fenced blocks */
  'data-fenced'?: boolean;
}

/**
 * Handles both inline code and fenced code blocks from react-markdown.
 * Inline: rendered as simple <code> span.
 * Fenced: full Shiki-highlighted block with header, copy, line numbers, collapse.
 *
 * Discrimination: fenced blocks are marked with data-fenced={true} by our
 * custom `pre` override in MarkdownRenderer (which clones the child element
 * and injects the prop). Alternatively, blocks with className "language-*"
 * are always fenced. Blocks with neither are inline.
 */
export function CodeBlock({ children, className, 'data-fenced': isFenced }: CodeBlockProps) {
  // Detect language from className like "language-typescript"
  const langMatch = className?.match(/language-(\w+)/);
  const language = langMatch?.[1] ?? '';

  // Fenced if explicitly marked OR if has a language class
  if (isFenced || language) {
    return (
      <CodeBlockErrorBoundary code={extractText(children)}>
        <FencedCodeBlock language={language || 'text'}>{children}</FencedCodeBlock>
      </CodeBlockErrorBoundary>
    );
  }

  // Inline code
  return <code className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-sm">{children}</code>;
}

/** Error boundary — falls back to plain <pre> if Shiki/rendering crashes */
class CodeBlockErrorBoundary extends Component<
  { children: ReactNode; code: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('CodeBlock render error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <pre className="my-2 overflow-auto rounded-md border border-border-subtle bg-bg-tertiary p-3 text-xs font-mono text-text-secondary">
          <code>{this.props.code}</code>
        </pre>
      );
    }
    return this.props.children;
  }
}

function FencedCodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [highlightedResult, setHighlightedResult] = useState<{
    code: string;
    language: string;
    html: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = extractText(children).trimEnd();
  const lineCount = code.split('\n').length;
  const isLong = lineCount > COLLAPSE_THRESHOLD;
  const highlightedHtml =
    highlightedResult?.code === code && highlightedResult.language === language
      ? highlightedResult.html
      : null;

  useEffect(() => {
    let cancelled = false;

    const timeout = window.setTimeout(() => {
      highlightCode(code, language).then((html) => {
        if (!cancelled) setHighlightedResult({ code, language, html });
      });
    }, HIGHLIGHT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [code, language]);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }, [code]);

  // Clean up timeout on unmount
  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border-subtle">
      {/* Header */}
      <div className="flex items-center justify-between bg-bg-elevated px-3 py-1.5">
        <span className="text-xs text-text-secondary">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-text-tertiary transition-colors hover:text-text-secondary"
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Code body */}
      <div
        className={`overflow-auto bg-bg-tertiary ${isLong && !expanded ? 'max-h-[calc(1.5rem*20+1.5rem)]' : ''}`}
      >
        <div className="flex text-xs leading-relaxed">
          {/* Keep the gutter mounted while code is streaming and syntax highlighting catches up. */}
          <div
            aria-hidden="true"
            data-line-number-gutter
            className="select-none whitespace-nowrap border-r border-border-subtle px-3 py-3 text-right font-mono leading-relaxed text-text-tertiary"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-3 py-3 font-mono leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!leading-relaxed [&_code]:!bg-transparent [&_code]:!leading-relaxed">
            {/* Highlighted code — HTML is pre-sanitized by highlightCode() with DOMPurify */}
            {highlightedHtml ? (
              <div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
            ) : (
              // Fallback while loading
              <pre className="overflow-visible whitespace-pre bg-transparent p-0 text-xs font-mono leading-relaxed text-text-secondary">
                <code>{code}</code>
              </pre>
            )}
          </div>
        </div>
      </div>

      {/* Collapse/expand footer */}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-center gap-1 border-t border-border-subtle bg-bg-elevated px-3 py-1 text-xs text-text-tertiary hover:text-text-secondary"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Show less' : `Show more (${lineCount} lines)`}
        </button>
      )}
    </div>
  );
}

/** Recursively extract text content from React children */
function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as any).props.children);
  }
  return '';
}
