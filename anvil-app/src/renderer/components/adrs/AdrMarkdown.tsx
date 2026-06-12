import { useEffect, useRef, useState, isValidElement, cloneElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import type { Components } from 'react-markdown';

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

function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current || !source) return;
    setError(null);
    const id = `adr-mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    mermaid
      .render(id, source.replace(/\\n/g, '\n'))
      .then(({ svg }) => {
        if (ref.current) {
          ref.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        document.getElementById(id)?.remove();
      });
  }, [source]);

  if (error) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
        <p className="mb-2 text-xs text-warning">Mermaid diagram could not be rendered</p>
        <pre className="max-h-40 overflow-auto text-xs text-text-tertiary">{source}</pre>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="my-3 overflow-auto rounded-lg border border-border bg-bg-secondary p-4"
    />
  );
}

function CodeBlock({ children, className, ...rest }: any) {
  const isFenced = rest['data-fenced'];
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];

  if (isFenced && lang === 'mermaid') {
    return <MermaidBlock source={String(children).trim()} />;
  }

  if (isFenced) {
    return (
      <div className="group relative my-2 rounded-lg border border-border bg-bg-primary">
        {lang && (
          <div className="border-b border-border px-3 py-1 text-xs text-text-tertiary">{lang}</div>
        )}
        <pre className="overflow-auto p-3">
          <code className="text-sm text-text-primary">{children}</code>
        </pre>
      </div>
    );
  }

  return (
    <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-sm text-accent">{children}</code>
  );
}

const components: Components = {
  code: CodeBlock as any,
  pre: ({ children }) => {
    if (isValidElement(children)) {
      return cloneElement(children as any, { 'data-fenced': true });
    }
    return <pre>{children}</pre>;
  },

  h1: ({ children }) => (
    <h1 className="mb-3 mt-6 text-2xl font-bold text-text-primary first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-5 text-xl font-semibold text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-4 text-lg font-semibold text-text-primary">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-base font-semibold text-text-primary">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-sm font-semibold text-text-primary">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-sm font-semibold text-text-tertiary">{children}</h6>
  ),

  p: ({ children }) => (
    <p className="mb-3 text-sm leading-relaxed text-text-secondary">{children}</p>
  ),

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-info underline hover:text-info/80"
    >
      {children}
    </a>
  ),

  ul: ({ children }) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 text-sm text-text-secondary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 text-sm text-text-secondary">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-3 border-accent/40 bg-accent/5 py-2 pl-4 pr-3 text-text-secondary italic">
      {children}
    </blockquote>
  ),

  table: ({ children }) => (
    <div className="my-3 overflow-auto rounded-lg border border-border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-bg-elevated">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border-subtle last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-text-tertiary">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-4 py-2 text-text-secondary">{children}</td>,

  hr: () => <hr className="my-6 border-border-subtle" />,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
};

interface AdrMarkdownProps {
  content: string;
}

export function AdrMarkdown({ content }: AdrMarkdownProps) {
  return (
    <div className="adr-markdown [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
