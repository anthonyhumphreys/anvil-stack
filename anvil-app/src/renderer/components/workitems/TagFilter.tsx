interface TagFilterProps {
  allTags: string[];
  selected: string[];
  onChange: (selectedTags: string[]) => void;
}

export function TagFilter({ allTags, selected, onChange }: TagFilterProps) {
  if (allTags.length === 0) return null;

  const toggle = (tag: string) => {
    const next = selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
    onChange(next);
  };

  return (
    <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
      {allTags.map((tag) => {
        const active = selected.includes(tag);
        return (
          <button
            key={tag}
            onClick={() => toggle(tag)}
            className={`shrink-0 rounded-full border px-2 py-0.5 text-sm transition-colors ${
              active
                ? 'border-accent bg-accent text-white'
                : 'border-border text-text-secondary hover:border-text-secondary hover:text-text-primary'
            }`}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}
