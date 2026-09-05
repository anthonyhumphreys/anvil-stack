import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, springTiming } from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { fade } from '@remotion/transitions/fade';
import { type FeatureSlideConfig, FeatureSlide } from './scenes/FeatureSlide';
import { ProductIntroScene } from './scenes/ProductIntroScene';
import { ProductOutroScene } from './scenes/ProductOutroScene';

const TRANSITION_FRAMES = 10;
const INTRO_FRAMES = 120;
const FEATURE_FRAMES = 90;
const OUTRO_FRAMES = 110;

const FEATURE_SLIDES: FeatureSlideConfig[] = [
  {
    activeNav: 'Repositories',
    eyebrow: 'Repositories',
    title: 'Index the codebase.',
    body: 'Anvil turns unfamiliar repos into readable delivery context with summaries, module maps, and architecture signal.',
    ghostLabel: 'Repos',
    accentTone: 'cyan',
    secondaryTone: 'red',
    pills: [
      { label: 'Language breakdowns', tone: 'cyan' },
      { label: 'Module summaries', tone: 'green' },
      { label: 'Remote connect', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Overview',
        title: 'Readable repo summaries',
        detail: 'Natural-language snapshots before the first deep dive.',
        tone: 'cyan',
      },
      {
        kicker: 'Structure',
        title: 'Architecture and modules',
        detail: 'Surface the shape of the system without opening every file.',
        tone: 'green',
      },
      {
        kicker: 'Workspace',
        title: 'Multi-repo context',
        detail: 'Attach several repos to one workspace and keep them aligned.',
        tone: 'amber',
      },
      {
        kicker: 'Flow',
        title: 'Index once, reuse everywhere',
        detail: 'Chat, docs, review, and governance all benefit from the same context.',
        tone: 'red',
      },
    ],
    footerNotes: [
      'Connect local or remote repos.',
      'Track indexing status on the rail.',
      'Carry repo context into every downstream feature.',
    ],
  },
  {
    activeNav: 'Chat',
    eyebrow: 'Chat',
    title: 'Prompt with real context.',
    body: 'Personas work against workspace state instead of floating generic chat memory.',
    ghostLabel: 'Chat',
    accentTone: 'violet',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Coder', tone: 'green' },
      { label: 'Design Companion', tone: 'violet' },
      { label: 'DB Expert', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Personas',
        title: 'Nine specialist modes',
        detail: 'Coder, Architect, Security, Reviewer, Docs, BA, Design, DB Expert, and Mentor.',
        tone: 'violet',
      },
      {
        kicker: 'Context',
        title: 'Workspace-aware by default',
        detail: 'Repo summaries, governance docs, and DB analyses can all flow into the session.',
        tone: 'cyan',
      },
      {
        kicker: 'Launch',
        title: 'Open in Anvil',
        detail: 'Jump straight into the relevant context from an external link or intent.',
        tone: 'red',
      },
      {
        kicker: 'Modes',
        title: 'From design to delivery',
        detail: 'Switch personas to match the task instead of changing tools.',
        tone: 'green',
      },
    ],
    footerNotes: ['Prompt the repo.', 'Prompt the board pack.', 'Prompt the database.'],
  },
  {
    activeNav: 'Embedded IDE',
    eyebrow: 'Embedded IDE',
    title: 'Keep the code in the cockpit.',
    body: 'Anvil launches a focused VS Code-style web editor with repo context, file targeting, terminals, and external fallback when you need the full desktop app.',
    ghostLabel: 'IDE',
    accentTone: 'cyan',
    secondaryTone: 'red',
    pills: [
      { label: 'Workspace file loaded', tone: 'cyan' },
      { label: 'Git hidden by default', tone: 'green' },
      { label: 'Focused inspection', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Editor',
        title: 'VS Code-style surface',
        detail:
          'Open the workspace inside Anvil instead of throwing users into a fresh empty editor.',
        tone: 'cyan',
      },
      {
        kicker: 'Focus',
        title: 'File links land on context',
        detail: 'Chat, review, and security findings can open the right file and line.',
        tone: 'green',
      },
      {
        kicker: 'Fallback',
        title: 'External open still works',
        detail: 'Jump to local VS Code, Cursor, or Codium when the user wants the native tool.',
        tone: 'amber',
      },
      {
        kicker: 'Control',
        title: 'Purpose-built profile',
        detail: 'Hide SCM and chat noise so the editor behaves like a product surface.',
        tone: 'red',
      },
    ],
    footerNotes: ['Open the workspace.', 'Focus the file.', 'Keep the Anvil shell in charge.'],
  },
  {
    activeNav: 'DB Insights',
    eyebrow: 'DB Insights',
    title: 'Read the schema first.',
    body: 'Import SSMS exports, analyse the database surface, and keep table and stored procedure context ready for the DB Expert persona.',
    ghostLabel: 'Data',
    accentTone: 'amber',
    secondaryTone: 'violet',
    pills: [
      { label: 'SQL exports in', tone: 'amber' },
      { label: 'Analysis stored', tone: 'green' },
      { label: 'DB Expert ready', tone: 'violet' },
    ],
    cards: [
      {
        kicker: 'Import',
        title: 'Schema and proc exports',
        detail: 'Bring in the SQL artefacts the team already has.',
        tone: 'amber',
      },
      {
        kicker: 'Analyse',
        title: 'Tables, views, and functions',
        detail: 'Summaries surface the shape of the database fast.',
        tone: 'cyan',
      },
      {
        kicker: 'Context',
        title: 'Workspace-level DB summary',
        detail: 'Keep the latest analysis loaded when the chat moves to data design.',
        tone: 'violet',
      },
      {
        kicker: 'Latest',
        title: 'Newest top-level feature',
        detail: 'Database understanding now sits beside repo understanding on the rail.',
        tone: 'red',
      },
    ],
    footerNotes: ['Add exports.', 'Run analyse.', 'Ask DB Expert.'],
  },
  {
    activeNav: 'Onboarding',
    eyebrow: 'Onboarding',
    title: 'Scaffold the workspace.',
    body: 'Create an empty workspace, connect existing repos, or scaffold new ones through the coder flow.',
    ghostLabel: 'Onboard',
    accentTone: 'amber',
    secondaryTone: 'green',
    pills: [
      { label: 'Empty workspace', tone: 'violet' },
      { label: 'Connect repos', tone: 'cyan' },
      { label: 'Scaffold new', tone: 'green' },
    ],
    cards: [
      {
        kicker: 'Start',
        title: 'Three setup paths',
        detail: 'Match the delivery moment instead of forcing one workflow.',
        tone: 'amber',
      },
      {
        kicker: 'Guardrails',
        title: 'Feature gating with guidance',
        detail: 'Repo-dependent areas stay visible while setup is still in flight.',
        tone: 'red',
      },
      {
        kicker: 'Artifacts',
        title: 'AGENTS.md and devcontainer checks',
        detail: 'Spot missing project scaffolding before the team feels the pain.',
        tone: 'cyan',
      },
      {
        kicker: 'Flow',
        title: 'Workspace-first scaffolding',
        detail: 'Build new repos inside the right delivery shell from day one.',
        tone: 'green',
      },
    ],
    footerNotes: [
      'Scaffolding state is explicit.',
      'Workspace and repository are separate concepts.',
      'Chat stays usable during setup.',
    ],
  },
  {
    activeNav: 'Work Items',
    eyebrow: 'Work Items',
    title: 'Work from the backlog.',
    body: 'ADO, Linear, and Jira items can become plans, fixes, review targets, or BA conversations without leaving Anvil.',
    ghostLabel: 'Work',
    accentTone: 'amber',
    secondaryTone: 'cyan',
    pills: [
      { label: 'ADO', tone: 'cyan' },
      { label: 'Linear', tone: 'violet' },
      { label: 'Jira', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'View',
        title: 'One backlog surface',
        detail: 'Browse, filter, and switch provider without changing your working context.',
        tone: 'amber',
      },
      {
        kicker: 'Action',
        title: 'Plan, fix, or BA',
        detail: 'Turn a work item straight into the right workflow.',
        tone: 'green',
      },
      {
        kicker: 'Hierarchy',
        title: 'Iterations and children',
        detail: 'Sprints, parent links, and nested work all stay visible.',
        tone: 'cyan',
      },
      {
        kicker: 'Traceability',
        title: 'Findings back into work',
        detail: 'Security and review issues can become tracked items fast.',
        tone: 'red',
      },
    ],
    footerNotes: ['Backlog to plan.', 'Backlog to fix.', 'Backlog to analysis.'],
  },
  {
    activeNav: 'Security',
    eyebrow: 'Security',
    title: 'Audit and remediate.',
    body: 'Review the code for security issues and turn findings into tracked remediation work.',
    ghostLabel: 'Secure',
    accentTone: 'red',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Static audit', tone: 'red' },
      { label: 'Work item handoff', tone: 'green' },
    ],
    cards: [
      {
        kicker: 'Static',
        title: 'OWASP and checklist coverage',
        detail: 'Use static analysis to widen the net across the codebase.',
        tone: 'red',
      },
      {
        kicker: 'Flow',
        title: 'Repo-linked scan history',
        detail: 'Keep the audit trail attached to the workspace and repo.',
        tone: 'cyan',
      },
      {
        kicker: 'Output',
        title: 'Actionable remediation payloads',
        detail: 'Findings already carry severity, evidence, and next steps.',
        tone: 'green',
      },
    ],
    footerNotes: ['Audit the code.', 'Review the findings.', 'Escalate the real risk.'],
  },
  {
    activeNav: 'Code Review',
    eyebrow: 'Code Review',
    title: 'Review the actual change.',
    body: 'Run a quick glance or a deeper senior-dev pass against the right slice of code, including pull requests.',
    ghostLabel: 'Review',
    accentTone: 'cyan',
    secondaryTone: 'amber',
    pills: [
      { label: 'Quick Glance', tone: 'cyan' },
      { label: 'Senior Dev', tone: 'amber' },
      { label: 'PR scope', tone: 'green' },
    ],
    cards: [
      {
        kicker: 'Scope',
        title: 'PR, repo, or file set',
        detail: 'Aim the review at the real surface area of the change.',
        tone: 'cyan',
      },
      {
        kicker: 'Depth',
        title: 'Two review modes',
        detail: 'Trade speed for depth when the risk profile changes.',
        tone: 'amber',
      },
      {
        kicker: 'Signal',
        title: 'Findings before summary',
        detail: 'Surface the bugs, regressions, and missing tests first.',
        tone: 'red',
      },
      {
        kicker: 'History',
        title: 'Review runs stay attached',
        detail: 'Compare earlier and later passes without leaving the rail.',
        tone: 'green',
      },
    ],
    footerNotes: ['Review the branch.', 'Review the pull request.', 'Review before the handover.'],
  },
  {
    activeNav: 'Documentation',
    eyebrow: 'Documentation',
    title: 'Keep Confluence current.',
    body: 'Browse, filter, create, and update documentation while keeping repo reality in the loop.',
    ghostLabel: 'Docs',
    accentTone: 'green',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Confluence-connected', tone: 'green' },
      { label: 'Staleness checks', tone: 'amber' },
      { label: 'Page generation', tone: 'cyan' },
    ],
    cards: [
      {
        kicker: 'Browse',
        title: 'Pages, labels, and hierarchy',
        detail: 'Move through doc space without context switching to the browser.',
        tone: 'green',
      },
      {
        kicker: 'Detect',
        title: 'Staleness against the repo',
        detail: 'Spot pages that drifted away from the actual implementation.',
        tone: 'amber',
      },
      {
        kicker: 'Create',
        title: 'Generate new pages',
        detail: 'Start docs from code and workspace context instead of a blank page.',
        tone: 'cyan',
      },
      {
        kicker: 'Update',
        title: 'Preview changes before apply',
        detail: 'Keep the human in the approval loop.',
        tone: 'red',
      },
    ],
    footerNotes: ['Browse the space.', 'Check the drift.', 'Generate the update.'],
  },
  {
    activeNav: 'ADRs',
    eyebrow: 'ADRs',
    title: 'Surface the decisions.',
    body: 'Scan ADRs across repos so the architecture history stays visible while the work moves.',
    ghostLabel: 'ADRs',
    accentTone: 'violet',
    secondaryTone: 'green',
    pills: [
      { label: 'Accepted', tone: 'green' },
      { label: 'Proposed', tone: 'cyan' },
      { label: 'Superseded', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Scan',
        title: 'Cross-repo ADR discovery',
        detail: 'Pull the decision record into the same workspace as the code.',
        tone: 'violet',
      },
      {
        kicker: 'Read',
        title: 'Status and markdown view',
        detail: 'Accepted, draft, deprecated, or superseded stays visible.',
        tone: 'cyan',
      },
      {
        kicker: 'Search',
        title: 'Architectural memory',
        detail: 'Find the decision before re-litigating the same choice.',
        tone: 'green',
      },
      {
        kicker: 'Govern',
        title: 'Feed the board pack',
        detail: 'Decision history can travel into broader delivery evidence.',
        tone: 'amber',
      },
    ],
    footerNotes: ['Find the ADR.', 'Read the trade-off.', 'Carry the context forward.'],
  },
  {
    activeNav: 'Diagrams',
    eyebrow: 'Diagrams',
    title: 'Generate the diagrams.',
    body: 'Create, edit, and chat over draw.io artefacts directly in the repo instead of treating diagrams as separate files nobody trusts.',
    ghostLabel: 'Maps',
    accentTone: 'violet',
    secondaryTone: 'cyan',
    pills: [
      { label: 'draw.io in repo', tone: 'violet' },
      { label: 'AI generation', tone: 'cyan' },
      { label: 'Viewer + editor', tone: 'green' },
    ],
    cards: [
      {
        kicker: 'Create',
        title: 'Generate new diagrams',
        detail: 'Use AI to draft diagrams from repo context and refine them in place.',
        tone: 'violet',
      },
      {
        kicker: 'Browse',
        title: 'Gallery and viewer',
        detail: 'Scan the repo’s diagram inventory without leaving the app.',
        tone: 'cyan',
      },
      {
        kicker: 'Edit',
        title: 'Open the real artefact',
        detail: 'Jump out to the editor when the diagram needs precision.',
        tone: 'green',
      },
      {
        kicker: 'Discuss',
        title: 'Diagram chat',
        detail: 'Treat architecture graphics as a living part of the delivery loop.',
        tone: 'amber',
      },
    ],
    footerNotes: ['Generate it.', 'Store it in-repo.', 'Chat over the architecture.'],
  },
  {
    activeNav: 'Governance',
    eyebrow: 'Governance',
    title: 'Package board evidence.',
    body: 'Lifecycle items, impact analysis, gate readiness, and handover packs turn delivery data into something a senior stakeholder can act on.',
    ghostLabel: 'Board',
    accentTone: 'red',
    secondaryTone: 'green',
    pills: [
      { label: 'Lifecycle items', tone: 'red' },
      { label: 'Gate readiness', tone: 'amber' },
      { label: 'Handover packs', tone: 'green' },
    ],
    cards: [
      {
        kicker: 'Boards',
        title: 'Docs and authority packs',
        detail: 'Organise governance material by board and keep it close to delivery.',
        tone: 'red',
      },
      {
        kicker: 'Lifecycle',
        title: 'Impact and readiness',
        detail: 'Track work across concept, delivery, and operation with evidence on each gate.',
        tone: 'amber',
      },
      {
        kicker: 'Packs',
        title: 'Exportable handover bundles',
        detail: 'Assemble code review, security, impact, and decisions into one pack.',
        tone: 'green',
      },
      {
        kicker: 'Context',
        title: 'Governance-aware chat',
        detail: 'Use documents as live context instead of static uploads.',
        tone: 'cyan',
      },
    ],
    footerNotes: ['Prepare the gate.', 'Check the evidence.', 'Package the handover.'],
  },
  {
    activeNav: 'Browser',
    eyebrow: 'Browser',
    title: 'Inspect the live surface.',
    body: 'Detected dev servers, an embedded browser, and a CDP bridge keep the running product close to the code.',
    ghostLabel: 'Live',
    accentTone: 'cyan',
    secondaryTone: 'green',
    pills: [
      { label: 'Detected targets', tone: 'cyan' },
      { label: 'Embedded browser', tone: 'green' },
      { label: 'CDP bridge', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Targets',
        title: 'Auto-detected dev servers',
        detail: 'Pick the app that just started without retyping the URL.',
        tone: 'cyan',
      },
      {
        kicker: 'Inspect',
        title: 'Webview in the workspace',
        detail: 'Browse, reload, and navigate without leaving the delivery shell.',
        tone: 'green',
      },
      {
        kicker: 'Bridge',
        title: 'Browser tooling attached',
        detail: 'Expose the running surface to agent workflows that need it.',
        tone: 'amber',
      },
      {
        kicker: 'Loop',
        title: 'Run to browser in one rail',
        detail: 'The feedback loop gets shorter when the app is already there.',
        tone: 'red',
      },
    ],
    footerNotes: ['Start the target.', 'Open the page.', 'Inspect the live behaviour.'],
  },
  {
    activeNav: 'Automations',
    eyebrow: 'Automations',
    title: 'Put the boring checks on rails.',
    body: 'Scheduled automation runs can collect context, execute checks, produce reports, and leave a readable event trail for the workspace.',
    ghostLabel: 'Auto',
    accentTone: 'green',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Nightly checks', tone: 'green' },
      { label: 'Report generation', tone: 'cyan' },
      { label: 'Event timeline', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Schedule',
        title: 'Run the recurring work',
        detail: 'Create workspace automations for checks, summaries, reports, and cleanup.',
        tone: 'green',
      },
      {
        kicker: 'Events',
        title: 'Readable run history',
        detail: 'Activity, model events, tool output, and failures stay inspectable.',
        tone: 'cyan',
      },
      {
        kicker: 'Launch',
        title: 'Pair with release intent',
        detail: 'Use automations to prepare evidence before the rollout conversation.',
        tone: 'amber',
      },
      {
        kicker: 'Control',
        title: 'No invisible magic',
        detail: 'Definitions, status, and outputs stay visible on the product surface.',
        tone: 'red',
      },
    ],
    footerNotes: ['Schedule the run.', 'Watch the stream.', 'Read the report.'],
  },
  {
    activeNav: 'Diagnostics',
    eyebrow: 'Diagnostics',
    title: 'Know what is wired up.',
    body: 'The diagnostics surface makes editor state, service health, integrations, MCP registry, and local tool availability visible before a workflow quietly combusts.',
    ghostLabel: 'Health',
    accentTone: 'red',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Editor status', tone: 'cyan' },
      { label: 'Services connected', tone: 'green' },
      { label: 'CLI health', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Health',
        title: 'Connected service snapshot',
        detail: 'See the state of critical local and remote dependencies in one pass.',
        tone: 'green',
      },
      {
        kicker: 'Registry',
        title: 'Codex skills and MCPs',
        detail: 'Inspect installed skills, registered servers, and CLI availability.',
        tone: 'cyan',
      },
      {
        kicker: 'Editor',
        title: 'Embedded IDE wiring',
        detail: 'Provider, command, URL, workspace, and errors are surfaced for support.',
        tone: 'amber',
      },
      {
        kicker: 'Repair',
        title: 'Fewer mystery failures',
        detail: 'When something is off, Anvil shows the broken link instead of shrugging.',
        tone: 'red',
      },
    ],
    footerNotes: ['Check the wiring.', 'Find the broken dependency.', 'Fix the real thing.'],
  },
  {
    activeNav: 'Mobile',
    eyebrow: 'Mobile Companion',
    title: 'Carry the launch state with you.',
    body: 'The companion app keeps PR summaries, security state, automation events, and approvals visible when the desktop cockpit is not in front of you.',
    ghostLabel: 'Mobile',
    accentTone: 'cyan',
    secondaryTone: 'green',
    pills: [
      { label: 'PR summaries', tone: 'cyan' },
      { label: 'Approval state', tone: 'green' },
      { label: 'Workspace feed', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Feed',
        title: 'Workspace activity on mobile',
        detail: 'Review merges, scan results, and automation outcomes from the companion surface.',
        tone: 'cyan',
      },
      {
        kicker: 'Review',
        title: 'PR and risk summaries',
        detail: 'See the same launch-blocking findings without opening the desktop app.',
        tone: 'amber',
      },
      {
        kicker: 'Action',
        title: 'Open back into Anvil',
        detail: 'Jump from the mobile summary into the right desktop context.',
        tone: 'green',
      },
      {
        kicker: 'Visibility',
        title: 'Useful away from the desk',
        detail: 'Small-screen status for the decisions that cannot wait for another meeting.',
        tone: 'red',
      },
    ],
    footerNotes: ['Read the update.', 'Check the risk.', 'Open in Anvil.'],
  },
  {
    activeNav: 'Git',
    eyebrow: 'Git',
    title: 'Stay in branch context.',
    body: 'Status, diffs, commits, branches, pushes, and pulls stay inside the same product surface as the review and work-item flows.',
    ghostLabel: 'Git',
    accentTone: 'green',
    secondaryTone: 'cyan',
    pills: [
      { label: 'Changes', tone: 'green' },
      { label: 'Branches', tone: 'cyan' },
      { label: 'Sync', tone: 'amber' },
    ],
    cards: [
      {
        kicker: 'Status',
        title: 'Working tree at a glance',
        detail: 'See staged, unstaged, and untracked changes without another window.',
        tone: 'green',
      },
      {
        kicker: 'Diff',
        title: 'Inspect before commit',
        detail: 'Bring the diff into the same place as the chat and review context.',
        tone: 'cyan',
      },
      {
        kicker: 'Branch',
        title: 'Create and switch branches',
        detail: 'Stay aware of branch state when the workflow needs it.',
        tone: 'amber',
      },
      {
        kicker: 'Sync',
        title: 'Push and pull in-app',
        detail: 'Close the gap between making the change and shipping it.',
        tone: 'red',
      },
    ],
    footerNotes: ['See the branch.', 'Commit the change.', 'Sync without leaving the rail.'],
  },
  {
    activeNav: 'Data & Compliance',
    eyebrow: 'Data & Compliance',
    title: 'Generate compliance artefacts.',
    body: 'Use repo-aware generation for DPIAs, privacy policies, and terms so legal and delivery conversations start with something grounded.',
    ghostLabel: 'Trust',
    accentTone: 'amber',
    secondaryTone: 'red',
    pills: [
      { label: 'DPIA', tone: 'amber' },
      { label: 'Privacy policy', tone: 'cyan' },
      { label: 'Terms of service', tone: 'red' },
    ],
    cards: [
      {
        kicker: 'Generate',
        title: 'Compliance documents from code',
        detail: 'Analyse the repo before drafting the artefact.',
        tone: 'amber',
      },
      {
        kicker: 'Store',
        title: 'Versioned output per repo',
        detail: 'Keep generated docs attached to the software they describe.',
        tone: 'green',
      },
      {
        kicker: 'Review',
        title: 'Human-readable markdown',
        detail: 'The output is meant to be checked, edited, and improved.',
        tone: 'cyan',
      },
      {
        kicker: 'Support',
        title: 'Risk work meets delivery work',
        detail: 'Compliance stops being a disconnected late-stage scramble.',
        tone: 'red',
      },
    ],
    footerNotes: [
      'Generate the draft.',
      'Review the language.',
      'Carry the evidence into governance.',
    ],
  },
];

