import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileWarning, LoaderCircle } from 'lucide-react';
import DOMPurify from 'dompurify';
import type { ChatArtifact, ChatArtifactFile } from '../../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { StreamedMermaidPreview } from './StreamedMermaidPreview';

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
      return <StreamedMermaidPreview identity={artifact.id} source={artifact.content} />;
    case 'csv':
      return <TabularPreview sheets={[{ name: 'CSV', rows: parseCsv(artifact.content) }]} />;
    case 'docx':
      return <DocxPreview artifact={artifact} />;
    case 'pptx':
      return <PptxPreview artifact={artifact} />;
    case 'pdf':
      return <PdfPreview artifact={artifact} />;
    case 'xlsx':
      return <XlsxPreview artifact={artifact} />;
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

type PreviewFile = Omit<ChatArtifactFile, 'dataBase64'> & {
  artifactId: string;
  version: number;
  data: ArrayBuffer;
};

function useArtifactFile(artifact: ChatArtifact): {
  file: PreviewFile | null;
  error: string | null;
  loading: boolean;
} {
  const [loadedFile, setLoadedFile] = useState<PreviewFile | null>(null);
  const [loadError, setLoadError] = useState<{
    artifactId: string;
    version: number;
    error: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void window.anvil.chat
      .readArtifactFile(artifact.id)
      .then((nextFile) => {
        if (cancelled) return;
        const { dataBase64, ...metadata } = nextFile;
        setLoadedFile({
          ...metadata,
          artifactId: artifact.id,
          version: artifact.version,
          data: base64ToArrayBuffer(dataBase64),
        });
      })
      .catch((readError: unknown) => {
        if (!cancelled) {
          setLoadError({
            artifactId: artifact.id,
            version: artifact.version,
            error: readError instanceof Error ? readError.message : String(readError),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.version]);

  const file = loadedFile?.artifactId === artifact.id ? loadedFile : null;
  const error =
    loadError?.artifactId === artifact.id && loadError.version === artifact.version
      ? loadError.error
      : null;

  return { file, error, loading: !file || file.version !== artifact.version };
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function DocxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error, loading } = useArtifactFile(artifact);
  const [rendered, setRendered] = useState<{
    artifactId: string;
    version: number;
    html: string;
  } | null>(null);
  const [conversionError, setConversionError] = useState<{
    version: number;
    error: string;
  } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void import('mammoth/mammoth.browser')
      .then((mammoth) => mammoth.convertToHtml({ arrayBuffer: file.data }))
      .then(({ value }) => {
        if (!cancelled) {
          setRendered({
            artifactId: file.artifactId,
            version: file.version,
            html: DOMPurify.sanitize(value),
          });
          setConversionError(null);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setConversionError({
            version: file.version,
            error: nextError instanceof Error ? nextError.message : String(nextError),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const visibleRendered = rendered?.artifactId === artifact.id ? rendered : null;
  const activeConversionError =
    conversionError &&
    conversionError.version === artifact.version &&
    file?.version === artifact.version
      ? conversionError.error
      : null;
  const activeError = error ?? activeConversionError;

  if (!visibleRendered && activeError) {
    return <PreviewError title="Word document could not be rendered" detail={activeError} />;
  }
  if (!visibleRendered) return <PreviewLoading label="Rendering Word document" />;

  const isUpdating =
    loading ||
    !file ||
    file.version !== artifact.version ||
    visibleRendered.version !== file.version;

  return (
    <div className="min-h-full bg-slate-300/10 px-4 py-6 sm:px-8">
      <PreviewUpdateNotice
        label={
          activeError
            ? `Showing version ${visibleRendered.version}; version ${artifact.version} could not be rendered.`
            : isUpdating
              ? `Showing version ${visibleRendered.version} while version ${artifact.version} is prepared.`
              : null
        }
        error={activeError}
      />
      <article
        className="mx-auto min-h-[720px] max-w-[816px] bg-slate-50 px-10 py-12 text-sm leading-relaxed text-slate-900 shadow-lg [&_a]:text-blue-700 [&_h1]:mb-5 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mb-4 [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:p-2 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: visibleRendered.html }}
      />
    </div>
  );
}

function PptxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error, loading } = useArtifactFile(artifact);
  const firstSlotRef = useRef<HTMLDivElement>(null);
  const secondSlotRef = useRef<HTMLDivElement>(null);
  const activeSlotRef = useRef<number | null>(null);
  const activeViewerRef = useRef<import('@aiden0z/pptx-renderer/browser').PptxViewer | null>(null);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [renderedVersion, setRenderedVersion] = useState<number | null>(null);
  const [renderError, setRenderError] = useState<{ version: number; error: string } | null>(null);

  useEffect(() => {
    if (!file) return;
    let viewer: import('@aiden0z/pptx-renderer/browser').PptxViewer | null = null;
    let cancelled = false;
    const slot = activeSlotRef.current === 0 ? 1 : 0;
    const container = slot === 0 ? firstSlotRef.current : secondSlotRef.current;
    if (!container) return;
    setRenderError(null);
    container.replaceChildren();

    void import('@aiden0z/pptx-renderer/browser')
      .then(({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) =>
        PptxViewer.open(file.data, container, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
        }),
      )
      .then((nextViewer) => {
        if (cancelled) {
          nextViewer.destroy();
          return;
        }

        viewer = nextViewer;
        const previousViewer = activeViewerRef.current;
        activeViewerRef.current = nextViewer;
        activeSlotRef.current = slot;
        setActiveSlot(slot);
        setRenderedVersion(file.version);
        setRenderError(null);
        previousViewer?.destroy();
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setRenderError({
            version: file.version,
            error: nextError instanceof Error ? nextError.message : String(nextError),
          });
        }
      });

    return () => {
      cancelled = true;
      if (viewer && activeViewerRef.current !== viewer) viewer.destroy();
      if (activeSlotRef.current !== slot) container.replaceChildren();
    };
  }, [file]);

  useEffect(
    () => () => {
      activeViewerRef.current?.destroy();
      activeViewerRef.current = null;
      activeSlotRef.current = null;
    },
    [],
  );

  const activeError =
    error ?? (renderError?.version === artifact.version ? renderError.error : null);
  const isUpdating =
    loading || !file || file.version !== artifact.version || renderedVersion !== artifact.version;

  if (activeSlot === null && activeError) {
    return <PreviewError title="PowerPoint could not be rendered" detail={activeError} />;
  }

  return (
    <div className="relative min-h-full overflow-auto bg-slate-950/40 p-4">
      <PreviewUpdateNotice
        label={
          activeSlot === null
            ? null
            : activeError
              ? `Showing version ${renderedVersion}; version ${artifact.version} could not be rendered.`
              : isUpdating
                ? `Showing version ${renderedVersion} while version ${artifact.version} is prepared.`
                : null
        }
        error={activeError}
      />
      {activeSlot === null && !activeError && <PreviewLoading label="Rendering PowerPoint" />}
      <div className="relative mx-auto min-h-full max-w-6xl">
        <div
          ref={firstSlotRef}
          aria-hidden={activeSlot !== 0}
          className={`w-full ${activeSlot === 0 ? '' : 'pointer-events-none absolute inset-0 invisible'}`}
        />
        <div
          ref={secondSlotRef}
          aria-hidden={activeSlot !== 1}
          className={`w-full ${activeSlot === 1 ? '' : 'pointer-events-none absolute inset-0 invisible'}`}
        />
      </div>
    </div>
  );
}

function PdfPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error, loading } = useArtifactFile(artifact);
  const [url, setUrl] = useState<{ artifactId: string; version: number; value: string } | null>(
    null,
  );
  const activeUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) return;
    const nextUrl = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
    setUrl({ artifactId: file.artifactId, version: file.version, value: nextUrl });
    return () => {
      if (activeUrlRef.current !== nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  useEffect(() => {
    const nextUrl = url?.value ?? null;
    const previousUrl = activeUrlRef.current;
    activeUrlRef.current = nextUrl;
    if (previousUrl && previousUrl !== nextUrl) URL.revokeObjectURL(previousUrl);

    return () => {
      if (activeUrlRef.current === nextUrl) {
        activeUrlRef.current = null;
        if (nextUrl) URL.revokeObjectURL(nextUrl);
      }
    };
  }, [url]);

  const visibleUrl = url?.artifactId === artifact.id ? url : null;

  if (!visibleUrl && error) return <PreviewError title="PDF could not be opened" detail={error} />;
  if (!visibleUrl) return <PreviewLoading label="Opening PDF" />;

  const isUpdating =
    loading || !file || file.version !== artifact.version || visibleUrl.version !== file.version;

  return (
    <div className="min-h-full">
      <PreviewUpdateNotice
        label={
          error
            ? `Showing version ${visibleUrl.version}; version ${artifact.version} could not be opened.`
            : isUpdating
              ? `Showing version ${visibleUrl.version} while version ${artifact.version} is prepared.`
              : null
        }
        error={error}
      />
      <iframe
        title={artifact.title}
        src={visibleUrl.value}
        className="h-full min-h-[640px] w-full bg-slate-100"
      />
    </div>
  );
}

interface PreviewSheet {
  name: string;
  rows: string[][];
}

function XlsxPreview({ artifact }: { artifact: ChatArtifact }) {
  const { file, error, loading } = useArtifactFile(artifact);
  const [rendered, setRendered] = useState<{
    artifactId: string;
    version: number;
    sheets: PreviewSheet[];
  } | null>(null);
  const [parseError, setParseError] = useState<{ version: number; error: string } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    try {
      void import('xlsx')
        .then((XLSX) => {
          if (cancelled) return;
          const workbook = XLSX.read(file.data, {
            type: 'array',
            cellDates: true,
          });
          const sheets = workbook.SheetNames.map((name) => ({
            name,
            rows: XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], {
              header: 1,
              raw: false,
              defval: '',
            }),
          }));
          setRendered({ artifactId: file.artifactId, version: file.version, sheets });
          setParseError(null);
        })
        .catch((nextError: unknown) => {
          if (!cancelled) {
            setParseError({
              version: file.version,
              error: nextError instanceof Error ? nextError.message : String(nextError),
            });
          }
        });
    } catch (nextError) {
      setParseError({
        version: file.version,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      });
    }
    return () => {
      cancelled = true;
    };
  }, [file]);

  const visibleRendered = rendered?.artifactId === artifact.id ? rendered : null;
  const activeParseError =
    parseError && parseError.version === artifact.version && file?.version === artifact.version
      ? parseError.error
      : null;
  const activeError = error ?? activeParseError;

  if (!visibleRendered && activeError) {
    return <PreviewError title="Spreadsheet could not be rendered" detail={activeError} />;
  }
  if (!visibleRendered) return <PreviewLoading label="Rendering spreadsheet" />;

  const isUpdating =
    loading ||
    !file ||
    file.version !== artifact.version ||
    visibleRendered.version !== file.version;

  return (
    <div className="flex min-h-full flex-col">
      <PreviewUpdateNotice
        label={
          activeError
            ? `Showing version ${visibleRendered.version}; version ${artifact.version} could not be rendered.`
            : isUpdating
              ? `Showing version ${visibleRendered.version} while version ${artifact.version} is prepared.`
              : null
        }
        error={activeError}
      />
      <TabularPreview sheets={visibleRendered.sheets} />
    </div>
  );
}

