import { describe, expect, it } from 'vitest';
import {
  parseAcpSessionCatalog,
  parseDevinAcpModels,
  parseDevinAuthStatus,
} from '../devin-bridge.service';

describe('parseDevinAcpModels', () => {
  it('parses models from ACP configOptions category "model"', () => {
    const output = [
      JSON.stringify({ method: 'session/update', params: {} }),
      JSON.stringify({
        id: 2,
        result: {
          sessionId: 'session-1',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'swe-2-max',
              options: [
                { value: 'swe-2-max', name: 'SWE-2 Max' },
                { value: 'claude-opus-5-high', name: 'Claude Opus 5 High' },
                { value: 'swe-2-max', name: 'Duplicate' },
              ],
            },
            {
              id: 'mode',
              category: 'mode',
              options: [{ value: 'ask', name: 'Ask' }],
            },
          ],
        },
      }),
    ].join('\n');

    expect(parseDevinAcpModels(output)).toEqual([
      { id: 'swe-2-max', label: 'SWE-2 Max' },
      { id: 'claude-opus-5-high', label: 'Claude Opus 5 High' },
    ]);
  });

  it('accepts the ACP models.availableModels dialect too', () => {
    const output = JSON.stringify({
      id: 2,
      result: {
        models: {
          currentModelId: 'default[]',
          availableModels: [{ modelId: 'swe-2-max', name: 'SWE-2 Max' }],
        },
      },
    });

    expect(parseDevinAcpModels(output)).toEqual([{ id: 'swe-2-max', label: 'SWE-2 Max' }]);
  });

  it('reports the detected default model', () => {
    const output = JSON.stringify({
      id: 2,
      result: {
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'swe-2-max',
            options: [{ value: 'swe-2-max', name: 'SWE-2 Max' }],
          },
        ],
      },
    });

    expect(parseAcpSessionCatalog(output)).toEqual({
      models: [{ id: 'swe-2-max', label: 'SWE-2 Max' }],
      defaultModel: 'swe-2-max',
    });
  });

  it('ignores noise lines and malformed entries', () => {
    const output = [
      'not json at all',
      JSON.stringify({ method: 'session/update', params: { update: {} } }),
      JSON.stringify({
        id: 2,
        result: {
          configOptions: [
            {
              id: 'model',
              options: [{ value: '  ' }, { name: 'missing value' }, { value: 'swe-2-max' }],
            },
          ],
        },
      }),
    ].join('\n');

    expect(parseDevinAcpModels(output)).toEqual([{ id: 'swe-2-max', label: 'swe-2-max' }]);
  });
});

describe('parseDevinAuthStatus', () => {
  it('detects a logged-in status', () => {
    expect(parseDevinAuthStatus('Logged in (via Devin).\n\nCredentials:\n  File: /tmp/x')).toBe(
      true,
    );
  });

  it('detects a logged-out status', () => {
    expect(parseDevinAuthStatus('Not logged in. Run devin auth login.')).toBe(false);
    expect(parseDevinAuthStatus('not authenticated')).toBe(false);
  });

  it('returns undefined for unrecognized output', () => {
    expect(parseDevinAuthStatus('')).toBeUndefined();
    expect(parseDevinAuthStatus('something else entirely')).toBeUndefined();
  });
});
