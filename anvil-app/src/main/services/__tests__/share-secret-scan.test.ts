import { describe, expect, it } from 'vitest';
import {
  REDACTED_PLACEHOLDER,
  redactSecrets,
  scanForSecrets,
  unresolvedFindings,
} from '../share-secret-scan.js';

const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const SLACK = 'xoxb-1234567890-abcdefghijkl';
const OPENAI = `sk-proj-${'Zx9'.repeat(10)}`;
const ANTHROPIC = `sk-ant-api03-${'Qw3'.repeat(10)}`;
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('scanForSecrets', () => {
  it('finds common token formats with masked excerpts', () => {
    const text = [
      `token: ${GITHUB}`,
      `aws ${AWS}`,
      `slack ${SLACK}`,
      `openai ${OPENAI}`,
      `anthropic ${ANTHROPIC}`,
      `jwt ${JWT}`,
      PRIVATE_KEY,
    ].join('\n');
    const findings = scanForSecrets(text);
    const labels = findings.map((finding) => finding.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'GitHub token',
        'AWS access key id',
        'Slack token',
        'OpenAI-style API key',
        'Anthropic API key',
        'JSON Web Token',
        'Private key block',
      ]),
    );
    for (const finding of findings) {
      for (const secret of [GITHUB, AWS, SLACK, OPENAI, ANTHROPIC, JWT]) {
        expect(finding.excerpt).not.toContain(secret);
      }
    }
    // The Anthropic key is one finding, not also an OpenAI-style one.
    expect(findings.filter((finding) => finding.excerpt.startsWith('sk-a'))).toHaveLength(1);
  });

  it('finds env-style secret assignments and connection-string passwords', () => {
    const text = [
      'DATABASE_PASSWORD=s3cr3t-Pa55word!',
      'API_KEY="abcd1234efgh5678"',
      'DATABASE_URL=postgres://app:hunter22pass@db.internal:5432/app',
      'LOG_LEVEL=debug',
      'tokenCount=12345678',
      'PASSWORD=changeme',
      'SECRET=${VAULT_SECRET}',
    ].join('\n');
    const findings = scanForSecrets(text);
    expect(findings.map((finding) => finding.label).sort()).toEqual([
      'Connection string password',
      'Secret-looking assignment',
      'Secret-looking assignment',
    ]);
    expect(findings.some((finding) => finding.excerpt.startsWith('DATABASE_PASSWORD='))).toBe(true);
  });

  it('detects secrets inside serialised bundle JSON', () => {
    const json = JSON.stringify({ html: `<script>const API_KEY = "abcd1234efgh5678";</script>` });
    const findings = scanForSecrets(json);
    expect(findings).toHaveLength(1);
    const redacted = redactSecrets(json, [findings[0].id]);
    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(redacted).not.toContain('abcd1234efgh5678');
    expect(redacted).toContain(REDACTED_PLACEHOLDER);
  });

  it('flags values Anvil already stores as credentials', () => {
    const findings = scanForSecrets('header: my-linear-key-0001 here', {
      knownSecrets: ['my-linear-key-0001', 'short'],
    });
    expect(findings).toEqual([
      expect.objectContaining({ label: 'Saved Anvil credential', occurrences: 1 }),
    ]);
  });

  it('gives stable ids and one finding per repeated value', () => {
    const text = `a ${GITHUB} b ${GITHUB}`;
    const first = scanForSecrets(text);
    const second = scanForSecrets(`prefix\n${text}`);
    expect(first).toHaveLength(1);
    expect(first[0].occurrences).toBe(2);
    expect(second[0].id).toBe(first[0].id);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of the selected findings only', () => {
    const text = `${GITHUB} ${AWS} ${GITHUB}`;
    const findings = scanForSecrets(text);
    const github = findings.find((finding) => finding.label === 'GitHub token');
    const redacted = redactSecrets(text, [github!.id]);
    expect(redacted).toBe(`${REDACTED_PLACEHOLDER} ${AWS} ${REDACTED_PLACEHOLDER}`);
    expect(scanForSecrets(redacted).map((finding) => finding.label)).toEqual(['AWS access key id']);
  });

  it('redacts private key blocks whole', () => {
    const findings = scanForSecrets(PRIVATE_KEY);
    expect(redactSecrets(PRIVATE_KEY, [findings[0].id])).toBe(REDACTED_PLACEHOLDER);
  });
});

describe('unresolvedFindings', () => {
  it('treats redacted and acknowledged ids as resolved', () => {
    const findings = [
      { id: 'a', label: 'x', excerpt: '' },
      { id: 'b', label: 'x', excerpt: '' },
      { id: 'c', label: 'x', excerpt: '' },
    ];
    expect(unresolvedFindings(findings, ['a'], ['b']).map((finding) => finding.id)).toEqual(['c']);
  });
});
