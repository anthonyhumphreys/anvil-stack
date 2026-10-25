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

  it('finds and removes saved credentials in every outgoing text encoding', () => {
    const secret = 'saved&<credential>"quote\\path\n12345';
    const html = secret
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      html,
      JSON.stringify(html).slice(1, -1),
    ];
    for (const form of forms) {
      const text = `prefix ${form} suffix ${form}`;
      const options = { knownSecrets: [secret] };
      const findings = scanForSecrets(text, options);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ label: 'Saved Anvil credential', occurrences: 2 });
      expect(scanForSecrets(`another prefix ${text}`, options)[0].id).toBe(findings[0].id);
      expect(findings[0].excerpt).not.toContain(secret);
      const redacted = redactSecrets(
        text,
        findings.map((finding) => finding.id),
        options,
      );
      expect(redacted).toBe('prefix [redacted] suffix [redacted]');
      expect(scanForSecrets(redacted, options)).toEqual([]);
    }
  });

  it('redacts HTML-escaped credentials in a thread bundle before recipients decode them', () => {
    const secret = 'saved&credential<123456>';
    const html = '<pre>saved&amp;credential&lt;123456&gt;</pre>';
    const bundle = JSON.stringify({ snapshot: { html }, title: 'Thread' });
    const options = { knownSecrets: [secret] };
    const findings = scanForSecrets(bundle, options);
    expect(findings).toHaveLength(1);
    const redacted = JSON.parse(
      redactSecrets(
        bundle,
        findings.map((finding) => finding.id),
        options,
      ),
    ) as {
      snapshot: { html: string };
    };
    const recipientText = redacted.snapshot.html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    expect(recipientText).toBe('<pre>[redacted]</pre>');
    expect(recipientText).not.toContain(secret);
  });

  it('redacts full HTML-encoded assignments and preserves their quotes and JSON', () => {
    for (const [html, expected] of [
      [
        '<pre>PASSWORD=&quot;abcd1234efgh5678&quot;</pre>',
        '<pre>PASSWORD=&quot;[redacted]&quot;</pre>',
      ],
      [
        '<pre>PASSWORD=&#39;abcd1234&amp;efgh5678&#39;</pre>',
        '<pre>PASSWORD=&#39;[redacted]&#39;</pre>',
      ],
      ['<pre>PASSWORD=abcd1234&amp;efgh5678</pre>', '<pre>PASSWORD=[redacted]</pre>'],
      [
        '<pre>&quot;API_KEY&quot;: &quot;abcd1234&lt;efgh5678&gt;&quot;</pre>',
        '<pre>&quot;API_KEY&quot;: &quot;[redacted]&quot;</pre>',
      ],
    ]) {
      const text = JSON.stringify({ snapshot: { html } });
      const findings = scanForSecrets(text);
      expect(findings).toHaveLength(1);
      const redacted = JSON.parse(
        redactSecrets(
          text,
          findings.map((finding) => finding.id),
        ),
      ) as {
        snapshot: { html: string };
      };
      expect(redacted.snapshot.html).toBe(expected);
      expect(scanForSecrets(JSON.stringify(redacted))).toEqual([]);
    }
  });

  it('redacts saved credentials from both the bundle title and its escaped snapshot heading', () => {
    const secret = 'saved&credential"123456';
    const text = JSON.stringify({
      title: secret,
      snapshot: { html: '<h1>saved&amp;credential&quot;123456</h1>' },
    });
    const options = { knownSecrets: [secret] };
    const findings = scanForSecrets(text, options);
    expect(findings).toHaveLength(1);
    const redacted = JSON.parse(
      redactSecrets(
        text,
        findings.map((finding) => finding.id),
        options,
      ),
    ) as {
      title: string;
      snapshot: { html: string };
    };
    expect(redacted.title).toBe('[redacted]');
    expect(redacted.snapshot.html).toBe('<h1>[redacted]</h1>');
  });

  it('redacts a saved credential escaped as JSON source inside the conversation HTML', () => {
    const secret = 'saved&credential"\\path123456';
    const source = JSON.stringify({ password: secret });
    const html = `<pre>${source.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</pre>`;
    const bundle = JSON.stringify({ snapshot: { html } });
    const options = { knownSecrets: [secret] };
    const findings = scanForSecrets(bundle, options);
    expect(findings.some((finding) => finding.label === 'Saved Anvil credential')).toBe(true);
    const redacted = JSON.parse(
      redactSecrets(
        bundle,
        findings.map((finding) => finding.id),
        options,
      ),
    ) as {
      snapshot: { html: string };
    };
    const decodedSource = redacted.snapshot.html
      .slice(5, -6)
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    expect(JSON.parse(decodedSource)).toEqual({ password: '[redacted]' });
  });

  it('redacts a quoted assignment from both structured continuation text and escaped snapshot HTML', () => {
    const text = JSON.stringify({
      continuation: { entries: [{ text: 'PASSWORD="abcd1234&efgh5678"' }] },
      snapshot: { html: '<pre>PASSWORD=&quot;abcd1234&amp;efgh5678&quot;</pre>' },
    });
    const findings = scanForSecrets(text);
    const redacted = JSON.parse(
      redactSecrets(
        text,
        findings.map((finding) => finding.id),
      ),
    ) as {
      continuation: { entries: Array<{ text: string }> };
      snapshot: { html: string };
    };
    expect(redacted.continuation.entries[0].text).toBe('PASSWORD="[redacted]"');
    expect(redacted.snapshot.html).toBe('<pre>PASSWORD=&quot;[redacted]&quot;</pre>');
  });

  it('redacts unquoted punctuation assignments in raw continuation and snapshot forms', () => {
    const text = JSON.stringify({
      text: 'PASSWORD=abcd1234&efgh5678',
      html: '<pre>PASSWORD=abcd1234&amp;efgh5678</pre>',
    });
    const findings = scanForSecrets(text);
    const result = JSON.parse(
      redactSecrets(
        text,
        findings.map((finding) => finding.id),
      ),
    );
    expect(result).toEqual({ text: 'PASSWORD=[redacted]', html: '<pre>PASSWORD=[redacted]</pre>' });
  });

  it('one known-credential decision redacts every encoded form atomically', () => {
    const secret = 'saved&credential123456';
    const text = JSON.stringify({ text: secret, html: '<pre>saved&amp;credential123456</pre>' });
    const options = { knownSecrets: [secret] };
    const findings = scanForSecrets(text, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(2);
    expect(findings[0].id).toBe(scanForSecrets(secret, options)[0].id);
    expect(JSON.parse(redactSecrets(text, [findings[0].id], options))).toEqual({
      text: '[redacted]',
      html: '<pre>[redacted]</pre>',
    });
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
