import { describe, expect, it } from 'vitest';
import {
  filterSkillSearchResults,
  normaliseSkillsShPayload,
  parseCodexMcpListOutput,
  parseSkillsFindOutput,
} from '../codex-registry.service.js';

describe('codex registry service', () => {
  it('parses stdio and http MCP tables from codex output', () => {
    const output = `
Name             Command  Args                                                 Env  Cwd  Status   Auth
chrome-devtools  npx      chrome-devtools-mcp@latest                           -    -    enabled  Unsupported
posthog          npx      -y mcp-remote@latest https://mcp-eu.posthog.com/sse  -    -    enabled  Unsupported

Name    Url                         Bearer Token Env Var  Status   Auth
linear  https://mcp.linear.app/mcp  -                     enabled  Unsupported
`;

    expect(parseCodexMcpListOutput(output)).toEqual([
      {
        name: 'chrome-devtools',
        transport: 'stdio',
        command: 'npx',
        args: ['chrome-devtools-mcp@latest'],
        status: 'enabled',
        auth: 'Unsupported',
        raw: 'chrome-devtools  npx      chrome-devtools-mcp@latest                           -    -    enabled  Unsupported',
      },
      {
        name: 'posthog',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote@latest', 'https://mcp-eu.posthog.com/sse'],
        status: 'enabled',
        auth: 'Unsupported',
        raw: 'posthog          npx      -y mcp-remote@latest https://mcp-eu.posthog.com/sse  -    -    enabled  Unsupported',
      },
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        status: 'enabled',
        auth: 'Unsupported',
        raw: 'linear  https://mcp.linear.app/mcp  -                     enabled  Unsupported',
      },
    ]);
  });

  it('normalises skills.sh payload variants into installable Codex skills', () => {
    const results = normaliseSkillsShPayload({
      data: [
        {
          name: 'React Performance',
          slug: 'react-performance',
          description: 'Spot expensive React rendering patterns.',
          repository: { owner: 'vercel-labs', name: 'agent-skills' },
          tags: ['react', 'perf'],
          installs: '42',
        },
      ],
    });

    expect(results).toEqual([
      {
        id: 'vercel-labs/agent-skills:react-performance',
        name: 'React Performance',
        description: 'Spot expensive React rendering patterns.',
        source: 'vercel-labs/agent-skills',
        skillName: 'react-performance',
        installCommand:
          'npx skills add vercel-labs/agent-skills --skill react-performance -a codex -g -y',
        url: 'https://github.com/vercel-labs/agent-skills',
        repositoryUrl: 'https://github.com/vercel-labs/agent-skills',
        installs: 42,
        weeklyInstalls: undefined,
        tags: ['react', 'perf'],
      },
    ]);
  });

  it('normalises skills.sh v1 search responses into installable Codex skills', () => {
    const results = normaliseSkillsShPayload({
      data: [
        {
          id: 'vercel-labs/agent-skills/vercel-react-best-practices',
          slug: 'vercel-react-best-practices',
          name: 'Vercel React Best Practices',
          source: 'vercel-labs/agent-skills',
          installs: 418700,
          installUrl: 'https://github.com/vercel-labs/agent-skills',
          url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
        },
      ],
    });

    expect(results).toEqual([
      {
        id: 'vercel-labs/agent-skills:vercel-react-best-practices',
        name: 'Vercel React Best Practices',
        description: undefined,
        source: 'vercel-labs/agent-skills',
        skillName: 'vercel-react-best-practices',
        installCommand:
          'npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices -a codex -g -y',
        url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
        repositoryUrl: 'https://github.com/vercel-labs/agent-skills',
        installs: 418700,
        weeklyInstalls: undefined,
        tags: undefined,
      },
    ]);
  });

  it('parses unauthenticated skills CLI find output', () => {
    const results = parseSkillsFindOutput(`
\u001b[38;5;102mInstall with\u001b[0m npx skills add <owner/repo@skill>

\u001b[38;5;145mvercel-labs/agent-skills@vercel-react-best-practices\u001b[0m \u001b[36m418.7K installs\u001b[0m
\u001b[38;5;102m└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices\u001b[0m

google-labs-code/stitch-skills@react:components 45.5K installs
└ https://skills.sh/google-labs-code/stitch-skills/react:components
`);

    expect(results).toEqual([
      {
        id: 'vercel-labs/agent-skills:vercel-react-best-practices',
        name: 'Vercel React Best Practices',
        source: 'vercel-labs/agent-skills',
        skillName: 'vercel-react-best-practices',
        installCommand:
          'npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices -a codex -g -y',
        url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
        repositoryUrl: 'https://github.com/vercel-labs/agent-skills',
        installs: 418700,
      },
      {
        id: 'google-labs-code/stitch-skills:react:components',
        name: 'React Components',
        source: 'google-labs-code/stitch-skills',
        skillName: 'react:components',
        installCommand:
          'npx skills add google-labs-code/stitch-skills --skill react:components -a codex -g -y',
        url: 'https://skills.sh/google-labs-code/stitch-skills/react:components',
        repositoryUrl: 'https://github.com/google-labs-code/stitch-skills',
        installs: 45500,
      },
    ]);
  });

  it('fuzzy-filters skills by name, source, description, and tags', () => {
    const items = normaliseSkillsShPayload([
      {
        name: 'GitHub CI',
        slug: 'github-ci',
        description: 'Fix failing Actions checks.',
        repository: 'openai/github-skills',
        tags: ['ci'],
      },
      {
        name: 'Azure Cost Review',
        slug: 'azure-cost',
        description: 'FinOps guidance.',
        repository: 'openai/cloud-skills',
        tags: ['azure'],
      },
    ]);

    expect(filterSkillSearchResults(items, 'gh ci').map((item) => item.name)).toEqual([
      'GitHub CI',
    ]);
  });
});
