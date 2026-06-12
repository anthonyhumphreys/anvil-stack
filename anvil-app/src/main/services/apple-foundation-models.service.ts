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

export async function testAppleFoundationModels(): Promise<{ ok: boolean; error?: string }> {
  const result = await callAppleFoundationModel(
    'What is a common short word for a basic system availability check?',
  );
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Apple Foundation Models are unavailable.' };
  }
  return { ok: true };
}
