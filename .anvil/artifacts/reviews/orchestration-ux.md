# Workflow UX refinement

The original setup exposed too much configuration before the user described their job.

The revised path is **Outcome → Flow → Preview → Run**.

- Focused launch screen: deliver, review, or explore.
- Preview starts no agents.
- Run saves the configuration automatically.
- Optional team settings, individually expandable specialists, and collapsed runtime limits.
- Compact graph with a dedicated objective and run footer.
- Collapsible library for smaller windows.
- Human steps display decisions instead of model metadata.

## Verification

Inspected the real Electron interface at 1400×900 and 1180×820. Launching an unsaved human-only workflow created one template, preserved its objective, and paused for a decision.

619 tests, production build, and ESLint pass. Existing renderer TypeScript errors do not reference the changed workflow components.

## Screenshots

![Outcome-first setup](orchestration/workflow-launch.png)

![Workflow preview](orchestration/workflow-preview.png)

![Compact team configuration](orchestration/workflow-team-compact.png)