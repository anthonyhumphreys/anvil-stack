import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Calendar } from 'lucide-react';
import type { Iteration } from '../../../shared/types';

interface SprintSelectorProps {
  iterations: Iteration[];
  selected: string[];
  onChange: (selectedPaths: string[]) => void;
  label?: string;
}

export function SprintSelector({
  iterations,
  selected,
  onChange,
  label: labelProp,
}: SprintSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((i) => i !== id) : [...selected, id];
    onChange(next);
  };

  const formatDate = (iso?: string) => {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const displayLabel =
    selected.length === 0
      ? labelProp
        ? `All ${labelProp}s`
        : 'All sprints'
      : selected.length === 1
        ? (iterations.find((i) => i.id === selected[0])?.name ?? labelProp ?? 'Sprint')
        : `${selected.length} ${labelProp ?? 'sprint'}s`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Sprint selector"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm transition-colors hover:bg-bg-tertiary"
      >
        <Calendar size={12} className="text-text-tertiary" />
        <span className="text-text-primary">{displayLabel}</span>
        <ChevronDown size={12} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-border bg-bg-elevated shadow-lg">
          {iterations.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-tertiary">
              No current {labelProp ? `${labelProp}s` : 'iterations'} found. Check settings.
            </div>
          ) : (
            iterations.map((iter) => (
              <label
                key={iter.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-bg-tertiary"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(iter.id)}
                  onChange={() => toggle(iter.id)}
                  className="h-3 w-3 rounded border-border accent-accent"
                />
                <div className="flex-1">
                  <div className="font-medium text-text-primary">{iter.name}</div>
                  {(iter.startDate || iter.finishDate) && (
                    <div className="text-xs text-text-tertiary">
                      {formatDate(iter.startDate)} — {formatDate(iter.finishDate)}
                    </div>
                  )}
                </div>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
