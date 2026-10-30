import {
  Braces,
  ChartColumn,
  ListChecks,
  Database,
  Eye,
  FileSearch,
  FileText,
  LayoutTemplate,
  Package,
  Shapes,
  ShieldAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ChatArtifact } from '../../../shared/types';

const KIND_ICONS: Record<string, LucideIcon> = {
  artifact: FileText,
  sketch: Shapes,
  review: FileSearch,
  validation: ListChecks,
  findings: ShieldAlert,
  dependencies: Package,
  pipeline: Workflow,
  data: ChartColumn,
};

export function surfaceKindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? LayoutTemplate;
}

export function SurfaceKindIcon({
  kind,
  size = 14,
  className = '',
}: {
  kind: string;
  size?: number;
  className?: string;
}) {
  const Icon = surfaceKindIcon(kind);
  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`.trim()} />;
}

export function artifactKindIcon(kind: ChatArtifact['kind']): LucideIcon {
  if (kind === 'markdown' || kind === 'text' || kind === 'docx' || kind === 'pdf') return FileText;
  if (kind === 'html' || kind === 'pptx') return Eye;
  if (kind === 'csv' || kind === 'xlsx') return Database;
  return Braces;
}

export function ArtifactIcon({
  kind,
  size = 13,
  className = '',
}: {
  kind: ChatArtifact['kind'];
  size?: number;
  className?: string;
}) {
  const Icon = artifactKindIcon(kind);
  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`.trim()} />;
}
