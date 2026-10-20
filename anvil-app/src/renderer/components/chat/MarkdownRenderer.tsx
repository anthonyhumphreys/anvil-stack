import { isValidElement, cloneElement, memo, useState } from 'react';
import type { ComponentProps } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { FileReference } from './FileReference';
import { parseEditorFileLocation } from '../../../shared/editor-file-link';
import type { Components } from 'react-markdown';

const BARE_FILE_REFERENCE_RE =
  /(^|[\s([{"'`])((?:(?:\.{1,2}|~)?\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>()\]{}'"`]+?)([),.;:!?]?)(?=$|\s|[\])}"'])/g;

const components: Components = {
  // Code — both inline and fenced, CodeBlock handles disambiguation
  code: CodeBlock as any,
  // Mark fenced code blocks with data-fenced prop, then unwrap <pre>
  // This allows CodeBlock to distinguish fenced blocks (even without a language) from inline code
  pre: ({ children }) => {
    if (isValidElement(children)) {
      return cloneElement(children as any, { 'data-fenced': true });
    }
    return <pre>{children}</pre>;
  },

  // Headings
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-xl font-semibold text-text-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-lg font-semibold text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-base font-semibold text-text-primary">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-sm font-semibold text-text-primary">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-sm font-semibold text-text-primary">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-sm font-semibold text-text-primary">{children}</h6>
  ),

  // Paragraph
  p: ({ children }) => <p className="mb-2 text-sm leading-relaxed text-text-primary">{children}</p>,

  // Links — render local file paths as styled chips, external URLs as normal links
  a: ({ children, href }) => {
    const fileLocation = parseEditorFileLocation(href);
    if (fileLocation) {
      const fileName = fileLocation.path.split(/[\\/]/).pop() ?? fileLocation.path;
      return (
        <FileReference
          fileName={fileName}
          line={fileLocation.line}
          column={fileLocation.column}
          filePath={fileLocation.path}
          isAbsolute={fileLocation.isAbsolute}
        />
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-info underline hover:text-info/80"
      >
        {children}
      </a>
    );
  },

  // Lists
  ul: ({ children }) => (
    <ul className="mb-2 list-outside list-disc pl-6 text-sm text-text-primary marker:text-text-secondary">
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      {...props}
      className="mb-2 list-outside list-decimal pl-8 text-sm text-text-primary marker:font-mono marker:tabular-nums marker:text-text-secondary"
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="mb-1 pl-1 leading-relaxed">{children}</li>,

  // Blockquote
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-info/50 pl-3 italic text-text-secondary">
      {children}
    </blockquote>
  ),

  // Table
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="w-full border border-border-subtle text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="bg-bg-elevated px-3 py-1.5 text-left font-medium text-text-primary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-border-subtle px-3 py-1.5 text-text-secondary">{children}</td>
  ),

  // Keep markdown images inside the reader's width and make loading failures legible.
  img: ({ src, alt, ...props }) => <MarkdownImage key={src} src={src} alt={alt ?? ''} {...props} />,

  // Horizontal rule
  hr: () => <hr className="my-4 border-border-subtle" />,

  // Strong / emphasis
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
};

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const displayContent = linkifyBareFileReferences(content);

  return (
    <div className="markdown-body overflow-visible text-sm leading-relaxed text-text-primary [overflow-wrap:anywhere] [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {displayContent}
      </ReactMarkdown>
    </div>
  );
});

function MarkdownImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const width = Number(props.width);
  const height = Number(props.height);
  const aspectRatio = width > 0 && height > 0 ? `${width} / ${height}` : '16 / 9';

  if (!src) return alt ? <span>{alt}</span> : null;

  return (
    <span
      style={{ aspectRatio }}
      className="relative my-2 inline-flex aspect-video max-h-96 w-full max-w-xl items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-tertiary align-middle"
      role={failed ? 'img' : undefined}
      aria-label={
        failed
          ? alt
            ? `${alt}: image could not be loaded`
            : 'Image could not be loaded'
          : undefined
      }
      aria-busy={!loaded && !failed}
    >
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center gap-2 overflow-auto px-3 py-2 text-xs text-text-tertiary">
          <AlertTriangle size={14} className="shrink-0 text-warning" />
          <span className="break-words">
            {alt ? `${alt} — image could not be loaded.` : 'Image could not be loaded.'}
          </span>
        </span>
      ) : !loaded ? (
        <span
          role="status"
          className="absolute inset-0 inline-flex items-center justify-center gap-2 px-3 py-2 text-xs text-text-tertiary"
        >
          <LoaderCircle size={14} className="shrink-0 animate-spin" />
          Loading image…
        </span>
      ) : null}
      <img
        {...props}
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`absolute inset-0 h-full w-full object-contain ${loaded && !failed ? 'opacity-100' : 'opacity-0'}`}
      />
    </span>
  );
}

export function linkifyBareFileReferences(content: string): string {
  const segments = splitMarkdownCodeSegments(content);
  return segments
    .map((segment) =>
      segment.code ? segment.value : linkifyBareFileReferencesInText(segment.value),
    )
    .join('');
}

function linkifyBareFileReferencesInText(content: string): string {
  return content.replace(BARE_FILE_REFERENCE_RE, (match, prefix, rawPath, trailing, offset) => {
    if (isInsideMarkdownLink(content, offset + prefix.length)) return match;

    const fileLocation = parseEditorFileLocation(rawPath, { requireFileSignal: true });
    if (!fileLocation) return match;

    const escapedPath = rawPath.replace(/([\\\]])/g, '\\$1');
    return `${prefix}[${rawPath}](${escapedPath})${trailing}`;
  });
}

function splitMarkdownCodeSegments(content: string): Array<{ value: string; code: boolean }> {
  const segments: Array<{ value: string; code: boolean }> = [];
  let index = 0;

  while (index < content.length) {
    const fenceIndex = content.indexOf('```', index);
    const inlineIndex = content.indexOf('`', index);
    const nextIndex =
      fenceIndex === -1
        ? inlineIndex
        : inlineIndex === -1
          ? fenceIndex
          : Math.min(fenceIndex, inlineIndex);

    if (nextIndex === -1) {
      segments.push({ value: content.slice(index), code: false });
      break;
    }

    if (nextIndex > index) {
      segments.push({ value: content.slice(index, nextIndex), code: false });
    }

    const marker = content.startsWith('```', nextIndex) ? '```' : '`';
    const endIndex = content.indexOf(marker, nextIndex + marker.length);
    if (endIndex === -1) {
      segments.push({ value: content.slice(nextIndex), code: true });
      break;
    }

    segments.push({
      value: content.slice(nextIndex, endIndex + marker.length),
      code: true,
    });
    index = endIndex + marker.length;
  }

  return segments;
}

function isInsideMarkdownLink(content: string, rawPathStart: number): boolean {
  return content.slice(Math.max(0, rawPathStart - 2), rawPathStart) === '](';
}
