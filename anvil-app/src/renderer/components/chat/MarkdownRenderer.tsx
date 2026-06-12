import { isValidElement, cloneElement, memo } from 'react';
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
    <div className="markdown-body overflow-visible text-sm leading-relaxed text-text-primary [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {displayContent}
      </ReactMarkdown>
    </div>
  );
});

export function linkifyBareFileReferences(content: string): string {
  const segments = splitMarkdownCodeSegments(content);
  return segments
    .map((segment) => (segment.code ? segment.value : linkifyBareFileReferencesInText(segment.value)))
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
