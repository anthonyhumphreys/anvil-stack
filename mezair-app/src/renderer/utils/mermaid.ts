import type { MermaidConfig } from 'mermaid';

// Mermaid configuration is global. Serialize initialization and rendering so ADR and
// canvas previews keep their own theme and security settings when rendered together.
let pending: Promise<unknown> = Promise.resolve();

export function renderMermaid(id: string, source: string, config: MermaidConfig) {
  const result = pending.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize(config);
    return mermaid.render(id, source);
  });
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
