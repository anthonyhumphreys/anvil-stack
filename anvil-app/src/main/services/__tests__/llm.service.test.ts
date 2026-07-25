import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  callAppleFoundationModel: vi.fn(),
  classifyPromptForOnDeviceModel: vi.fn(),
  completionCreate: vi.fn(),
}));

vi.mock('../settings.service.js', () => ({
  getSettings: mocks.getSettings,
}));

vi.mock('../apple-foundation-models.service.js', () => ({
  callAppleFoundationModel: mocks.callAppleFoundationModel,
  classifyPromptForOnDeviceModel: mocks.classifyPromptForOnDeviceModel,
  isLikelyAppleFoundationModelsRefusal: (value: string) =>
    /(?:i apologize|i'm sorry|cannot assist|can't assist|unable to assist)/i.test(value),
}));

vi.mock('openai', () => ({
  OpenAI: vi.fn().mockImplementation(function OpenAIMock() {
    return {
      chat: {
        completions: {
          create: mocks.completionCreate,
        },
      },
    };
  }),
  AzureOpenAI: vi.fn().mockImplementation(function AzureOpenAIMock() {
    return {
      chat: {
        completions: {
          create: mocks.completionCreate,
        },
      },
    };
  }),
}));

import { buildCursorPrintArgs, callLlm, resetLlmClient } from '../llm.service.js';

function openAiSettings() {
  return {
    llmProvider: 'openai',
    appleFoundationModelsMode: 'prefer-simple',
    openaiApiKey: 'test-key',
    openaiModel: 'gpt-5.5',
    reasoningLevel: 'medium',
  };
}

describe('callLlm Apple Foundation Models routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLlmClient();
    mocks.getSettings.mockReturnValue(openAiSettings());
    mocks.classifyPromptForOnDeviceModel.mockResolvedValue('local');
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: 'fallback response' } }],
    });
  });

  it('uses Apple Foundation Models when the classifier routes locally', async () => {
    mocks.callAppleFoundationModel.mockResolvedValue({
      ok: true,
      content: 'local response',
      unavailable: false,
    });

    const response = await callLlm('draft a short fix prompt', 1024, 0.3, 0, {
      taskClass: 'prompt-draft',
    });

    expect(response).toBe('local response');
    expect(mocks.classifyPromptForOnDeviceModel).toHaveBeenCalledTimes(1);
    expect(mocks.callAppleFoundationModel).toHaveBeenCalledTimes(1);
    expect(mocks.completionCreate).not.toHaveBeenCalled();
  });

  it('falls back when the classifier routes to the cloud backend', async () => {
    mocks.classifyPromptForOnDeviceModel.mockResolvedValue('cloud');

    const response = await callLlm('draft a short fix prompt', 1024, 0.3, 0, {
      taskClass: 'prompt-draft',
    });

    expect(response).toBe('fallback response');
    expect(mocks.callAppleFoundationModel).not.toHaveBeenCalled();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back when classification is unavailable', async () => {
    mocks.classifyPromptForOnDeviceModel.mockResolvedValue(null);

    const response = await callLlm('draft a short fix prompt', 1024, 0.3, 0, {
      taskClass: 'prompt-draft',
    });

    expect(response).toBe('fallback response');
    expect(mocks.callAppleFoundationModel).not.toHaveBeenCalled();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back when a local JSON task returns non-JSON', async () => {
    mocks.callAppleFoundationModel.mockResolvedValue({
      ok: true,
      content: 'probably JSON, if you squint',
      unavailable: false,
    });

    const response = await callLlm('return json', 1024, 0.3, 0, { taskClass: 'simple-json' });

    expect(response).toBe('fallback response');
    expect(mocks.callAppleFoundationModel).toHaveBeenCalledTimes(1);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back when Apple Foundation Models refuses an eligible task', async () => {
    mocks.callAppleFoundationModel.mockResolvedValue({
      ok: true,
      content: 'I apologize, but I cannot assist with that request.',
      unavailable: false,
    });

    const response = await callLlm('draft a short fix prompt', 1024, 0.3, 0, {
      taskClass: 'prompt-draft',
    });

    expect(response).toBe('fallback response');
    expect(mocks.callAppleFoundationModel).toHaveBeenCalledTimes(1);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it('does not attempt local routing without a task class', async () => {
    const response = await callLlm('review this diff', 1024, 0.2, 0);

    expect(response).toBe('fallback response');
    expect(mocks.classifyPromptForOnDeviceModel).not.toHaveBeenCalled();
    expect(mocks.callAppleFoundationModel).not.toHaveBeenCalled();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it('does not attempt local routing when max tokens exceed the local cap', async () => {
    const response = await callLlm('review this diff', 8192, 0.2, 0, {
      taskClass: 'code-review',
    });

    expect(response).toBe('fallback response');
    expect(mocks.classifyPromptForOnDeviceModel).not.toHaveBeenCalled();
    expect(mocks.callAppleFoundationModel).not.toHaveBeenCalled();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });
});

describe('Cursor CLI routing', () => {
  it('passes the selected Cursor model without shell interpolation', () => {
    expect(buildCursorPrintArgs('Review this change', 'cursor-grok-4.5-medium')).toEqual([
      '-p',
      '--model',
      'cursor-grok-4.5-medium',
      'Review this change',
    ]);
  });
});
