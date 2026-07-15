import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileWarning, LoaderCircle } from 'lucide-react';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import type { ChatArtifact, ChatArtifactFile } from '../../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  themeVariables: {
    primaryColor: '#172033',
    primaryTextColor: '#f8fbff',
    primaryBorderColor: '#33415f',
    lineColor: '#95a3b8',
    secondaryColor: '#111827',
    tertiaryColor: '#0b1020',
    edgeLabelBackground: '#111827',
    fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
  },
});

interface ArtifactPreviewProps {
  artifact: ChatArtifact;
  mode: 'preview' | 'source';
}

const BINARY_KINDS = new Set<ChatArtifact['kind']>(['docx', 'pptx', 'pdf', 'xlsx']);

export function ArtifactPreview({ artifact, mode }: ArtifactPreviewProps) {
  if (mode === 'source' || artifact.kind === 'code' || artifact.kind === 'data') {
    if (BINARY_KINDS.has(artifact.kind)) {
      return <BinarySourceNotice artifact={artifact} />;
    }
    return <SourcePreview content={artifact.content} />;
  }

  switch (artifact.kind) {
    case 'html':
      return (
        <iframe
          title={artifact.title}
          sandbox=""
          srcDoc={artifact.content}
          className="h-full min-h-[520px] w-full bg-white"
        />
      );
    case 'markdown':
      return (
        <div className="mx-auto max-w-3xl px-5 py-4">
          <MarkdownRenderer content={artifact.content} />
        </div>
      );
    case 'mermaid':
    case 'diagram':
      return <MermaidPreview source={artifact.content} />;
    case 'csv':
      return <TabularPreview sheets={[{ name: 'CSV', rows: parseCsv(artifact.content) }]} />;
    case 'docx':
      return <DocxPreview key={`${artifact.id}:${artifact.version}`} artifact={artifact} />;
    case 'pptx':
      return <PptxPreview key={`${artifact.id}:${artifact.version}`} artifact={artifact} />;
    case 'pdf':
      return <PdfPreview key={`${artifact.id}:${artifact.version}`} artifact={artifact} />;
    case 'xlsx':
      return <XlsxPreview key={`${artifact.id}:${artifact.version}`} artifact={artifact} />;
    default:
      return (
        <pre className="min-h-full whitespace-pre-wrap p-4 text-sm leading-relaxed text-text-secondary">
          {artifact.content}
        </pre>
      );
  }
}

function SourcePreview({ content }: { content: string }) {
  return (
    <pre className="min-h-full overflow-auto p-4 font-mono text-xs leading-relaxed text-text-secondary">
      <code>{content}</code>
    </pre>
  );
}

function BinarySourceNotice({ artifact }: { artifact: ChatArtifact }) {
  const detail =
    artifact.content.length <= 500
      ? artifact.content
      : 'Binary files do not have a useful text source view.';
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <FileWarning className="mx-auto text-text-tertiary" size={24} />
        <p className="mt-3 text-sm font-medium text-text-primary">Binary artifact</p>
        <p className="mt-1 text-sm leading-relaxed text-text-tertiary">
          {detail || 'Binary files do not have a useful text source view.'}
        </p>
      </div>
    </div>
  );
}

function MermaidPreview({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `canvas-mermaid-${crypto.randomUUID()}`;
    setError(null);

    void mermaid
      .render(id, source.replace(/\\n/g, '\n'))
      .then(({ svg }) => {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['foreignObject'],
        });
      })
      .catch((renderError: unknown) => {
        document.getElementById(id)?.remove();
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : String(renderError));
        }
      });

    return () => {
      cancelled = true;
      document.getElementById(id)?.remove();
    };
  }, [source]);

  if (error) return <PreviewError title="Mermaid diagram could not be rendered" detail={error} />;

  return (
    <div className="flex min-h-full items-start justify-center overflow-auto p-6">
      <div ref={ref} className="min-w-0 max-w-full [&_svg]:h-auto [&_svg]:max-w-full" />
    </div>
  );
}