function TabularPreview({ sheets }: { sheets: PreviewSheet[] }) {
  const [activeSheetKey, setActiveSheetKey] = useState<string | null>(null);
  const activeSheet = Math.max(
    0,
    sheets.findIndex((candidate, index) => `${candidate.name}-${index}` === activeSheetKey),
  );
  const sheet = sheets[activeSheet] ?? { name: 'Sheet', rows: [] };
  const visibleRows = sheet.rows.slice(0, 1_000);
  const columnCount = Math.min(100, Math.max(0, ...visibleRows.map((row) => row.length)));

  return (
    <div className="flex min-h-full flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-bg-secondary px-2 pt-2">
          {sheets.map((candidate, index) => (
            <button
              key={`${candidate.name}-${index}`}
              type="button"
              onClick={() => setActiveSheetKey(`${candidate.name}-${index}`)}
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

function PreviewUpdateNotice({ label, error }: { label?: string | null; error?: string | null }) {
  const active = Boolean(label || error);

  return (
    <div
      className={`flex h-6 items-center gap-2 overflow-hidden px-3 text-xs ${active ? 'border-b border-border-subtle' : ''} ${error ? 'text-warning' : 'text-text-tertiary'}`}
      role={active ? (error ? 'alert' : 'status') : undefined}
      aria-live={active ? 'polite' : undefined}
      aria-hidden={active ? undefined : true}
      title={error ?? label ?? undefined}
    >
      {active &&
        (error ? (
          <AlertTriangle size={14} className="shrink-0" />
        ) : (
          <LoaderCircle size={14} className="shrink-0 animate-spin" />
        ))}
      {active && (
        <span className="truncate">
          {error ? `${label ?? 'Preview update failed.'} ${error}` : label}
        </span>
      )}
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
        {detail && (
          <p className="mt-2 break-words text-xs leading-relaxed text-text-tertiary">{detail}</p>
        )}
      </div>
    </div>
  );
}
