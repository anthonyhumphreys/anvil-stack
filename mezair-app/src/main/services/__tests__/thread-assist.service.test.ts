import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ChatThread } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSettings: vi.fn(),
  getChatThread: vi.fn(),
  loadChatHistory: vi.fn(),
  updateChatThread: vi.fn(),
  callPreferredLocalModel: vi.fn(),
  callLlm: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.send } }],
  },
}));

vi.mock('../settings.service.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('../chat-persistence.service.js', () => ({
  getChatThread: mocks.getChatThread,
  loadChatHistory: mocks.loadChatHistory,
  updateChatThread: mocks.updateChatThread,
}));
vi.mock('../local-llm.service.js', () => ({
  callPreferredLocalModel: mocks.callPreferredLocalModel,
  isLikelyLocalModelRefusal: (value: string) => /sorry|can't assist/i.test(value),
}));
vi.mock('../llm.service.js', () => ({ callLlm: mocks.callLlm }));

import { scheduleThreadMetadataRefresh } from '../thread-assist.service.js';

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    threadAssistProvider: 'apple',
    ...overrides,
  } as AppSettings;
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    title: 'help me debug this test',
    titleLocked: false,
    ...overrides,
  } as ChatThread;
}

const history = [
  { role: 'user', content: 'help me debug this failing test' },
  { role: 'assistant', content: 'The mock is missing a return value.' },
];

async function flushAssist(): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.updateChatThread).toHaveBeenCalled();
  });
}

describe('thread assistance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockReturnValue(settings());
    mocks.getChatThread.mockReturnValue(thread());
    mocks.loadChatHistory.mockReturnValue(history);
    mocks.updateChatThread.mockImplementation((_id: string, updates: Record<string, unknown>) =>
      thread({ title: (updates.title as string) ?? 'x', summary: updates.summary as string }),
    );
    mocks.callPreferredLocalModel.mockResolvedValue({
      ok: true,
      content: '{"title": "Debug failing test", "summary": "Fixing a mocked test failure."}',
    });
  });

  it('does nothing when the provider is off', async () => {
    mocks.getSettings.mockReturnValue(settings({ threadAssistProvider: 'off' }));
    scheduleThreadMetadataRefresh('thread-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.callPreferredLocalModel).not.toHaveBeenCalled();
    expect(mocks.callLlm).not.toHaveBeenCalled();
  });

  it('generates title and summary through a local provider and broadcasts metadata', async () => {
    scheduleThreadMetadataRefresh('thread-1');
    await flushAssist();

    expect(mocks.callPreferredLocalModel).toHaveBeenCalledWith(
      expect.stringContaining('debug this failing test'),
      160,
      expect.objectContaining({ provider: 'apple' }),
    );
    expect(mocks.updateChatThread).toHaveBeenCalledWith('thread-1', {
      title: 'Debug failing test',
      summary: 'Fixing a mocked test failure.',
    });
    expect(mocks.send).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({ type: 'thread_metadata', appThreadId: 'thread-1' }),
    );
  });

  it('does not overwrite a manually renamed (locked) title', async () => {
    mocks.getChatThread.mockReturnValue(thread({ titleLocked: true, title: 'My custom name' }));
    scheduleThreadMetadataRefresh('thread-locked');
    await flushAssist();

    expect(mocks.updateChatThread).toHaveBeenCalledWith('thread-locked', {
      title: undefined,
      summary: 'Fixing a mocked test failure.',
    });
  });

  it('routes the configured provider through callLlm', async () => {
    mocks.getSettings.mockReturnValue(settings({ threadAssistProvider: 'configured' }));
    mocks.callLlm.mockResolvedValue(
      '{"title": "Configured title", "summary": "From the primary provider."}',
    );
    scheduleThreadMetadataRefresh('thread-2');
    await flushAssist();

    expect(mocks.callLlm).toHaveBeenCalledWith(
      expect.stringContaining('debug this failing test'),
      160,
      0.3,
      1,
      expect.objectContaining({ taskClass: 'short-summary' }),
    );
    expect(mocks.callPreferredLocalModel).not.toHaveBeenCalled();
  });

  it('routes a connected provider through callLlm with the chosen model', async () => {
    mocks.getSettings.mockReturnValue(
      settings({ threadAssistProvider: 'llmgateway', threadAssistModel: 'gpt-5.6-sol' }),
    );
    mocks.callLlm.mockResolvedValue(
      '{"title": "Gateway title", "summary": "From a connected provider."}',
    );
    scheduleThreadMetadataRefresh('thread-3');
    await flushAssist();

    expect(mocks.callLlm).toHaveBeenCalledWith(
      expect.stringContaining('debug this failing test'),
      160,
      0.3,
      1,
      expect.objectContaining({
        taskClass: 'short-summary',
        provider: 'llmgateway',
        model: 'gpt-5.6-sol',
      }),
    );
    expect(mocks.callPreferredLocalModel).not.toHaveBeenCalled();
  });

  it('ignores malformed and refusal responses', async () => {
    mocks.callPreferredLocalModel.mockResolvedValue({
      ok: true,
      content: 'Sorry, I cannot assist with that.',
    });
    scheduleThreadMetadataRefresh('thread-refusal');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.updateChatThread).not.toHaveBeenCalled();
  });
});
