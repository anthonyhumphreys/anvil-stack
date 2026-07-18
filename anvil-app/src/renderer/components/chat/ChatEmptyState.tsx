import {
  MessageSquare,
  Code,
  Shield,
  Eye,
  BookOpen,
  Palette,
  GraduationCap,
  Database,
  Building2,
  Sparkles,
  ArrowRight,
  Headphones,
  Wrench,
  Radio,
  SearchCheck,
  GitPullRequest,
  Gauge,
} from 'lucide-react';

interface Suggestion {
  label: string;
  prompt: string;
}

const PERSONA_SUGGESTIONS: Record<string, Suggestion[]> = {
  coder: [
    {
      label: 'Explain a file',
      prompt: 'Can you explain how the authentication flow works in this codebase?',
    },
    {
      label: 'Refactor code',
      prompt: 'Help me refactor the error handling in this module to be more consistent.',
    },
    {
      label: 'Add a feature',
      prompt: 'I need to add pagination to the user list component. What approach should I take?',
    },
    {
      label: 'Fix a bug',
      prompt: 'There is a race condition in the data fetching logic. Help me find and fix it.',
    },
  ],
  architect: [
    {
      label: 'Review architecture',
      prompt: 'Analyze the current module structure and suggest improvements for scalability.',
    },
    {
      label: 'Design pattern',
      prompt: 'What design patterns would best fit our current service layer architecture?',
    },
    {
      label: 'Tech decision',
      prompt:
        'Help me evaluate the trade-offs between using Redux and React Context for state management.',
    },
    {
      label: 'System design',
      prompt: 'Design a caching strategy for our API responses that handles invalidation well.',
    },
  ],
  security: [
    {
      label: 'Audit dependencies',
      prompt: 'Review our dependencies for known vulnerabilities and suggest updates.',
    },
    {
      label: 'Input validation',
      prompt: 'Check our API endpoints for proper input validation and sanitization.',
    },
    {
      label: 'Auth review',
      prompt: 'Review the authentication implementation for potential security issues.',
    },
    {
      label: 'Secrets scan',
      prompt:
        'Scan the codebase for any hardcoded secrets or credentials that should be externalized.',
    },
  ],
  reviewer: [
    {
      label: 'Code review',
      prompt: 'Review the recent changes in the main module for code quality and best practices.',
    },
    {
      label: 'Style check',
      prompt: 'Check if our code follows the established conventions and suggest improvements.',
    },
    {
      label: 'Performance',
      prompt: 'Identify any performance bottlenecks in the current implementation.',
    },
    {
      label: 'Test coverage',
      prompt: 'Analyze the test coverage and suggest areas that need more thorough testing.',
    },
  ],
  docs: [
    {
      label: 'Generate docs',
      prompt: 'Generate comprehensive documentation for the API endpoints in this module.',
    },
    {
      label: 'README update',
      prompt: 'Help me write a clear README that explains how to set up and run this project.',
    },
    {
      label: 'API docs',
      prompt: 'Create API documentation with examples for the main service functions.',
    },
    {
      label: 'Architecture docs',
      prompt: 'Document the system architecture with diagrams and explanations.',
    },
  ],
  ba: [
    {
      label: 'Requirements analysis',
      prompt: 'Analyze the current requirements and identify any gaps or ambiguities.',
    },
    {
      label: 'User stories',
      prompt:
        'Help me break down this epic into well-formed user stories with acceptance criteria.',
    },
    {
      label: 'Impact analysis',
      prompt: 'What would be the impact of changing the data model for user preferences?',
    },
    {
      label: 'Process flow',
      prompt: 'Map out the current user onboarding flow and identify improvement opportunities.',
    },
  ],
  design: [
    {
      label: 'UI review',
      prompt: 'Review the current UI components and suggest improvements for usability.',
    },
    {
      label: 'Design system',
      prompt: 'Help me establish a consistent design system for our component library.',
    },
    {
      label: 'Accessibility',
      prompt: 'Audit our components for accessibility issues and suggest fixes.',
    },
    {
      label: 'Responsive design',
      prompt: 'Review the responsive behavior and suggest improvements for mobile.',
    },
  ],
  mentor: [
    {
      label: 'Explain concept',
      prompt: 'Explain how dependency injection works and why it is useful in this codebase.',
    },
    {
      label: 'Best practices',
      prompt: 'What are the best practices for structuring a React application at scale?',
    },
    {
      label: 'Code walkthrough',
      prompt: 'Walk me through how the data flows from the API to the UI in this app.',
    },
    {
      label: 'Learning path',
      prompt:
        'I want to improve my TypeScript skills. What should I focus on based on this codebase?',
    },
  ],
  'db-expert': [
    {
      label: 'Schema review',
      prompt: 'Review the current database schema and suggest normalization improvements.',
    },
    {
      label: 'Query optimization',
      prompt: 'Help me optimize this slow query that joins multiple large tables.',
    },
    {
      label: 'Migration plan',
      prompt: 'Plan a safe migration to add a new column to a table with millions of rows.',
    },
    {
      label: 'Index strategy',
      prompt: 'What indexes should I add to improve the performance of our most common queries?',
    },
  ],
  'service-desk': [
    {
      label: 'Triage an issue',
      prompt:
        'Help me capture and classify this issue, assess impact and urgency, and identify safe first-line checks.',
    },
    {
      label: 'Clarify a request',
      prompt: 'Turn this request into a clear outcome with the missing information and next owner.',
    },
    {
      label: 'Escalation pack',
      prompt:
        'Prepare a second-line escalation pack with symptoms, scope, evidence, actions tried, and results.',
    },
    {
      label: 'User update',
      prompt: 'Draft a concise user update that states what is known, what is next, and when.',
    },
  ],
  'technical-support': [
    {
      label: 'Diagnose issue',
      prompt:
        'Turn this support report into evidence-backed hypotheses and safe diagnostic checks.',
    },
    {
      label: 'Inspect repository',
      prompt:
        'Inspect the selected repositories for likely ownership, configuration, and failure paths.',
    },
    {
      label: 'Build reproduction',
      prompt: 'Help me define a safe, repeatable reproduction with expected and observed results.',
    },
    {
      label: 'Escalate clearly',
      prompt:
        'Prepare an engineering or vendor escalation with evidence, eliminated causes, and risk.',
    },
  ],
  'incident-manager': [
    {
      label: 'Open incident',
      prompt: 'Structure the incident objective, impact, roles, workstreams, and next update time.',
    },
    {
      label: 'Incident update',
      prompt: 'Draft a factual stakeholder update with knowns, unknowns, actions, and timing.',
    },
    {
      label: 'Decision log',
      prompt: 'Create a timestamped decision and action log with owners and evidence.',
    },
    {
      label: 'Handover',
      prompt: 'Prepare a clean incident handover covering state, risks, owners, and next actions.',
    },
  ],
  'problem-manager': [
    {
      label: 'Problem statement',
      prompt: 'Define the recurring problem, affected services, evidence, and impact pattern.',
    },
    {
      label: 'Root cause analysis',
      prompt: 'Build an evidence-led causal analysis without promoting hypotheses to facts.',
    },
    {
      label: 'Known error',
      prompt: 'Draft a known-error record with detection, impact, workaround, and residual risk.',
    },
    {
      label: 'Corrective actions',
      prompt: 'Turn the findings into owned corrective and preventive actions with validation.',
    },
  ],
  'change-manager': [
    {
      label: 'Assess change',
      prompt:
        'Assess this change for scope, customer impact, dependencies, risk, and evidence gaps.',
    },
    {
      label: 'Challenge plan',
      prompt: 'Review implementation, test, communication, monitoring, and approval readiness.',
    },
    {
      label: 'Backout review',
      prompt: 'Challenge the backout plan, stop conditions, authority, and recovery validation.',
    },
    {
      label: 'Post-change review',
      prompt: 'Prepare post-change validation and learning questions from the available evidence.',
    },
  ],
  'service-manager': [
    {
      label: 'Service snapshot',
      prompt:
        'Map this service, its customers, outcomes, ownership, dependencies, and support model.',
    },
    {
      label: 'Service review',
      prompt:
        'Prepare a service review with sourced measures, themes, risks, and decisions needed.',
    },
    {
      label: 'Improvement plan',
      prompt: 'Turn these service themes into measurable, owned continual-improvement actions.',
    },
    {
      label: 'Stakeholder brief',
      prompt:
        'Draft a concise service brief that separates evidence, interpretation, and decisions.',
    },
  ],
};

