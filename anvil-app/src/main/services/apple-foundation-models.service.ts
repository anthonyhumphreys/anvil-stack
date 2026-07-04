import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface AppleFoundationModelsHelperResponse {
  ok?: boolean;
  content?: string;
  unavailable?: boolean;
  error?: string;
}

export interface AppleFoundationModelsResult {
  ok: boolean;
  content?: string;
  unavailable?: boolean;
  error?: string;
}

function getHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'apple-foundation-models-helper.swift')
    : join(process.cwd(), 'resources', 'apple-foundation-models-helper.swift');
}

function parseHelperResponse(stdout: string): AppleFoundationModelsResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, unavailable: false, error: 'Apple Foundation Models returned no output' };
  }

  try {
    const parsed = JSON.parse(trimmed) as AppleFoundationModelsHelperResponse;
    return {
      ok: parsed.ok === true,
      content: parsed.content,
      unavailable: parsed.unavailable === true,
      error: parsed.error,
    };
  } catch {
    return {
      ok: false,
      unavailable: false,
      error: `Apple Foundation Models returned invalid JSON: ${trimmed.slice(0, 240)}`,
    };
  }
}

export async function callAppleFoundationModel(prompt: string): Promise<AppleFoundationModelsResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, unavailable: true, error: 'Apple Foundation Models require macOS.' };
  }

  const helperPath = getHelperPath();
  if (!existsSync(helperPath)) {
    return {
      ok: false,
      unavailable: true,
      error: `Apple Foundation Models helper was not found at ${helperPath}`,
    };
  }

  return new Promise((resolve) => {
    const child = spawn('/usr/bin/xcrun', ['swift', helperPath], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        unavailable: false,
        error: 'Apple Foundation Models timed out after 30 seconds',
      });
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, unavailable: true, error: err.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const detail = stderr.trim() || `helper exited with code ${code}`;
        resolve({ ok: false, unavailable: true, error: detail.slice(0, 500) });
        return;
      }

      resolve(parseHelperResponse(stdout));
    });

    child.stdin.write(JSON.stringify({ prompt }));
    child.stdin.end();
  });
}

export type OnDeviceRoute = 'local' | 'cloud';

export function isLikelyAppleFoundationModelsRefusal(value: string): boolean {
  return /(?:i apologize|i'm sorry|cannot assist|can't assist|unable to assist)/i.test(value);
}

const CLASSIFIER_MAX_SAMPLE_CHARS = 2_000;

/**
 * Parse the classifier's response into a routing decision.
 * Returns null when the response cannot be interpreted, so callers fall back
 * to normal routing.
 */
export function parseOnDeviceRouteResponse(content: string | undefined | null): OnDeviceRoute | null {
  if (!content) return null;
  const trimmed = content.trim();

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { route?: unknown };
      if (parsed.route === 'local' || parsed.route === 'cloud') return parsed.route;
    } catch {
      // Fall through to the bare-word check.
    }
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'local' || lowered === '"local"') return 'local';
  if (lowered === 'cloud' || lowered === '"cloud"') return 'cloud';
  return null;
}

/**
 * Use the on-device Apple model to decide whether a prompt is simple enough to
 * answer locally ('local') or needs the configured GPT/Codex backend ('cloud').
 * Returns null when classification is unavailable or fails.
 */
export async function classifyPromptForOnDeviceModel(prompt: string): Promise<OnDeviceRoute | null> {
  if (process.platform !== 'darwin') return null;

  const sample = prompt.slice(0, CLASSIFIER_MAX_SAMPLE_CHARS);
  const classificationPrompt = [
    'You are a routing classifier. Decide whether the user prompt below can be fully answered by a small on-device language model with no tools.',
    '',
    'Answer "local" ONLY if the prompt is simple, self-contained, and needs no repository or file access, no code edits, no command execution, no web access, and no deep multi-step reasoning.',
    'Answer "cloud" for anything involving code changes, repositories, files, tools, long or complex analysis, or anything you are unsure about.',
    '',
    'Respond with ONLY this JSON, nothing else: {"route": "local"} or {"route": "cloud"}',
    '',
    '--- USER PROMPT START ---',
    sample,
    '--- USER PROMPT END ---',
  ].join('\n');

  const result = await callAppleFoundationModel(classificationPrompt);
  if (!result.ok) return null;
  return parseOnDeviceRouteResponse(result.content);
}

export async function testAppleFoundationModels(): Promise<{ ok: boolean; error?: string }> {
  const result = await callAppleFoundationModel(
    'What is a common short word for a basic system availability check?',
  );
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Apple Foundation Models are unavailable.' };
  }
  return { ok: true };
}