export const ANVIL_SIZZLE_DURATION =
  INTRO_FRAMES +
  FEATURE_SLIDES.length * FEATURE_FRAMES +
  OUTRO_FRAMES -
  TRANSITION_FRAMES * (FEATURE_SLIDES.length + 1);

const timing = springTiming({
  durationInFrames: TRANSITION_FRAMES,
  config: { damping: 200, mass: 0.6 },
});

const transitionForIndex = (index: number) => {
  switch (index % 4) {
    case 0:
      return slide({ direction: 'from-right' });
    case 1:
      return slide({ direction: 'from-bottom' });
    case 2:
      return slide({ direction: 'from-left' });
    default:
      return fade();
  }
};

export const AnvilSizzle: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#04070d' }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={INTRO_FRAMES}>
          <ProductIntroScene />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition presentation={fade()} timing={timing} />

        {FEATURE_SLIDES.map((slideConfig, index) => (
          <React.Fragment key={slideConfig.activeNav}>
            <TransitionSeries.Sequence durationInFrames={FEATURE_FRAMES}>
              <FeatureSlide {...slideConfig} />
            </TransitionSeries.Sequence>
            {index < FEATURE_SLIDES.length - 1 ? (
              <TransitionSeries.Transition
                presentation={transitionForIndex(index)}
                timing={timing}
              />
            ) : null}
          </React.Fragment>
        ))}

        <TransitionSeries.Transition presentation={fade()} timing={timing} />

        <TransitionSeries.Sequence durationInFrames={OUTRO_FRAMES}>
          <ProductOutroScene />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
