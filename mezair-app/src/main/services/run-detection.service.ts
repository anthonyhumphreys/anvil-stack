// src/main/services/run-detection.service.ts

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunCommand } from '../../shared/run-types.js';
import { callLlm } from './llm.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cmd(
  repoId: string,
  label: string,
  command: string,
  source: RunCommand['source'],
): RunCommand {
  return { id: randomUUID(), repoId, label, command, source, pinned: false };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Static detectors
// ---------------------------------------------------------------------------

async function detectPackageJson(repoId: string, repoPath: string): Promise<RunCommand[]> {
  const filePath = path.join(repoPath, 'package.json');
  if (!(await fileExists(filePath))) return [];
  try {
    const raw = await readFile(filePath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return [];
    return Object.keys(pkg.scripts).map((key) =>
      cmd(repoId, key, `npm run ${key}`, 'package.json'),
    );
  } catch {
    return [];
  }
}

async function detectMakefile(repoId: string, repoPath: string): Promise<RunCommand[]> {
  for (const name of ['Makefile', 'makefile']) {
    const filePath = path.join(repoPath, name);
    if (!(await fileExists(filePath))) continue;
    try {
      const content = await readFile(filePath, 'utf-8');
      const targets = content
        .split('\n')
        .filter((line) => /^[a-zA-Z_][\w-]*\s*:/.test(line) && !line.startsWith('\t'))
        .map((line) => line.split(':')[0].trim());
      return targets.map((t) => cmd(repoId, t, `make ${t}`, 'Makefile'));
    } catch {
      return [];
    }
  }
  return [];
}

async function detectCargoToml(repoId: string, repoPath: string): Promise<RunCommand[]> {
  if (!(await fileExists(path.join(repoPath, 'Cargo.toml')))) return [];
  return [
    cmd(repoId, 'run', 'cargo run', 'Cargo.toml'),
    cmd(repoId, 'build', 'cargo build', 'Cargo.toml'),
    cmd(repoId, 'test', 'cargo test', 'Cargo.toml'),
  ];
}

async function detectPyprojectToml(repoId: string, repoPath: string): Promise<RunCommand[]> {
  const filePath = path.join(repoPath, 'pyproject.toml');
  if (!(await fileExists(filePath))) return [];
  try {
    const content = await readFile(filePath, 'utf-8');
    const commands: RunCommand[] = [];

    // Poetry scripts
    const poetrySection = content.match(/\[tool\.poetry\.scripts\]\s*\n([\s\S]*?)(?:\n\[|$)/);
    if (poetrySection) {
      const lines = poetrySection[1].split('\n').filter((l) => l.includes('='));
      for (const line of lines) {
        const name = line.split('=')[0].trim().replace(/"/g, '');
        commands.push(cmd(repoId, name, `poetry run ${name}`, 'pyproject.toml'));
      }
    }

    // PEP 621 scripts
    const pepSection = content.match(/\[project\.scripts\]\s*\n([\s\S]*?)(?:\n\[|$)/);
    if (pepSection) {
      const lines = pepSection[1].split('\n').filter((l) => l.includes('='));
      for (const line of lines) {
        const name = line.split('=')[0].trim().replace(/"/g, '');
        commands.push(cmd(repoId, name, name, 'pyproject.toml'));
      }
    }

    // Fallback: try to detect package name
    if (commands.length === 0) {
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) {
        commands.push(
          cmd(repoId, `run ${nameMatch[1]}`, `python -m ${nameMatch[1]}`, 'pyproject.toml'),
        );
      }
    }

    return commands;
  } catch {
    return [];
  }
}

async function detectGoMod(repoId: string, repoPath: string): Promise<RunCommand[]> {
  if (!(await fileExists(path.join(repoPath, 'go.mod')))) return [];
  return [
    cmd(repoId, 'run', 'go run .', 'go.mod'),
    cmd(repoId, 'build', 'go build', 'go.mod'),
    cmd(repoId, 'test', 'go test ./...', 'go.mod'),
  ];
}

async function detectDockerCompose(repoId: string, repoPath: string): Promise<RunCommand[]> {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await fileExists(path.join(repoPath, name))) {
      return [cmd(repoId, 'compose up', 'docker compose up', 'docker-compose.yml')];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectScripts(repoId: string, repoPath: string): Promise<RunCommand[]> {
  const results = await Promise.all([
    detectPackageJson(repoId, repoPath),
    detectMakefile(repoId, repoPath),
    detectCargoToml(repoId, repoPath),
    detectPyprojectToml(repoId, repoPath),
    detectGoMod(repoId, repoPath),
    detectDockerCompose(repoId, repoPath),
  ]);
  return results.flat();
}

export async function detectScriptsAi(repoId: string, repoPath: string): Promise<RunCommand[]> {
  try {
    const entries = await readdir(repoPath);
    const fileList = entries.slice(0, 50).join('\n');

    const prompt = `You are analyzing a software project to determine how to run it.

Here are the files in the project root:
${fileList}

List the commands needed to run, build, and test this project. Return a JSON array of objects with "label" (short name like "dev" or "start") and "command" (full shell command like "npm run dev"). Only return the JSON array, no other text.`;

    const response = await callLlm(prompt, 1024, 0.2, 3, { taskClass: 'simple-json' });

    const arrayMatch = response.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    const parsed = JSON.parse(arrayMatch[0]) as Array<{ label: string; command: string }>;
    return parsed.map((item) => cmd(repoId, String(item.label), String(item.command), 'ai'));
  } catch (err) {
    console.error('[RunDetection] AI detection failed:', err);
    return [];
  }
}
