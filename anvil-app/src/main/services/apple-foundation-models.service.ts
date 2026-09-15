import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppleLocalModelStatus, AppleModelFeatureFlags } from '../../shared/types.js';

export type AppleLocalBackend =
  | 'fm-cli'
  | 'swift-helper-27'
  | 'swift-helper-vision'
  | 'swift-helper';

export interface AppleModelCallOptions {
  instructions?: string;
  images?: string[];
  maxTokens?: number;
  temperature?: number;
  greedy?: boolean;
  useCase?: 'general' | 'contentTagging';
  guardrails?: 'default' | 'permissive-content-transformations';
  /** Stream deltas through onPartial when the backend supports it. */
  stream?: boolean;
  onPartial?: (delta: string) => void;
  timeoutMs?: number;
}

export interface AppleFoundationModelsResult {
  ok: boolean;
  content?: string;
  unavailable?: boolean;
  error?: string;
  backend?: AppleLocalBackend;
  inputTokens?: number;
}

const RESPOND_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const COMPILE_TIMEOUT_MS = 180_000;
const STATUS_CACHE_MS = 60_000;
const FM_LICENSE_MARKER = /not agreed to the apple foundation models cli legal notice|fm license/i;

interface HelperEvent {
  type?: string;
  ok?: boolean;
  content?: string;
  unavailable?: boolean;
  error?: string;
  text?: string;
  inputTokens?: number;
  // capabilities events
  available?: boolean;
  reason?: string;
  contextSize?: number;
  features?: Partial<AppleModelFeatureFlags>;
  implementation?: string;
}

interface HelperSpec {
  id: AppleLocalBackend;
  file: string;
  minMacOs: [number, number];
}

const HELPERS: HelperSpec[] = [
  { id: 'swift-helper', file: 'apple-foundation-models-helper.swift', minMacOs: [26, 0] },
  { id: 'swift-helper-27', file: 'apple-foundation-models-helper-27.swift', minMacOs: [26, 4] },
  {
    id: 'swift-helper-vision',
    file: 'apple-foundation-models-helper-vision.swift',
    minMacOs: [27, 0],
  },
];

let cachedStatus: { at: number; status: AppleLocalModelStatus } | null = null;
let statusInFlight: Promise<AppleLocalModelStatus> | null = null;
let fmProbeCache: { at: number; state: FmCliState } | null = null;
let statusGeneration = 0;
const helperBinaryCache = new Map<string, Promise<string | null>>();

function helperSourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(process.cwd(), 'resources', file);
}

function helperCacheDir(): string {
  const dir = join(app.getPath('userData'), 'afm-helpers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface MacOsVersion {
  major: number;
  minor: number;
}

function runCommand(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ code: null, stdout, stderr, error: 'timed out' });
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS);

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
      resolve({ code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    try {
      if (options.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    } catch {
      // Process died before stdin was consumed; close/error will settle it.
    }
  });
}

let macOsVersionCache: MacOsVersion | null | undefined;