const PERSONA_ICONS: Record<string, React.ReactNode> = {
  coder: <Code size={22} />,
  architect: <Building2 size={22} />,
  security: <Shield size={22} />,
  reviewer: <Eye size={22} />,
  docs: <BookOpen size={22} />,
  ba: <MessageSquare size={22} />,
  design: <Palette size={22} />,
  mentor: <GraduationCap size={22} />,
  'db-expert': <Database size={22} />,
  'service-desk': <Headphones size={22} />,
  'technical-support': <Wrench size={22} />,
  'incident-manager': <Radio size={22} />,
  'problem-manager': <SearchCheck size={22} />,
  'change-manager': <GitPullRequest size={22} />,
  'service-manager': <Gauge size={22} />,
};

interface ChatEmptyStateProps {
  personaId: string;
  personaName: string;
  personaColour: string;
  hasRepos: boolean;
  hasGovernanceDocs: boolean;
  isDbExpertPersona: boolean;
  onSuggestionClick: (prompt: string) => void;
}

export function ChatEmptyState({
  personaId,
  personaName,
  personaColour,
  hasRepos,
  hasGovernanceDocs,
  isDbExpertPersona,
  onSuggestionClick,
}: ChatEmptyStateProps) {
  const suggestions = PERSONA_SUGGESTIONS[personaId] ?? PERSONA_SUGGESTIONS.coder;
  const icon = PERSONA_ICONS[personaId] ?? <MessageSquare size={22} />;
  const isItsmPersona = [
    'service-desk',
    'technical-support',
    'incident-manager',
    'problem-manager',
    'change-manager',
    'service-manager',
  ].includes(personaId);

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-8">
      <div className="relative mb-5">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg"
          style={{
            background: `linear-gradient(135deg, ${personaColour}20 0%, ${personaColour}08 100%)`,
            boxShadow: `0 8px 32px ${personaColour}15`,
          }}
        >
          <span style={{ color: personaColour }}>{icon}</span>
        </div>
        <div
          className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full"
          style={{ backgroundColor: personaColour }}
        >
          <Sparkles size={12} className="text-white" />
        </div>
      </div>

      <h3 className="mb-1.5 text-lg font-semibold tracking-tight text-text-primary">
        Start a conversation with {personaName}
      </h3>

      <p className="mb-8 max-w-md text-center text-sm leading-relaxed text-text-tertiary">
        {isDbExpertPersona
          ? 'Import SSMS schema or stored procedure exports in DB Insights, then ask questions about the database design here.'
          : isItsmPersona && !hasRepos
            ? 'Use Chat and the ITSM workbench to explore the service, issue, evidence, and handover. Add repositories when technical context would help.'
            : hasRepos
              ? 'Ask about your code, request changes, or get help understanding the codebase.'
              : hasGovernanceDocs
                ? 'Ask questions using the governance documents as context.'
                : 'Add repositories or governance documents to give Chat more context, or ask questions directly.'}
      </p>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            onClick={() => onSuggestionClick(suggestion.prompt)}
            className={getSuggestionCardClassName()}
          >
            <div className="mb-1.5 flex w-full items-center justify-between">
              <span
                className="text-xs font-semibold uppercase tracking-wider transition-colors"
                style={{ color: personaColour }}
              >
                {suggestion.label}
              </span>
              <ArrowRight size={12} className={getSuggestionArrowClassName()} />
            </div>
            <span className="line-clamp-2 text-sm leading-relaxed text-text-secondary transition-colors group-hover:text-text-primary group-focus-visible:text-text-primary">
              {suggestion.prompt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function getSuggestionCardClassName(): string {
  return 'group flex flex-col items-start rounded-xl border border-border bg-bg-secondary px-4 py-3.5 text-left transition-all duration-200 hover:border-border hover:bg-bg-tertiary hover:shadow-md focus-visible:border-border focus-visible:bg-bg-tertiary focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35';
}

export function getSuggestionArrowClassName(): string {
  return 'text-text-tertiary opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100';
}
