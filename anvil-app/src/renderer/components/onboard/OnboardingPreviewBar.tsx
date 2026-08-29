import { Eye, X } from 'lucide-react';

interface OnboardingPreviewBarProps {
  onExit: () => void;
}

export function OnboardingPreviewBar({ onExit }: OnboardingPreviewBarProps) {
  return (
    <div className="fixed inset-x-0 top-10 z-20 flex items-center justify-center px-4">
      <div className="flex items-center gap-3 rounded-lg border border-info/40 bg-bg-elevated px-3 py-2 text-xs text-text-secondary">
        <Eye size={14} className="shrink-0 text-info" aria-hidden="true" />
        <span>Preview mode. Changes are not saved.</span>
        <button
          type="button"
          onClick={onExit}
          className="ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-text-primary transition-colors hover:bg-bg-hover"
        >
          <X size={13} aria-hidden="true" />
          Exit preview
        </button>
      </div>
    </div>
  );
}