async function getMacOsVersion(): Promise<MacOsVersion | null> {
  if (process.platform !== 'darwin') return null;
  if (macOsVersionCache !== undefined) return macOsVersionCache;
  const result = await runCommand('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 5_000 });
  const match = result.stdout.trim().match(/^(\d+)\.(\d+)/);
  macOsVersionCache = match
    ? { major: Number(match[1]), minor: Number(match[2]) }
    : null;
  return macOsVersionCache;
}

function macOsAtLeast(version: MacOsVersion | null, min: [number, number]): boolean {
  if (!version) return false;
  return version.major > min[0] || (version.major === min[0] && version.minor >= min[1]);
}

// ---------------------------------------------------------------------------
// fm CLI backend (macOS 27+, license-gated)
// ---------------------------------------------------------------------------

function fmCliPath(): string | null {
  if (existsSync('/usr/bin/fm')) return '/usr/bin/fm';
  return null;
}

export interface FmCliState {
  installed: boolean;
  licenseAccepted: boolean;
  available?: boolean;
  detail?: string;
}

async function probeFmCli(): Promise<FmCliState> {
  if (fmProbeCache && Date.now() - fmProbeCache.at < STATUS_CACHE_MS) {
    return fmProbeCache.state;
  }
  const generation = statusGeneration;
  const path = fmCliPath();
  if (!path) return { installed: false, licenseAccepted: false };

  const cache = (state: FmCliState): FmCliState => {
    if (generation === statusGeneration) fmProbeCache = { at: Date.now(), state };
    return state;
  };

  const result = await runCommand(path, ['available']);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (FM_LICENSE_MARKER.test(combined)) {
    // Deliberately uncached: the user can accept the notice at any time.
    return { installed: true, licenseAccepted: false, detail: 'licenseRequired' };
  }
  if (result.error) {
    return cache({ installed: true, licenseAccepted: false, detail: result.error });
  }
  const unavailable = /unavailable|not available/i.test(result.stdout) && result.code !== 0;
  return cache({
    installed: true,
    licenseAccepted: true,
    available: result.code === 0 && !unavailable,
    detail: result.stdout.trim().slice(0, 200) || undefined,
  });
}

async function callViaFmCli(
  prompt: string,
  options: AppleModelCallOptions,
  fm: FmCliState,
): Promise<AppleFoundationModelsResult> {
  const path = fmCliPath();
  if (!path || !fm.installed || !fm.licenseAccepted) {
    return { ok: false, unavailable: true, error: 'fm CLI unavailable', backend: 'fm-cli' };
  }

  const stream = options.stream === true || options.onPartial !== undefined;
  const args = ['respond', stream ? '--stream' : '--no-stream'];
  if (options.instructions?.trim()) args.push('--instructions', options.instructions.trim());
  for (const image of options.images ?? []) args.push('--image', image);
  if (options.useCase === 'contentTagging') args.push('--use-case', 'content-tagging');
  if (options.guardrails) args.push('--guardrails', options.guardrails);
  if (options.greedy) args.push('--greedy');
  args.push('--', prompt);

  return new Promise((resolve) => {
    const child = spawn(path, args, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
        error: `fm respond timed out after ${Math.round(
          (options.timeoutMs ?? RESPOND_TIMEOUT_MS) / 1000,
        )} seconds`,
        backend: 'fm-cli',
      });
    }, options.timeoutMs ?? RESPOND_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (stream) options.onPartial?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, unavailable: true, error: err.message, backend: 'fm-cli' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const combined = `${stdout}\n${stderr}`;
      if (FM_LICENSE_MARKER.test(combined)) {
        resolve({
          ok: false,
          unavailable: true,
          error:
            'The fm CLI legal notice has not been accepted. Run `sudo fm license` once to enable it.',
          backend: 'fm-cli',
        });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `fm exited with code ${code}`;
        resolve({ ok: false, unavailable: true, error: detail.slice(0, 500), backend: 'fm-cli' });
        return;
      }
      const content = stdout.trim();
      resolve(
        content
          ? { ok: true, content, backend: 'fm-cli' }
          : { ok: false, error: 'fm returned an empty response', backend: 'fm-cli' },
      );
    });
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Swift helper backend (compiled binary preferred, xcrun JIT fallback)
// ---------------------------------------------------------------------------

async function compileHelper(spec: HelperSpec): Promise<string | null> {
  const source = helperSourcePath(spec.file);
  if (!existsSync(source)) return null;

  let stamp: string;
  try {
    const stat = statSync(source);
    stamp = `${Math.round(stat.mtimeMs)}-${stat.size}`;
  } catch {
    return null;
  }

  const cached = helperBinaryCache.get(`${spec.id}:${stamp}`);
  if (cached) return cached;

  const compile = (async () => {
    try {
      const binary = join(helperCacheDir(), `${spec.id}-${stamp}`);
      if (existsSync(binary)) return binary;
      const result = await runCommand(
        '/usr/bin/xcrun',
        ['swiftc', '-O', '-o', binary, source],
        { timeoutMs: COMPILE_TIMEOUT_MS },
      );
      if (result.code === 0 && existsSync(binary)) return binary;
      console.warn(`[AFM] Failed to compile ${spec.id}: ${result.stderr.trim().slice(0, 300)}`);
      return null;
    } catch (error) {
      console.warn(`[AFM] Failed to compile ${spec.id}:`, error);
      return null;
    }
  })();

  helperBinaryCache.set(`${spec.id}:${stamp}`, compile);
  return compile;
}

interface HelperRun {
  result: AppleFoundationModelsResult;
  lastEvent: HelperEvent | null;
}

