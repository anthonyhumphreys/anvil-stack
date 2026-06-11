import { FileCode2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

interface FileReferenceProps {
  fileName: string;
  line?: number;
  column?: number;
  filePath: string;
  isAbsolute: boolean;
}

export function FileReference({
  fileName,
  line,
  column,
  filePath,
  isAbsolute,
}: FileReferenceProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const label = line ? `${fileName}:${line}${column ? `:${column}` : ''}` : fileName;

  return (
    <button
      onClick={() =>
        navigate(
          buildEditorUrl({
            workspaceId: activeWorkspace?.id,
            absolutePath: isAbsolute ? filePath : undefined,
            relativePath: isAbsolute ? undefined : filePath,
            line,
            column,
            source: 'chat',
            title: label,
          }),
        )
      }
      className="inline-flex cursor-pointer items-center gap-1 rounded border border-border-subtle bg-bg-tertiary px-1.5 py-0.5 align-baseline font-mono text-xs text-info transition-colors hover:border-info/35 hover:bg-info/10"
      title={filePath + (line ? `#L${line}` : '')}
    >
      <FileCode2 size={11} className="shrink-0 opacity-60" />
      {label}
    </button>
  );
}