function useArtifactFile(artifact: ChatArtifact): {
  file: ChatArtifactFile | null;
  error: string | null;
} {
  const [file, setFile] = useState<ChatArtifactFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    void window.anvil.chat
      .readArtifactFile(artifact.id)
      .then((nextFile) => {
        if (!cancelled) setFile(nextFile);
      })
      .catch((readError: unknown) => {
        if (!cancelled) {
          setError(readError instanceof Error ? readError.message : String(readError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.version]);

  return { file, error };
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function DocxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error } = useArtifactFile(artifact);
  const [html, setHtml] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setHtml(null);
    setConversionError(null);
    void import('mammoth/mammoth.browser')
      .then((mammoth) =>
        mammoth.convertToHtml({ arrayBuffer: base64ToArrayBuffer(file.dataBase64) }),
      )
      .then(({ value }) => {
        if (!cancelled) setHtml(DOMPurify.sanitize(value));
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setConversionError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (error || conversionError) {
    return <PreviewError title="Word document could not be rendered" detail={error ?? conversionError} />;
  }
  if (!html) return <PreviewLoading label="Rendering Word document" />;

  return (
    <div className="min-h-full bg-slate-300/10 px-4 py-6 sm:px-8">
      <article
        className="mx-auto min-h-[720px] max-w-[816px] bg-slate-50 px-10 py-12 text-sm leading-relaxed text-slate-900 shadow-lg [&_a]:text-blue-700 [&_h1]:mb-5 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mb-4 [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:p-2 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function PptxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error } = useArtifactFile(artifact);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!file || !containerRef.current) return;
    let viewer: import('@aiden0z/pptx-renderer/browser').PptxViewer | null = null;
    let cancelled = false;
    setRenderError(null);
    containerRef.current.replaceChildren();

    const container = containerRef.current;
    void import('@aiden0z/pptx-renderer/browser')
      .then(({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) =>
        PptxViewer.open(base64ToArrayBuffer(file.dataBase64), container, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
        }),
      )
      .then((nextViewer) => {
        if (cancelled) nextViewer.destroy();
        else viewer = nextViewer;
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setRenderError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });

    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [file]);

  if (error || renderError) {
    return <PreviewError title="PowerPoint could not be rendered" detail={error ?? renderError} />;
  }

  return (
    <div className="min-h-full overflow-auto bg-slate-950/40 p-4">
      {!file && <PreviewLoading label="Rendering PowerPoint" />}
      <div ref={containerRef} className="mx-auto min-h-full max-w-6xl" />
    </div>
  );
}

function PdfPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error } = useArtifactFile(artifact);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(
      new Blob([base64ToArrayBuffer(file.dataBase64)], { type: file.mimeType }),
    );
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  if (error) return <PreviewError title="PDF could not be opened" detail={error} />;
  if (!url) return <PreviewLoading label="Opening PDF" />;
  return <iframe title={artifact.title} src={url} className="h-full min-h-[640px] w-full bg-slate-100" />;
}

interface PreviewSheet {
  name: string;
  rows: string[][];
}

function XlsxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error } = useArtifactFile(artifact);
  const [sheets, setSheets] = useState<PreviewSheet[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    try {
      void import('xlsx')
        .then((XLSX) => {
          if (cancelled) return;
          const workbook = XLSX.read(base64ToArrayBuffer(file.dataBase64), {
            type: 'array',
            cellDates: true,
          });
          setSheets(
            workbook.SheetNames.map((name) => ({
              name,
              rows: XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], {
                header: 1,
                raw: false,
                defval: '',
              }),
            })),
          );
          setParseError(null);
        })
        .catch((nextError: unknown) => {
          if (!cancelled) {
            setParseError(nextError instanceof Error ? nextError.message : String(nextError));
          }
        });
    } catch (nextError) {
      setParseError(nextError instanceof Error ? nextError.message : String(nextError));
    }
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (error || parseError) {
    return <PreviewError title="Spreadsheet could not be rendered" detail={error ?? parseError} />;
  }
  if (!sheets) return <PreviewLoading label="Rendering spreadsheet" />;
  return <TabularPreview sheets={sheets} />;
}

function TabularPreview({ sheets }: { sheets: PreviewSheet[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet] ?? { name: 'Sheet', rows: [] };
  const visibleRows = sheet.rows.slice(0, 1_000);
  const columnCount = Math.min(100, Math.max(0, ...visibleRows.map((row) => row.length)));

  useEffect(() => setActiveSheet(0), [sheets]);

  return (
    <div className="flex min-h-full flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-bg-secondary px-2 pt-2">
          {sheets.map((candidate, index) => (
            <button
              key={`${candidate.name}-${index}`}
              type="button"
              onClick={() => setActiveSheet(index)}
              className={`shrink-0 rounded-t-md border border-b-0 px-3 py-1.5 text-xs transition-colors ${
                index === activeSheet
                  ? 'border-border bg-bg-primary text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-tertiary">This sheet is empty.</div>
        ) : (
          <table className="border-separate border-spacing-0 font-mono text-xs text-text-secondary">
            <thead className="sticky top-0 z-10 bg-bg-elevated">
              <tr>
                <th className="sticky left-0 z-20 border-b border-r border-border bg-bg-elevated px-2 py-1.5 text-text-tertiary" />
                {Array.from({ length: columnCount }, (_, index) => (
                  <th
                    key={index}
                    className="min-w-28 border-b border-r border-border px-2 py-1.5 text-left font-medium text-text-tertiary"
                  >
                    {columnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-bg-tertiary/40">
                  <th className="sticky left-0 border-b border-r border-border/60 bg-bg-secondary px-2 py-1.5 text-right font-normal text-text-tertiary">
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: columnCount }, (_, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="max-w-80 border-b border-r border-border/40 px-2 py-1.5 align-top"
                    >
                      <span className="block max-h-32 overflow-hidden whitespace-pre-wrap break-words">
                        {row[columnIndex] ?? ''}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheet.rows.length > 1_000 && (
        <p className="shrink-0 border-t border-border/60 bg-bg-secondary px-3 py-2 text-xs text-text-tertiary">
          Showing the first 1,000 of {sheet.rows.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

function columnLabel(index: number): string {
  let label = '';
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function PreviewLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-full items-center justify-center gap-2 p-6 text-sm text-text-tertiary">
      <LoaderCircle className="animate-spin" size={16} />
      {label}
    </div>
  );
}

function PreviewError({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-lg border border-warning/25 bg-warning/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-warning">
          <AlertTriangle size={15} />
          {title}
        </div>
        {detail && <p className="mt-2 break-words text-xs leading-relaxed text-text-tertiary">{detail}</p>}
      </div>
    </div>
  );
}