function runHelperProcess(
  command: string,
  args: string[],
  input: Record<string, unknown>,
  options: AppleModelCallOptions,
  backend: AppleLocalBackend,
): Promise<HelperRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let content = '';
    let lastEvent: HelperEvent | null = null;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        result: {
          ok: false,
          unavailable: false,
          error: `Apple Foundation Models timed out after ${Math.round(
            (options.timeoutMs ?? RESPOND_TIMEOUT_MS) / 1000,
          )} seconds`,
          backend,
        },
        lastEvent,
      });
    }, options.timeoutMs ?? RESPOND_TIMEOUT_MS);

    const finish = (result: AppleFoundationModelsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ result: { ...result, backend }, lastEvent });
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: HelperEvent;
      try {
        event = JSON.parse(trimmed) as HelperEvent;
      } catch {
        // Non-JSON noise on stdout (e.g. swiftc warnings) is ignored.
        return;
      }
      lastEvent = event;
      if (event.type === 'delta' && typeof event.text === 'string') {
        content += event.text;
        options.onPartial?.(event.text);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish({ ok: false, unavailable: true, error: err.message });
    });

    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (lastEvent && lastEvent.type !== 'delta') {
        finish({
          ok: lastEvent.ok === true,
          content: lastEvent.content ?? (content || undefined),
          unavailable: lastEvent.unavailable === true,
          error: lastEvent.error,
          inputTokens: lastEvent.inputTokens,
        });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `helper exited with code ${code}`;
        finish({ ok: false, unavailable: true, error: detail.slice(0, 500) });
        return;
      }
      finish({ ok: false, error: 'Apple Foundation Models returned no output' });
    });

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch (error) {
      finish({
        ok: false,
        unavailable: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function runHelper(
  spec: HelperSpec,
  input: Record<string, unknown>,
  options: AppleModelCallOptions = {},
): Promise<HelperRun> {
  const source = helperSourcePath(spec.file);
  if (!existsSync(source)) {
    return {
      result: {
        ok: false,
        unavailable: true,
        error: `Apple Foundation Models helper was not found at ${source}`,
        backend: spec.id,
      },
      lastEvent: null,
    };
  }

  const binary = await compileHelper(spec);
  if (binary) {
    return runHelperProcess(binary, [], input, options, spec.id);
  }
  return runHelperProcess('/usr/bin/xcrun', ['swift', source], input, options, spec.id);
}

async function probeHelper(spec: HelperSpec): Promise<HelperEvent | null> {
  const { result, lastEvent } = await runHelper(
    spec,
    { command: 'capabilities' },
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (!result.ok || lastEvent?.type !== 'capabilities') return null;
  return lastEvent;
}

// ---------------------------------------------------------------------------
// Composite status + entry points
// ---------------------------------------------------------------------------

function mergeFeatures(parts: Array<Partial<AppleModelFeatureFlags> | undefined>): AppleModelFeatureFlags {
  return {
    streaming: parts.some((p) => p?.streaming),
    instructions: parts.some((p) => p?.instructions),
    images: parts.some((p) => p?.images),
    tokenCounting: parts.some((p) => p?.tokenCounting),
    contextSize: parts.some((p) => p?.contextSize),
    useCases: parts.some((p) => p?.useCases),
    structuredOutput: parts.some((p) => p?.structuredOutput),
  };
}

export function invalidateAppleLocalModelStatus(): void {
  statusGeneration += 1;
  cachedStatus = null;
  fmProbeCache = null;
  // Drop the reference so a new probe starts immediately; the orphaned
  // in-flight probe still resolves but can't repopulate the caches.
  statusInFlight = null;
}

export async function getAppleLocalModelStatus(force = false): Promise<AppleLocalModelStatus> {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      available: false,
      reason: 'requiresMacOS',
      features: mergeFeatures([]),
    };
  }

  if (!force && cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.status;
  }
  if (statusInFlight) return statusInFlight;

  const generation = statusGeneration;
  const flight = (async () => {
    const version = await getMacOsVersion();
    const fm = await probeFmCli();

    const eligible = HELPERS.filter((spec) => macOsAtLeast(version, spec.minMacOs));
    const probes = await Promise.all(eligible.map((spec) => probeHelper(spec)));
    const capsById = new Map<AppleLocalBackend, HelperEvent | null>(
      eligible.map((spec, i) => [spec.id, probes[i]]),
    );
    const baseCaps = capsById.get('swift-helper');
    const caps27 = capsById.get('swift-helper-27');
    const visionCaps = capsById.get('swift-helper-vision');

    const helperStatus = caps27 ?? baseCaps;
    const fmReady = fm.installed && fm.licenseAccepted && fm.available !== false;
    const backend: AppleLocalBackend | undefined = fmReady
      ? 'fm-cli'
      : caps27
        ? 'swift-helper-27'
        : baseCaps
          ? 'swift-helper'
          : undefined;

    const features = mergeFeatures([
      fmReady ? { images: true, tokenCounting: true, instructions: true } : undefined,
      helperStatus?.features,
      visionCaps?.features,
    ]);

    const status: AppleLocalModelStatus = {
      platform: 'darwin',
      osVersion: version ? `${version.major}.${version.minor}` : undefined,
      available: fmReady || helperStatus?.available === true,
      reason: fmReady
        ? 'available'
        : (helperStatus?.reason ?? (fm.installed ? (fm.detail ?? 'fmUnavailable') : 'noBackend')),
      backend,
      contextSize: caps27?.contextSize,
      fmCli: {
        installed: fm.installed,
        licenseAccepted: fm.licenseAccepted,
        detail: fm.detail,
      },
      features,
    };
    if (generation === statusGeneration) cachedStatus = { at: Date.now(), status };
    if (statusInFlight === flight) statusInFlight = null;
    return status;
  })();
  statusInFlight = flight;

  return flight;
}

/**
 * Call the on-device Apple Foundation Model. Prefers the macOS 27 `fm` CLI
 * (prebuilt binary, supports images), then the compiled macOS 26.4+/27 helper,
 * then the base helper. Falls through on backend failure.
 */
export async function callAppleFoundationModel(
  prompt: string,
  options: AppleModelCallOptions = {},
): Promise<AppleFoundationModelsResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, unavailable: true, error: 'Apple Foundation Models require macOS.' };
  }

  const version = await getMacOsVersion();
  const hasImages = (options.images ?? []).length > 0;
  const wantsStream = options.stream === true || options.onPartial !== undefined;

  // fm has no --max-tokens/--temperature flags. A small token cap or an
  // explicit temperature marks a strict-output call (e.g. the route
  // classifier); helpers honor those controls, fm does not.
  const needsHelperControls =
    options.temperature !== undefined ||
    (options.maxTokens !== undefined && options.maxTokens < 512);

  // 1. fm CLI — preferred on macOS 27 when licensed and available.
  const fm = await probeFmCli();
  if (fm.installed && fm.licenseAccepted && fm.available !== false && !needsHelperControls) {
    const result = await callViaFmCli(prompt, options, fm);
    if (result.ok || !result.unavailable) return result;
    // Backend reported unavailable — fall through to helpers.
  }

  const helperInput = {
    instructions: options.instructions,
    useCase: options.useCase,
    guardrails: options.guardrails,
    options:
      options.temperature !== undefined || options.maxTokens !== undefined || options.greedy
        ? {
            temperature: options.temperature,
            maximumResponseTokens: options.maxTokens,
            sampling: options.greedy ? 'greedy' : undefined,
          }
        : undefined,
  };

  // 2. Vision helper for image prompts.
  const visionSpec = HELPERS.find((h) => h.id === 'swift-helper-vision')!;
  if (hasImages && macOsAtLeast(version, visionSpec.minMacOs)) {
    const { result } = await runHelper(
      visionSpec,
      {
        command: 'respond',
        prompt,
        ...helperInput,
        images: options.images,
        stream: wantsStream,
      },
      options,
    );
    if (result.ok || !result.unavailable) return result;
  }

  if (hasImages) {
    return {
      ok: false,
      unavailable: true,
      error:
        'Image prompts need macOS 27 with either the fm CLI (`sudo fm license`) or a Swift toolchain that supports the vision API.',
    };
  }

  // 3. macOS 26.4+/27 helper, then base helper.
  for (const spec of HELPERS.filter(
    (h) => h.id !== 'swift-helper-vision' && macOsAtLeast(version, h.minMacOs),
  ).sort((a, b) => b.minMacOs[0] - a.minMacOs[0] || b.minMacOs[1] - a.minMacOs[1])) {
    const { result } = await runHelper(
      spec,
      { command: 'respond', prompt, ...helperInput, stream: wantsStream },
      options,
    );
    if (result.ok || !result.unavailable) return result;
  }

  return {
    ok: false,
    unavailable: true,
    error:
      'Apple Foundation Models are unavailable: no working backend (fm CLI or Swift helper).',
  };
}

/** Count prompt tokens with the on-device tokenizer; null when unsupported. */
export async function countAppleModelTokens(
  prompt: string,
  instructions?: string,
): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  const version = await getMacOsVersion();

  const fm = await probeFmCli();
  if (fm.installed && fm.licenseAccepted) {
    const path = fmCliPath();
    if (path) {
      const args = ['count-tokens', '--quiet'];
      if (instructions?.trim()) args.push('--instructions', instructions.trim());
      args.push('--', prompt);
      const result = await runCommand(path, args, { timeoutMs: PROBE_TIMEOUT_MS });
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      if (result.code === 0 && Number.isFinite(parsed)) return parsed;
    }
  }

  const spec27 = HELPERS.find((h) => h.id === 'swift-helper-27')!;
  if (!macOsAtLeast(version, spec27.minMacOs)) return null;
  const { result } = await runHelper(
    spec27,
    { command: 'count-tokens', prompt, instructions },
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  return result.ok && typeof result.inputTokens === 'number' ? result.inputTokens : null;
}
