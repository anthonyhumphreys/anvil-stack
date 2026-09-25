import { useSettingsContext } from '../SettingsContext';
import { SettingsPanel } from '../settings-ui';

export function ReviewCategory() {
  const { draft } = useSettingsContext();
  const { settings } = draft;

  return (
    <SettingsPanel
      panelId="rubrics"
      title="Code Review Rubrics"
      description="Leave a rubric empty to use the built-in default for that review mode."
      saveKeys={['codeReviewQuickGlanceRubric', 'codeReviewSeniorDevRubric']}
      autosave
    >
      <div className="space-y-1">
        <label className="block text-sm text-text-secondary">Quick Glance Rubric</label>
        <p className="text-xs text-text-tertiary">
          Custom review criteria for quick reviews. Leave empty to use the default.
        </p>
        <textarea
          value={settings.codeReviewQuickGlanceRubric ?? ''}
          onChange={(e) => draft.update('codeReviewQuickGlanceRubric', e.target.value)}
          placeholder="e.g. Focus on naming conventions, unused imports, and obvious null checks..."
          rows={4}
          className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>
      <div className="space-y-1">
        <label className="block text-sm text-text-secondary">Senior Dev Review Rubric</label>
        <p className="text-xs text-text-tertiary">
          Custom review criteria for thorough reviews. Leave empty to use the default.
        </p>
        <textarea
          value={settings.codeReviewSeniorDevRubric ?? ''}
          onChange={(e) => draft.update('codeReviewSeniorDevRubric', e.target.value)}
          placeholder="e.g. Check for SOLID violations, test coverage gaps, race conditions, N+1 queries..."
          rows={4}
          className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>
    </SettingsPanel>
  );
}
