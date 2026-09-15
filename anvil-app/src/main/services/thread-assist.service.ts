import { BrowserWindow } from 'electron';
import type { ChatThread, ThreadAssistProvider } from '../../shared/types.js';
import {
  getChatThread,
  loadChatHistory,
  updateChatThread,
} from './chat-persistence.service.js';
import { getSettings } from './settings.service.js';
import {
  callPreferredLocalModel,
  isLikelyLocalModelRefusal,
} from './local-llm.service.js';
import { callLlm } from './llm.service.js';

const ASSIST_MIN_INTERVAL_MS = 45_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_TITLE_CHARS = 60;
const MAX_SUMMARY_CHARS = 240;

const lastAssistAt = new Map<string, number>();
const inFlight = new Set<string>();

const ASSIST_INSTRUCTIONS = [
  'You maintain a sidebar list of conversation threads.',
  'Respond with ONLY JSON: {"title": "<concise 3-8 word title>", "summary": "<one sentence, max 200 characters>"}',
  'The title should name the task or topic. The summary should say what is being worked on and its current state.',
].join('\n');

function buildTranscript(threadId: string): string {
  const messages = loadChatHistory(threadId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(0, 600)}`,
    );
  return messages.join('\n').slice(-MAX_TRANSCRIPT_CHARS);
}

function parseAssistResponse(content: string): { title?: string; summary?: string } | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { title?: unknown; summary?: unknown };
    return {
      title:
        typeof parsed.title === 'string'
          ? parsed.title.replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, MAX_TITLE_CHARS)
          : undefined,
      summary:
        typeof parsed.summary === 'string'
          ? parsed.summary.trim().slice(0, MAX_SUMMARY_CHARS)
          : undefined,
    };
  } catch {
    return null;
  }
}

async function generateThreadMetadata(
  provider: Exclude<ThreadAssistProvider, 'off'>,
  transcript: string,
): Promise<{ title?: string; summary?: string } | null> {
  const prompt = `Here is a conversation thread:\n\n${transcript}`;
  let content: string | undefined;

  if (provider === 'configured') {
    try {
      content = await callLlm(prompt, 160, 0.3, 1, { taskClass: 'short-summary' });
    } catch {
      return null;
    }
  } else {
    const result = await callPreferredLocalModel(prompt, 160, {
      provider,
      instructions: ASSIST_INSTRUCTIONS,
    });
    if (!result.ok || isLikelyLocalModelRefusal(result.content ?? '')) return null;
    content = result.content;
  }

  const parsed = content ? parseAssistResponse(content) : null;
  if (!parsed || (!parsed.title && !parsed.summary)) return null;
  if (parsed.title && isLikelyLocalModelRefusal(parsed.title)) parsed.title = undefined;
  if (parsed.summary && isLikelyLocalModelRefusal(parsed.summary)) parsed.summary = undefined;
  return parsed.title || parsed.summary ? parsed : null;
}

function broadcastThreadMetadata(thread: ChatThread): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', {
      type: 'thread_metadata',
      appThreadId: thread.id,
      threadTitle: thread.title,
      threadSummary: thread.summary,
    });
  }
}

/**
 * Refresh a thread's generated title and rolling summary after a completed
 * turn. Throttled per thread and skipped entirely when the user has disabled
 * the assist provider or renamed the thread manually.
 */
export function scheduleThreadMetadataRefresh(threadId: string): void {
  const provider = getSettings().threadAssistProvider;
  if (!provider || provider === 'off') return;
  if (inFlight.has(threadId)) return;

  const last = lastAssistAt.get(threadId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < ASSIST_MIN_INTERVAL_MS && last !== 0) return;
  lastAssistAt.set(threadId, Date.now());

  inFlight.add(threadId);
  void (async () => {
    try {
      const thread = getChatThread(threadId);
      if (!thread) return;
      const transcript = buildTranscript(threadId);
      if (!transcript.trim()) return;

      const metadata = await generateThreadMetadata(provider, transcript);
      if (!metadata) return;

      const updated = updateChatThread(threadId, {
        title: !thread.titleLocked && metadata.title ? metadata.title : undefined,
        summary: metadata.summary ?? undefined,
      });
      if (updated) broadcastThreadMetadata(updated);
    } catch (error) {
      console.warn('[ThreadAssist] Metadata refresh failed:', error);
    } finally {
      inFlight.delete(threadId);
    }
  })();
}
