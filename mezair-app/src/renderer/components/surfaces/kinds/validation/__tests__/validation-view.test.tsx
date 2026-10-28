import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ValidationInline } from '../index';
import { validationFixture } from '../../../../chat/replay/ValidationPreview';
import { validationWorkflowPrompt } from '../../../../../../shared/surfaces/kinds/validation';
import type { ValidationSurfaceData } from '../../../../../../shared/surfaces/kinds/validation';

function markup(scenario: Parameters<typeof validationFixture>[0], readOnly = false) {
  return renderToStaticMarkup(
    <ValidationInline
      intent={validationFixture(scenario)}
      presentation="inline"
      onAction={async () => ({ ok: true })}
      onComment={() => undefined}
      onOpenStage={() => undefined}
      readOnly={readOnly}
    />,
  );
}
describe('inline validation', () => {
  it('shows outcomes and provenance with evidence collapsed, without a scenario form', () => {
    const html = markup('results');
    expect(html).toContain('Validation found failures');
    expect(html).toContain('Recorded by Mezair');
    expect(html).toContain('Reported by agent');
    expect(html).toContain('Show evidence');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(html).not.toContain('Save approved scenario');
    expect(html).not.toContain('Replay scenario');
  });
  it('labels planned, running and stale states and keeps mutations out of read-only views', () => {
    expect(markup('plan')).toContain('Unchecked');
    expect(markup('running')).toContain('Stop validation');
    expect(markup('stale')).toContain('Stale evidence');
    expect(markup('results', true)).not.toContain('Save as workflow');
    expect(markup('results', true)).not.toContain('Rerun failures');
  });
  it('exports reusable instructions without carrying receipts or a previous snapshot', () => {
    const data = validationFixture('results').payload.data as ValidationSurfaceData;
    const prompt = validationWorkflowPrompt(data);
    expect(prompt).toContain('explicitly requests validation');
    expect(prompt).toContain("Use this workflow run's linked work item");
    expect(prompt).toContain('refresh acceptance criteria');
    expect(prompt).not.toContain(data.snapshot.head);
    expect(prompt).not.toContain('12 tests passed');
    expect(prompt).toContain('Do not infer human acceptance');
  });
});
