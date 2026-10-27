import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Building2,
  ChevronDown,
  ClipboardList,
  Code,
  Database,
  Eye,
  GitPullRequest,
  GraduationCap,
  Gauge,
  Headphones,
  Palette,
  Presentation,
  Radio,
  Search,
  SearchCheck,
  Shield,
  Wrench,
} from 'lucide-react';
import type { Persona, UserRole } from '../../../shared/types';
import { groupPersonasForRole } from '../../utils/persona-groups';
import {
  filterPersonas,
  loadRecentPersonaIds,
  recordRecentPersonaId,
  splitPersonaRecents,
} from './persona-recents';

export const PERSONA_ICONS: Record<string, React.ReactNode> = {
  Code: <Code size={14} />,
  Building2: <Building2 size={14} />,
  Shield: <Shield size={14} />,
  Eye: <Eye size={14} />,
  BookOpen: <BookOpen size={14} />,
  ClipboardList: <ClipboardList size={14} />,
  Presentation: <Presentation size={14} />,
  Palette: <Palette size={14} />,
  GraduationCap: <GraduationCap size={14} />,
  Database: <Database size={14} />,
  Headphones: <Headphones size={14} />,
  Wrench: <Wrench size={14} />,
  Radio: <Radio size={14} />,
  SearchCheck: <SearchCheck size={14} />,
  GitPullRequest: <GitPullRequest size={14} />,
  Gauge: <Gauge size={14} />,
};

/**
 * CH10 — persona picker with recents on top and type-to-filter.
 */
export function ChatPersonaPicker({
  personas,
  activePersona,
  userRole,
  personaColour,
  onSelect,
}: {
  personas: Persona[];
  activePersona: Persona | null;
  userRole: UserRole;
  personaColour: string;
  onSelect: (persona: Persona) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentPersonaIds());
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setRecentIds(loadRecentPersonaIds());
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const select = (persona: Persona) => {
    setRecentIds(recordRecentPersonaId(persona.id));
    setOpen(false);
    onSelect(persona);
  };

  const filtered = filterPersonas(personas, query);
  const { recent, rest } = splitPersonaRecents(filtered, recentIds);
  const groups = groupPersonasForRole(rest, userRole);

  const renderPersona = (persona: Persona) => (
    <button
      key={persona.id}
      type="button"
      onClick={() => select(persona)}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-bg-tertiary ${
        activePersona?.id === persona.id ? 'bg-bg-tertiary' : ''
      }`}
    >
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: persona.colour }}
      />
      <span className="shrink-0 text-text-secondary">{PERSONA_ICONS[persona.icon]}</span>
      <span className="min-w-0">
        <span className="block font-medium text-text-primary">{persona.name}</span>
        <span className="block truncate text-xs text-text-tertiary">{persona.description}</span>
      </span>
    </button>
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 max-w-44 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        aria-label="Select persona"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: personaColour }}
        />
        {activePersona ? PERSONA_ICONS[activePersona.icon] : null}
        <span className="truncate">{activePersona?.name ?? 'Select persona'}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select persona"
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(32rem,calc(100vh-8rem))] w-72 overflow-y-auto rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-overlay"
        >
          <div className="sticky top-0 border-b border-border/60 bg-bg-elevated p-1.5">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter personas…"
                aria-label="Filter personas"
                className="w-full rounded-lg border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50"
              />
            </div>
          </div>

          <div className="p-1.5">
            {recent.length > 0 && (
              <div>
                <p className="px-3 py-1.5 text-eyebrow font-semibold uppercase text-text-muted">
                  Recent
                </p>
                {recent.map(renderPersona)}
              </div>
            )}
            {groups.map((group, groupIndex) => (
              <div
                key={group.id}
                className={
                  groupIndex > 0 || recent.length > 0 ? 'mt-1 border-t border-border/60 pt-1' : ''
                }
              >
                {group.label && (
                  <p className="px-3 py-1.5 text-eyebrow font-semibold uppercase text-text-muted">
                    {group.label}
                  </p>
                )}
                {group.personas.map(renderPersona)}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-text-tertiary">
                No personas match “{query.trim()}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
